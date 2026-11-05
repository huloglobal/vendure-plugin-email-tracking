import { createHash } from 'crypto';
import { CORRELATION_KEY, EmailEventType, ProviderSlug } from './event-types';

/**
 * Provider payload → normalised events. Each mapper takes the parsed body a
 * provider posts (after its signature has been verified) and returns zero or
 * more events; anything a provider sends that the timeline has no use for
 * (SendGrid `processed`, Mailgun `accepted`, SES `Send`, …) maps to nothing.
 */
export type SuppressionReason = 'hard-bounce' | 'complaint';

export interface ProviderEvent {
    provider: ProviderSlug;
    type: EmailEventType;
    occurredAt: Date;
    /** Lower-cased recipient address, when the provider names one. */
    recipient: string | null;
    /** The provider identity of this event; its SHA-256 is the row's `dedupeKey`. */
    eventKey: string;
    /** The correlation value we put on the mail (`<id>-<hmac>`), echoed back by the provider; unverified here. */
    correlation: string | null;
    /** RFC Message-ID without brackets. */
    messageId: string | null;
    providerMessageId: string | null;
    detail: string | null;
    /** Set when the event proves the address is bad (hard bounce, complaint, dropped for those). */
    suppress: SuppressionReason | null;
    ip: string | null;
    userAgent: string | null;
    url: string | null;
    /** Sanitised, truncated subset of the provider's fields (never a body, never the address). */
    payload: Record<string, unknown>;
}

// ── helpers ─────────────────────────────────────────────────────────────

const str = (v: unknown, max = 300): string | null => {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return null;
    const s = String(v).trim();
    return s ? s.slice(0, max) : null;
};

/** Message-ID without angle brackets. */
export function bareMessageId(v: unknown): string | null {
    const s = str(v, 500);
    if (!s) return null;
    return s.replace(/^<|>$/g, '').trim().slice(0, 255) || null;
}

export function normaliseRecipient(v: unknown): string | null {
    const s = str(v, 320);
    if (!s) return null;
    const m = /<([^<>]+)>/.exec(s);
    const addr = (m ? m[1] : s).trim().toLowerCase();
    return /^[^\s@]{1,64}@[^\s@]{1,255}$/.test(addr) ? addr : null;
}

/** A metadata value by key, ignoring case: nodemailer re-cases custom header
 *  names (`X-PM-Metadata-hulo-log-id` goes out as `X-Pm-Metadata-Hulo-Log-ID`),
 *  and Postmark keeps the key as it arrived. */
export function metadataValue(meta: unknown, key: string): unknown {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return undefined;
    const want = key.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(meta, key)) return (meta as any)[key];
    for (const [k, v] of Object.entries(meta as Record<string, unknown>)) if (k.toLowerCase() === want) return v;
    return undefined;
}

/** The correlation value from a provider metadata field (string, or SES's one-element array); shape-checked only. */
export function correlationFrom(v: unknown): string | null {
    const raw = Array.isArray(v) ? v[0] : v;
    if (raw === null || raw === undefined) return null;
    const s = String(raw).trim();
    return /^\d{1,10}(-[0-9a-f]{16})?$/.test(s) ? s : null;
}

/** Seconds (number or numeric string) or an ISO date → Date; invalid → now. */
export function toDate(v: unknown, now = new Date()): Date {
    if (typeof v === 'number' && Number.isFinite(v)) return new Date(v > 1e12 ? v : Math.round(v * 1000));
    if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) return toDate(Number(v), now);
    if (typeof v === 'string' && v.trim()) {
        const t = Date.parse(v);
        if (Number.isFinite(t)) return new Date(t);
    }
    return now;
}

/** SHA-256 hex of `provider|eventKey` — the unique `dedupeKey`. */
export function dedupeKeyFor(source: string, eventKey: string): string {
    return createHash('sha256').update(`${source}|${eventKey}`).digest('hex');
}

/** Keep only the listed scalar fields, each truncated; the whole thing stays under ~4 KB. */
function pick(obj: any, keys: string[], max = 300): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!obj || typeof obj !== 'object') return out;
    for (const k of keys) {
        const v = obj[k];
        if (v === null || v === undefined || v === '') continue;
        if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
        else if (typeof v === 'string') out[k] = v.slice(0, max);
        else if (Array.isArray(v) && v.every(x => typeof x === 'string')) out[k] = v.slice(0, 10).map(x => x.slice(0, 64));
    }
    return out;
}

