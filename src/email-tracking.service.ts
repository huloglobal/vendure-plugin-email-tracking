import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import {
    hashIp, isLicensed, signValue, adapterFor, DbAdapter,
    PluginPrefs, WeeklyDigest, WeeklyDigestSettings, DigestStat, DigestTip, DigestMail, DigestInput,
    smtpTransportFromEnv, describeLicence, licenceLifecycleNotice, formatStat, composeDigest,
} from '@huloglobal/vendure-licence-sdk';
import { Logger, ProcessContext, TransactionalConnection } from '@vendure/core';
import * as nodemailer from 'nodemailer';
import { EmailLog, EmailLogStatus } from './email-log.entity';
import { EmailSuppression } from './email-suppression.entity';
import { lookupGeo } from './geo-lookup';
import { getLicenceStatus, getOptions, ownTrackingPrefixes, trackingBaseUrl, hasPremiumAccess, getEvalState, configuredSigningSecret, setStatsProvider } from './options';
import { parseEmailClient } from './parse-ua';
import { decodeHtmlHref } from './decode-html-href';
import { trackedClickHref } from './click-signature';

const loggerCtx = 'EmailTrackingService';

/** Package short id — the pref namespace, buy URL slug and heartbeat label. */
export const PLUGIN_SHORT_ID = 'vendure-plugin-email-tracking';
export const PLUGIN_DISPLAY_NAME = 'Email Tracking';
export const ADMIN_ROUTE = 'email-log';

/** What the free tier loses — shown in the trial/free banners and the digest. */
export const PREMIUM_FEATURES = [
    'Open and click tracking',
    'Per-template open and click rates',
    'CSV export',
    'Suppression list',
];

const DAY_MS = 86_400_000;

/** One aggregate row over `email_log` for a time window. */
export interface LogAggregate {
    tracked: number;
    opens: number;
    clicks: number;
    bounced: number;
    opened: number;
}

/** The stats keys reported to the licence server (eval + heartbeat) and
 *  rendered in the weekly report. Numbers only, no PII. */
export function statsFromAggregate(a: Partial<LogAggregate> | null | undefined): Record<string, number> {
    const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
    const tracked = n(a?.tracked);
    const opened = n(a?.opened);
    return {
        emailsTracked: tracked,
        emailOpens: n(a?.opens),
        emailClicks: n(a?.clicks),
        emailsBounced: n(a?.bounced),
        openRatePct: tracked > 0 ? Math.round((opened / tracked) * 1000) / 10 : 0,
    };
}

/** Merchant-facing labels + formats for the stats keys, in display order. */
export const STAT_LABELS: Array<{ key: string; label: string; format: DigestStat['format'] }> = [
    { key: 'emailsTracked', label: 'emails tracked', format: 'count' },
    { key: 'emailOpens', label: 'opens recorded', format: 'count' },
    { key: 'emailClicks', label: 'link clicks recorded', format: 'count' },
    { key: 'emailsBounced', label: 'bounces and complaints caught', format: 'count' },
    { key: 'openRatePct', label: 'open rate', format: 'percent' },
];

export function digestStats(current: Record<string, number>, previous?: Record<string, number> | null): DigestStat[] {
    return STAT_LABELS.map(l => ({
        key: l.key, label: l.label, format: l.format,
        value: current[l.key] ?? 0,
        previous: previous ? (previous[l.key] ?? 0) : null,
    }));
}

/** Top `max` non-zero stats formatted for the licence banner ("So far: …"). */
export function recentStatLines(stats: Record<string, number>, max = 3): Array<{ label: string; value: string }> {
    return STAT_LABELS
        .filter(l => (stats[l.key] ?? 0) > 0)
        .slice(0, max)
        .map(l => ({ label: l.label, value: formatStat({ key: l.key, label: l.label, value: stats[l.key], format: l.format }) }));
}

export interface SetupItem {
    key: string;
    label: string;
    done: boolean;
    hint: string;
    tab?: string;
    url?: string;
}

export interface SetupChecklist {
    items: SetupItem[];
    complete: boolean;
}

