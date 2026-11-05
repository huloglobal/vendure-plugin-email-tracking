import { createHash } from 'crypto';
import { classifyEmailEvent } from '@huloglobal/vendure-licence-sdk';
import { EVENT_LABELS, EmailEventType } from './event-types';
import { redactSensitiveUrl } from './link-meta';

/**
 * The order activity timeline: pure builders that turn `email_event` rows,
 * legacy `email_log` rows (emails sent before 0.16.0) and Vendure's order
 * history into one chronologically sortable list, plus the filter, cursor
 * and canonical-hash helpers. No database access here.
 */

export type TimelineFilter = 'all' | 'emails' | 'opens' | 'clicks' | 'delivery' | 'order' | 'notes';
export const TIMELINE_FILTERS: readonly TimelineFilter[] = ['all', 'emails', 'opens', 'clicks', 'delivery', 'order', 'notes'];

export type TimelineKind = 'event' | 'legacy' | 'history';

export interface TimelineLocation { country: string | null; region: string | null; city: string | null; timezone: string | null; }
export interface TimelineNetwork {
    asn: string | null; org: string | null;
    isProxy: boolean | null; isVpn: boolean | null; isTor: boolean | null; isHosting: boolean | null; isMobile: boolean | null;
    enrichedBy: string | null;
}

export interface TimelineItem {
    /** Stable id: `e<eventId>`, `l<emailLogId>-…` (legacy), `h<historyId>`. */
    id: string;
    /** ISO 8601, UTC. */
    at: string;
    kind: TimelineKind;
    /** Event type (`sent`, `open`, …) or the Vendure HistoryEntryType. */
    type: string;
    /** Event source, `email_log` for legacy rows, `vendure` for order history. */
    source: string;
    label: string;
    detail: string | null;
    emailLogId: number | null;
    emailType: string | null;
    classification: string | null;
    reasons: string[];
    location: TimelineLocation | null;
    network: TimelineNetwork | null;
    client: string | null;
    platform: string | null;
    isBot: boolean | null;
    /** As stored: raw or hashed per `hashIpsInHistory`. */
    ip: string | null;
    /** Sensitive URLs redacted. */
    url: string | null;
    linkIndex: number | null;
    linkText: string | null;
    actor: string | null;
    legacy: boolean;
    /** Order notes only: Vendure's public (customer-visible) or private (internal) note. */
    visibility?: 'public' | 'private';
    /** Full export only: every stored column, payloads and full user agents. */
    full?: Record<string, unknown>;
}

/** Sort rank per kind, so items at the same millisecond keep a stable order. */
const RANK: Record<TimelineKind, number> = { history: 0, legacy: 1, event: 2 };

export interface SortKey { t: number; r: number; k: string; }

export function sortKeyOf(item: Pick<TimelineItem, 'at' | 'kind' | 'id'>): SortKey {
    return { t: Date.parse(item.at), r: RANK[item.kind], k: secondaryKey(item.id) };
}

/** Zero-padded numeric parts so string order equals numeric order. */
function secondaryKey(id: string): string {
    return id.replace(/\d+/g, d => d.padStart(12, '0'));
}

export function compareKeys(a: SortKey, b: SortKey): number {
    if (a.t !== b.t) return a.t < b.t ? -1 : 1;
    if (a.r !== b.r) return a.r < b.r ? -1 : 1;
    return a.k < b.k ? -1 : a.k > b.k ? 1 : 0;
}

export function compareItems(a: TimelineItem, b: TimelineItem): number {
    return compareKeys(sortKeyOf(a), sortKeyOf(b));
}

/** Opaque cursor for "Load more": the sort key of the last item returned. */
export function encodeCursor(key: SortKey): string {
    return Buffer.from(JSON.stringify([key.t, key.r, key.k]), 'utf8').toString('base64url');
}

export function decodeCursor(raw: unknown): SortKey | null {
    if (typeof raw !== 'string' || !raw || raw.length > 200) return null;
    try {
        const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
        if (!Array.isArray(v) || v.length !== 3) return null;
        const [t, r, k] = v;
        if (!Number.isFinite(t) || ![0, 1, 2].includes(r) || typeof k !== 'string' || k.length > 120) return null;
        return { t, r, k };
    } catch {
        return null;
    }
}