function capPayload(p: Record<string, unknown>): Record<string, unknown> {
    let json = JSON.stringify(p);
    if (json.length <= 4000) return p;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(p)) {
        out[k] = typeof v === 'string' ? v.slice(0, 120) : v;
        json = JSON.stringify(out);
        if (json.length > 4000) { delete out[k]; break; }
    }
    return out;
}

function event(e: Omit<ProviderEvent, 'payload' | 'detail'> & { detail?: string | null; payload?: Record<string, unknown> }): ProviderEvent {
    return {
        ...e,
        detail: e.detail ? e.detail.replace(/\s+/g, ' ').trim().slice(0, 1000) || null : null,
        url: e.url ? e.url.slice(0, 2000) : null,
        userAgent: e.userAgent ? e.userAgent.slice(0, 1000) : null,
        ip: e.ip ? e.ip.slice(0, 64) : null,
        payload: capPayload(e.payload || {}),
    };
}

const joinDetail = (...parts: Array<unknown>): string | null =>
    parts.map(p => str(p, 600)).filter(Boolean).join(' — ') || null;

// ── Postmark ────────────────────────────────────────────────────────────

const POSTMARK_FIELDS = ['RecordType', 'Type', 'TypeCode', 'ID', 'MessageID', 'MessageStream', 'Tag', 'ServerID', 'Description',
    'Inactive', 'CanActivate', 'DeliveredAt', 'BouncedAt', 'ReceivedAt', 'ChangedAt', 'FirstOpen', 'Platform', 'ReadSeconds',
    'ClickLocation', 'SuppressSending', 'SuppressionReason', 'Origin'];

/** Postmark bounce `Type` → normalised type + suppression. Informational types map to nothing. */
export function postmarkBounceType(t: string): { type: EmailEventType; suppress: SuppressionReason | null } | null {
    switch (t) {
        case 'HardBounce':
        case 'BadEmailAddress':
            return { type: 'bounced', suppress: 'hard-bounce' };
        case 'SpamComplaint':
            return { type: 'complained', suppress: 'complaint' };
        case 'Unsubscribe':
            return { type: 'unsubscribed', suppress: null };
        case 'SoftBounce':
        case 'Transient':
        case 'DnsError':
        case 'SpamNotification':
        case 'VirusNotification':
        case 'Blocked':
        case 'DMARCPolicy':
        case 'Unknown':
            return { type: 'soft-bounce', suppress: null };
        case 'ManuallyDeactivated':
        case 'Unconfirmed':
        case 'SMTPApiError':
        case 'TemplateRenderingFailed':
            return { type: 'dropped', suppress: null };
        default:
            // Subscribe, AutoResponder, AddressChange, OpenRelayTest, ChallengeVerification, InboundError, …
            return null;
    }
}