export interface SetupFacts {
    /** Any `email_log` row in the last 30 days — proves the sender is wrapped. */
    hasRecentLog: boolean;
    publicBaseUrl: string;
    /** `bounceWebhookSecret` or a *configured* `signingSecret`. */
    bounceSecretConfigured: boolean;
    /** At least one open or click ever recorded. */
    hasEngagement: boolean;
}

const DOCS_URL = 'https://huloglobal.com/vendure-plugins/email-tracking/docs/';

/** Pure: the set-up checklist from facts the service gathers. */
export function buildSetupItems(f: SetupFacts): SetupChecklist {
    const base = (f.publicBaseUrl || '').trim();
    const baseIsPublic = !!base && !/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(base);
    const items: SetupItem[] = [
        {
            key: 'sender', label: 'Email sender wrapped', done: f.hasRecentLog,
            hint: f.hasRecentLog
                ? 'Vendure\'s outgoing mail is flowing through the tracking sender.'
                : 'Pass `emailSender: new TrackingEmailSender()` to EmailPlugin.init() so every email is logged. Nothing has been logged in the last 30 days.',
            url: DOCS_URL,
        },
        {
            key: 'publicBaseUrl', label: 'Public base URL set', done: baseIsPublic,
            hint: baseIsPublic
                ? `Pixel and click links point at ${base}.`
                : 'Set `publicBaseUrl` to your public shop host (https://shop.example.com) so the open pixel and click links resolve from customers\' inboxes.',
            url: DOCS_URL,
        },
        {
            key: 'bounceWebhook', label: 'Bounce webhook secret configured', done: f.bounceSecretConfigured,
            hint: f.bounceSecretConfigured
                ? 'Signed bounce and complaint webhooks are accepted at /email-track/bounce.'
                : 'Set `bounceWebhookSecret` and point your mail provider\'s bounce webhook at /email-track/bounce — hard bounces and complaints then land on the suppression list automatically.',
            url: DOCS_URL,
        },
        {
            key: 'engagement', label: 'First open or click recorded', done: f.hasEngagement,
            hint: f.hasEngagement
                ? 'Opens and clicks are being recorded.'
                : 'Recorded once a customer opens a tracked email or clicks a link in it. Needs an active licence or the evaluation — the free tier serves the pixel but does not record.',
        },
    ];
    return { items, complete: items.every(i => i.done) };
}

/** Tips for the weekly report: the undone checklist items, in order (max 3). */
export function tipsFromChecklist(list: SetupChecklist, adminUrl: string | null): DigestTip[] {
    return list.items.filter(i => !i.done).slice(0, 3).map(i => ({
        title: i.label,
        body: i.hint,
        url: i.url || adminUrl || undefined,
        linkLabel: i.url ? 'Docs' : 'Open in Admin',
    }));
}

/** `paid` / `trial` / `free` exactly as `licence/status` reports it. */
export function effectiveTier(): 'paid' | 'trial' | 'free' {
    if (getLicenceStatus()?.valid) return 'paid';
    return getEvalState()?.active ? 'trial' : 'free';
}

interface SendTrackedMeta {
    /** Logical email type — e.g. 'welcome', 'order-confirmation', 'invoice'. */
    type: string;
    /** Optional context string, e.g. chase stage 'T-7' / 'due' / 'T+14'. */
    context?: string;
    /** Channel id (1 = elite, 2 = LD). Defaults to 1. */
    channelId?: number;
    customerId?: number;
    orderId?: number;
    orderCode?: string;
    invoiceId?: number;
    applicationId?: number;
}

/** Rows deleted per statement by the retention sweeper. */
export const RETENTION_BATCH = 5000;
/** Batches per sweep (1 000 000 rows); the next daily run continues. */
const RETENTION_MAX_BATCHES = 200;

/**
 * Delete matching rows `RETENTION_BATCH` at a time, oldest id first, until
 * a batch comes back short. One unbounded `DELETE` on a large `email_log`
 * holds locks for the whole scan and stalls the sender; small batches with
 * a pause between them do not. The derived-table form is valid on
 * MariaDB/MySQL (which refuse `LIMIT` in a plain `IN` subquery) and on
 * Postgres (which has no `DELETE … ORDER BY … LIMIT`).
 */