/** The event id inside an event item's secondary key (`e000000000123` → 123). */
export function eventIdOfKey(k: string): number | null {
    const m = /^e(\d+)$/.exec(k);
    return m ? Number(m[1]) : null;
}

// ── Filters ──────────────────────────────────────────────────────────────

const DELIVERY_TYPES = new Set(['delivered', 'deferred', 'bounced', 'soft-bounce', 'complained', 'dropped', 'failed', 'suppressed']);

/** Event types a filter selects (null: every type; []: none). */
export function eventTypesForFilter(f: TimelineFilter): string[] | null {
    switch (f) {
        case 'all': case 'emails': return null;
        case 'opens': return ['open'];
        case 'clicks': return ['click'];
        case 'delivery': return [...DELIVERY_TYPES];
        default: return [];
    }
}

export function matchesFilter(item: TimelineItem, f: TimelineFilter): boolean {
    if (f === 'all') return true;
    if (item.kind === 'history') {
        if (f === 'notes') return item.type === 'ORDER_NOTE';
        if (f === 'order') return item.type !== 'ORDER_NOTE';
        return false;
    }
    const types = eventTypesForFilter(f);
    return types === null || types.includes(item.type);
}

export function parseFilter(v: unknown): TimelineFilter {
    const s = String(v || 'all').toLowerCase();
    return (TIMELINE_FILTERS as readonly string[]).includes(s) ? (s as TimelineFilter) : 'all';
}

// ── Event rows ───────────────────────────────────────────────────────────

/** Dates from any driver: Date, or the UTC `YYYY-MM-DD HH:MM:SS[.fff]` strings sqlite returns. */
export function toIso(v: unknown): string | null {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
    const s = String(v);
    const naive = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s);
    const t = Date.parse(naive ? s.replace(' ', 'T') + 'Z' : s);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

const loc = (country: any, region: any, city: any, timezone: any): TimelineLocation | null =>
    country || region || city || timezone
        ? { country: country ?? null, region: region ?? null, city: city ?? null, timezone: timezone ?? null }
        : null;

function parseJson(s: unknown): any {
    if (typeof s !== 'string' || !s) return null;
    try { return JSON.parse(s); } catch { return null; }
}

const bool = (v: unknown): boolean | null => (v === null || v === undefined ? null : v === true || v === 1 || v === '1' || v === 'true');

export interface EmailInfo { id: number; type: string | null; subject: string | null; }

/** One `email_event` row as a timeline item. */
export function eventItem(row: any, email: EmailInfo | undefined, full: boolean): TimelineItem {
    const type = String(row.type) as EmailEventType;
    const reasons = row.classificationReasons ? String(row.classificationReasons).split(',').filter(Boolean) : [];
    const network = row.enrichedBy || row.asn || row.org
        ? {
            asn: row.asn ?? null, org: row.org ?? null,
            isProxy: bool(row.isProxy), isVpn: bool(row.isVpn), isTor: bool(row.isTor), isHosting: bool(row.isHosting), isMobile: bool(row.isMobile),
            enrichedBy: row.enrichedBy ?? null,
        }
        : null;
    const linkIndex = row.linkIndex != null ? Number(row.linkIndex) : null;
    const linkText = row.linkText ?? null;
    const capped = reasons.includes(CAPPED_MARK);
    let detail: string | null = row.detail ?? null;
    if (type === 'click' && !detail) detail = linkLabel(linkIndex, linkText) || hostOf(row.url) || null;
    const item: TimelineItem = {
        id: `e${row.id}`,
        at: toIso(row.occurredAt) || new Date(0).toISOString(),
        kind: 'event',
        type,
        source: String(row.source),
        label: capped ? (type === 'click' ? 'Further clicks not stored' : 'Further opens not stored') : (EVENT_LABELS[type] || type),
        detail,
        emailLogId: row.emailLogId != null ? Number(row.emailLogId) : null,
        emailType: email?.type ?? null,
        classification: row.classification ?? null,
        reasons,
        location: loc(row.country, row.region, row.city, row.timezone),
        network,
        client: row.client ?? null,
        platform: row.platform ?? null,
        isBot: bool(row.isBot),
        ip: row.ip ?? null,
        url: row.url ? redactSensitiveUrl(String(row.url)) : null,
        linkIndex,
        linkText,
        actor: null,
        legacy: false,
    };
    if (full) {
        item.full = {
            id: Number(row.id), createdAt: toIso(row.createdAt), updatedAt: toIso(row.updatedAt),
            emailLogId: row.emailLogId ?? null, orderId: row.orderId ?? null, customerId: row.customerId ?? null, channelId: row.channelId ?? null,
            type: row.type, source: row.source, occurredAt: toIso(row.occurredAt),
            messageId: row.messageId ?? null, providerMessageId: row.providerMessageId ?? null, dedupeKey: row.dedupeKey ?? null,
            recipientHash: row.recipientHash ?? null, ip: row.ip ?? null, ipHash: row.ipHash ?? null,
            country: row.country ?? null, region: row.region ?? null, city: row.city ?? null, timezone: row.timezone ?? null,
            asn: row.asn ?? null, org: row.org ?? null, isProxy: bool(row.isProxy), isVpn: bool(row.isVpn), isTor: bool(row.isTor),
            isHosting: bool(row.isHosting), isMobile: bool(row.isMobile), enrichedBy: row.enrichedBy ?? null, enrichedAt: toIso(row.enrichedAt),
            userAgent: row.userAgent ?? null, client: row.client ?? null, platform: row.platform ?? null, isBot: bool(row.isBot),
            classification: row.classification ?? null, classificationReasons: row.classificationReasons ?? null,
            url: row.url ?? null, linkIndex: row.linkIndex ?? null, linkText: row.linkText ?? null,
            detail: row.detail ?? null, payload: parseJson(row.payload),
        };
    }
    return item;
}

