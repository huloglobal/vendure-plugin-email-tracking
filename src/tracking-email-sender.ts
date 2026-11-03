import { Injector, Logger, TransactionalConnection } from '@vendure/core';
import { EmailSender } from '@vendure/email-plugin/lib/src/sender/email-sender';
import { EmailDetails, EmailTransportOptions } from '@vendure/email-plugin/lib/src/types';
import { NodemailerEmailSender } from '@vendure/email-plugin/lib/src/sender/nodemailer-email-sender';
import { EmailLog, EmailLogStatus } from './email-log.entity';
import { getOptions, ownTrackingPrefixes, trackingBaseUrl } from './options';
import { adapterFor, signValue } from '@huloglobal/vendure-licence-sdk';
import { decodeHtmlHref } from './decode-html-href';
import { trackedClickHref } from './click-signature';

const loggerCtx = 'TrackingEmailSender';

/** Where `CapturingSender` parks nodemailer's `info` for the send in flight. */
const SMTP_INFO = Symbol('huloSmtpInfo');

interface SmtpInfo { messageId?: string; response?: string; }

/**
 * `NodemailerEmailSender.send()` discards the `info` nodemailer returns
 * (Message-ID + SMTP response), which the bounce webhook needs to match a
 * DSN back to the log row. This subclass keeps it on the `EmailDetails`
 * object of that very send (never on the shared sender), so concurrent
 * job-queue sends cannot mix results up. `sendMail` is private in the
 * upstream typings, hence the instance override rather than a method.
 */
export class CapturingSender extends NodemailerEmailSender {
    constructor() {
        super();
        const base = (NodemailerEmailSender.prototype as any).sendMail;
        if (typeof base !== 'function') return;
        (this as any).sendMail = async (email: EmailDetails, transporter: any) => {
            const info = await base.call(this, email, transporter);
            if (info && typeof info === 'object') (email as any)[SMTP_INFO] = info;
            return info;
        };
    }

    /** The captured info for this `EmailDetails`, removed on read. */
    takeInfo(email: EmailDetails): SmtpInfo | null {
        const info = (email as any)[SMTP_INFO] || null;
        delete (email as any)[SMTP_INFO];
        return info;
    }
}

/** `sent` / `deferred` / `failed` from the SMTP reply code, like `sendTracked`. */
export function statusFromSmtpResponse(response: string | undefined): EmailLogStatus {
    const code = parseInt(String(response || '').split(' ')[0], 10);
    if (code >= 500) return 'failed';
    if (code >= 400) return 'deferred';
    return 'sent';
}

/**
 * Wraps the default NodemailerEmailSender so every send by the Vendure
 * email-plugin (order confirmation, password reset, OTP, invoice, etc.)
 * also creates an EmailLog row and gets the open-pixel + click-tracking
 * rewrites applied to its html body.
 *
 * The actual SMTP transport handling stays in the default sender — we just
 * mutate the body in-place before delegating, and persist the row.
 */
export class TrackingEmailSender implements EmailSender {
    private inner = new CapturingSender();
    private connection!: TransactionalConnection;

    init(injector: Injector) {
        try {
            this.connection = injector.get(TransactionalConnection);
            Logger.info('TrackingEmailSender init() OK — tracking enabled', loggerCtx);
        } catch (e: any) {
            Logger.error(`TrackingEmailSender init() FAILED: ${e?.message}`, loggerCtx);
        }
    }