export async function batchedDelete(
    db: Pick<DbAdapter, 'query'>,
    table: 'email_log' | 'email_link',
    where: string,
    params: any[],
    pauseMs = 50,
): Promise<number> {
    let total = 0;
    for (let i = 0; i < RETENTION_MAX_BATCHES; i++) {
        const res = await db.query(
            `DELETE FROM ${table} WHERE id IN (SELECT id FROM (SELECT id FROM ${table} WHERE ${where} ORDER BY id ASC LIMIT ${RETENTION_BATCH}) AS batch)`,
            params,
            { needAffected: true },
        );
        const n = Number(res?.affectedRows ?? 0);
        total += n;
        if (n < RETENTION_BATCH) break;
        if (pauseMs > 0) await new Promise(r => setTimeout(r, pauseMs));
    }
    return total;
}

@Injectable()
export class EmailTrackingService implements OnApplicationBootstrap, OnModuleDestroy {
    private retentionTimer: NodeJS.Timeout | null = null;
    private retentionFirst: NodeJS.Timeout | null = null;
    /** Shared `hulo_plugin_prefs` rows for this plugin (digest settings, trial lead). */
    readonly prefs: PluginPrefs;
    /** Monday 08:00 (server-local) "what Email Tracking did for you" report. */
    readonly digest: WeeklyDigest;

    constructor(private connection: TransactionalConnection, private processContext: ProcessContext) {
        const query = (sql: string, params?: any[], o?: any) => adapterFor(this.connection.rawConnection).query(sql, params, o);
        this.prefs = new PluginPrefs(query, PLUGIN_SHORT_ID);
        this.digest = new WeeklyDigest({
            pluginId: PLUGIN_SHORT_ID,
            pluginName: PLUGIN_DISPLAY_NAME,
            prefs: this.prefs,
            collect: (from, to) => this.digestCollect(from, to),
            send: (to, mail) => this.digestSend(to, mail),
            defaultRecipient: () => this.digestDefaultRecipient(),
        });
    }

    /** Called by Nest after every provider is initialised. Safe place to
     *  start background sweepers that need DB access. The sweeper runs on
     *  the worker only (the server answers pixels and clicks). */
    onApplicationBootstrap(): void {
        // Usage stats (30 days, numbers only) for the evaluation ping and the
        // heartbeat — both server and worker may answer, so wire it everywhere.
        setStatsProvider(() => this.evalStats());
        void this.prefs.ensureTable();
        if (this.processContext.isWorker) this.digest.start();

        const opts = getOptions();
        const r = opts.retention;
        if (!r || ((!r.days || r.days <= 0) && !r.maxRows)) return;
        if (!this.processContext.isWorker) return;
        const interval = Math.max(60_000, r.sweepIntervalMs ?? 24 * 60 * 60 * 1000);
        this.retentionFirst = setTimeout(() => { void this.sweepRetention(); }, 60_000);
        this.retentionTimer = setInterval(() => { void this.sweepRetention(); }, interval);
        this.retentionFirst.unref?.();
        this.retentionTimer.unref?.();
    }

    onModuleDestroy(): void {
        this.digest.stop();
        if (this.retentionFirst) clearTimeout(this.retentionFirst);
        if (this.retentionTimer) clearInterval(this.retentionTimer);
        this.retentionFirst = null;
        this.retentionTimer = null;
    }

    // ── Usage stats, setup checklist, weekly report ───────────────────────

    /** One aggregate over `email_log` for `[from, to)`. Install-wide (every
     *  channel): these are the numbers the licence server and the weekly
     *  report use. Fails soft to zeros. */
    async aggregate(from: Date, to: Date): Promise<LogAggregate> {
        try {
            const rows = await adapterFor(this.connection.rawConnection).query(
                `SELECT COUNT(*)                                                                AS tracked,
                        SUM(\`openCount\`)                                                       AS opens,
                        SUM(\`clickCount\`)                                                      AS clicks,
                        SUM(CASE WHEN status='bounced' OR status='complained' THEN 1 ELSE 0 END) AS bounced,
                        SUM(CASE WHEN \`openCount\` > 0 THEN 1 ELSE 0 END)                       AS opened
                 FROM email_log
                 WHERE \`createdAt\` >= ? AND \`createdAt\` < ?`,
                [from, to],
            );
            const r = rows?.[0] || {};
            return { tracked: Number(r.tracked) || 0, opens: Number(r.opens) || 0, clicks: Number(r.clicks) || 0, bounced: Number(r.bounced) || 0, opened: Number(r.opened) || 0 };
        } catch (e: any) {
            Logger.warn(`stats aggregate failed: ${e?.message}`, loggerCtx);
            return { tracked: 0, opens: 0, clicks: 0, bounced: 0, opened: 0 };
        }
    }