function hostOf(url: unknown): string | null {
    try { return url ? new URL(String(url)).host : null; } catch { return null; }
}

/** The reason code on the marker row of a capped day (`EmailEventService.recordEngagement`). */
const CAPPED_MARK = 'events-capped';

/**
 * How a clicked link is named in the UI and the PDF: `Link #2: Reset your
 * password` (the position counted from 1; `linkIndex` itself, in the
 * exports, is 0-based), `Link #2` without anchor text, the text alone
 * without a position; null when neither is known.
 */
export function linkLabel(linkIndex: number | null | undefined, linkText: string | null | undefined): string | null {
    const text = linkText ? String(linkText) : '';
    if (linkIndex !== null && linkIndex !== undefined && Number.isInteger(Number(linkIndex)) && Number(linkIndex) >= 0) {
        return `Link #${Number(linkIndex) + 1}${text ? `: ${text}` : ''}`;
    }
    return text || null;
}

// ── Legacy email_log rows (sent before 0.16.0) ───────────────────────────

/** Per-email facts from `email_event`, used to decide what to synthesise. */
export interface LogEventStats {
    /** Earliest event time for the email; legacy JSON entries before it are synthesised. */
    firstAt: string | null;
    /** A send outcome (sent/failed/deferred/suppressed from the send path) exists. */
    hasSend: boolean;
    /** A status-changing event from a webhook (delivered, bounce, complaint, deferral, dropped) exists. */
    hasStatus: boolean;
}

/** True for an open / click that came through a link without a signature (classification `unverified`, reason `unsigned-token`). */
export function isUnsignedItem(item: Pick<TimelineItem, 'reasons'> & { classification?: string | null }): boolean {
    return item.classification === 'unverified' || (Array.isArray(item.reasons) && item.reasons.includes('unsigned-token'));
}

const LEGACY_NOTE = 'recorded before 0.16.0';

/**
 * Items synthesised from one `email_log` row and its `opensJson` /
 * `clicksJson` (the last 50 of each), marked `legacy`. Entries at or after
 * the email's first `email_event` row are skipped — those are on the
 * timeline already as events.
 */
