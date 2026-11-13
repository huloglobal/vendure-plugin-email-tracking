import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { Logger, TransactionalConnection } from '@vendure/core';
import { adapterFor } from '@huloglobal/vendure-licence-sdk';
import { createHmac } from 'crypto';
import { In, IsNull, Not } from 'typeorm';
import { EmailEvent } from './email-event.entity';
import { EmailLog, EmailLogStatus } from './email-log.entity';
import {
    EmailEventSource, EmailEventType, FREE_PROVIDER_TYPES, precedenceChange, StatusChange, statusChangeForEvent, UNVERIFIED,
} from './event-types';
import { GeoLookup } from './geo-lookup';
import { ClampedEnrichment, IpEnricher, ipApiFreeTierWarning } from './ip-enrichment';
import { canonicalIp, isPrivateOrReservedIp } from './ip-utils';
import { eventHashKey, getOptions } from './options';
import { parseEmailClient } from './parse-ua';
import { bareMessageId, dedupeKeyFor, ProviderEvent, SuppressionReason } from './webhook-mappers';
import { correlationIdFrom } from './outgoing-mail';
import { classifyEngagement } from './engagement-class';
import { findLink, LinkMeta, redactSensitiveUrl } from './link-meta';

const loggerCtx = 'EmailEventService';

/** The email_log columns an event copies its links from. */
export interface LogLink {
    id: number;
    orderId?: number | null;
    customerId?: number | null;
    channelId?: number | null;
    recipient?: string | null;
    status?: string | null;
}

export interface RecordEventInput {
    type: EmailEventType;
    source: EmailEventSource;
    occurredAt?: Date;
    log?: LogLink | null;
    /** Channel for an event with no email_log row (e.g. an admin suppression). */
    channelId?: number | null;
    messageId?: string | null;
    providerMessageId?: string | null;
    dedupeKey?: string | null;
    /** Hashed into `recipientHash`; never stored in clear. */
    recipient?: string | null;
    /** The raw IP: stored raw or hashed per `hashIpsInHistory`, kept in memory for enrichment. */
    ip?: string | null;
    geo?: GeoLookup | null;
    userAgent?: string | null;
    url?: string | null;
    linkIndex?: number | null;
    linkText?: string | null;
    detail?: string | null;
    payload?: Record<string, unknown> | null;
    /** An open / click that came through a bare (unsigned) id: classification `unverified`,
     *  reason `unsigned-token`, never enriched. */
    unsigned?: boolean;
    /** The one row that marks a day on which this email's opens (or clicks) stopped being stored one by one. */
    capMarker?: boolean;
}

/** Reason code on an open / click that came through a link without a signature (anyone can produce one). */
export const UNSIGNED_REASON = 'unsigned-token';
/** Reason code on the marker row of a day on which an email reached its engagement cap. */
export const CAPPED_REASON = 'events-capped';

/**
 * Open (or click) rows stored per email per UTC day through the plugin's own
 * pixel and redirector. Beyond it the day gets one marker row (reason
 * `events-capped`) and nothing more is stored; signed hits still increment
 * the `email_log` counters. One tracked URL — or a bare id enumerated by
 * anyone — therefore cannot grow the table without bound.
 */
export const ENGAGEMENT_EVENTS_PER_DAY = 100;
/** The same for hits through bare (unsigned) ids, which anyone can produce. */
export const UNSIGNED_EVENTS_PER_DAY = 10;