    /** Stats over the last `days` days, keyed as the licence server expects. */
    async statsForDays(days: number): Promise<Record<string, number>> {
        const to = new Date();
        return statsFromAggregate(await this.aggregate(new Date(to.getTime() - days * DAY_MS), to));
    }

    /** Last 30 days — the evaluation + heartbeat stats provider. */
    evalStats(): Promise<Record<string, number>> {
        return this.statsForDays(30);
    }

    /** Real checks behind the set-up checklist card and the digest tips. */
    async setupChecklist(): Promise<SetupChecklist> {
        const opts = getOptions();
        const db = adapterFor(this.connection.rawConnection);
        let hasRecentLog = false;
        let hasEngagement = false;
        try {
            const rows = await db.query('SELECT id FROM email_log WHERE `createdAt` >= DATE_SUB(NOW(), INTERVAL ? DAY) LIMIT 1', [30]);
            hasRecentLog = Array.isArray(rows) && rows.length > 0;
        } catch { /* fail-soft */ }
        try {
            const rows = await db.query('SELECT id FROM email_log WHERE `openCount` > 0 OR `clickCount` > 0 LIMIT 1');
            hasEngagement = Array.isArray(rows) && rows.length > 0;
        } catch { /* fail-soft */ }
        return buildSetupItems({
            hasRecentLog,
            publicBaseUrl: opts.publicBaseUrl,
            bounceSecretConfigured: !!(opts.bounceWebhookSecret || configuredSigningSecret()),
            hasEngagement,
        });
    }

    /** Where the admin page lives, for the digest and tips. */
    adminUrl(): string | null {
        const base = (getOptions().publicBaseUrl || '').replace(/\/$/, '');
        return base ? `${base}/admin/extensions/${ADMIN_ROUTE}` : null;
    }

    /** Lifecycle notice + headline numbers for the licence banner and widget. */
    licenceNotice() {
        return licenceLifecycleNotice(describeLicence(getLicenceStatus()), getEvalState(), PLUGIN_SHORT_ID);
    }

    /** Dashboard widget payload: three 7-day figures, the notice, the route. */
    async widgetData() {
        const stats = await this.statsForDays(7);
        const fmt = (key: string, label: string, format: DigestStat['format'] = 'count') =>
            ({ label, value: formatStat({ key, label, value: stats[key] ?? 0, format }) });
        return {
            tier: effectiveTier(),
            notice: this.licenceNotice(),
            stats: [fmt('emailsTracked', 'Emails tracked'), fmt('emailOpens', 'Opens'), fmt('emailClicks', 'Clicks')],
            route: `/extensions/${ADMIN_ROUTE}`,
        };
    }

    private async digestCollect(from: Date, to: Date): Promise<Omit<DigestInput, 'periodStart' | 'periodEnd' | 'pluginName' | 'shortId'>> {
        const span = to.getTime() - from.getTime();
        const [cur, prev, checklist] = await Promise.all([
            this.aggregate(from, to),
            this.aggregate(new Date(from.getTime() - span), from),
            this.setupChecklist(),
        ]);
        const adminUrl = this.adminUrl();
        return {
            stats: digestStats(statsFromAggregate(cur), statsFromAggregate(prev)),
            tips: tipsFromChecklist(checklist, adminUrl),
            tier: effectiveTier(),
            licence: describeLicence(getLicenceStatus()),
            evalState: getEvalState(),
            adminUrl,
            premiumFeatures: PREMIUM_FEATURES,
            settingsHint: `Change the recipient or stop this weekly report in Admin → Email Log → Weekly report.`,
        };
    }

