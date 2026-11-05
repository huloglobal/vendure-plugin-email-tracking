import { Injector, Logger, TransactionalConnection } from '@vendure/core';
import { EmailSender } from '@vendure/email-plugin/lib/src/sender/email-sender';
import { EmailDetails, EmailTransportOptions } from '@vendure/email-plugin/lib/src/types';
import { NodemailerEmailSender } from '@vendure/email-plugin/lib/src/sender/nodemailer-email-sender';
import { EmailLog, EmailLogStatus } from './email-log.entity';
import { adapterFor } from '@huloglobal/vendure-licence-sdk';
import { EmailEventService } from './email-event.service';
import { correlationHeaders, ExtraHeaderValue, mergeHeaders, providerMessageIdFromSmtpReply, sendPayload, wrapTrackedHtml } from './outgoing-mail';
import { LinkMeta } from './link-meta';

const loggerCtx = 'TrackingEmailSender';

/** Where `CapturingSender` parks nodemailer's `info` for the send in flight. */
const SMTP_INFO = Symbol('huloSmtpInfo');
/** Extra headers (provider correlation) for the send in flight. */
const EXTRA_HEADERS = Symbol('huloExtraHeaders');

interface SmtpInfo { messageId?: string; response?: string; }

/**
 * `NodemailerEmailSender.send()` discards the `info` nodemailer returns
 * (Message-ID + SMTP response), which the bounce webhook needs to match a
 * DSN back to the log row. This subclass keeps it on the `EmailDetails`
 * object of that very send (never on the shared sender), so concurrent
 * job-queue sends cannot mix results up. `sendMail` is private in the
 * upstream typings, hence the instance override rather than a method.
 * It also adds the headers parked with `setExtraHeaders` (the provider
 * correlation id), which `EmailDetails` has no field for.
 */
export class CapturingSender extends NodemailerEmailSender {
    constructor() {
        super();
        const base = (NodemailerEmailSender.prototype as any).sendMail;
        if (typeof base !== 'function') return;
        (this as any).sendMail = async (email: EmailDetails, transporter: any) => {
            const extra: Record<string, ExtraHeaderValue> | undefined = (email as any)[EXTRA_HEADERS];
            const t = extra && Object.keys(extra).length && transporter && typeof transporter.sendMail === 'function'
                ? { sendMail: (opts: any) => transporter.sendMail({ ...opts, headers: mergeHeaders(opts?.headers, extra) }) }
                : transporter;
            const info = await base.call(this, email, t);
            if (info && typeof info === 'object') (email as any)[SMTP_INFO] = info;
            return info;
        };
    }

    /** Headers to add to this one send. */
    setExtraHeaders(email: EmailDetails, headers: Record<string, ExtraHeaderValue>): void {
        if (Object.keys(headers).length) (email as any)[EXTRA_HEADERS] = headers;
    }

    /** The captured info for this `EmailDetails`, removed on read. */
    takeInfo(email: EmailDetails): SmtpInfo | null {
        const info = (email as any)[SMTP_INFO] || null;
        delete (email as any)[SMTP_INFO];
        delete (email as any)[EXTRA_HEADERS];
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
    private events: EmailEventService | null = null;

    init(injector: Injector) {
        try {
            this.connection = injector.get(TransactionalConnection);
            Logger.info('TrackingEmailSender init() OK — tracking enabled', loggerCtx);
        } catch (e: any) {
            Logger.error(`TrackingEmailSender init() FAILED: ${e?.message}`, loggerCtx);
        }
        try {
            this.events = injector.get(EmailEventService);
        } catch {
            this.events = null; // EmailTrackingPlugin not in this process: no timeline rows
        }
    }

    /** Best-effort send-outcome event (never throws). `signed`: null when the body was not wrapped. */
    private async recordOutcome(saved: EmailLog, type: 'sent' | 'deferred' | 'failed', info: SmtpInfo | null, detail: string | null, links: LinkMeta[], signed: boolean | null) {
        if (!this.events) return;
        await this.events.record({
            type, source: 'smtp',
            log: { id: Number(saved.id), orderId: saved.orderId ?? null, customerId: saved.customerId ?? null, channelId: saved.channelId ?? null },
            recipient: saved.recipient,
            messageId: info?.messageId ? String(info.messageId) : null,
            providerMessageId: providerMessageIdFromSmtpReply(info?.response),
            detail,
            payload: signed === null ? null : sendPayload(type === 'failed' ? [] : links, signed),
        });
    }

    /**
     * The SMTP outcome replaces only the optimistic `sent` the row was created
     * with: the correlation header lets a provider event land between the
     * provider's reply and this write, and its bounced / complained /
     * delivered status must stand.
     */
    private async settleStatus(emailLogId: number, outcome: EmailLogStatus): Promise<void> {
        if (outcome === 'sent') return;
        await adapterFor(this.connection.rawConnection).query(
            "UPDATE email_log SET status = ? WHERE id = ? AND status = 'sent'",
            [outcome, emailLogId], { needAffected: true },
        );
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

        // Rewrite + pixel-inject the html body in place; note each link for the click events.
        let links: LinkMeta[] = [];
        let signed: boolean | null = null;
        if (saved) {
            try {
                const wrapped = wrapTrackedHtml(email.body || '', Number(saved.id));
                email.body = wrapped.html;
                links = wrapped.links;
                signed = wrapped.signed;
            } catch (e: any) {
                Logger.warn(`tracking wrap failed: ${e?.message}`, loggerCtx);
            }
            // Configured providers echo the email_log id back in their webhook events.
            try { this.inner.setExtraHeaders(email, correlationHeaders(Number(saved.id))); } catch { /* never blocks the send */ }
        }

        try {
            await this.inner.send(email, options);
        } catch (e: any) {
            this.inner.takeInfo(email);
            if (saved) {
                saved.errorMessage = String(e?.message || e).slice(0, 2000);
                saved.smtpResponse = e?.response ? String(e.response).slice(0, 500) : saved.smtpResponse;
                try {
                    await repo.update(saved.id, { errorMessage: saved.errorMessage, smtpResponse: saved.smtpResponse ?? null } as any);
                    await this.settleStatus(Number(saved.id), 'failed');
                } catch { /* the SMTP error is the one to surface */ }
                await this.recordOutcome(saved, 'failed', null, [saved.smtpResponse, saved.errorMessage].filter(Boolean).join(' — ') || null, links, signed);
            }
            throw e;
        }
        // Message-ID + SMTP reply onto the row so bounces (`/email-track/bounce`) can find it.
        const info = this.inner.takeInfo(email);
        if (saved && info) {
            const status = statusFromSmtpResponse(info.response);
            try {
                await repo.update(saved.id, {
                    smtpMessageId: String(info.messageId || '').replace(/^<|>$/g, '').slice(0, 500),
                    smtpResponse: String(info.response || '').slice(0, 500),
                });
                await this.settleStatus(Number(saved.id), status);
            } catch (e: any) {
                Logger.warn(`smtp result could not be recorded on email #${saved.id}: ${e?.message}`, loggerCtx);
            }
            await this.recordOutcome(saved, status === 'failed' ? 'failed' : status === 'deferred' ? 'deferred' : 'sent', info,
                info.response ? String(info.response).slice(0, 500) : null, links, signed);
        } else if (saved) {
            await this.recordOutcome(saved, 'sent', null, null, links, signed);
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

    /** Rewrite links + append the open pixel (shared with sendTracked: outgoing-mail.ts). */
    private wrapHtml(html: string, eventId: number): string {
        return wrapTrackedHtml(html, eventId).html;
    }
}
