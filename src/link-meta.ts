import { createHash, createHmac } from 'crypto';

/**
 * Link metadata and sensitive-URL redaction for mail the plugin wraps
 * (TrackingEmailSender / sendTracked) and for the click URLs providers
 * report. Neither changes the tracked URL or its signature, so links in
 * already-sent emails keep working.
 */

/** Query parameter names (or name parts) that carry secrets. */
const SENSITIVE_PARTS = new Set([
    'token', 'code', 'key', 'sig', 'signature', 'auth', 'password', 'reset', 'otp',
    'session', 'sess', 'sid', 'jwt', 'apikey', 'magic', 'pin', 'nonce', 'hash', 'ticket', 'secret', 'passwd', 'pwd',
    'pass', 'passcode', 'credential', 'credentials', 'assertion', 'saml', 'verify', 'verification', 'confirm',
    'confirmation', 'activation', 'invite',
]);
/** Substrings that mark a secret whatever the separators (accesstoken, resetpassword, phpsessid). */
const SENSITIVE_SUBSTRINGS = ['token', 'password', 'passwd', 'signature', 'secret', 'apikey', 'session', 'sessid', 'jwt', 'credential'];
/** Path segments (or segment parts) of account-action URLs: their query, and token-like
 *  segments after them, are never recorded. */
const SENSITIVE_PATH_PARTS = new Set([
    'reset', 'password', 'passwd', 'verify', 'verification', 'confirm', 'confirmation', 'activate', 'activation',
    'login', 'signin', 'logon', 'magic', 'auth', 'oauth', 'oauth2', 'sso', 'saml', 'token', 'tokens', 'otp', 'invite',
    'invitation', 'session', 'unsubscribe', 'recover', 'recovery', 'forgot',
]);

/** True when a query parameter name looks like it carries a secret. */
export function isSensitiveParamName(name: string): boolean {
    const n = String(name).toLowerCase();
    if (SENSITIVE_SUBSTRINGS.some(s => n.includes(s))) return true;
    return n.split(/[^a-z0-9]+/).some(part => SENSITIVE_PARTS.has(part));
}

/** True when a path segment names an account action (reset, verify, login, magic link, …). */
function isSensitiveSegment(segment: string): boolean {
    let s = segment.toLowerCase();
    try { s = decodeURIComponent(s); } catch { /* keep as is */ }
    if (SENSITIVE_PATH_PARTS.has(s.replace(/[^a-z0-9]/g, ''))) return true;
    return s.split(/[^a-z0-9]+/).some(part => SENSITIVE_PATH_PARTS.has(part));
}

/**
 * The path with token-like segments after an account-action segment replaced
 * by `[redacted]` (`/password/reset/9f8e7d…` → `/password/reset/[redacted]`).
 * A segment counts as a token when it holds a digit or is 16+ characters.
 */
function redactPath(pathname: string): { path: string; sensitive: boolean; changed: boolean } {
    const segments = pathname.split('/');
    let sensitive = false;
    let changed = false;
    const out = segments.map(seg => {
        if (!seg) return seg;
        if (sensitive && seg !== '[redacted]' && (/\d/.test(seg) || seg.length >= 16)) { changed = true; return '[redacted]'; }
        if (isSensitiveSegment(seg)) sensitive = true;
        return seg;
    });
    return { path: out.join('/'), sensitive, changed };
}

/** A parameter value that is itself a URL (redirect targets: `next`, `u`, `return`, …), decoded up to twice. */
function nestedUrl(value: string, base: URL): string | null {
    let s = String(value || '').trim();
    for (let i = 0; i < 3 && s; i++) {
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^\/[^/\\]/.test(s) || s === '/') {
            try { return new URL(s, `${base.protocol}//${base.host}`).href; } catch { return null; }
        }
        let decoded: string;
        try { decoded = decodeURIComponent(s); } catch { return null; }
        if (decoded === s) return null;
        s = decoded.trim();
    }
    return null;
}

/** A query value that is (or holds) an email address: `bea@example.com`, `<bea@example.com>`. */
const ADDRESS_IN_VALUE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/;