    /** This package has no mailer of its own: the host's SMTP_* env is used. */
    private async digestSend(to: string, mail: DigestMail): Promise<unknown> {
        const transport = smtpTransportFromEnv();
        if (!transport) throw new Error('No SMTP transport: set SMTP_SERVER (or SMTP_HOST), SMTP_USER and SMTP_PASSWORD in the host environment');
        const from = process.env.SMTP_FROM || process.env.SMTP_USER || undefined;
        return transport.sendMail({ ...(from ? { from } : {}), to, subject: mail.subject, text: mail.text, html: mail.html });
    }

    /** The licence's customer email, else the trial lead the admin typed. */
    private async digestDefaultRecipient(): Promise<string | null> {
        const customer = describeLicence(getLicenceStatus())?.customer;
        if (customer) return customer;
        return (await this.prefs.get('eval.leadEmail')) || null;
    }

    /** This week's report rendered for the admin preview (no send). */
    async digestPreview(): Promise<DigestMail> {
        const end = new Date();
        const start = new Date(end.getTime() - 7 * DAY_MS);
        const partial = await this.digestCollect(start, end);
        return composeDigest({ ...partial, pluginName: PLUGIN_DISPLAY_NAME, shortId: PLUGIN_SHORT_ID, periodStart: start, periodEnd: end });
    }

    digestSettings(): Promise<WeeklyDigestSettings> { return this.digest.settings(); }

    /** One retention pass: `email_log` older than `days` (and beyond `maxRows`),
     *  `email_link` rows past `expiresAt` or older than `days`. */
    async sweepRetention(): Promise<{ logs: number; links: number }> {
        const r = getOptions().retention;
        const db = adapterFor(this.connection.rawConnection);
        const out = { logs: 0, links: 0 };
        if (!r) return out;
        try {
            if (r.days && r.days > 0) {
                out.logs += await batchedDelete(db, 'email_log', '`createdAt` < DATE_SUB(NOW(), INTERVAL ? DAY)', [r.days]);
                out.links += await batchedDelete(db, 'email_link', '`createdAt` < DATE_SUB(NOW(), INTERVAL ? DAY)', [r.days]);
            }
            if (r.maxRows && r.maxRows > 0) {
                const rows = await db.query('SELECT COUNT(*) AS n FROM email_log');
                const over = Number(rows?.[0]?.n ?? 0) - r.maxRows;
                if (over > 0) {
                    // Oldest ids first; the cutoff id keeps every batch bounded.
                    const edge = await db.query('SELECT id FROM email_log ORDER BY id ASC LIMIT 1 OFFSET ?', [over]);
                    const cutoff = Number(edge?.[0]?.id ?? 0);
                    if (cutoff > 0) out.logs += await batchedDelete(db, 'email_log', 'id < ?', [cutoff]);
                }
            }
            out.links += await batchedDelete(db, 'email_link', '`expiresAt` IS NOT NULL AND `expiresAt` < NOW()', []);
            if (out.logs || out.links) Logger.info(`retention: pruned ${out.logs} email_log and ${out.links} email_link row(s)`, loggerCtx);
        } catch (e: any) {
            Logger.warn(`retention sweep failed: ${e?.message}`, loggerCtx);
        }
        return out;
    }