export function mapPostmark(body: any): ProviderEvent[] {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
    const meta = body.Metadata && typeof body.Metadata === 'object' ? body.Metadata : {};
    const base = {
        provider: 'postmark' as const,
        correlation: correlationFrom(metadataValue(meta, CORRELATION_KEY)),
        messageId: null,
        providerMessageId: str(body.MessageID, 255),
        ip: null as string | null,
        userAgent: null as string | null,
        url: null as string | null,
        payload: pick(body, POSTMARK_FIELDS),
    };
    const pmId = base.providerMessageId || '';
    switch (String(body.RecordType || '')) {
        case 'Bounce': {
            const m = postmarkBounceType(String(body.Type || ''));
            if (!m) return [];
            const recipient = normaliseRecipient(body.Email);
            return [event({
                ...base, ...m, recipient,
                occurredAt: toDate(body.BouncedAt),
                eventKey: `bounce|${str(body.ID) ?? pmId}|${recipient ?? ''}`,
                detail: joinDetail(body.Type, body.Description, body.Details),
            })];
        }
        case 'SpamComplaint': {
            const recipient = normaliseRecipient(body.Email);
            return [event({
                ...base, type: 'complained', suppress: 'complaint', recipient,
                occurredAt: toDate(body.BouncedAt),
                eventKey: `spam|${str(body.ID) ?? pmId}|${recipient ?? ''}`,
                detail: joinDetail('SpamComplaint', body.Description, body.Details),
            })];
        }
        case 'Delivery': {
            const recipient = normaliseRecipient(body.Recipient);
            return [event({
                ...base, type: 'delivered', suppress: null, recipient,
                occurredAt: toDate(body.DeliveredAt),
                eventKey: `delivery|${pmId}|${recipient ?? ''}`,
                detail: str(body.Details, 600),
            })];
        }
        case 'Open': {
            const recipient = normaliseRecipient(body.Recipient);
            return [event({
                ...base, type: 'open', suppress: null, recipient,
                occurredAt: toDate(body.ReceivedAt),
                eventKey: `open|${pmId}|${str(body.ReceivedAt) ?? ''}|${recipient ?? ''}`,
                ip: str(body.Geo?.IP, 64), userAgent: str(body.UserAgent, 1000),
            })];
        }
        case 'Click': {
            const recipient = normaliseRecipient(body.Recipient);
            return [event({
                ...base, type: 'click', suppress: null, recipient,
                occurredAt: toDate(body.ReceivedAt),
                eventKey: `click|${pmId}|${str(body.ReceivedAt) ?? ''}|${str(body.OriginalLink, 500) ?? ''}`,
                ip: str(body.Geo?.IP, 64), userAgent: str(body.UserAgent, 1000), url: str(body.OriginalLink, 2000),
            })];
        }
        case 'SubscriptionChange': {
            // Hard bounces and complaints arrive on their own records; only a manual
            // opt-out (the recipient unsubscribed) is new information here.
            if (body.SuppressSending !== true || body.SuppressionReason !== 'ManualSuppression') return [];
            const recipient = normaliseRecipient(body.Recipient);
            return [event({
                ...base, type: 'unsubscribed', suppress: null, recipient,
                occurredAt: toDate(body.ChangedAt),
                eventKey: `subscription|${pmId}|${str(body.ChangedAt) ?? ''}|${recipient ?? ''}`,
                detail: 'Recipient unsubscribed (Postmark manual suppression)',
            })];
        }
        default:
            return [];
    }
}

// ── SendGrid ────────────────────────────────────────────────────────────

const SENDGRID_FIELDS = ['event', 'type', 'sg_event_id', 'sg_message_id', 'smtp-id', 'reason', 'status', 'response', 'attempt',
    'bounce_classification', 'tls', 'category', 'asm_group_id', 'url_offset'];

/**
 * SendGrid `dropped` reasons that mean the address itself is bad, matched
 * exactly: "Bounced Address" and "Invalid" (an invalid address) → hard
 * bounce, "Spam Reporting Address" → complaint. Every other documented
 * reason ("Invalid SMTPAPI header", "Spam Content", "Unsubscribed Address",
 * "Recipient List over Package Quota") is about the message or the account,
 * not the address, and never suppresses.
 */