/**
 * True when a URL would leak a secret if recorded: user info in the URL, a
 * token-like query parameter (token, code, key, sig, signature, auth,
 * password, reset, otp, session, jwt, apikey, pin, magic, …), a parameter
 * whose value is an email address (`?email=bea@example.com` — the recipient
 * is never stored in clear), a parameter whose value is a URL that is itself
 * sensitive (`?next=/reset?token=…`), a `key=value` fragment
 * (`#access_token=…`), or an account-action path (reset, verify, confirm,
 * login, magic link, unsubscribe, …) with a query or a token-like segment.
 */
export function isSensitiveUrl(url: string, depth = 0): boolean {
    let u: URL;
    try { u = new URL(url); } catch { return false; }
    if (u.username || u.password) return true;
    for (const [k, v] of u.searchParams) {
        if (isSensitiveParamName(k)) return true;
        if (v.includes('@') && ADDRESS_IN_VALUE.test(v)) return true;
        if (depth < 3) {
            const nested = nestedUrl(v, u);
            if (nested && isSensitiveUrl(nested, depth + 1)) return true;
        }
    }
    if (u.hash.includes('=')) return true;
    const p = redactPath(u.pathname);
    return p.sensitive && (!!u.search || p.changed);
}

/** True when the URL's query string has a token-like parameter (or the URL is otherwise sensitive). */
export function hasSensitiveQuery(url: string): boolean {
    return isSensitiveUrl(url);
}

/**
 * The form of a URL that is safe to record: `https://host/path?[redacted]`
 * when `isSensitiveUrl` (query and fragment dropped, user info dropped,
 * token-like segments after an account-action segment replaced by
 * `[redacted]`), else the URL unchanged. Used for what is *recorded*; the
 * redirect still goes to the real URL. Idempotent.
 */
export function redactSensitiveUrl(url: string): string {
    if (!url || !isSensitiveUrl(url)) return url;
    try {
        const u = new URL(url);
        const { path } = redactPath(u.pathname);
        return `${u.protocol}//${u.host}${path}${u.search || u.hash ? '?[redacted]' : ''}`;
    } catch {
        return url;
    }
}

/**
 * 16-hex fingerprint of a tracked destination — how a click finds its link
 * entry. Keyed with the install's signing secret (HMAC) when there is one,
 * and taken over the *redacted* form of a sensitive URL, so neither an
 * export nor a database copy lets anyone recover a low-entropy code by
 * trying candidates.
 */
export function urlFingerprint(url: string, secret?: string | null): string {
    const material = `hulo-link|${redactSensitiveUrl(url)}`;
    return (secret ? createHmac('sha256', secret) : createHash('sha256')).update(material).digest('hex').slice(0, 16);
}

/** One rewritten link: index among tracked links, anchor text, sensitive flag, URL fingerprint. */
export interface LinkMeta {
    i: number;
    t: string;
    s: boolean;
    h: string;
}

/** Visible text of an anchor's inner HTML, tags stripped, at most 120 characters. */
export function anchorText(innerHtml: string): string {
    let text = innerHtml
        .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#0*39;|&apos;/gi, "'")
        .replace(/&#(\d{1,6});/g, (_m, d) => safeChar(Number(d)))
        .replace(/&#x([0-9a-f]{1,6});/gi, (_m, h) => safeChar(parseInt(h, 16)))
        .replace(/\s+/g, ' ')
        .trim();
    if (!text) {
        const alt = /<img\b[^>]*\balt\s*=\s*(["'])(.*?)\1/i.exec(innerHtml);
        if (alt && alt[2].trim()) text = `[image: ${alt[2].trim()}]`;
    }
    return text.slice(0, 120);
}

function safeChar(cp: number): string {
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : ' ';
}

/** The inner HTML of the anchor whose opening `<a … href=…` match ends at `from`. */
export function innerHtmlAfter(html: string, from: number): string {
    const close = html.indexOf('>', from);
    if (close < 0) return '';
    const end = html.slice(close + 1).search(/<\/a\s*>/i);
    if (end < 0) return '';
    return html.slice(close + 1, close + 1 + Math.min(end, 4000));
}

/** Find the entry for a clicked destination (first match on its fingerprint). */
export function findLink(links: LinkMeta[] | null | undefined, url: string, secret?: string | null): LinkMeta | null {
    if (!Array.isArray(links) || !url) return null;
    const h = urlFingerprint(url, secret);
    return links.find(l => l && l.h === h) || null;
}

/** Cap for the stored list (a newsletter-sized email stays a few KB). */
export const MAX_LINKS = 100;