export function legacyItems(log: any, stats: LogEventStats | undefined, full: boolean): TimelineItem[] {
    const out: TimelineItem[] = [];
    const id = Number(log.id);
    const cutoff = stats?.firstAt ? Date.parse(stats.firstAt) : Infinity;
    const email: EmailInfo = { id, type: log.type ?? null, subject: log.subject ?? null };
    const base = (suffix: string, at: string, type: string, label: string, detail: string | null): TimelineItem => ({
        id: `l${id}-${suffix}`, at, kind: 'legacy', type, source: 'email_log', label, detail,
        emailLogId: id, emailType: email.type, classification: null, reasons: [], location: null, network: null,
        client: null, platform: null, isBot: null, ip: null, url: null, linkIndex: null, linkText: null, actor: null, legacy: true,
    });
    const createdAt = toIso(log.createdAt);
    const status = String(log.status || 'sent');
    if (!stats?.hasSend && createdAt) {
        const type = status === 'failed' || status === 'suppressed' ? status : 'sent';
        const detail = [log.subject ? `“${String(log.subject).slice(0, 160)}”` : null, log.smtpResponse || (type !== 'sent' ? log.errorMessage : null)]
            .filter(Boolean).join(' — ') || null;
        const it = base('s', createdAt, type, EVENT_LABELS[type as EmailEventType], detail);
        if (full) it.full = { emailLog: legacyLogColumns(log) };
        out.push(it);
    }
    // Only for an email with no event rows of its own: one sent since 0.16.0 has its send
    // outcome (e.g. `deferred` from the SMTP reply) and every later status change as events.
    // The time the status was set was never recorded, and the row's updatedAt moves with
    // every later write (an open, a click), so it is shown at the send time — a value that
    // never changes — and says so.
    if (!stats?.hasSend && !stats?.hasStatus && ['bounced', 'complained', 'deferred', 'delivered'].includes(status) && createdAt) {
        out.push(base('st', createdAt, status, EVENT_LABELS[status as EmailEventType],
            [log.errorMessage, `status ${LEGACY_NOTE} (time not recorded; shown at the send time)`].filter(Boolean).join(' — ')));
    }
    const opens = Array.isArray(parseJson(log.opensJson)) ? parseJson(log.opensJson) : [];
    opens.forEach((o: any, i: number) => {
        const at = toIso(o?.ts);
        if (!at || Date.parse(at) >= cutoff) return;
        const c = classifyEmailEvent({ userAgent: o?.ua ?? null, eventType: 'email_open' });
        const it = base(`o${i}`, at, 'open', EVENT_LABELS.open, null);
        Object.assign(it, {
            classification: c.classification, reasons: c.reasons, location: loc(o?.country, o?.region, o?.city, o?.timezone),
            client: o?.client ?? null, platform: o?.platform ?? null, isBot: o?.isBot ?? null, ip: o?.ip ?? null,
        });
        if (full) it.full = { entry: o };
        out.push(it);
    });
    const clicks = Array.isArray(parseJson(log.clicksJson)) ? parseJson(log.clicksJson) : [];
    clicks.forEach((c0: any, i: number) => {
        const at = toIso(c0?.ts);
        if (!at || Date.parse(at) >= cutoff) return;
        const c = classifyEmailEvent({ userAgent: c0?.ua ?? null, eventType: 'email_click' });
        const url = c0?.url ? redactSensitiveUrl(String(c0.url)) : null;
        const it = base(`c${i}`, at, 'click', EVENT_LABELS.click, hostOf(url));
        Object.assign(it, {
            classification: c.classification, reasons: c.reasons, location: loc(c0?.country, c0?.region, c0?.city, c0?.timezone),
            ip: c0?.ip ?? null, url,
        });
        // Click history from before 0.16.0 kept raw URLs; the full export never carries a live token.
        if (full) it.full = { entry: c0 && typeof c0 === 'object' && typeof c0.url === 'string' ? { ...c0, url: redactSensitiveUrl(c0.url) } : c0 };
        out.push(it);
    });
    return out;
}

function legacyLogColumns(log: any): Record<string, unknown> {
    const keep = ['id', 'createdAt', 'updatedAt', 'type', 'recipient', 'subject', 'fromAddress', 'bcc', 'replyTo', 'context', 'channelId',
        'customerId', 'orderId', 'orderCode', 'invoiceId', 'applicationId', 'status', 'smtpResponse', 'smtpMessageId', 'errorMessage',
        'openCount', 'firstOpenedAt', 'lastOpenedAt', 'firstOpenIp', 'firstOpenUserAgent', 'clickCount', 'firstClickedAt', 'tracked'];
    const out: Record<string, unknown> = {};
    for (const k of keep) out[k] = log[k] instanceof Date ? log[k].toISOString() : log[k] ?? null;
    return out;
}

// ── Vendure order history ────────────────────────────────────────────────

export interface PaymentInfo { id: string; amount: number; method: string; state: string; refunds: Array<{ id: string; total: number; reason?: string | null }>; }

/**
 * An amount in minor units as `GBP 12.50`. `precision` is the host's
 * `MoneyStrategy.precision` (Vendure 2.2+; default 2): the number of decimal
 * places the stored integers carry.
 */