export function sendgridDropSuppression(reason: unknown): SuppressionReason | null {
    const r = String(reason ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
    if (r === 'spam reporting address') return 'complaint';
    if (r === 'bounced address' || r === 'invalid') return 'hard-bounce';
    return null;
}

export function mapSendgrid(body: any): ProviderEvent[] {
    if (!Array.isArray(body)) return [];
    const out: ProviderEvent[] = [];
    for (const e of body.slice(0, 1000)) {
        if (!e || typeof e !== 'object') continue;
        const kind = String(e.event || '').toLowerCase();
        let type: EmailEventType | null = null;
        let suppress: SuppressionReason | null = null;
        switch (kind) {
            case 'delivered': type = 'delivered'; break;
            case 'deferred': type = 'deferred'; break;
            case 'bounce':
                if (String(e.type || '').toLowerCase() === 'blocked') type = 'soft-bounce';
                else { type = 'bounced'; suppress = 'hard-bounce'; }
                break;
            case 'blocked': type = 'soft-bounce'; break;
            case 'dropped': type = 'dropped'; suppress = sendgridDropSuppression(String(e.reason || '')); break;
            case 'spamreport': type = 'complained'; suppress = 'complaint'; break;
            case 'unsubscribe':
            case 'group_unsubscribe': type = 'unsubscribed'; break;
            case 'open': type = 'open'; break;
            case 'click': type = 'click'; break;
            default: type = null; // processed, group_resubscribe, …
        }
        if (!type) continue;
        const recipient = normaliseRecipient(e.email);
        const sgId = str(e.sg_message_id, 255);
        const correlation = correlationFrom(e[CORRELATION_KEY] ?? metadataValue(e.unique_args, CORRELATION_KEY) ?? metadataValue(e.custom_args, CORRELATION_KEY));
        out.push(event({
            provider: 'sendgrid', type, suppress, recipient,
            occurredAt: toDate(e.timestamp),
            eventKey: str(e.sg_event_id, 200) || `${sgId ?? ''}|${kind}|${str(e.timestamp) ?? ''}|${recipient ?? ''}`,
            correlation,
            messageId: bareMessageId(e['smtp-id']),
            providerMessageId: sgId,
            detail: joinDetail(e.reason, e.response, e.status),
            ip: str(e.ip, 64), userAgent: str(e.useragent, 1000), url: str(e.url, 2000),
            payload: pick(e, SENDGRID_FIELDS),
        }));
    }
    return out;
}

// ── Mailgun ─────────────────────────────────────────────────────────────

export function mapMailgun(body: any): ProviderEvent[] {
    const d = body && typeof body === 'object' ? body['event-data'] : null;
    if (!d || typeof d !== 'object') return [];
    const kind = String(d.event || '').toLowerCase();
    let type: EmailEventType | null = null;
    let suppress: SuppressionReason | null = null;
    const reason = String(d.reason || '').toLowerCase();
    switch (kind) {
        case 'delivered': type = 'delivered'; break;
        case 'failed':
            if (String(d.severity || '').toLowerCase() !== 'permanent') { type = 'deferred'; break; }
            if (reason === 'suppress-bounce') { type = 'dropped'; suppress = 'hard-bounce'; }
            else if (reason === 'suppress-complaint') { type = 'dropped'; suppress = 'complaint'; }
            else if (reason === 'bounce' || reason === '') { type = 'bounced'; suppress = 'hard-bounce'; }
            else type = 'dropped'; // suppress-unsubscribe, old, generic, …
            break;
        case 'rejected': type = 'dropped'; break;
        case 'complained': type = 'complained'; suppress = 'complaint'; break;
        case 'unsubscribed': type = 'unsubscribed'; break;
        case 'opened': type = 'open'; break;
        case 'clicked': type = 'click'; break;
        default: type = null; // accepted, stored, …
    }
    if (!type) return [];
    const ds = d['delivery-status'] && typeof d['delivery-status'] === 'object' ? d['delivery-status'] : {};
    const recipient = normaliseRecipient(d.recipient);
    const payload = {
        ...pick(d, ['event', 'id', 'severity', 'reason', 'log-level', 'method']),
        ...Object.fromEntries(Object.entries(pick(ds, ['code', 'message', 'description', 'attempt-no', 'mx-host'])).map(([k, v]) => [`delivery-status.${k}`, v])),
    };
    return [event({
        provider: 'mailgun', type, suppress, recipient,
        occurredAt: toDate(d.timestamp),
        eventKey: str(d.id, 200) || `${kind}|${str(d.timestamp) ?? ''}|${recipient ?? ''}`,
        correlation: correlationFrom(metadataValue(d['user-variables'], CORRELATION_KEY)),
        messageId: bareMessageId(d.message?.headers?.['message-id']),
        providerMessageId: null,
        detail: joinDetail(ds.code ? `SMTP ${ds.code}` : null, ds.description || ds.message, reason && reason !== 'bounce' ? `reason: ${reason}` : null),
        ip: str(d.ip, 64), userAgent: str(d['client-info']?.['user-agent'], 1000), url: str(d.url, 2000),
        payload,
    })];
}

// ── Amazon SES (the Message of an SNS Notification) ──────────────────────

function sesMessageIdHeader(mail: any): string | null {
    const fromCommon = bareMessageId(mail?.commonHeaders?.messageId);
    if (fromCommon) return fromCommon;
    if (Array.isArray(mail?.headers)) {
        const h = mail.headers.find((x: any) => String(x?.name || '').toLowerCase() === 'message-id');
        return bareMessageId(h?.value);
    }
    return null;
}

/** SES notification (identity notifications or configuration-set event publishing). */
export function mapSes(message: any, snsMessageId: string): ProviderEvent[] {
    if (!message || typeof message !== 'object') return [];
    const kind = String(message.notificationType || message.eventType || '');
    const mail = message.mail && typeof message.mail === 'object' ? message.mail : {};
    const base = {
        provider: 'ses' as const,
        correlation: correlationFrom(metadataValue(mail.tags, CORRELATION_KEY)),
        messageId: sesMessageIdHeader(mail),
        providerMessageId: str(mail.messageId, 255),
        ip: null as string | null,
        userAgent: null as string | null,
        url: null as string | null,
    };
    const common = { notificationType: kind, sesMessageId: base.providerMessageId, snsMessageId: snsMessageId.slice(0, 64) };
    const destination: string[] = Array.isArray(mail.destination) ? mail.destination : [];
    type Built = Partial<ProviderEvent> & { type: EmailEventType; suppress: SuppressionReason | null; occurredAt: Date };
    const perRecipient = (list: any[], build: (r: any) => Built) =>
        list.slice(0, 50).map(r => {
            const recipient = normaliseRecipient(typeof r === 'string' ? r : r?.emailAddress);
            const built = build(r);
            return event({ ...base, ...built, recipient, eventKey: built.eventKey || `${snsMessageId}|${recipient ?? ''}` });
        });
    switch (kind) {
        case 'Bounce': {
            const b = message.bounce || {};
            const permanent = b.bounceType === 'Permanent';
            return perRecipient(Array.isArray(b.bouncedRecipients) ? b.bouncedRecipients : [], (r) => ({
                type: permanent ? 'bounced' : 'soft-bounce',
                suppress: permanent ? 'hard-bounce' : null,
                occurredAt: toDate(b.timestamp),
                detail: joinDetail(`${b.bounceType || 'Unknown'}/${b.bounceSubType || 'General'}`, r?.diagnosticCode || r?.status),
                payload: { ...common, ...pick(b, ['bounceType', 'bounceSubType', 'feedbackId', 'reportingMTA', 'remoteMtaIp']), ...pick(r, ['status', 'action', 'diagnosticCode']) },
            }));
        }
        case 'Complaint': {
            const c = message.complaint || {};
            return perRecipient(Array.isArray(c.complainedRecipients) ? c.complainedRecipients : [], () => ({
                type: 'complained', suppress: 'complaint',
                occurredAt: toDate(c.timestamp),
                detail: joinDetail('Complaint', c.complaintFeedbackType || c.complaintSubType),
                payload: { ...common, ...pick(c, ['complaintFeedbackType', 'complaintSubType', 'feedbackId', 'userAgent']) },
            }));
        }
        case 'Delivery': {
            const d = message.delivery || {};
            return perRecipient(Array.isArray(d.recipients) ? d.recipients : [], () => ({
                type: 'delivered', suppress: null,
                occurredAt: toDate(d.timestamp),
                detail: str(d.smtpResponse, 600),
                payload: { ...common, ...pick(d, ['smtpResponse', 'processingTimeMillis', 'reportingMTA', 'remoteMtaIp']) },
            }));
        }
        case 'DeliveryDelay': {
            const dd = message.deliveryDelay || {};
            return perRecipient(Array.isArray(dd.delayedRecipients) ? dd.delayedRecipients : [], (r) => ({
                type: 'deferred', suppress: null,
                occurredAt: toDate(dd.timestamp),
                detail: joinDetail(dd.delayType, r?.diagnosticCode || r?.status),
                payload: { ...common, ...pick(dd, ['delayType', 'expirationTime', 'reportingMTA']), ...pick(r, ['status', 'diagnosticCode']) },
            }));
        }
        case 'Reject':
            return perRecipient(destination, () => ({
                type: 'dropped', suppress: null, occurredAt: toDate(mail.timestamp),
                detail: joinDetail('Rejected by SES', message.reject?.reason),
                payload: { ...common, ...pick(message.reject, ['reason']) },
            }));
        case 'Open': {
            const o = message.open || {};
            return perRecipient(destination.slice(0, 1), () => ({
                type: 'open', suppress: null, occurredAt: toDate(o.timestamp),
                eventKey: `${snsMessageId}|open`,
                ip: str(o.ipAddress, 64), userAgent: str(o.userAgent, 1000),
                payload: common,
            }));
        }
        case 'Click': {
            const c = message.click || {};
            return perRecipient(destination.slice(0, 1), () => ({
                type: 'click', suppress: null, occurredAt: toDate(c.timestamp),
                eventKey: `${snsMessageId}|click`,
                ip: str(c.ipAddress, 64), userAgent: str(c.userAgent, 1000), url: str(c.link, 2000),
                payload: common,
            }));
        }
        case 'Subscription':
            return perRecipient(destination.slice(0, 1), () => ({
                type: 'unsubscribed', suppress: null, occurredAt: toDate(message.subscription?.timestamp ?? mail.timestamp),
                detail: 'Recipient changed their subscription (SES)',
                payload: common,
            }));
        default:
            return []; // Send, Rendering Failure, AmazonSnsSubscriptionSucceeded, …
    }
}
