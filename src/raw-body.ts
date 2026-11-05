import { applySecurityHeaders } from '@huloglobal/vendure-licence-sdk';
import { createGunzip, createInflate } from 'zlib';
import { PROVIDER_SLUGS, ProviderSlug } from './event-types';
import { getLimiter, getWebhookLimits, realIp } from './http-helpers';
import { configuredSigningSecret, getOptions } from './options';

/** The largest provider webhook body (SendGrid and Postmark). */
export const WEBHOOK_BODY_LIMIT = 1024 * 1024;
/**
 * Body cap per provider slug, the same whether the provider is configured or
 * not: SendGrid posts batches of up to 768 KB, and Postmark can add the full
 * bounce dump ("Include bounce content"); a Mailgun event is a few KB; an SNS
 * message is at most 256 KB, a little more once escaped into its envelope.
 */
export const WEBHOOK_BODY_LIMITS: Readonly<Record<ProviderSlug, number>> = {
    sendgrid: WEBHOOK_BODY_LIMIT,
    postmark: WEBHOOK_BODY_LIMIT,
    mailgun: 256 * 1024,
    ses: 320 * 1024,
};
/**
 * Providers whose signature or credentials travel outside the JSON body
 * (SendGrid's signature headers, Postmark's Basic auth): their body is kept
 * as bytes and parsed only after the check passed, so an unauthenticated
 * request never costs a JSON parse. Mailgun and SNS sign fields inside the
 * body, which therefore has to be parsed first.
 */
export const PARSE_AFTER_VERIFY: ReadonlySet<ProviderSlug> = new Set<ProviderSlug>(['postmark', 'sendgrid']);
/**
 * Deepest nesting of arrays / objects accepted in a body parsed before its
 * signature is checked (Mailgun, SNS). No provider nests more than a few
 * levels, and deep nesting is what makes `JSON.parse` slow: a 1 MB body of
 * nested arrays costs about 150 ms of event loop.
 */
export const WEBHOOK_MAX_JSON_DEPTH = 32;
/**
 * Most arrays + objects accepted in a body parsed before its signature is
 * checked (Mailgun, SNS): a Mailgun event has about 25, an SNS envelope 4
 * (the SES notification is a string inside it). Parse time grows with their
 * number — 320 KB of small nested arrays still costs tens of milliseconds.
 */
export const WEBHOOK_MAX_JSON_CONTAINERS = 1000;
/** Body cap for `/email-track/bounce`: the 100 KB of the global JSON parser it used before 0.16.0. */
export const BOUNCE_BODY_LIMIT = 100 * 1024;
/** A request body must arrive within this time; slower ones are answered 408 and closed. */
export const BODY_READ_TIMEOUT_MS = 10_000;

/**
 * Route-scoped body capture for `/email-track/webhook/:provider` and
 * `/email-track/bounce`, registered by the plugin's `configuration` as
 * `beforeListen` middleware (the way Vendure's StripePlugin captures its raw
 * body). It keeps the exact bytes on `req.rawBody` — SendGrid signs them, and
 * the bounce HMAC is computed over them — and parses JSON into `req.body`
 * (for SendGrid and Postmark only after verification, in the controller).
 *
 * Before reading a byte it answers what needs no body: 404 for an unknown
 * provider slug, 429 for an address that has used up its allowance, 415 for
 * an unsupported type or encoding, 413 for a declared length over the cap —
 * the same checks for every known provider slug, configured or not, so the
 * answers reveal nothing about which providers are on (the controller
 * answers 401 for an unconfigured one after the same body read). Early
 * answers close the connection instead of draining or buffering the body.
 * A body must arrive within 10 s (408).
 *
 * Dependency-free (Node built-ins only): body-parser is not a declared
 * dependency of Vendure core, so a strict package manager would not let this
 * plugin import it.
 */

interface CaptureOptions {
    limit: number;
    /** Inflate gzip / deflate bodies (the bounce route, like the global parser before 0.16.0). */
    inflate: boolean;
    timeoutMs?: number;
    /** Called with the status of every request this capture answers itself (415, 413, 408, 400). */
    onReject?: (status: number) => void;
    /** Keep the bytes only (`req.huloBodyDeferred`): the handler parses them with `parseJsonBody` once it trusts them. */
    deferParse?: boolean;
    /** Answer 400 instead of parsing a body nested deeper than this (arrays and objects). */
    maxDepth?: number;
    /** Answer 400 instead of parsing a body with more arrays + objects than this. */
    maxContainers?: number;
}

/**
 * True when no array / object in `raw` nests deeper than `maxDepth` levels
 * and there are at most `maxContainers` of them: one pass over the bytes,
 * string contents skipped (a malformed body passes and then fails to parse).
 */