    /**
     * Send an email through nodemailer with full tracking: creates an
     * EmailLog row, injects a 1×1 open-tracking pixel, rewrites every
     * `href` in the html to go through our click-tracker, records the
     * SMTP response on success / failure.
     *
     * Returns the created EmailLog row (with id). Throws only if the
     * transport configuration itself is invalid; SMTP delivery failures
     * are caught and recorded as status='failed' / 'deferred'.
     */
    async sendTracked(
        transporter: nodemailer.Transporter,
        mail: nodemailer.SendMailOptions,
        meta: SendTrackedMeta,
    ): Promise<EmailLog> {
        const repo = this.connection.rawConnection.getRepository(EmailLog);
        const recipient = this.firstAddress(mail.to) || '';

        // Suppression check — refuse to call SMTP for recipients on the
        // suppression list, and record a `status='suppressed'` row so
        // the admin can still see the attempt in the log.
        if (recipient && await this.isSuppressed(recipient)) {
            const suppressed = repo.create({
                type: meta.type, recipient,
                subject: String(mail.subject || ''),
                fromAddress: this.firstAddress(mail.from as any),
                channelId: meta.channelId || 1,
                customerId: meta.customerId, orderId: meta.orderId, orderCode: meta.orderCode,
                invoiceId: meta.invoiceId, applicationId: meta.applicationId,
                status: 'suppressed' as EmailLogStatus, tracked: true,
                errorMessage: 'Recipient is on the suppression list',
            });
            return await repo.save(suppressed);
        }

        // Create the row up-front so the pixel/click URLs have an id to
        // reference. status starts as 'sent' optimistically; we update
        // it if the SMTP submit throws or returns 4xx/5xx.
        const row = repo.create({
            type: meta.type,
            recipient: this.firstAddress(mail.to),
            subject: String(mail.subject || ''),
            fromAddress: this.firstAddress(mail.from as any),
            bcc: this.firstAddress(mail.bcc),
            replyTo: this.firstAddress(mail.replyTo as any),
            context: meta.context,
            channelId: meta.channelId || 1,
            customerId: meta.customerId,
            orderId: meta.orderId,
            orderCode: meta.orderCode,
            invoiceId: meta.invoiceId,
            applicationId: meta.applicationId,
            status: 'sent' as EmailLogStatus,
            tracked: true,
        });
        const saved = await repo.save(row);

        // Wrap the HTML — clicks first (so the pixel itself isn't rewritten),
        // then the pixel append. Plain-text-only emails are unaffected.
        // nodemailer also accepts Buffer/stream/{path} bodies: only wrap a string.
        const html = typeof mail.html === 'string' ? mail.html : '';
        if (mail.html && !html) Logger.warn('tracked send: non-string html body left untouched (no tracking)', loggerCtx);
        if (html) {
            const wrapped = this.wrapHtml(html, Number(saved.id));
            mail = { ...mail, html: wrapped };
        }

        // Send.
        try {
            const info = await transporter.sendMail(mail);
            saved.smtpResponse = String(info.response || '').slice(0, 500);
            // Stored without angle brackets; the bounce matcher accepts both forms.
            saved.smtpMessageId = String(info.messageId || '').replace(/^<|>$/g, '').slice(0, 500);
            // Gmail's "250 2.0.0 OK" → sent. 4xx → deferred. 5xx → failed.
            const code = parseInt((info.response || '').split(' ')[0], 10);
            if (code >= 500) saved.status = 'failed';
            else if (code >= 400) saved.status = 'deferred';
            else saved.status = 'sent';
            await repo.save(saved);
        } catch (e: any) {
            saved.status = 'failed';
            saved.errorMessage = String(e?.message || e).slice(0, 2000);
            saved.smtpResponse = e?.response ? String(e.response).slice(0, 500) : '';
            await repo.save(saved);
            Logger.error(`Tracked send FAILED [${meta.type}] to ${saved.recipient}: ${e?.message}`, loggerCtx);
            throw e;
        }
        Logger.info(`Tracked send OK [${meta.type}] to ${saved.recipient} (id=${saved.id})`, loggerCtx);
        return saved;
    }

    /** Wrap an HTML body for tracking: rewrite links + append open pixel. */
    wrapHtml(html: string, eventId: number): string {
        const base = trackingBaseUrl();
        const token = this.tokenForId(eventId);
        const trackedHtml = this.rewriteLinks(html, token, base);
        const pixel = `<img src="${base}/email-track/open/${token}.gif" width="1" height="1" alt="" border="0" style="border:0;width:1px;height:1px;opacity:0;overflow:hidden">`;
        if (/<\/body>/i.test(trackedHtml)) {
            return trackedHtml.replace(/<\/body>/i, `${pixel}</body>`);
        }
        return trackedHtml + pixel;
    }

    /** Build the URL path token for an email-log id. When a
     *  `signingSecret` is configured, the token is `<id>.<hmac>` so the
     *  controller can verify nobody forged a URL. Without a secret we
     *  fall back to the bare id (legacy behaviour). */
    private tokenForId(eventId: number): string {
        const secret = getOptions().signingSecret;
        if (secret) return signValue(String(eventId), secret);
        return String(eventId);
    }