/** An email address, optionally in angle brackets (local part without quotes or apostrophes). */
const ADDRESS_RE = /<?[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+>?/g;

/** Every email address in SMTP / provider text replaced by `<address>` (MTAs often quote the recipient). */
export function scrubAddresses(text: string): string {
    return String(text).replace(ADDRESS_RE, '<address>');
}

/** Payload keys that hold message ids (`<id@host>`), which look like addresses but are not personal data. */
const MESSAGE_ID_KEYS = /^(smtp-id|message-?id|sg_message_id|sesmessageid|snsmessageid)$/i;

/** A payload with `scrubAddresses` applied to every string value (message-id keys excepted), at any depth. */
export function scrubPayload(value: unknown, key = '', depth = 0): unknown {
    if (typeof value === 'string') return MESSAGE_ID_KEYS.test(key) ? value : scrubAddresses(value);
    if (depth > 4 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(v => scrubPayload(v, key, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubPayload(v, k, depth + 1);
    return out;
}

/** Midnight UTC of the day `d` falls on. */
export function utcDayStart(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export interface RecordResult {
    id: number | null;
    duplicate: boolean;
    /** The row could not be written (e.g. the table is missing before the migration). */
    failed: boolean;
}

export type IngestResult = 'recorded' | 'duplicate' | 'skipped';

const SQLITE_TYPES = new Set(['sqlite', 'sqljs', 'better-sqlite3', 'capacitor', 'cordova', 'expo', 'nativescript', 'react-native']);

const cut = (v: unknown, n: number): string | null => {
    if (v === null || v === undefined) return null;
    const s = String(v);
    return s ? s.slice(0, n) : null;
};

/** Keyed HMAC of the lower-cased address — groups events without storing it (key: `eventHashKey()`). */
export function recipientHash(recipient: string, key: string): string {
    const addr = String(recipient).trim().toLowerCase().replace(/^.*<([^<>]+)>.*$/, '$1');
    return createHmac('sha256', key || 'hulo-email-tracking').update(`recipient|${addr}`).digest('hex');
}

/** Keyed HMAC (32 hex) of the canonical IP — the `email_event` `ipHash` (and `ip` under `hashIpsInHistory`). */
export function eventIpHash(ip: string, key: string): string {
    return createHmac('sha256', key || 'hulo-email-tracking').update(`ip|${canonicalIp(ip) ?? String(ip).slice(0, 64)}`).digest('hex').slice(0, 32);
}

/**
 * The location to store after enrichment, merged as a unit so a place no
 * source reported is never shown: a GeoLite2 city-level result is kept
 * whole; with only a GeoLite2 country, the provider's region / city /
 * timezone are taken only when the provider names the same country;
 * without any GeoLite2 location, the provider's location is taken whole.
 * Returns only the columns to change.
 */
export function mergeLocation(
    geo: Partial<GeoLookup> | null | undefined,
    r: Pick<ClampedEnrichment, 'country' | 'region' | 'city' | 'timezone'>,
): Partial<Record<'country' | 'region' | 'city' | 'timezone', string>> {
    const g = { country: geo?.country || null, region: geo?.region || null, city: geo?.city || null, timezone: geo?.timezone || null };
    const out: Partial<Record<'country' | 'region' | 'city' | 'timezone', string>> = {};
    if (!g.country && !g.region && !g.city && !g.timezone) {
        for (const k of ['country', 'region', 'city', 'timezone'] as const) if (r[k]) out[k] = r[k] as string;
        return out;
    }
    const sameCountry = !!g.country && !!r.country && g.country.toUpperCase() === r.country.toUpperCase();
    if (!sameCountry) return out;
    if (g.city) {
        if (!g.timezone && r.timezone) out.timezone = r.timezone;
        return out;
    }
    if (r.city) {
        // A city-level answer for the same country: its region, city and timezone belong together.
        out.city = r.city;
        if (r.region) out.region = r.region;
        if (r.timezone) out.timezone = r.timezone;
        return out;
    }
    if (!g.region && r.region) out.region = r.region;
    if (!g.timezone && r.timezone) out.timezone = r.timezone;
    return out;
}

/**
 * A click URL a provider reported, as it may be stored: one of the plugin's
 * own tracked links (`…/email-track/click/<token>?u=…&s=…`) is unwrapped to
 * its destination, then every URL is redacted (`redactSensitiveUrl`), so a
 * reset or magic-link token never reaches the database. `destination` is
 * the unredacted target, for the link lookup only (never stored).
 */
export function providerClickUrl(raw: string | null | undefined): { url: string | null; destination: string | null } {
    if (!raw) return { url: null, destination: null };
    let u: URL;
    try { u = new URL(String(raw)); } catch { return { url: null, destination: null }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { url: null, destination: null };
    if (/\/email-track\/click\/[^/]+\/?$/.test(u.pathname)) {
        const dest = u.searchParams.get('u');
        let target: URL | null = null;
        try { target = dest ? new URL(dest) : null; } catch { target = null; }
        if (target && dest && (target.protocol === 'http:' || target.protocol === 'https:')) return { url: redactSensitiveUrl(dest).slice(0, 2000), destination: dest };
        return { url: `${u.protocol}//${u.host}/email-track/click/[redacted]`, destination: null };
    }
    return { url: redactSensitiveUrl(String(raw)).slice(0, 2000), destination: String(raw) };
}

/** Columns of the INSERT IGNORE below, in placeholder order. */
export const EVENT_INSERT_COLUMNS = [
    'emailLogId', 'orderId', 'customerId', 'channelId', 'type', 'source', 'occurredAt', 'messageId', 'providerMessageId',
    'dedupeKey', 'recipientHash', 'ip', 'ipHash', 'country', 'region', 'city', 'timezone', 'userAgent', 'client', 'platform',
    'isBot', 'classification', 'classificationReasons', 'url', 'linkIndex', 'linkText', 'detail', 'payload',
] as const;

/**
 * Writes the `email_event` timeline. Every method is best-effort: a
 * missing table (before the 0.16.0 migration), a constraint or a driver
 * error is logged and swallowed, so a send, a pixel or a redirect never
 * fails because of an event row.
 */
@Injectable()
export class EmailEventService implements OnApplicationBootstrap {
    private enricher: IpEnricher | null | undefined;
    private warnedMissing = false;

    constructor(private connection: TransactionalConnection) {}

    onApplicationBootstrap(): void {
        const o = getOptions().ipEnrichment;
        if (o && o.provider === 'ip-api' && !o.key) Logger.warn(ipApiFreeTierWarning(), loggerCtx);
        if (o) Logger.info(`IP enrichment on: ${this.getEnricher()?.providerName} (opt-in; the IP address is the only data sent)`, loggerCtx);
    }

    private isSqlite(): boolean {
        return SQLITE_TYPES.has(String((this.connection.rawConnection.options as any)?.type || ''));
    }

    /** The configured enricher, or null when `ipEnrichment` is unset (no third-party calls). */
    getEnricher(): IpEnricher | null {
        if (this.enricher === undefined) {
            const o = getOptions().ipEnrichment;
            this.enricher = o ? new IpEnricher(o) : null;
        }
        return this.enricher;
    }

    /** Test hook: replace (or clear) the enricher. */
    setEnricher(e: IpEnricher | null): void { this.enricher = e; }

    /** Build the row (clamped to the columns) for an event. */
    buildRow(input: RecordEventInput): Record<(typeof EVENT_INSERT_COLUMNS)[number], any> {
        const opts = getOptions();
        const key = eventHashKey();
        // The validated, canonical address (no zone, no brackets) when it is one.
        const ip = input.ip ? (canonicalIp(input.ip) ?? String(input.ip).slice(0, 64)) : null;
        const engagement = (input.type === 'open' || input.type === 'click') && !input.capMarker;
        const ua = input.userAgent ? String(input.userAgent).slice(0, 1000) : null;
        const parsed = engagement || ua ? parseEmailClient(ua) : null;
        let classification: string | null = null;
        let reasons: string[] = [];
        if (engagement) {
            const cls = classifyEngagement(input.type as 'open' | 'click', ua, ip);
            // A bare id proves nothing about who fetched it: never human or machine, the UA reasons kept as chips.
            classification = input.unsigned ? UNVERIFIED : cls.classification;
            reasons = input.unsigned ? [UNSIGNED_REASON, ...cls.reasons.filter(r => r !== UNSIGNED_REASON)] : cls.reasons;
        } else if (input.capMarker) {
            reasons = input.unsigned ? [CAPPED_REASON, UNSIGNED_REASON] : [CAPPED_REASON];
        }
        let payload: string | null = null;
        if (input.payload && Object.keys(input.payload).length) {
            const scrubbed = scrubPayload(input.payload) as Record<string, unknown>;
            payload = JSON.stringify(scrubbed);
            if (payload.length > 16_000) {
                const p: any = { ...scrubbed };
                if (Array.isArray(p.links)) p.links = p.links.slice(0, 40);
                payload = JSON.stringify(p).slice(0, 16_000);
            }
        }
        return {
            emailLogId: input.log?.id ?? null,
            orderId: input.log?.orderId ?? null,
            customerId: input.log?.customerId ?? null,
            channelId: input.log?.channelId ?? input.channelId ?? null,
            type: input.type,
            source: input.source,
            occurredAt: input.occurredAt || new Date(),
            messageId: cut(bareMessageId(input.messageId), 255),
            providerMessageId: cut(input.providerMessageId, 255),
            dedupeKey: cut(input.dedupeKey, 64),
            recipientHash: input.recipient ? recipientHash(input.recipient, key) : null,
            ip: ip ? (opts.hashIpsInHistory ? eventIpHash(ip, key) : ip) : null,
            ipHash: ip ? eventIpHash(ip, key) : null,
            country: cut(input.geo?.country, 8),
            region: cut(input.geo?.region, 64),
            city: cut(input.geo?.city, 128),
            timezone: cut(input.geo?.timezone, 64),
            userAgent: ua,
            client: parsed ? cut(parsed.client, 64) : null,
            platform: parsed ? cut(parsed.platform, 32) : null,
            isBot: parsed ? parsed.isBot : null,
            classification,
            classificationReasons: reasons.length ? cut(reasons.join(','), 255) : null,
            url: cut(input.url, 2000),
            linkIndex: Number.isInteger(input.linkIndex) ? input.linkIndex : null,
            linkText: cut(input.linkText, 120),
            // The recipient (and any other address an MTA quotes) never reaches this table in clear.
            detail: input.detail ? cut(scrubAddresses(String(input.detail).trim()), 2000) : null,
            payload,
        };
    }

    /** Insert one event (INSERT IGNORE on `dedupeKey`). Never throws. */
    async record(input: RecordEventInput): Promise<RecordResult> {
        let row: Record<string, any>;
        try {
            row = this.buildRow(input);
        } catch (e: any) {
            Logger.warn(`email event not recorded (${input.type}): ${e?.message}`, loggerCtx);
            return { id: null, duplicate: false, failed: true };
        }
        try {
            const result = this.isSqlite() ? await this.insertViaRepository(row) : await this.insertIgnore(row);
            // Never for an unsigned-link hit: anyone can produce those, and they would spend the lookup budget.
            if (result.id && input.ip && !input.unsigned && (input.type === 'open' || input.type === 'click')) {
                this.scheduleEnrichment(result.id, input.ip, row.userAgent, input.type, input.geo || null);
            }
            return result;
        } catch (e: any) {
            this.logWriteFailure(input.type, e);
            return { id: null, duplicate: false, failed: true };
        }
    }

    /** `<emailLogId>|<type>|s or u|<UTC day>` of the days whose cap this process has seen reached. */
    private readonly cappedDays = new Map<string, true>();
    /** Per cap key, the last recording in flight: count-then-insert runs one at a time per key, so a burst cannot pass the count together. */
    private readonly capQueues = new Map<string, Promise<unknown>>();

    /**
     * An open or click from the plugin's own pixel / redirector, within the
     * per-email daily cap (`ENGAGEMENT_EVENTS_PER_DAY`; `UNSIGNED_EVENTS_PER_DAY`
     * for bare ids): written as `record()` writes it until the email has that
     * many rows of the type for the UTC day; then one marker row for the day
     * (unique dedupe key, so one across processes) and nothing more. The
     * recordings of one email, type and day run one after another in this
     * process (pixel and redirect hits are fire-and-forget, so a burst would
     * otherwise pass the count together); with several server processes a
     * few more rows can land at the boundary, and the marker states the
     * count it saw. `capped` is true when the hit was not stored as its own
     * row. Never throws.
     */
    async recordEngagement(input: RecordEventInput & { type: 'open' | 'click' }): Promise<RecordResult & { capped: boolean }> {
        const emailLogId = input.log?.id;
        const at = input.occurredAt || new Date();
        if (!emailLogId) return { ...(await this.record({ ...input, occurredAt: at })), capped: false };
        const unsigned = !!input.unsigned;
        const day = at.toISOString().slice(0, 10);
        const key = `${emailLogId}|${input.type}|${unsigned ? 'u' : 's'}|${day}`;
        if (this.cappedDays.has(key)) return { id: null, duplicate: false, failed: false, capped: true };
        const run = (this.capQueues.get(key) || Promise.resolve()).then(() => this.recordWithinCap(input, emailLogId, at, day, key, unsigned));
        const settled = run.catch(() => undefined);
        this.capQueues.set(key, settled);
        void settled.then(() => { if (this.capQueues.get(key) === settled) this.capQueues.delete(key); });
        return run;
    }

    /** One step of `recordEngagement`, run in its key's queue. */
    private async recordWithinCap(input: RecordEventInput & { type: 'open' | 'click' }, emailLogId: number, at: Date, day: string, key: string,
        unsigned: boolean): Promise<RecordResult & { capped: boolean }> {
        if (this.cappedDays.has(key)) return { id: null, duplicate: false, failed: false, capped: true };
        const limit = unsigned ? UNSIGNED_EVENTS_PER_DAY : ENGAGEMENT_EVENTS_PER_DAY;
        const n = await this.countEngagement(emailLogId, input.type, unsigned, utcDayStart(at));
        if (n === null || n < limit) return { ...(await this.record({ ...input, occurredAt: at })), capped: false };
        this.rememberCapped(key);
        const what = input.type === 'open' ? 'opens' : 'clicks';
        await this.record({
            type: input.type, source: input.source, occurredAt: at, log: input.log, capMarker: true, unsigned,
            dedupeKey: dedupeKeyFor('engagement-cap', key),
            detail: unsigned
                ? `${n} ${what} through unsigned links were stored for this email on ${day} (UTC); further ones that day are not recorded.`
                : `${n} ${what} were stored for this email on ${day} (UTC); further ${what} that day are counted in the email log but not stored one by one.`,
        });
        return { id: null, duplicate: false, failed: false, capped: true };
    }

    /** This email's rows of `type` since `from`, bare-id ones (`unverified`) or the others; null when unknown. */
    private async countEngagement(emailLogId: number, type: 'open' | 'click', unsigned: boolean, from: Date): Promise<number | null> {
        try {
            const db = adapterFor(this.connection.rawConnection);
            // sqlite drivers cannot bind a Date: the UTC string TypeORM stores there.
            const since = this.isSqlite() ? from.toISOString().replace('T', ' ').replace('Z', '') : from;
            const rows = unsigned
                ? await db.query("SELECT COUNT(*) AS n FROM email_event WHERE `emailLogId` = ? AND type = ? AND `occurredAt` >= ? AND classification = 'unverified'", [emailLogId, type, since])
                : await db.query("SELECT COUNT(*) AS n FROM email_event WHERE `emailLogId` = ? AND type = ? AND `occurredAt` >= ? AND COALESCE(classification, '') <> 'unverified'", [emailLogId, type, since]);
            const v = Number(Array.isArray(rows) ? rows[0]?.n : NaN);
            return Number.isFinite(v) ? v : null;
        } catch {
            return null; // e.g. the table is not migrated yet: record() reports that once
        }
    }

    private rememberCapped(key: string): void {
        if (this.cappedDays.size >= 5000) {
            const oldest = this.cappedDays.keys().next().value;
            if (oldest !== undefined) this.cappedDays.delete(oldest);
        }
        this.cappedDays.set(key, true);
    }

    private logWriteFailure(type: string, e: any) {
        const msg = String(e?.message || e);
        if (/email_event/.test(msg) && /(doesn't exist|does not exist|no such table|not exist)/i.test(msg)) {
            if (!this.warnedMissing) {
                this.warnedMissing = true;
                Logger.warn('email_event table is missing — run the 0.16.0 migration (README → Upgrading to 0.16.0). Events are not recorded until then; everything else works as before.', loggerCtx);
            }
            return;
        }
        Logger.warn(`email event not recorded (${type}): ${msg}`, loggerCtx);
    }

    /** MySQL / MariaDB / Postgres: one statement through the dialect adapter. */
    private async insertIgnore(row: Record<string, any>): Promise<RecordResult> {
        const values = EVENT_INSERT_COLUMNS.map(c => row[c] ?? null);
        const res = await adapterFor(this.connection.rawConnection).query(
            `INSERT IGNORE INTO email_event (\`createdAt\`, \`updatedAt\`, \`emailLogId\`, \`orderId\`, \`customerId\`, \`channelId\`, type, source, \`occurredAt\`, \`messageId\`, \`providerMessageId\`, \`dedupeKey\`, \`recipientHash\`, ip, \`ipHash\`, country, region, city, timezone, \`userAgent\`, client, platform, \`isBot\`, classification, \`classificationReasons\`, url, \`linkIndex\`, \`linkText\`, detail, payload)
             VALUES (NOW(), NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            values,
            { needInsertId: true },
        );
        const affected = Number(res?.affectedRows ?? 0);
        if (!affected) return { id: null, duplicate: true, failed: false };
        const id = Number(res?.insertId ?? 0);
        return { id: id > 0 ? id : null, duplicate: false, failed: false };
    }

    /** sqlite / sql.js (tests, local dev): the repository handles dates and ids. */
    private async insertViaRepository(row: Record<string, any>): Promise<RecordResult> {
        const repo = this.connection.rawConnection.getRepository(EmailEvent);
        if (row.dedupeKey) {
            const dup = await repo.findOne({ where: { dedupeKey: row.dedupeKey }, select: ['id'] as any });
            if (dup) return { id: null, duplicate: true, failed: false };
        }
        try {
            const res = await repo.insert(row as any);
            const id = Number(res.identifiers?.[0]?.id ?? 0);
            return { id: id > 0 ? id : null, duplicate: false, failed: false };
        } catch (e: any) {
            if (row.dedupeKey && /UNIQUE|constraint/i.test(String(e?.message))) return { id: null, duplicate: true, failed: false };
            throw e;
        }
    }

    // ── IP enrichment ──────────────────────────────────────────────────

    /** Fire-and-forget: look the IP up (cache first) and write the result + a re-classification. */
    scheduleEnrichment(eventId: number, rawIp: string, userAgent: string | null, type: 'open' | 'click', geo: GeoLookup | null): void {
        const enricher = this.getEnricher();
        const ip = canonicalIp(rawIp);
        if (!enricher || !ip || isPrivateOrReservedIp(ip)) return;
        const cached = enricher.peek(ip);
        const p = cached !== undefined ? Promise.resolve(cached) : enricher.lookup(ip);
        p.then(r => (r ? this.applyEnrichment(eventId, r, userAgent, type, geo, ip) : undefined))
            .catch((e: any) => Logger.verbose(`enrichment write skipped (event ${eventId}): ${e?.message}`, loggerCtx));
    }

    /** Store the enrichment on the row and re-classify with the IP flags. */
    async applyEnrichment(eventId: number, r: ClampedEnrichment, userAgent: string | null, type: 'open' | 'click', geo: GeoLookup | null, ip: string | null = null): Promise<void> {
        const cls = classifyEngagement(type, userAgent, ip, {
            ipIsProxy: r.isProxy, ipIsVpn: r.isVpn, ipIsTor: r.isTor, ipIsDatacentre: r.isHosting, ipOrg: r.org,
        });
        const patch: Partial<EmailEvent> = {
            asn: r.asn, org: r.org, isProxy: r.isProxy, isVpn: r.isVpn, isTor: r.isTor, isHosting: r.isHosting, isMobile: r.isMobile,
            enrichedBy: r.enrichedBy, enrichedAt: new Date(),
            classification: cls.classification,
            classificationReasons: cls.reasons.length ? cls.reasons.join(',').slice(0, 255) : null,
        };
        // The location as a unit: GeoLite2 wins, the provider never adds a place from another country.
        Object.assign(patch, mergeLocation(geo, r));
        await this.connection.rawConnection.getRepository(EmailEvent).update(eventId, patch);
    }

    // ── email_log status precedence ────────────────────────────────────

    /**
     * Apply a status change atomically, in one statement: `incoming` replaces
     * the current status only when the current one is in its `from` set —
     * for a plain status, every status that ranks lower (STATUS_RANK), so the
     * result always equals `nextStatus()`. `reason` (bounces) fills
     * `errorMessage` when the status changes.
     */
    async applyStatus(emailLogId: number, incoming: EmailLogStatus | StatusChange, reason?: string | null): Promise<void> {
        const change = typeof incoming === 'string' ? precedenceChange(incoming) : incoming;
        if (!change.from.length) return;
        const marks = change.from.map(() => '?').join(', ');
        await adapterFor(this.connection.rawConnection).query(
            `UPDATE email_log SET status = ?, \`errorMessage\` = COALESCE(?, \`errorMessage\`) WHERE id = ? AND status IN (${marks})`,
            [change.to, reason ? String(reason).slice(0, 2000) : null, emailLogId, ...change.from],
            { needAffected: true },
        );
    }

    /** Remove a provider event row again (its effects failed, so the provider's retry must not look like a duplicate). */
    async forgetEvent(dedupeKey: string): Promise<void> {
        await adapterFor(this.connection.rawConnection).query('DELETE FROM email_event WHERE `dedupeKey` = ?', [dedupeKey]);
    }

    // ── Correlation ────────────────────────────────────────────────────

    /**
     * The email a provider event belongs to, in order of preference: the
     * correlation id we put on the outgoing mail, the Message-ID (with or
     * without brackets), the provider message id parsed from the SMTP reply.
     */
    async findLogFor(ev: Pick<ProviderEvent, 'correlation' | 'messageId' | 'providerMessageId'>): Promise<LogLink | null> {
        const repo = this.connection.rawConnection.getRepository(EmailLog);
        const select = ['id', 'orderId', 'customerId', 'channelId', 'recipient', 'status'] as any;
        // Only a value this install signed counts: a shared provider account may report other shops' mail.
        const correlationId = correlationIdFrom(ev.correlation);
        if (correlationId) {
            const r = await repo.findOne({ where: { id: correlationId }, select });
            if (r) return r as LogLink;
        }
        if (ev.messageId) {
            const bare = ev.messageId.replace(/^<|>$/g, '');
            const r = await repo.findOne({ where: { smtpMessageId: In([bare, `<${bare}>`]) }, select, order: { id: 'DESC' } as any });
            if (r) return r as LogLink;
        }
        if (ev.providerMessageId) {
            const ids = Array.from(new Set([ev.providerMessageId, ev.providerMessageId.split('.')[0]].filter(Boolean)));
            try {
                const sent = await this.connection.rawConnection.getRepository(EmailEvent).findOne({
                    where: { providerMessageId: In(ids), emailLogId: Not(IsNull()) },
                    select: ['id', 'emailLogId'] as any,
                    order: { id: 'DESC' } as any,
                });
                if (sent?.emailLogId) {
                    const r = await repo.findOne({ where: { id: Number(sent.emailLogId) }, select });
                    if (r) return r as LogLink;
                }
            } catch { /* email_event not migrated yet */ }
        }
        return null;
    }

    /**
     * What the email's send-outcome event recorded: whether its pixel and
     * click tokens were signed (null when the event predates the flag) and
     * the link list. Null when the email has no send event (sent before
     * 0.16.0, or the table was missing).
     */
    async sendInfo(emailLogId: number): Promise<{ signed: boolean | null; links: LinkMeta[] | null } | null> {
        try {
            const row = await this.connection.rawConnection.getRepository(EmailEvent).findOne({
                where: { emailLogId, source: 'smtp', type: In(['sent', 'deferred', 'failed']) },
                select: ['id', 'payload'] as any,
                order: { id: 'ASC' } as any,
            });
            if (!row) return null;
            let p: any = null;
            try { p = row.payload ? JSON.parse(row.payload) : null; } catch { p = null; }
            return { signed: typeof p?.signed === 'boolean' ? p.signed : null, links: Array.isArray(p?.links) ? p.links : null };
        } catch {
            return null;
        }
    }

    /** Link metadata stored on the email's send-outcome event. */
    async linksFor(emailLogId: number): Promise<LinkMeta[] | null> {
        return (await this.sendInfo(emailLogId))?.links ?? null;
    }

    // ── Provider events ────────────────────────────────────────────────

    /**
     * One verified provider event: gate, correlate, record (idempotent on
     * the dedupe key), then the effects — the status change and, for a hard
     * bounce / complaint / bad-address drop, the suppression list (even when
     * no email matched: a verified provider says the address is bad).
     * Effects run only for a newly recorded event, so a provider retry or a
     * replay is a no-op. If an effect fails, the event row is removed again
     * and the error propagates (the caller answers 500), so the provider's
     * retry is processed in full. A click URL is stored unwrapped (when it
     * is one of our tracked links) and redacted.
     */
    async ingest(
        ev: ProviderEvent,
        deps: {
            premium: boolean;
            recordEngagement: boolean;
            suppress: (recipient: string, reason: SuppressionReason, note: string, channelId?: number) => Promise<unknown>;
        },
    ): Promise<IngestResult> {
        const engagement = ev.type === 'open' || ev.type === 'click';
        if (engagement && (!deps.recordEngagement || !deps.premium)) return 'skipped';
        if (!engagement && !FREE_PROVIDER_TYPES.includes(ev.type) && !deps.premium) return 'skipped';
        const log = await this.findLogFor(ev).catch(() => null);
        let url: string | null = null;
        let link: LinkMeta | null = null;
        if (ev.url) {
            const c = providerClickUrl(ev.url);
            url = c.url;
            if (log && c.destination && ev.type === 'click') link = findLink(await this.linksFor(log.id), c.destination, getOptions().signingSecret);
        }
        const dedupeKey = dedupeKeyFor(ev.provider, ev.eventKey);
        const rec = await this.record({
            type: ev.type, source: ev.provider, occurredAt: ev.occurredAt, log,
            messageId: ev.messageId, providerMessageId: ev.providerMessageId,
            dedupeKey,
            recipient: ev.recipient, ip: engagement ? ev.ip : null, userAgent: ev.userAgent,
            url, linkIndex: link ? link.i : null, linkText: link ? link.t : null, detail: ev.detail, payload: ev.payload,
        });
        if (rec.duplicate) return 'duplicate';
        try {
            const change = statusChangeForEvent(ev.type, ev.suppress);
            if (log && change) {
                const bounceLike = ev.type !== 'delivered';
                await this.applyStatus(log.id, change, bounceLike ? ev.detail : null);
            }
            if (ev.suppress && ev.recipient) {
                const what = ev.suppress === 'complaint' ? 'complaint' : ev.type === 'dropped' ? 'dropped (bad address)' : 'hard bounce';
                const note = `Auto-added from ${ev.provider} ${what}${log ? ` on email #${log.id}` : ''}${ev.detail ? `: ${ev.detail}` : ''}`;
                await deps.suppress(ev.recipient, ev.suppress, note.slice(0, 2000), log?.channelId ?? undefined);
            }
        } catch (e) {
            if (!rec.failed) await this.forgetEvent(dedupeKey).catch(() => undefined);
            throw e;
        }
        return 'recorded';
    }
}