export function jsonShapeWithin(raw: Buffer, maxDepth: number, maxContainers = Infinity): boolean {
    let depth = 0;
    let containers = 0;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (c === 0x5c) escaped = true; // backslash
            else if (c === 0x22) inString = false; // "
            continue;
        }
        if (c === 0x22) inString = true;
        else if (c === 0x5b || c === 0x7b) { if (++depth > maxDepth || ++containers > maxContainers) return false; } // [ {
        else if (c === 0x5d || c === 0x7d) depth--; // ] }
    }
    return true;
}

/** `raw` as JSON (a leading BOM ignored, an empty body is `{}`); `invalid` when it does not parse. */
export function parseJsonBody(raw: Buffer | undefined | null): { body: any; invalid: boolean } {
    const text = (raw ? raw.toString('utf8') : '').replace(/^\uFEFF/, '');
    if (!text.trim()) return { body: {}, invalid: false };
    try {
        return { body: JSON.parse(text), invalid: false };
    } catch {
        return { body: {}, invalid: true };
    }
}

/** Answer without reading the body, and close the connection so nothing is drained. */
function reject(res: any, status: number, extra: Record<string, string> = {}, json?: unknown): void {
    if (res.headersSent) return;
    try { applySecurityHeaders(res, { strict: true }); } catch { /* mock responses */ }
    for (const [k, v] of Object.entries(extra)) res.setHeader?.(k, v);
    res.setHeader?.('Connection', 'close');
    res.statusCode = status;
    if (json !== undefined) {
        res.setHeader?.('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(json));
    } else {
        res.end();
    }
}

const contentType = (req: any) => String(req.headers?.['content-type'] || '').toLowerCase();
const isJson = (type: string) => /^application\/json\s*(;|$)/.test(type);
const isTextPlain = (type: string) => /^text\/plain\s*(;|$)/.test(type);

/**
 * Read the body into `req.rawBody` / `req.body` and call `next()`, or answer
 * 413 / 400 / 408 itself (400: unreadable, nested deeper than `maxDepth`
 * or with more than `maxContainers` arrays + objects). With `deferParse` the
 * body is not parsed: `req.body` is `{}` and `req.huloBodyDeferred` is set.
 * Exported for the unit tests.
 */
export function captureBody(req: any, res: any, next: (err?: any) => void, opts: CaptureOptions): void {
    const limit = opts.limit;
    const refuse = (status: number) => { opts.onReject?.(status); reject(res, status); };
    const encoding = String(req.headers?.['content-encoding'] || 'identity').trim().toLowerCase();
    if (encoding !== 'identity' && !(opts.inflate && (encoding === 'gzip' || encoding === 'deflate'))) return refuse(415);
    const declared = Number(req.headers?.['content-length']);
    if (Number.isFinite(declared) && declared > limit) return refuse(413);

    let stream: any = req;
    if (encoding === 'gzip') stream = req.pipe(createGunzip());
    else if (encoding === 'deflate') stream = req.pipe(createInflate());
    let chunks: Buffer[] = [];
    let size = 0;
    let wire = 0;
    let done = false;
    const finish = () => {
        done = true;
        clearTimeout(timer);
        chunks = [];
    };
    const fail = (status: number) => {
        if (done) return;
        finish();
        try { if (stream !== req) { req.unpipe?.(stream); stream.destroy?.(); } } catch { /* ignore */ }
        refuse(status);
    };
    const timer = setTimeout(() => fail(408), opts.timeoutMs ?? BODY_READ_TIMEOUT_MS);
    (timer as any).unref?.();
    if (stream !== req) {
        // The compressed bytes count against the cap too.
        req.on('data', (chunk: Buffer) => { wire += chunk.length; if (wire > limit) fail(413); });
    }
    stream.on('data', (chunk: Buffer) => {
        if (done) return;
        size += chunk.length;
        if (size > limit) return fail(413);
        chunks.push(chunk);
    });
    stream.on('error', () => fail(400));
    // The client went away before the end: drop what was read. ('close' also
    // follows a complete request, possibly before the inflater has finished.)
    let received = false;
    req.on('end', () => { received = true; });
    req.on('close', () => { if (!done && !received) finish(); });
    stream.on('end', () => {
        if (done) return;
        const raw = Buffer.concat(chunks);
        // Refused before JSON.parse ever sees it: many or deeply nested arrays / objects are what make parsing slow.
        if (!opts.deferParse && (opts.maxDepth || opts.maxContainers)
            && !jsonShapeWithin(raw, opts.maxDepth ?? Infinity, opts.maxContainers ?? Infinity)) return fail(400);
        finish();
        req.rawBody = raw;
        // Mark the body as read so the global parsers skip this request.
        req._body = true;
        if (opts.deferParse) {
            req.body = {};
            req.huloBodyDeferred = true;
            return next();
        }
        const parsed = parseJsonBody(raw);
        req.body = parsed.body;
        if (parsed.invalid) req.huloBodyInvalid = true;
        next();
    });
}

/** The provider slug of a request mounted at `/email-track/webhook` (one path segment), or null. */
function slugOf(req: any): string | null {
    const m = /^\/([^/?#]+)\/?(?:[?#]|$)/.exec(String(req.url || ''));
    if (!m) return null;
    try { return decodeURIComponent(m[1]).toLowerCase(); } catch { return null; }
}

/**
 * `POST /email-track/webhook/:provider`: unknown slug 404; an address that
 * has used up its failure allowance 429 (`providerWebhooks.rateLimit.failed`
 * — only rejected requests spend it, never verified ones); then, by slug and
 * never by whether the provider is configured: JSON (`application/json`, any
 * provider) or, for `ses` only, `text/plain` (SNS posts its JSON envelope as
 * text/plain), identity encoding only (no provider compresses webhooks), at
 * most `WEBHOOK_BODY_LIMITS` (1 MB SendGrid and Postmark, 320 KB SES, 256 KB
 * Mailgun) and, for the bodies parsed before verification (Mailgun, SES), at
 * most 32 levels of nesting and 1 000 arrays + objects — 415 / 413 / 408 /
 * 400 otherwise, each charged to the failure allowance. SendGrid and
 * Postmark bodies are kept as bytes and parsed only after their check passed
 * (`PARSE_AFTER_VERIFY`). Whether the provider is configured is the
 * controller's first check, after the body is read like any other.
 * `limits` (tests): one cap for every slug.
 */
export function providerWebhookBodyMiddleware(limits: number | Readonly<Record<ProviderSlug, number>> = WEBHOOK_BODY_LIMITS) {
    return function huloEmailTrackingWebhookBody(req: any, res: any, next: (err?: any) => void) {
        if (req.method !== 'POST') return next();
        const slug = slugOf(req) as ProviderSlug | null;
        if (!slug || !(PROVIDER_SLUGS as readonly string[]).includes(slug)) return reject(res, 404);
        const ip = realIp(req);
        const webhookLimits = getWebhookLimits();
        if (webhookLimits.blocked(ip)) return reject(res, 429, { 'Retry-After': '60' });
        req.huloRateChecked = true;
        if (req._body || req.rawBody) return next();
        const type = contentType(req);
        if (!isJson(type) && !(slug === 'ses' && isTextPlain(type))) {
            webhookLimits.chargeFailure(ip);
            return reject(res, 415);
        }
        captureBody(req, res, next, {
            limit: typeof limits === 'number' ? limits : limits[slug] ?? WEBHOOK_BODY_LIMIT,
            inflate: false,
            onReject: () => webhookLimits.chargeFailure(ip),
            deferParse: PARSE_AFTER_VERIFY.has(slug),
            maxDepth: WEBHOOK_MAX_JSON_DEPTH,
            maxContainers: WEBHOOK_MAX_JSON_CONTAINERS,
        });
    };
}

/**
 * `POST /email-track/bounce`: while the endpoint is disabled (no secret and
 * no `allowUnauthenticatedBounceWebhook`) nothing is read and the controller
 * answers 503; otherwise the rate limit (429) before reading, then
 * `application/json` only — as the global parser accepted before 0.16.0, so
 * a web page cannot post a cross-site "simple" `text/plain` or form request —
 * gzip / deflate inflated, at most 100 KB.
 */
export function bounceBodyMiddleware(limit = BOUNCE_BODY_LIMIT) {
    return function huloEmailTrackingBounceBody(req: any, res: any, next: (err?: any) => void) {
        if (req.method !== 'POST' || !/^\/?(?:[?#]|$)/.test(String(req.url || ''))) return next();
        if (req._body || req.rawBody) return next();
        const opts = getOptions();
        if (!(opts.bounceWebhookSecret || configuredSigningSecret()) && !opts.allowUnauthenticatedBounceWebhook) {
            // The controller answers 503 without looking at the body; never read it.
            req._body = true;
            req.body = {};
            res.setHeader?.('Connection', 'close');
            return next();
        }
        const ip = realIp(req);
        if (ip && !getLimiter().allow(`bounce|${ip}`)) return reject(res, 429, { 'Retry-After': '60' }, { error: 'Too many requests' });
        req.huloRateChecked = true;
        if (!isJson(contentType(req))) return reject(res, 415, {}, { error: 'Content-Type must be application/json' });
        captureBody(req, res, next, { limit, inflate: true });
    };
}