export function formatMoney(minor: number | null | undefined, currency: string | null | undefined, precision = 2): string {
    if (minor === null || minor === undefined || !Number.isFinite(Number(minor))) return '';
    const p = Number.isInteger(precision) && precision >= 0 && precision <= 8 ? precision : 2;
    return `${currency || ''} ${(Number(minor) / 10 ** p).toFixed(p)}`.trim();
}

const HISTORY_LABELS: Record<string, string> = {
    ORDER_STATE_TRANSITION: 'Order state changed',
    ORDER_PAYMENT_TRANSITION: 'Payment state changed',
    ORDER_FULFILLMENT: 'Fulfilment created',
    ORDER_FULFILLMENT_TRANSITION: 'Fulfilment state changed',
    ORDER_CANCELLATION: 'Order cancelled',
    ORDER_REFUND_TRANSITION: 'Refund state changed',
    ORDER_NOTE: 'Note',
    ORDER_COUPON_APPLIED: 'Coupon applied',
    ORDER_COUPON_REMOVED: 'Coupon removed',
    ORDER_MODIFIED: 'Order modified',
    ORDER_CUSTOMER_UPDATED: 'Customer changed',
    ORDER_CURRENCY_UPDATED: 'Currency changed',
};

/** True for a Vendure history type the timeline knows; any other prints its raw data (admin views only). */
export function isKnownHistoryType(type: string): boolean {
    return Object.prototype.hasOwnProperty.call(HISTORY_LABELS, type);
}

/** One Vendure order history entry (payments looked up for amounts; `precision` as for `formatMoney`). */
export function historyItem(entry: any, payments: PaymentInfo[], currency: string | null, full: boolean, precision = 2): TimelineItem {
    const type = String(entry.type);
    const money = (minor: number) => formatMoney(minor, currency, precision);
    const d = entry.data && typeof entry.data === 'object' ? entry.data : {};
    const arrow = (a: unknown, b: unknown) => `${a ?? '?'} → ${b ?? '?'}`;
    let detail: string | null = null;
    switch (type) {
        case 'ORDER_STATE_TRANSITION': detail = arrow(d.from, d.to); break;
        case 'ORDER_PAYMENT_TRANSITION': {
            const p = payments.find(x => String(x.id) === String(d.paymentId));
            detail = arrow(d.from, d.to) + (p ? ` — ${money(p.amount)} via ${p.method}` : '');
            break;
        }
        case 'ORDER_FULFILLMENT': detail = d.fulfillmentId != null ? `Fulfilment #${d.fulfillmentId}` : null; break;
        case 'ORDER_FULFILLMENT_TRANSITION': detail = `#${d.fulfillmentId ?? '?'}: ${arrow(d.from, d.to)}`; break;
        case 'ORDER_CANCELLATION': {
            const qty = Array.isArray(d.lines) ? d.lines.reduce((n: number, l: any) => n + (Number(l?.quantity) || 0), 0) : 0;
            detail = [qty ? `${qty} item(s)` : null, d.shippingCancelled ? 'shipping cancelled' : null, d.reason ? `reason: ${d.reason}` : null].filter(Boolean).join(' — ') || null;
            break;
        }
        case 'ORDER_REFUND_TRANSITION': {
            let refund: { total: number } | undefined;
            for (const p of payments) refund = refund || p.refunds.find(r => String(r.id) === String(d.refundId));
            detail = arrow(d.from, d.to) + (refund ? ` — ${money(refund.total)}` : '') + (d.reason ? ` — reason: ${d.reason}` : '');
            break;
        }
        // Whole: a note is the admin's own record (often pasted customer correspondence). The PDF cuts a cell
        // taller than a page with a notice saying how much is missing; the exports keep every character.
        case 'ORDER_NOTE': detail = typeof d.note === 'string' ? d.note : null; break;
        case 'ORDER_COUPON_APPLIED':
        case 'ORDER_COUPON_REMOVED': detail = d.couponCode ? String(d.couponCode) : null; break;
        case 'ORDER_MODIFIED': detail = d.modificationId != null ? `Modification #${d.modificationId}` : null; break;
        case 'ORDER_CUSTOMER_UPDATED': detail = arrow(d.previousCustomerName, d.newCustomerName) + (d.note ? ` — ${d.note}` : ''); break;
        case 'ORDER_CURRENCY_UPDATED': detail = arrow(d.previousCurrency, d.newCurrency); break;
        default: {
            const json = JSON.stringify(d);
            detail = json && json !== '{}' ? json.slice(0, 500) : null;
        }
    }
    const admin = entry.administrator;
    const actor = admin ? [admin.firstName, admin.lastName].filter(Boolean).join(' ') || admin.emailAddress || null : null;
    const label = (HISTORY_LABELS[type] || type) + (type === 'ORDER_NOTE' ? (entry.isPublic ? ' (public)' : ' (private)') : '');
    const item: TimelineItem = {
        id: `h${entry.id}`, at: toIso(entry.createdAt) || new Date(0).toISOString(), kind: 'history', type, source: 'vendure',
        label, detail, emailLogId: null, emailType: null, classification: null, reasons: [], location: null, network: null,
        client: null, platform: null, isBot: null, ip: null, url: null, linkIndex: null, linkText: null, actor, legacy: false,
    };
    if (type === 'ORDER_NOTE') item.visibility = entry.isPublic ? 'public' : 'private';
    if (full) item.full = { id: entry.id, type, isPublic: !!entry.isPublic, data: d, administratorId: admin?.id ?? null };
    return item;
}

