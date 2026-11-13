import { signValue } from '@huloglobal/vendure-licence-sdk';
import { createHmac, timingSafeEqual } from 'crypto';
import { trackedClickHref } from './click-signature';
import { decodeHtmlHref } from './decode-html-href';
import { CORRELATION_KEY } from './event-types';
import { anchorText, innerHtmlAfter, isSensitiveUrl, LinkMeta, MAX_LINKS, urlFingerprint } from './link-meta';
import { getOptions, ownTrackingPrefixes, trackingBaseUrl } from './options';

/**
 * Wrap an HTML body for tracking — rewrite links through the click
 * redirector and append the open pixel — and describe each rewritten link
 * (index, anchor text, sensitive flag, keyed URL fingerprint) for the click
 * events. The URLs and their signatures are exactly what 0.15.x produced.
 * `signed` says whether the pixel and click tokens carry an HMAC (always,
 * once a signing secret exists), so a later hit on the bare id of this email
 * can be recognised as forged. `kinds` (0.17.0, the tracking switches):
 * `clicks: false` leaves the links alone, `opens: false` adds no pixel.
 */
export function wrapTrackedHtml(html: string, eventId: number, kinds: { opens?: boolean; clicks?: boolean } = {}): { html: string; links: LinkMeta[]; signed: boolean } {
    const opens = kinds.opens !== false;
    const clicks = kinds.clicks !== false;
    const base = trackingBaseUrl();
    const ownPrefixes = ownTrackingPrefixes();
    // Signed when a secret exists, so nobody can enumerate ids to forge opens/clicks.
    const secret = getOptions().signingSecret;
    const token = secret ? signValue(String(eventId), secret) : String(eventId);
    const links: LinkMeta[] = [];
    const rewritten = !clicks ? html : html.replace(/<a\b([^>]*?)\bhref\s*=\s*(["'])(.*?)\2/gi, (m: string, attrs: string, q: string, url: string, offset: number) => {
        const trimmed = String(url).trim();
        if (!trimmed) return m;
        if (/^(mailto:|tel:|#)/i.test(trimmed)) return m;
        if (ownPrefixes.some(p => trimmed.startsWith(p))) return m;
        if (/unsubscribe/i.test(trimmed) || /\bopt[-_]?out\b/i.test(trimmed)) return m;
        // Templates HTML-escape query-string separators inside href attributes.
        // Decode them before encoding the target or links such as password
        // resets arrive without a usable token query parameter.
        const target = decodeHtmlHref(trimmed).trim();
        if (links.length < MAX_LINKS) {
            links.push({ i: links.length, t: anchorText(innerHtmlAfter(html, offset + m.length)), s: isSensitiveUrl(target), h: urlFingerprint(target, secret) });
        }
        return `<a${attrs}href=${q}${trackedClickHref(base, token, target, secret)}${q}`;
    });
    const pixel = `<img src="${base}/email-track/open/${token}.gif" width="1" height="1" alt="" border="0" style="border:0;width:1px;height:1px;opacity:0;overflow:hidden">`;
    const out = !opens ? rewritten : /<\/body>/i.test(rewritten) ? rewritten.replace(/<\/body>/i, `${pixel}</body>`) : rewritten + pixel;
    return { html: out, links, signed: !!secret };
}

/** The send event's payload: the link list and whether the tokens are signed. */
export function sendPayload(links: LinkMeta[], signed: boolean): Record<string, unknown> {
    return links.length ? { signed, links } : { signed };
}

/**
 * The correlation value: `<email_log id>-<16 hex HMAC>` signed with the
 * install's signing secret, so an event a shared provider account reports
 * for another shop's email can never be linked to one of ours. Letters,
 * digits and a dash only — valid as an SES message tag value too.
 */
export function correlationToken(emailLogId: number, secret = getOptions().signingSecret): string {
    if (!secret) return String(emailLogId);
    return `${emailLogId}-${createHmac('sha256', secret).update(`hulo-corr|${emailLogId}`).digest('hex').slice(0, 16)}`;
}

/** The email_log id inside a correlation value we issued, or null (wrong install, tampered, malformed). */
export function correlationIdFrom(token: string | null | undefined, secret = getOptions().signingSecret): number | null {
    const m = /^(\d{1,10})(?:-([0-9a-f]{16}))?$/.exec(String(token ?? ''));
    if (!m) return null;
    const id = Number(m[1]);
    if (!(id > 0 && id <= 2147483647)) return null;
    if (!secret) return m[2] ? null : id;
    if (!m[2]) return null;
    const expected = correlationToken(id, secret).split('-')[1];
    return timingSafeEqual(Buffer.from(expected), Buffer.from(m[2])) ? id : null;
}

/**
 * A header value nodemailer writes exactly as given (`prepared`): it would
 * otherwise RFC 2047-encode any value holding a double quote, and SendGrid
 * and Mailgun need the raw JSON of `X-SMTPAPI` / `X-Mailgun-Variables`.
 */
export interface PreparedHeader {
    prepared: true;
    value: string;
}

export type ExtraHeaderValue = string | PreparedHeader;

/** Header names whose value is JSON we may merge with the sender's own. */
const JSON_HEADERS = new Set(['x-smtpapi', 'x-mailgun-variables']);

/**
 * JSON for a prepared header: non-ASCII as `\u` escapes (SendGrid asks for
 * that), and folded over several lines (CRLF + space between tokens, which
 * the receiving MTA unfolds back into valid JSON) when it would not fit in
 * one 998-character header line.
 */
export function preparedJson(v: unknown): PreparedHeader {
    const ascii = (s: string) => s.replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
    const compact = ascii(JSON.stringify(v));
    if (compact.length <= 900) return { prepared: true, value: compact };
    // Pretty-printed JSON breaks only between tokens (strings never hold a raw newline).
    return { prepared: true, value: ascii(JSON.stringify(v, null, 1)).split('\n').join('\r\n ') };
}

/**
 * The correlation header(s) for the providers whose webhooks are configured
 * — only those, so other providers never pass an unknown header on to the
 * recipient. The value is `correlationToken()` — the email_log id with an
 * install HMAC, not personal data; providers echo it back in their events:
 *   SendGrid `X-SMTPAPI` unique_args · Mailgun `X-Mailgun-Variables` ·
 *   Postmark `X-PM-Metadata-hulo-log-id` · SES `X-SES-MESSAGE-TAGS`.
 * The JSON ones are `prepared`, so they reach the provider as raw JSON.
 */
export function correlationHeaders(emailLogId: number): Record<string, ExtraHeaderValue> {
    const pw = getOptions().providerWebhooks;
    const h: Record<string, ExtraHeaderValue> = {};
    if (!pw || !Number.isInteger(emailLogId) || emailLogId <= 0) return h;
    const id = correlationToken(emailLogId);
    if (pw.sendgrid?.verificationKey) h['X-SMTPAPI'] = preparedJson({ unique_args: { [CORRELATION_KEY]: id } });
    if (pw.mailgun?.signingKey) h['X-Mailgun-Variables'] = preparedJson({ [CORRELATION_KEY]: id });
    if (pw.postmark?.username && pw.postmark?.password) h[`X-PM-Metadata-${CORRELATION_KEY}`] = id;
    if (pw.ses?.topicArns?.length) h['X-SES-MESSAGE-TAGS'] = `${CORRELATION_KEY}=${id}`;
    return h;
}

/**
 * Add `extra` to nodemailer's `headers` (object or `[{ key, value }]` list).
 * JSON headers the sender already set (X-SMTPAPI, X-Mailgun-Variables) are
 * merged and sent prepared; any other header the sender set wins.
 */
export function mergeHeaders(existing: any, extra: Record<string, ExtraHeaderValue>): any {
    if (!Object.keys(extra).length) return existing;
    if (Array.isArray(existing)) {
        const out = existing.slice();
        for (const [k, v] of Object.entries(extra)) {
            const i = out.findIndex((h: any) => String(h?.key || '').toLowerCase() === k.toLowerCase());
            if (i < 0) out.push({ key: k, value: v });
            else out[i] = { key: out[i].key, value: mergeJsonHeader(k, out[i].value, v) };
        }
        return out;
    }
    const out: Record<string, any> = { ...(existing && typeof existing === 'object' ? existing : {}) };
    for (const [k, v] of Object.entries(extra)) {
        const found = Object.keys(out).find(x => x.toLowerCase() === k.toLowerCase());
        if (!found) out[k] = v;
        else out[found] = mergeJsonHeader(k, out[found], v);
    }
    return out;
}

const headerText = (v: any): string => (typeof v === 'string' ? v : String(v?.value ?? ''));

function mergeJsonHeader(name: string, current: any, add: ExtraHeaderValue): any {
    const lower = name.toLowerCase();
    if (!JSON_HEADERS.has(lower)) return current;
    try {
        // A folded value (CRLF + space) unfolds to plain JSON whitespace.
        const a = JSON.parse(headerText(current).replace(/\r?\n[ \t]*/g, ' '));
        const b = JSON.parse(headerText(add).replace(/\r?\n[ \t]*/g, ' '));
        if (!a || typeof a !== 'object' || Array.isArray(a)) return current;
        if (lower === 'x-smtpapi') return preparedJson({ ...a, unique_args: { ...(a.unique_args || {}), ...(b.unique_args || {}) } });
        return preparedJson({ ...a, ...b });
    } catch {
        return current;
    }
}

/**
 * The provider's message id from the SMTP reply, when it carries one:
 * `250 2.0.0 Ok: queued as 4ZxB2k0Qy1z3` (Postfix, SendGrid, Postmark, …)
 * or Amazon SES `250 Ok 0100018b5e6f7a8b-…-000000`.
 */
export function providerMessageIdFromSmtpReply(response: unknown): string | null {
    const s = String(response || '').slice(0, 1000);
    let m = /queued as\s+<?([A-Za-z0-9][A-Za-z0-9._@:+=-]{2,200})>?/i.exec(s);
    if (m) return m[1].replace(/[.,;]+$/, '').slice(0, 255);
    // SES SMTP ("250 Ok <id>") and nodemailer's SES API transport (the bare id).
    m = /^(?:250[ -](?:2\.\d\.\d\s+)?Ok\s+)?<?([0-9a-f]{16}(?:-[0-9a-f]+){5}-\d{6})>?\s*$/i.exec(s.trim());
    if (m) return m[1];
    return null;
}