    async send(email: EmailDetails, options: EmailTransportOptions): Promise<void> {
        const trackable = options.type === 'smtp' || options.type === 'ses' || options.type === 'sendmail';
        if (!trackable) {
            return this.inner.send(email, options);
        }
        if (!this.connection) {
            Logger.warn(`TrackingEmailSender.send() called but connection is null — skipping tracking for "${email.subject}"`, loggerCtx);
            return this.inner.send(email, options);
        }

        const repo = this.connection.rawConnection.getRepository(EmailLog);
        // Vendure's `EmailDetails` doesn't carry the source Order / Customer
        // through to the sender — we get subject/body only. Recover the
        // orderCode from the subject (Vendure's default templates render it
        // as `#<code>`) and then look up the Order by code for the id +
        // customerId. Best-effort: if none of that resolves, the row still
        // saves with just the raw envelope, exactly as before.
        const orderCode = this.extractOrderCode(email.subject, email.body);
        const linkedIds = orderCode ? await this.lookupOrderIds(orderCode) : null;
        // Even without an order (password-reset, OTP, email-verification,
        // welcome, etc.) we can still link the row to a customer by
        // recipient email. Doing it here means the per-customer Emails
        // view picks up ALL of these too, not just order-related sends.
        const customerIdByEmail = !linkedIds?.customerId
            ? await this.lookupCustomerIdByEmail(email.recipient)
            : null;
        const payload: Partial<EmailLog> = {
            type: this.inferType(email.subject),
            recipient: (email.recipient || '').slice(0, 255),
            subject: (email.subject || '').slice(0, 512),
            fromAddress: (email.from || '').slice(0, 255),
            bcc: email.bcc?.slice(0, 255),
            replyTo: email.replyTo?.slice(0, 255),
            channelId: linkedIds?.channelId || 1,
            status: 'sent' as EmailLogStatus,
            tracked: true,
        };
        if (orderCode) payload.orderCode = orderCode;
        if (linkedIds?.orderId) payload.orderId = linkedIds.orderId;
        if (linkedIds?.customerId != null) payload.customerId = linkedIds.customerId;
        else if (customerIdByEmail != null) payload.customerId = customerIdByEmail;
        // The log row must never stop the email (OTP, password reset, order
        // confirmation): a DB error here means "send untracked", not "fail".
        let saved: EmailLog | null = null;
        try {
            saved = await repo.save(repo.create(payload));
        } catch (e: any) {
            Logger.warn(`email log row could not be written (sending untracked): ${e?.message}`, loggerCtx);
        }

        // Rewrite + pixel-inject the html body in place.
        if (saved) {
            try {
                email.body = this.wrapHtml(email.body || '', Number(saved.id));
            } catch (e: any) {
                Logger.warn(`tracking wrap failed: ${e?.message}`, loggerCtx);
            }
        }

        try {
            await this.inner.send(email, options);
        } catch (e: any) {
            if (saved) {
                saved.status = 'failed';
                saved.errorMessage = String(e?.message || e).slice(0, 2000);
                saved.smtpResponse = e?.response ? String(e.response).slice(0, 500) : saved.smtpResponse;
                try { await repo.save(saved); } catch { /* the SMTP error is the one to surface */ }
            }
            throw e;
        }
        // Message-ID + SMTP reply onto the row so bounces (`/email-track/bounce`) can find it.
        const info = this.inner.takeInfo(email);
        if (saved && info) {
            try {
                await repo.update(saved.id, {
                    smtpMessageId: String(info.messageId || '').replace(/^<|>$/g, '').slice(0, 500),
                    smtpResponse: String(info.response || '').slice(0, 500),
                    status: statusFromSmtpResponse(info.response),
                });
            } catch (e: any) {
                Logger.warn(`smtp result could not be recorded on email #${saved.id}: ${e?.message}`, loggerCtx);
            }
        }
        if (saved) Logger.info(`Tracked plugin-email [${saved.type}] to ${saved.recipient} (id=${saved.id})`, loggerCtx);
    }

    /**
     * Pull an order code out of the email subject (or, as a fallback,
     * the body). Vendure's default order-related templates render the
     * order code as `#<code>` in the subject, e.g.
     * "Order confirmation for #S2BZ54TEK91HUUBA". Order codes are always
     * uppercase alphanumeric — accept 10–32 characters to cover custom
     * `orderCodeStrategy` implementations.
     */
    private extractOrderCode(subject?: string, body?: string): string | null {
        const rx = /#([A-Z0-9]{10,32})\b/;
        const inSubject = rx.exec(subject || '');
        if (inSubject) return inSubject[1];
        const inBody = rx.exec(body || '');
        return inBody ? inBody[1] : null;
    }