/** What the evidence report includes besides the always-printed rows. */
export interface EvidenceScope {
    /** Private (internal) order notes, printed marked "internal". Default: left out. */
    internalNotes: boolean;
}

/**
 * The items of the PDF evidence report — a document meant to be handed to a
 * payment processor or a customer — from the redacted timeline: private
 * (internal) order notes are left out unless `internalNotes`, and then
 * labelled "Note (internal)"; history entries of a type the timeline does
 * not know keep their row but not their raw data. `activity.json?evidence=1`
 * returns exactly these items, so their SHA-256 matches the report.
 */
export function evidenceItems(items: TimelineItem[], scope: EvidenceScope): { items: TimelineItem[]; internalNotesLeftOut: number } {
    let internalNotesLeftOut = 0;
    const out: TimelineItem[] = [];
    for (const i of items) {
        if (i.kind === 'history' && i.type === 'ORDER_NOTE' && i.visibility !== 'public') {
            if (!scope.internalNotes) { internalNotesLeftOut++; continue; }
            out.push({ ...i, label: 'Note (internal)' });
            continue;
        }
        if (i.kind === 'history' && !isKnownHistoryType(i.type)) {
            out.push({ ...i, detail: null });
            continue;
        }
        out.push(i);
    }
    return { items: out, internalNotesLeftOut };
}

/** The redacted form of an item (drops the full-export block). */
export function redacted(item: TimelineItem): TimelineItem {
    if (!item.full) return item;
    const { full: _full, ...rest } = item;
    return rest;
}

// ── Canonical hash ───────────────────────────────────────────────────────

/** JSON with object keys sorted at every level and no whitespace; undefined dropped. */
export function canonicalJson(v: unknown): string {
    if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
    if (Array.isArray(v)) return `[${v.map(x => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`;
    const keys = Object.keys(v as Record<string, unknown>).filter(k => (v as any)[k] !== undefined).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson((v as any)[k])}`).join(',')}}`;
}

/** SHA-256 of the canonical JSON of the redacted items — printed on the PDF, returned by activity.json. */
export function timelineSha256(items: TimelineItem[]): string {
    return createHash('sha256').update(canonicalJson(items.map(redacted)), 'utf8').digest('hex');
}

// ── Pagination over already-merged candidates ─────────────────────────────

/**
 * Sort candidates, keep those after the cursor, cut to `take`. Each source
 * contributes at most `take + 1` items past the cursor, so the first `take`
 * of the merge are exact; `hasMore` is whether anything remained.
 */
export function pageOf(candidates: TimelineItem[], cursor: SortKey | null, take: number, order: 'asc' | 'desc'):
    { items: TimelineItem[]; hasMore: boolean; nextCursor: string | null } {
    const dir = order === 'desc' ? -1 : 1;
    const after = cursor
        ? candidates.filter(i => dir * compareKeys(sortKeyOf(i), cursor) > 0)
        : candidates.slice();
    after.sort((a, b) => dir * compareItems(a, b));
    const items = after.slice(0, take);
    const hasMore = after.length > take;
    const last = items[items.length - 1];
    return { items, hasMore, nextCursor: hasMore && last ? encodeCursor(sortKeyOf(last)) : null };
}
