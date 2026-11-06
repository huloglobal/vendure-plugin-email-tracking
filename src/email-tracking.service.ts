import { Injectable, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import {
    hashIp, adapterFor, DbAdapter,
    PluginPrefs, WeeklyDigest, WeeklyDigestSettings, DigestStat, DigestTip, DigestMail, DigestInput,
    smtpTransportFromEnv, describeLicence, licenceLifecycleNotice, formatStat, composeDigest,
} from '@huloglobal/vendure-licence-sdk';
import { Logger, ProcessContext, TransactionalConnection } from '@vendure/core';
import * as nodemailer from 'nodemailer';
import { EmailLog, EmailLogStatus } from './email-log.entity';
import { EmailSuppression } from './email-suppression.entity';
import { lookupGeo } from './geo-lookup';
import { getLicenceStatus, getOptions, hasPremiumAccess, getEvalState, configuredSigningSecret, setStatsProvider } from './options';
import { parseEmailClient } from './parse-ua';
import { EmailEventService } from './email-event.service';
import { correlationHeaders, mergeHeaders, providerMessageIdFromSmtpReply, sendPayload, wrapTrackedHtml } from './outgoing-mail';
import { findLink, LinkMeta, redactSensitiveUrl } from './link-meta';
import { dedupeKeyFor } from './webhook-mappers';
import { ACCEPTED_SQL, ATTEMPT_COLUMNS, attemptInfosFor, replyCode, SendClock, sendClock, TimelineStart, unsettledSince } from './send-attempts';

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
    'Order email activity and evidence report',
    'Provider delivery, deferral and unsubscribe events',
];

/** SQLite family (tests, local dev): Date parameters are bound as UTC strings there. */
const SQLITE_TYPES = new Set(['sqlite', 'sqljs', 'better-sqlite3', 'capacitor', 'cordova', 'expo', 'nativescript', 'react-native']);

const DAY_MS = 86_400_000;