    /**
     * Look up `orderId` + `customerId` for an order code so the
     * per-order and per-customer Emails views can filter without a
     * subject-string match. Best-effort — if the order isn't found
     * (e.g. code came from a draft template that was never saved),
     * we return null and let the row save with only `orderCode`.
     */
    private async lookupOrderIds(
        code: string,
    ): Promise<{ orderId: number; customerId: number | null; channelId: number | null } | null> {
        try {
            // Backticks: Vendure's camelCase columns are quoted on Postgres. The
            // channel is the order's own (non-default) channel when it has one.
            const rows: any[] = await adapterFor(this.connection.rawConnection).query(
                `SELECT o.id, o.\`customerId\`,
                        (SELECT occ.\`channelId\` FROM order_channels_channel occ JOIN channel ch ON ch.id = occ.\`channelId\`
                          WHERE occ.\`orderId\` = o.id ORDER BY (ch.code = '__default_channel__') ASC, occ.\`channelId\` DESC LIMIT 1) AS channelId
                   FROM \`order\` o WHERE o.code = ? LIMIT 1`,
                [code],
            );
            if (!rows?.length) return null;
            const r = rows[0];
            return {
                orderId: Number(r.id),
                customerId: r.customerId != null ? Number(r.customerId) : null,
                channelId: r.channelId != null ? Number(r.channelId) : null,
            };
        } catch (e: any) {
            Logger.warn(`orderId lookup failed for code=${code}: ${e?.message}`, loggerCtx);
            return null;
        }
    }

    /**
     * Find a Customer id by their email address so emails without any
     * order context (password reset, OTP, verification, welcome, etc.)
     * still show up in the per-customer Emails view. Case-insensitive
     * lookup against the Customer table. Returns null on no-match.
     */
    private async lookupCustomerIdByEmail(recipient?: string): Promise<number | null> {
        const clean = (recipient || '').split(',')[0].trim().replace(/^.*<|>.*$/g, '').trim();
        if (!clean || !clean.includes('@')) return null;
        try {
            const rows: any[] = await adapterFor(this.connection.rawConnection).query(
                'SELECT id FROM customer WHERE LOWER(`emailAddress`) = LOWER(?) AND `deletedAt` IS NULL LIMIT 1',
                [clean],
            );
            return rows?.length ? Number(rows[0].id) : null;
        } catch (e: any) {
            Logger.warn(`customerId lookup failed for recipient=${clean}: ${e?.message}`, loggerCtx);
            return null;
        }
    }

    /** Best-effort categorisation of plugin-email sends. */
    private inferType(subject: string): string {
        const s = (subject || '').toLowerCase();
        if (s.includes('order confirmation') || s.includes('order receipt')) return 'order-confirmation';
        if (s.includes('verify')) return 'email-verification';
        if (s.includes('password')) return 'password-reset';
        if (s.includes('otp') || s.includes('one-time') || s.includes('login code')) return 'otp-code';
        if (s.includes('invoice')) return 'invoice';
        if (s.includes('review')) return 'review-reminder';
        if (s.includes('payment')) return 'payment-due';
        if (s.includes('abandoned')) return 'abandoned-cart';
        if (s.includes('email address')) return 'email-address-change';
        return 'plugin-email';
    }

    private wrapHtml(html: string, eventId: number): string {
        const base = trackingBaseUrl();
        const ownPrefixes = ownTrackingPrefixes();
        // Signed when a secret exists, so nobody can enumerate ids to forge opens/clicks.
        const secret = getOptions().signingSecret;
        const token = secret ? signValue(String(eventId), secret) : String(eventId);
        const rewritten = html.replace(/<a\b([^>]*?)\bhref\s*=\s*(["'])(.*?)\2/gi, (m, attrs, q, url) => {
            const trimmed = String(url).trim();
            if (!trimmed) return m;
            if (/^(mailto:|tel:|#)/i.test(trimmed)) return m;
            if (ownPrefixes.some(p => trimmed.startsWith(p))) return m;
            if (/unsubscribe/i.test(trimmed) || /\bopt[-_]?out\b/i.test(trimmed)) return m;
            // Templates HTML-escape query-string separators inside href attributes.
            // Decode them before encoding the target or links such as password
            // resets arrive without a usable token query parameter.
            const target = decodeHtmlHref(trimmed).trim();
            return `<a${attrs}href=${q}${trackedClickHref(base, token, target, secret)}${q}`;
        });
        const pixel = `<img src="${base}/email-track/open/${token}.gif" width="1" height="1" alt="" border="0" style="border:0;width:1px;height:1px;opacity:0;overflow:hidden">`;
        if (/<\/body>/i.test(rewritten)) return rewritten.replace(/<\/body>/i, `${pixel}</body>`);
        return rewritten + pixel;
    }
}