    private rewriteLinks(html: string, token: string, base: string): string {
        const ownPrefixes = ownTrackingPrefixes();
        return html.replace(/<a\b([^>]*?)\bhref\s*=\s*(["'])(.*?)\2/gi, (match, attrs, quote, url) => {
            const trimmed = String(url).trim();
            if (!trimmed) return match;
            if (/^(mailto:|tel:|#)/i.test(trimmed)) return match;
            if (ownPrefixes.some(p => trimmed.startsWith(p))) return match;
            if (/unsubscribe/i.test(trimmed) || /\bopt[-_]?out\b/i.test(trimmed)) return match;
            // Decode HTML-escaped query separators before encoding the target.
            const target = decodeHtmlHref(trimmed).trim();
            return `<a${attrs}href=${quote}${trackedClickHref(base, token, target, getOptions().signingSecret)}${quote}`;
        });
    }

    /** Record a pixel-hit open. Idempotent re-counting; firstOpenedAt only
     *  set the first time. Full history of the last 50 opens is kept on
     *  the row as `opensJson` for the admin detail page.
     *
     *  Each open entry includes:
     *    - ts        ISO timestamp
     *    - ip        raw or hashed (per `hashIpsInHistory` option)
     *    - ipHash    one-way hash with the per-install salt
     *    - ua / client / platform / isBot   from parseEmailClient
     *    - country / region / city / timezone   best-effort MaxMind geo
     */
    async recordOpen(id: number, ip: string | null, ua: string | null) {
        const repo = this.connection.rawConnection.getRepository(EmailLog);
        const opts = getOptions();
        const now = new Date();
        // Geo lookup uses the raw IP — done before hashing so we can
        // resolve country/city even when the stored IP is anonymised.
        const geo = await lookupGeo(ip);
        const ipForRow = opts.hashIpsInHistory ? hashIp(ip, opts.ipSalt || '') : ip;
        // Atomic counter: Gmail's proxy, Apple MPP and the real open arrive together.
        const r = await adapterFor(this.connection.rawConnection).query(
            `UPDATE email_log SET \`openCount\` = \`openCount\` + 1, \`lastOpenedAt\` = ?,
                    \`firstOpenedAt\` = COALESCE(\`firstOpenedAt\`, ?), \`firstOpenIp\` = COALESCE(\`firstOpenIp\`, ?), \`firstOpenUserAgent\` = COALESCE(\`firstOpenUserAgent\`, ?)
              WHERE id = ?`,
            [now, now, ipForRow || null, ua ? ua.slice(0, 1000) : null, id], { needAffected: true },
        );
        if (!Number(r?.affectedRows ?? r?.rowCount ?? 0)) return;
        // History is best effort (last writer wins on the JSON only).
        const row = await repo.findOne({ where: { id } });
        if (!row) return;
        let opens: any[] = [];
        try { opens = JSON.parse(row.opensJson || '[]'); } catch {}
        const parsed = parseEmailClient(ua);
        opens.push({
            ts: now.toISOString(),
            ip: ipForRow,
            ipHash: hashIp(ip, opts.ipSalt || ''),
            ua: ua ? ua.slice(0, 300) : null,
            client: parsed.client,
            platform: parsed.platform,
            isBot: parsed.isBot,
            country: geo.country,
            region: geo.region,
            city: geo.city,
            timezone: geo.timezone,
        });
        if (opens.length > 50) opens = opens.slice(-50);
        await repo.update(id, { opensJson: JSON.stringify(opens) });
    }

    /** Record a click. Geo + IP hashing applied the same way as opens. */
    async recordClick(id: number, url: string, ip: string | null, ua: string | null): Promise<string | null> {
        const repo = this.connection.rawConnection.getRepository(EmailLog);
        const opts = getOptions();
        const now = new Date();
        const r = await adapterFor(this.connection.rawConnection).query(
            `UPDATE email_log SET \`clickCount\` = \`clickCount\` + 1, \`firstClickedAt\` = COALESCE(\`firstClickedAt\`, ?) WHERE id = ?`,
            [now, id], { needAffected: true },
        );
        if (!Number(r?.affectedRows ?? r?.rowCount ?? 0)) return null;
        const row = await repo.findOne({ where: { id } });
        if (!row) return null;

        const geo = await lookupGeo(ip);
        const ipForRow = opts.hashIpsInHistory ? hashIp(ip, opts.ipSalt || '') : ip;

        let clicks: any[] = [];
        try { clicks = JSON.parse(row.clicksJson || '[]'); } catch {}
        clicks.push({
            url: url.slice(0, 1000),
            ts: now.toISOString(),
            ip: ipForRow,
            ipHash: hashIp(ip, opts.ipSalt || ''),
            ua: ua ? ua.slice(0, 300) : null,
            country: geo.country,
            region: geo.region,
            city: geo.city,
            timezone: geo.timezone,
        });
        if (clicks.length > 50) clicks = clicks.slice(-50);
        await repo.update(id, { clicksJson: JSON.stringify(clicks) });
        return url;
    }

    /** SMTP DSN (bounce / complaint) hook — wire up if you point Postmaster
     *  Tools / a bounce-processor at /email-track/bounce. Hard bounces +
     *  complaints automatically add the recipient to the suppression list
     *  so the next send-attempt is refused. */
    async recordBounce(messageId: string, status: 'bounced' | 'complained', reason?: string, opts: { soft?: boolean } = {}) {
        const repo = this.connection.rawConnection.getRepository(EmailLog);
        // Providers send the Message-ID with or without angle brackets.
        const bare = messageId.replace(/^<|>$/g, '');
        const row = (await repo.findOne({ where: { smtpMessageId: bare } })) || (await repo.findOne({ where: { smtpMessageId: `<${bare}>` } }));
        if (!row) return false;
        row.status = opts.soft ? 'deferred' : status;
        if (reason) row.errorMessage = reason.slice(0, 2000);
        await repo.save(row);
        if (opts.soft) return true; // mailbox full / greylisted: never suppress

        if (row.recipient) {
            const suppressionReason = status === 'complained' ? 'complaint' : 'hard-bounce';
            await this.addSuppression(row.recipient, suppressionReason, reason || `Auto-added from ${status} on email #${row.id}`, row.channelId);
        }
        return true;
    }

    /** Returns true if the recipient should be skipped at send-time. */
    async isSuppressed(recipient: string): Promise<boolean> {
        // Suppression-list enforcement is a paid feature. Unlicensed
        // installs always return false here so the suppression rows
        // are visible in the admin UI but not consulted on send —
        // matches the privacy boundary "we don't gate your own emails".
        if (!hasPremiumAccess()) return false;
        if (!recipient) return false;
        const repo = this.connection.rawConnection.getRepository(EmailSuppression);
        const row = await repo.findOne({ where: { recipient: recipient.toLowerCase() } });
        return !!row;
    }

    async addSuppression(recipient: string, reason: string, note?: string, channelId?: number): Promise<EmailSuppression> {
        const repo = this.connection.rawConnection.getRepository(EmailSuppression);
        const lower = recipient.toLowerCase();
        const existing = await repo.findOne({ where: { recipient: lower } });
        if (existing) {
            if (note && note !== existing.note) {
                existing.note = note.slice(0, 2000);
                return await repo.save(existing);
            }
            return existing;
        }
        // Two bounce webhooks for the same address can race: insert-ignore under the unique index, then read back.
        await adapterFor(this.connection.rawConnection).query(
            `INSERT IGNORE INTO email_suppression (\`createdAt\`, \`updatedAt\`, recipient, reason, note, \`channelId\`) VALUES (NOW(), NOW(), ?, ?, ?, ?)`,
            [lower, reason.slice(0, 32), note ? note.slice(0, 2000) : null, channelId || null],
        ).catch(() => undefined);
        const row = await repo.findOne({ where: { recipient: lower } });
        return row || (await repo.save(repo.create({ recipient: lower, reason, note: note ? note.slice(0, 2000) : (null as any), channelId: channelId || null as any })));
    }

    async removeSuppression(recipient: string): Promise<boolean> {
        const repo = this.connection.rawConnection.getRepository(EmailSuppression);
        const res = await repo.delete({ recipient: recipient.toLowerCase() });
        return !!(res.affected && res.affected > 0);
    }

    private firstAddress(addr: any): string | undefined {
        if (!addr) return undefined;
        if (typeof addr === 'string') return addr.slice(0, 500);
        if (Array.isArray(addr)) return addr.map(a => typeof a === 'string' ? a : a?.address).filter(Boolean).join(', ').slice(0, 500);
        if (addr.address) return String(addr.address).slice(0, 500);
        return String(addr).slice(0, 500);
    }
}