/** One aggregate row over `email_log` for a time window. */
export interface LogAggregate {
    /** Emails the mail server accepted (send-attempts.ts): refused, suppressed and in-flight attempts are not counted. */
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

/** One row of the By template table (`GET /email-track/log/stats/by-template`, `huloEmailStatsByTemplate`). */
export interface TemplateStats {
    type: string | null;
    /** Accepted by the mail server: the open and click rates are over these. */
    sent: number;
    opened: number;
    clicked: number;
    bounced: number;
    /** Failed for good, as the Email Log's Failed card counts them. */
    failed: number;
    suppressed: number;
    totalOpens: number;
    totalClicks: number;
    openRate: number;
    clickRate: number;
    ctor: number;
}

/** Refused attempts read per By template table (newest first); older ones are left out of `failed`. */
const TEMPLATE_REFUSED_CAP = 5000;

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
    /** At least one provider webhook (0.16.0) is configured — bounces arrive that way too. */
    providerWebhooksConfigured?: boolean;
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
            key: 'bounceWebhook', label: 'Bounce webhook secret configured', done: f.bounceSecretConfigured || !!f.providerWebhooksConfigured,
            hint: f.bounceSecretConfigured
                ? 'Signed bounce and complaint webhooks are accepted at /email-track/bounce.'
                : f.providerWebhooksConfigured
                    ? 'Provider delivery webhooks are configured at /email-track/webhook/:provider — bounces and complaints reach the suppression list that way.'
                    : 'Set `bounceWebhookSecret` and point your mail provider\'s bounce webhook at /email-track/bounce, or configure `providerWebhooks` (Postmark, SendGrid, Mailgun, Amazon SES) — hard bounces and complaints then land on the suppression list automatically.',
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

/** The shortest `email_event` retention: provider webhooks accept a replay for up to 72 hours (SendGrid),
 *  and a replay is a no-op only while its dedupe row exists. */
export const EVENT_RETENTION_MIN_DAYS = 3;

/**
 * Delete matching rows `RETENTION_BATCH` at a time, oldest id first, until
 * no full batch is left. Each round selects the next batch's ids and deletes
 * the matching rows up to the last of them, so the count comes from the rows
 * selected — never from the driver's affected-rows figure, which TypeORM
 * reports as 2 for every DELETE on PostgreSQL. One unbounded `DELETE` on a
 * large `email_log` holds locks for the whole scan and stalls the sender;
 * small batches with a pause between them do not.
 */
export async function batchedDelete(
    db: Pick<DbAdapter, 'query'>,
    table: 'email_log' | 'email_link' | 'email_event',
    where: string,
    params: any[],
    pauseMs = 50,
): Promise<number> {
    let total = 0;
    for (let i = 0; i < RETENTION_MAX_BATCHES; i++) {
        const rows = await db.query(
            `SELECT id FROM ${table} WHERE ${where} ORDER BY id ASC LIMIT ${RETENTION_BATCH}`,
            params,
        );
        const ids = (Array.isArray(rows) ? rows : []).map((r: any) => Number(r?.id)).filter(n => Number.isFinite(n));
        if (!ids.length) break;
        const last = Math.max(...ids);
        await db.query(`DELETE FROM ${table} WHERE id <= ? AND (${where})`, [last, ...params], { needAffected: true });
        total += ids.length;
        if (ids.length < RETENTION_BATCH) break;
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

    /** Writes the `email_event` timeline. */
    private readonly events: EmailEventService;

    constructor(
        private connection: TransactionalConnection,
        private processContext: ProcessContext,
        // Optional: a host plugin that lists EmailTrackingService in its own `providers` (as 0.15.x
        // allowed) gets an instance in a module without EmailEventService; it then writes the same
        // table through one of its own instead of failing the host's boot.
        @Optional() events?: EmailEventService,
    ) {
        this.events = events ?? new EmailEventService(connection);
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
     *  report use. `tracked` counts the emails the mail server accepted (a
     *  refused attempt, a suppressed one, a send still in flight or one that
     *  never recorded a reply is not an email tracked), so the open rate is
     *  over emails that went out. Fails soft to zeros. */
    async aggregate(from: Date, to: Date): Promise<LogAggregate> {
        try {
            const { now, timelineFrom } = await this.clock();
            const rows = await adapterFor(this.connection.rawConnection).query(
                `SELECT SUM(CASE WHEN ${ACCEPTED_SQL} THEN 1 ELSE 0 END)                      AS tracked,
                        SUM(\`openCount\`)                                                       AS opens,
                        SUM(\`clickCount\`)                                                      AS clicks,
                        SUM(CASE WHEN status='bounced' OR status='complained' THEN 1 ELSE 0 END) AS bounced,
                        SUM(CASE WHEN \`openCount\` > 0 THEN 1 ELSE 0 END)                       AS opened
                 FROM email_log
                 WHERE \`createdAt\` >= ? AND \`createdAt\` < ?`,
                [unsettledSince(now, timelineFrom, this.dbType()), from, to],
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

    /**
     * Per-template figures for the last `days` days, optionally one channel's.
     * `sent` counts the emails the mail server accepted — never a refused
     * attempt (a failed try that was retried included), a send still in
     * flight or one that never recorded a reply — and the open and click
     * rates are over them. `failed` counts the emails that failed for good,
     * exactly as the Email Log's Failed card: a refused attempt that was
     * retried, or whose retry is due, is not one.
     */
    async statsByTemplate(days: number, scope: number | null): Promise<TemplateStats[]> {
        const db = adapterFor(this.connection.rawConnection);
        const { now, timelineFrom } = await this.clock();
        const since = this.sqlDate(new Date(now - days * DAY_MS));
        const rows: any[] = await db.query(
            `SELECT type,
                    SUM(CASE WHEN ${ACCEPTED_SQL} THEN 1 ELSE 0 END)                         AS sent,
                    SUM(CASE WHEN \`openCount\` > 0 THEN 1 ELSE 0 END)                       AS opened,
                    SUM(CASE WHEN \`clickCount\` > 0 THEN 1 ELSE 0 END)                      AS clicked,
                    SUM(CASE WHEN status='bounced' OR status='complained' THEN 1 ELSE 0 END) AS bounced,
                    SUM(CASE WHEN status='suppressed' THEN 1 ELSE 0 END)                    AS suppressed,
                    SUM(\`openCount\`)                                                       AS totalOpens,
                    SUM(\`clickCount\`)                                                      AS totalClicks
             FROM email_log
             WHERE \`createdAt\` >= ?${scope ? ' AND \`channelId\` = ?' : ''}
             GROUP BY type
             ORDER BY sent DESC`,
            [unsettledSince(now, timelineFrom, this.dbType()), since, ...(scope ? [scope] : [])],
        );
        const refused: any[] = await db.query(
            `SELECT ${ATTEMPT_COLUMNS} FROM email_log
             WHERE status IN ('failed', 'deferred') AND \`createdAt\` >= ?${scope ? ' AND \`channelId\` = ?' : ''}
             ORDER BY id DESC LIMIT ?`,
            [since, ...(scope ? [scope] : []), TEMPLATE_REFUSED_CAP],
        );
        const infos = await attemptInfosFor((sql, params) => db.query(sql, params), refused || [], { now, timelineFrom, dbType: this.dbType() });
        const failed = new Map<string, number>();
        for (const r of refused || []) {
            if (infos.get(Number(r.id))?.state === 'failed') failed.set(String(r.type), (failed.get(String(r.type)) || 0) + 1);
        }
        return (rows || []).map(r => {
            const sent = Number(r.sent) || 0;
            const opened = Number(r.opened) || 0;
            const clicked = Number(r.clicked) || 0;
            return {
                type: r.type ?? null, sent, opened, clicked,
                bounced: Number(r.bounced) || 0,
                failed: failed.get(String(r.type)) || 0,
                suppressed: Number(r.suppressed) || 0,
                totalOpens: Number(r.totalOpens) || 0,
                totalClicks: Number(r.totalClicks) || 0,
                openRate: sent > 0 ? opened / sent : 0,
                clickRate: sent > 0 ? clicked / sent : 0,
                ctor: opened > 0 ? clicked / opened : 0, // click-to-open
            };
        });
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
            providerWebhooksConfigured: !!(opts.providerWebhooks && (
                (opts.providerWebhooks.postmark?.username && opts.providerWebhooks.postmark?.password)
                || opts.providerWebhooks.sendgrid?.verificationKey
                || opts.providerWebhooks.mailgun?.signingKey
                || opts.providerWebhooks.ses?.topicArns?.length)),
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
     *  `email_link` rows past `expiresAt` or older than `days`, and
     *  `email_event` rows older than `days` (at least 3), belonging to emails
     *  `maxRows` pruned, or — under `maxRows` — unlinked (no email) and older
     *  than the oldest email kept. */
    async sweepRetention(): Promise<{ logs: number; links: number; events: number }> {
        const r = getOptions().retention;
        const db = adapterFor(this.connection.rawConnection);
        const out = { logs: 0, links: 0, events: 0 };
        if (!r) return out;
        try {
            if (r.days && r.days > 0) {
                out.logs += await batchedDelete(db, 'email_log', '`createdAt` < DATE_SUB(NOW(), INTERVAL ? DAY)', [r.days]);
                out.links += await batchedDelete(db, 'email_link', '`createdAt` < DATE_SUB(NOW(), INTERVAL ? DAY)', [r.days]);
            }
            let cutoff = 0;
            if (r.maxRows && r.maxRows > 0) {
                const rows = await db.query('SELECT COUNT(*) AS n FROM email_log');
                const over = Number(rows?.[0]?.n ?? 0) - r.maxRows;
                if (over > 0) {
                    // Oldest ids first; the cutoff id keeps every batch bounded.
                    const edge = await db.query('SELECT id FROM email_log ORDER BY id ASC LIMIT 1 OFFSET ?', [over]);
                    cutoff = Number(edge?.[0]?.id ?? 0);
                    if (cutoff > 0) out.logs += await batchedDelete(db, 'email_log', 'id < ?', [cutoff]);
                }
            }
            out.links += await batchedDelete(db, 'email_link', '`expiresAt` IS NOT NULL AND `expiresAt` < NOW()', []);
            // The event timeline: its own failure (e.g. the table is not migrated yet) never stops the rest.
            try {
                if (r.days && r.days > 0) {
                    out.events += await batchedDelete(db, 'email_event', '`createdAt` < DATE_SUB(NOW(), INTERVAL ? DAY)', [Math.max(r.days, EVENT_RETENTION_MIN_DAYS)]);
                }
                if (cutoff > 0) {
                    out.events += await batchedDelete(db, 'email_event', '`emailLogId` < ?', [cutoff]);
                    // Unlinked events (admin suppressions, unmatched provider events) go with the emails of their time.
                    const oldest = await db.query('SELECT `createdAt` FROM email_log ORDER BY id ASC LIMIT 1');
                    const keptFrom = oldest?.[0]?.createdAt;
                    if (keptFrom) out.events += await batchedDelete(db, 'email_event', '`emailLogId` IS NULL AND `createdAt` < ?', [keptFrom]);
                }
            } catch (e: any) {
                Logger.warn(`retention: email_event not pruned: ${e?.message}`, loggerCtx);
            }
            if (out.logs || out.links || out.events) Logger.info(`retention: pruned ${out.logs} email_log, ${out.links} email_link and ${out.events} email_event row(s)`, loggerCtx);
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
            const row = await repo.save(suppressed);
            await this.events.record({
                type: 'suppressed', source: 'smtp', log: this.linkOf(row), recipient,
                detail: 'Not sent: the recipient is on the suppression list',
            });
            return row;
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
        let links: LinkMeta[] = [];
        let signed: boolean | null = null;
        if (html) {
            const wrapped = wrapTrackedHtml(html, Number(saved.id));
            links = wrapped.links;
            signed = wrapped.signed;
            mail = { ...mail, html: wrapped.html };
        }
        // The configured providers echo this id back in their webhook events.
        const corr = correlationHeaders(Number(saved.id));
        if (Object.keys(corr).length) mail = { ...mail, headers: mergeHeaders(mail.headers, corr) };

        // Send.
        let info: any;
        try {
            info = await transporter.sendMail(mail);
        } catch (e: any) {
            saved.errorMessage = String(e?.message || e).slice(0, 2000);
            saved.smtpResponse = e?.response ? String(e.response).slice(0, 500) : '';
            await repo.update(saved.id, { errorMessage: saved.errorMessage, smtpResponse: saved.smtpResponse });
            saved.status = await this.settleSendStatus(Number(saved.id), 'failed');
            await this.events.record({
                type: 'failed', source: 'smtp', log: this.linkOf(saved), recipient,
                detail: [saved.smtpResponse, saved.errorMessage].filter(Boolean).join(' — ') || null,
                payload: signed === null ? null : sendPayload([], signed),
            });
            Logger.error(`Tracked send FAILED [${meta.type}] to ${saved.recipient}: ${e?.message}`, loggerCtx);
            throw e;
        }
        saved.smtpResponse = String(info?.response || '').slice(0, 500);
        // Stored without angle brackets; the bounce matcher accepts both forms.
        saved.smtpMessageId = String(info?.messageId || '').replace(/^<|>$/g, '').slice(0, 500);
        // Gmail's "250 2.0.0 OK" → sent. 4xx → deferred. 5xx → failed. A reply without a code (SES: the message id) → sent.
        const code = replyCode(info?.response) ?? 0;
        const outcome: EmailLogStatus = code >= 500 ? 'failed' : code >= 400 ? 'deferred' : 'sent';
        await repo.update(saved.id, { smtpResponse: saved.smtpResponse, smtpMessageId: saved.smtpMessageId });
        saved.status = await this.settleSendStatus(Number(saved.id), outcome);
        await this.events.record({
            type: outcome === 'failed' ? 'failed' : outcome === 'deferred' ? 'deferred' : 'sent',
            source: 'smtp', log: this.linkOf(saved), recipient,
            messageId: saved.smtpMessageId || null,
            providerMessageId: providerMessageIdFromSmtpReply(saved.smtpResponse),
            detail: saved.smtpResponse || null,
            payload: signed === null ? null : sendPayload(links, signed),
        });
        Logger.info(`Tracked send OK [${meta.type}] to ${saved.recipient} (id=${saved.id})`, loggerCtx);
        return saved;
    }

    /**
     * The status after the SMTP reply: `outcome` replaces only the optimistic
     * `sent` the row was created with (one guarded UPDATE), so a provider
     * event that arrived between the provider's reply and this write — a
     * bounce, a complaint, a delivery — is never overwritten. Returns the
     * status the row has now.
     */
    async settleSendStatus(emailLogId: number, outcome: EmailLogStatus): Promise<EmailLogStatus> {
        if (outcome !== 'sent') {
            await adapterFor(this.connection.rawConnection).query(
                "UPDATE email_log SET status = ? WHERE id = ? AND status = 'sent'",
                [outcome, emailLogId], { needAffected: true },
            );
        }
        try {
            const row = await this.connection.rawConnection.getRepository(EmailLog).findOne({ where: { id: emailLogId }, select: ['id', 'status'] as any });
            return (row?.status as EmailLogStatus) || outcome;
        } catch {
            return outcome;
        }
    }

    /** Wrap an HTML body for tracking: rewrite links + append open pixel.
     *  When a `signingSecret` is set (configured or generated) the token is
     *  `<id>.<hmac>` so nobody can forge a URL; otherwise the bare id. */
    wrapHtml(html: string, eventId: number): string {
        return wrapTrackedHtml(html, eventId).html;
    }

    /** The email_log columns an event copies. */
    private linkOf(row: Pick<EmailLog, 'id' | 'orderId' | 'customerId' | 'channelId'>) {
        return {
            id: Number(row.id),
            orderId: row.orderId ?? null,
            customerId: row.customerId ?? null,
            channelId: row.channelId ?? null,
        };
    }

    /** Date parameter for raw SQL: sqlite drivers cannot bind a Date object. */
    private sqlDate(d: Date): Date | string {
        return SQLITE_TYPES.has(String((this.connection.rawConnection.options as any)?.type || ''))
            ? d.toISOString().replace('T', ' ').replace('Z', '')
            : d;
    }

    /** The TypeORM driver type (`mysql`, `postgres`, `sqljs` …). */
    private dbType(): string {
        return String((this.connection.rawConnection.options as any)?.type || '');
    }

    private readonly timeline = new TimelineStart();

    /** What the send states are read against: the database's "now" (it writes `createdAt`) and when the event timeline began. */
    private clock(): Promise<SendClock> {
        const db = adapterFor(this.connection.rawConnection);
        return sendClock((sql, params) => db.query(sql, params), this.dbType(), this.timeline);
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
     *
     *  A bare (unsigned) id while a signing secret exists is recorded as an
     *  `unverified` event only: anyone can produce one, so it never touches
     *  the `email_log` counters, first-open fields or history (see
     *  `isEventOnlyHit`).
     */
    async recordOpen(id: number, ip: string | null, ua: string | null, how: { signed?: boolean } = {}) {
        const repo = this.connection.rawConnection.getRepository(EmailLog);
        const opts = getOptions();
        const now = new Date();
        const unsigned = how.signed === false;
        if (unsigned && await this.isForgedUnsignedHit(id)) return;
        // Geo lookup uses the raw IP — done before hashing so we can
        // resolve country/city even when the stored IP is anonymised.
        const geo = await lookupGeo(ip);
        if (unsigned && this.isEventOnlyHit()) {
            const row = await repo.findOne({ where: { id }, select: ['id', 'orderId', 'customerId', 'channelId'] as any });
            if (row) await this.events.recordEngagement({ type: 'open', source: 'pixel', occurredAt: now, log: this.linkOf(row), ip, geo, userAgent: ua, unsigned });
            return;
        }
        const ipForRow = opts.hashIpsInHistory ? hashIp(ip, opts.ipSalt || '') : ip;
        // Atomic counter: Gmail's proxy, Apple MPP and the real open arrive together.
        const r = await adapterFor(this.connection.rawConnection).query(
            `UPDATE email_log SET \`openCount\` = \`openCount\` + 1, \`lastOpenedAt\` = ?,
                    \`firstOpenedAt\` = COALESCE(\`firstOpenedAt\`, ?), \`firstOpenIp\` = COALESCE(\`firstOpenIp\`, ?), \`firstOpenUserAgent\` = COALESCE(\`firstOpenUserAgent\`, ?)
              WHERE id = ?`,
            [this.sqlDate(now), this.sqlDate(now), ipForRow || null, ua ? ua.slice(0, 1000) : null, id], { needAffected: true },
        );
        // MySQL / Postgres report the affected rows; sqlite does not (the lookup below decides).
        const affected = r?.affectedRows ?? r?.rowCount;
        if (affected !== undefined && !Number(affected)) return;
        // History is best effort (last writer wins on the JSON only).
        const row = await repo.findOne({ where: { id } });
        if (!row) return;
        // The raw event (never deduplicated; capped per email per day), classified; enrichment follows asynchronously.
        await this.events.recordEngagement({ type: 'open', source: 'pixel', occurredAt: now, log: this.linkOf(row), ip, geo, userAgent: ua, unsigned });
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

    /** Record a click. Geo + IP hashing applied the same way as opens.
     *  The recorded URL (event and `clicksJson`) has token-like query
     *  parameters redacted; the redirect itself still uses the real URL.
     *  `link` is the per-link metadata when the caller has it (EmailLink
     *  tokens); for wrapped mail it is looked up from the send event.
     *  A bare (unsigned) id while a signing secret exists is an `unverified`
     *  event only, as for opens. */
    async recordClick(id: number, url: string, ip: string | null, ua: string | null, link?: { linkIndex?: number | null; linkText?: string | null }, how: { signed?: boolean } = {}): Promise<string | null> {
        const repo = this.connection.rawConnection.getRepository(EmailLog);
        const opts = getOptions();
        const now = new Date();
        const unsigned = how.signed === false;
        if (unsigned && await this.isForgedUnsignedHit(id)) return null;
        const eventOnly = unsigned && this.isEventOnlyHit();
        let row: EmailLog | null;
        if (eventOnly) {
            row = await repo.findOne({ where: { id }, select: ['id', 'orderId', 'customerId', 'channelId'] as any });
        } else {
            const r = await adapterFor(this.connection.rawConnection).query(
                `UPDATE email_log SET \`clickCount\` = \`clickCount\` + 1, \`firstClickedAt\` = COALESCE(\`firstClickedAt\`, ?) WHERE id = ?`,
                [this.sqlDate(now), id], { needAffected: true },
            );
            const affected = r?.affectedRows ?? r?.rowCount;
            if (affected !== undefined && !Number(affected)) return null;
            row = await repo.findOne({ where: { id } });
        }
        if (!row) return null;

        const [geo, links] = await Promise.all([
            lookupGeo(ip),
            link ? Promise.resolve(null) : this.events.linksFor(id),
        ]);
        const ipForRow = opts.hashIpsInHistory ? hashIp(ip, opts.ipSalt || '') : ip;
        const found = link ? null : findLink(links, url, opts.signingSecret);
        const recorded = redactSensitiveUrl(url);
        await this.events.recordEngagement({
            type: 'click', source: 'redirect', occurredAt: now, log: this.linkOf(row), ip, geo, userAgent: ua, url: recorded,
            linkIndex: link ? (link.linkIndex ?? null) : (found ? found.i : null),
            linkText: link ? (link.linkText ?? null) : (found ? found.t : null),
            unsigned,
        });
        if (eventOnly) return url;

        let clicks: any[] = [];
        try { clicks = JSON.parse(row.clicksJson || '[]'); } catch {}
        clicks.push({
            url: recorded.slice(0, 1000),
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

    /**
     * A pixel / click on the bare (unsigned) id of an email whose own links
     * were signed: nobody received that URL from us, so it is forged and is
     * not recorded at all. Bare ids of every other email — no 0.16.0 send
     * event saying its links were signed: sent before 0.16.0 (signed or
     * not), or while no secret existed — are recorded with the
     * `unsigned-token` reason (`isEventOnlyHit` says where).
     */
    private async isForgedUnsignedHit(id: number): Promise<boolean> {
        if (!getOptions().signingSecret) return false;
        return (await this.events.sendInfo(id))?.signed === true;
    }

    /**
     * True while a signing secret exists (configured or generated): a bare
     * id is then recorded as an `unverified` event only — never counted in
     * `email_log` (openCount / clickCount, firstOpenedAt / firstClickedAt,
     * the JSON history), so enumerating ids cannot move the figures the
     * Email Log, the order summary and the evidence report show. Without any
     * secret every link is a bare id and is counted as in 0.15.4 (still
     * flagged `unverified` on its event).
     */
    private isEventOnlyHit(): boolean {
        return !!getOptions().signingSecret;
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
        // Status precedence (event-types.ts): a soft bounce never overwrites a
        // delivered/bounced/complained email, a bounce never a complaint.
        await this.events.applyStatus(Number(row.id), opts.soft ? 'deferred' : status, reason || null);
        const type = opts.soft ? 'soft-bounce' : status === 'complained' ? 'complained' : 'bounced';
        await this.events.record({
            type, source: 'bounce-webhook', log: this.linkOf(row), recipient: row.recipient, messageId: bare,
            // A retried webhook carries the same facts: one row.
            dedupeKey: dedupeKeyFor('bounce-webhook', `${bare}|${type}|${reason || ''}`),
            detail: reason || null,
        });
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

    /** A manual suppression on the event timeline (source `admin`). Best-effort. */
    async recordAdminSuppression(recipient: string, reason: string, userId: string | null, channelId: number | null): Promise<void> {
        await this.events.record({
            type: 'suppressed', source: 'admin', recipient, channelId,
            detail: `Added to the suppression list by an administrator (reason: ${String(reason).slice(0, 32)})`,
            payload: userId ? { by: `user #${userId}` } : null,
        });
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
