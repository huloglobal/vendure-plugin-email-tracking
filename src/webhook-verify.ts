import { createHash, createHmac, createPublicKey, createVerify, KeyObject, timingSafeEqual, verify as cryptoVerify, X509Certificate } from 'crypto';

/**
 * Signature verification for the provider webhooks at
 * `POST /email-track/webhook/:provider`. Every function here is pure apart
 * from the SNS certificate fetch, which is injectable. They never throw:
 * a malformed input is simply "not verified".
 */

/** Constant-time equality of two strings of any length (compares SHA-256 digests). */
export function safeEqualStrings(a: string, b: string): boolean {
    const ha = createHash('sha256').update(String(a), 'utf8').digest();
    const hb = createHash('sha256').update(String(b), 'utf8').digest();
    return timingSafeEqual(ha, hb);
}

// ── Postmark: HTTP Basic auth ──────────────────────────────────────────

/** `Authorization: Basic base64(user:pass)` against the configured pair, constant time. */
export function verifyPostmarkAuth(authorization: string | undefined, cfg: { username: string; password: string } | undefined): boolean {
    if (!cfg || !cfg.username || !cfg.password) return false;
    const h = String(authorization || '');
    const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(h);
    if (!m) return false;
    let decoded = '';
    try { decoded = Buffer.from(m[1], 'base64').toString('utf8'); } catch { return false; }
    const idx = decoded.indexOf(':');
    if (idx < 0) return false;
    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);
    // Both halves are always compared, so timing does not reveal which one failed.
    const okUser = safeEqualStrings(user, cfg.username);
    const okPass = safeEqualStrings(pass, cfg.password);
    return okUser && okPass;
}

// ── SendGrid: ECDSA P-256 / SHA-256 over timestamp + raw body ──────────

/** The verification key as shown in SendGrid's UI: base64 DER (SPKI) or PEM. Null when unusable. */
export function parseSendgridKey(key: string | undefined): KeyObject | null {
    if (!key || typeof key !== 'string') return null;
    try {
        const k = key.trim();
        const obj = k.includes('BEGIN PUBLIC KEY')
            ? createPublicKey(k)
            : createPublicKey({ key: Buffer.from(k.replace(/\s+/g, ''), 'base64'), format: 'der', type: 'spki' });
        if (obj.asymmetricKeyType !== 'ec') return null;
        const curve = (obj as any).asymmetricKeyDetails?.namedCurve;
        if (curve && curve !== 'prime256v1') return null;
        return obj;
    } catch {
        return null;
    }
}

/**
 * How far a SendGrid signature timestamp may be from now. Longer than
 * SendGrid's 24-hour retry horizon, so a retry always verifies; a captured
 * request cannot be replayed after that (while it is inside the window its
 * dedupe row, kept at least 3 days by the retention sweeper, makes a replay
 * a no-op).
 */
export const SENDGRID_MAX_SKEW_SEC = 72 * 3600;

/**
 * `x-twilio-email-event-webhook-signature` (base64 DER ECDSA signature) over
 * `x-twilio-email-event-webhook-timestamp` + the exact raw request body. A
 * timestamp more than 72 hours from now is refused.
 */
export function verifySendgridSignature(
    key: KeyObject | null,
    signatureB64: string | undefined,
    timestamp: string | undefined,
    rawBody: Buffer | undefined,
    now = Date.now(),
): boolean {
    if (!key || !signatureB64 || !timestamp || !rawBody || !Buffer.isBuffer(rawBody)) return false;
    const ts = String(timestamp).trim();
    if (!/^\d{1,13}$/.test(ts)) return false;
    if (Math.abs(now / 1000 - Number(ts)) > SENDGRID_MAX_SKEW_SEC) return false;
    try {
        const sig = Buffer.from(String(signatureB64).trim(), 'base64');
        if (!sig.length) return false;
        const payload = Buffer.concat([Buffer.from(ts, 'utf8'), rawBody]);
        return cryptoVerify('sha256', payload, { key, dsaEncoding: 'der' }, sig);
    } catch {
        return false;
    }
}

// ── Mailgun: HMAC-SHA256(signingKey, timestamp + token), replay window ──

export const MAILGUN_MAX_SKEW_SEC = 15 * 60;

/**
 * Bounded memory of Mailgun tokens already accepted. A token only needs
 * remembering while its timestamp is inside the ±15-minute window. The
 * controller reserves a token (`add`) synchronously right after it
 * verifies — before any await — so concurrent requests carrying the same
 * signed token are refused, and releases it (`delete`) when processing
 * failed, so Mailgun's retry is accepted. Per process: with several server
 * instances a token can be accepted once by each inside the window.
 */
export class ReplayCache {
    private readonly seen = new Map<string, number>();
    constructor(private readonly maxEntries = 10_000, private readonly ttlMs = 2 * MAILGUN_MAX_SKEW_SEC * 1000) {}

    has(token: string, now = Date.now()): boolean {
        const exp = this.seen.get(token);
        if (exp === undefined) return false;
        if (exp <= now) { this.seen.delete(token); return false; }
        return true;
    }

    add(token: string, now = Date.now()): void {
        // Drop expired entries from the front (insertion order ≈ expiry order).
        for (const [k, exp] of this.seen) {
            if (exp > now && this.seen.size < this.maxEntries) break;
            this.seen.delete(k);
        }
        this.seen.set(token, now + this.ttlMs);
    }

    /** Forget a token (its request failed on our side; the provider will retry). */
    delete(token: string): void {
        this.seen.delete(token);
    }

    get size(): number { return this.seen.size; }
}

export type MailgunVerdict = 'ok' | 'bad-signature' | 'stale' | 'replay';

/**
 * Verify Mailgun's `signature: { timestamp, token, signature }` block. On
 * `ok` the caller reserves the token at once (`cache.add`, before any await)
 * and releases it (`cache.delete`) if processing fails, so a delivery that
 * failed on our side can be retried. Mailgun signs only timestamp + token,
 * not the event data: the replay cache is what stops a captured signature
 * being reused with other events.
 */
export function verifyMailgunSignature(
    sig: { timestamp?: unknown; token?: unknown; signature?: unknown } | undefined,
    signingKey: string | undefined,
    cache: ReplayCache,
    now = Date.now(),
): MailgunVerdict {
    if (!signingKey || !sig) return 'bad-signature';
    const ts = String(sig.timestamp ?? '');
    const token = String(sig.token ?? '');
    const provided = String(sig.signature ?? '').toLowerCase();
    if (!/^\d{1,12}$/.test(ts) || !token || token.length > 256 || !/^[0-9a-f]{64}$/.test(provided)) return 'bad-signature';
    const expected = createHmac('sha256', signingKey).update(ts + token).digest('hex');
    if (!timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(provided, 'utf8'))) return 'bad-signature';
    if (Math.abs(now / 1000 - Number(ts)) > MAILGUN_MAX_SKEW_SEC) return 'stale';
    if (cache.has(token, now)) return 'replay';
    return 'ok';
}

// ── Amazon SES via SNS: message signature ───────────────────────────────

export type CertFetcher = (url: string) => Promise<string>;

/** Region names as AWS writes them: eu-west-1, us-gov-west-1, cn-north-1, ap-southeast-2 … */
const AWS_REGION = /^[a-z]{2}(-gov|-iso[a-z]?)?-[a-z]+-\d{1,2}$/;
const SNS_CERT_PATH = /^\/SimpleNotificationService-[0-9a-f]{16,64}\.pem$/i;

/** Partition and region of an SNS topic ARN (`arn:aws:sns:eu-west-1:123456789012:name`), or null. */
export function snsTopicRegion(topicArn: unknown): { partition: string; region: string } | null {
    const m = /^arn:(aws|aws-cn|aws-us-gov):sns:([a-z0-9-]+):\d{12}:[A-Za-z0-9_.-]{1,256}$/.exec(String(topicArn ?? ''));
    if (!m || !AWS_REGION.test(m[2])) return null;
    return { partition: m[1], region: m[2] };
}

/** The only SNS endpoint host a message on this topic can name: `sns.<the topic's region>.amazonaws.com` (`.com.cn` in China). */
export function snsHostForTopic(topicArn: unknown): string | null {
    const t = snsTopicRegion(topicArn);
    if (!t) return null;
    return `sns.${t.region}.amazonaws.com${t.partition === 'aws-cn' ? '.cn' : ''}`;
}

/**
 * `SigningCertURL` must be https on exactly `sns.<region>.amazonaws.com(.cn)`
 * for the region of the (allowlisted) topic, with a
 * `/SimpleNotificationService-<hex>.pem` path — never another host under
 * amazonaws.com (an S3 bucket called "sns" lives at sns.s3.amazonaws.com) —
 * and written in its canonical form, as AWS always sends it: no explicit
 * `:443`, dot-segments, percent-encoded dots, embedded tabs or upper-case
 * host. Each spelling would otherwise be its own cache entry and fetch.
 */
export function isValidSnsCertUrl(raw: unknown, topicArn: unknown): boolean {
    if (typeof raw !== 'string' || raw.length > 1024) return false;
    const host = snsHostForTopic(topicArn);
    if (!host) return false;
    try {
        const u = new URL(raw);
        return u.href === raw && u.protocol === 'https:' && !u.username && !u.password && !u.port && !u.search && !u.hash
            && u.hostname === host && SNS_CERT_PATH.test(u.pathname);
    } catch {
        return false;
    }
}

/** A `SubscribeURL` we may fetch: https on the topic's own `sns.<region>.amazonaws.com(.cn)`, Action=ConfirmSubscription for this topic. */
export function isValidSnsSubscribeUrl(raw: unknown, topicArn: string): boolean {
    if (typeof raw !== 'string' || raw.length > 4096) return false;
    const host = snsHostForTopic(topicArn);
    if (!host) return false;
    try {
        const u = new URL(raw);
        return u.protocol === 'https:' && !u.username && !u.password && !u.port
            && u.hostname.toLowerCase() === host
            && u.searchParams.get('Action') === 'ConfirmSubscription'
            && u.searchParams.get('TopicArn') === topicArn;
    } catch {
        return false;
    }
}

/** The canonical string SNS signs, per message `Type`; null for an unknown type or a missing field. */
export function snsStringToSign(m: any): string | null {
    if (!m || typeof m !== 'object') return null;
    let keys: string[];
    if (m.Type === 'Notification') {
        keys = ['Message', 'MessageId', ...(m.Subject !== undefined && m.Subject !== null ? ['Subject'] : []), 'Timestamp', 'TopicArn', 'Type'];
    } else if (m.Type === 'SubscriptionConfirmation' || m.Type === 'UnsubscribeConfirmation') {
        keys = ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
    } else {
        return null;
    }
    let out = '';
    for (const k of keys) {
        if (typeof m[k] !== 'string') return null;
        out += `${k}\n${m[k]}\n`;
    }
    return out;
}

/** How long a failed certificate fetch is remembered (a burst of messages naming it makes one request). */
export const CERT_FAILURE_TTL_MS = 15_000;
/** New certificate fetches per minute in all (a flood of distinct URLs cannot become a flood of requests). */
export const CERT_FETCHES_PER_MINUTE = 60;
/**
 * New certificate fetches one client address can cause per minute. Checked
 * first, so a sender of unsigned messages naming made-up certificate URLs
 * (it only needs to know one allowlisted topic ARN) spends its own
 * allowance, not the one the real SNS deliveries need after a restart or a
 * certificate rotation; using up the global one takes
 * `CERT_FETCHES_PER_MINUTE / CERT_FETCHES_PER_CLIENT_PER_MINUTE` (30)
 * addresses, and a cached certificate still serves meanwhile, also expired.
 */
export const CERT_FETCHES_PER_CLIENT_PER_MINUTE = 2;

/**
 * Bounded TTL cache for SNS signing certificates (they rotate rarely), with
 * a short negative cache for URLs that failed, one shared fetch per URL in
 * flight, and at most `CERT_FETCHES_PER_CLIENT_PER_MINUTE` new fetches a
 * minute per client address and `CERT_FETCHES_PER_MINUTE` in all. An expired
 * entry stays readable (`stale`) for when an allowance is used up: the
 * certificate's own validity dates are still checked.
 */
export class CertCache {
    private readonly entries = new Map<string, { pem: string; expires: number }>();
    private readonly failures = new Map<string, number>();
    private readonly inflight = new Map<string, Promise<string>>();
    private fetchTimes: number[] = [];
    /** Recent fetch times per client address (bounded: the least recently used address goes first). */
    private readonly clientFetches = new Map<string, number[]>();
    constructor(private readonly maxEntries = 16, private readonly ttlMs = 24 * 3600_000, private readonly failureTtlMs = CERT_FAILURE_TTL_MS,
        private readonly fetchesPerMinute = CERT_FETCHES_PER_MINUTE, private readonly perClientPerMinute = CERT_FETCHES_PER_CLIENT_PER_MINUTE,
        private readonly maxClients = 10_000) {}
    get(url: string, now = Date.now()): string | null {
        const e = this.entries.get(url);
        if (!e || e.expires <= now) return null;
        return e.pem;
    }
    /** The cached certificate for `url`, also past its cache lifetime. */
    stale(url: string): string | null {
        return this.entries.get(url)?.pem ?? null;
    }
    /** True while a fetch of `url` is running (joining it costs nothing). */
    isFetching(url: string): boolean {
        return this.inflight.has(url);
    }
    /** Take one of this minute's fetches — `client`'s own allowance first, then the global one; false when either is used up. */
    tryStartFetch(now = Date.now(), client?: string | null): boolean {
        this.fetchTimes = this.fetchTimes.filter(t => t > now - 60_000);
        const mine = client ? (this.clientFetches.get(client) || []).filter(t => t > now - 60_000) : null;
        if (mine && mine.length >= this.perClientPerMinute) return false;
        if (this.fetchTimes.length >= this.fetchesPerMinute) return false;
        this.fetchTimes.push(now);
        if (client && mine) {
            mine.push(now);
            this.clientFetches.delete(client); // re-insert: most recently used last
            if (this.clientFetches.size >= this.maxClients) {
                const oldest = this.clientFetches.keys().next().value;
                if (oldest !== undefined) this.clientFetches.delete(oldest);
            }
            this.clientFetches.set(client, mine);
        }
        return true;
    }
    set(url: string, pem: string, now = Date.now()): void {
        if (!this.entries.has(url) && this.entries.size >= this.maxEntries) {
            const oldest = this.entries.keys().next().value;
            if (oldest !== undefined) this.entries.delete(oldest);
        }
        this.entries.set(url, { pem, expires: now + this.ttlMs });
        this.failures.delete(url);
    }
    /** True while a recent fetch of `url` failed. */
    failedRecently(url: string, now = Date.now()): boolean {
        const until = this.failures.get(url);
        if (until === undefined) return false;
        if (until <= now) { this.failures.delete(url); return false; }
        return true;
    }
    setFailure(url: string, now = Date.now()): void {
        if (!this.failures.has(url) && this.failures.size >= 64) {
            const oldest = this.failures.keys().next().value;
            if (oldest !== undefined) this.failures.delete(oldest);
        }
        this.failures.set(url, now + this.failureTtlMs);
    }
    /** One fetch per URL at a time: concurrent callers share it. */
    fetchOnce(url: string, fetchCert: CertFetcher): Promise<string> {
        const running = this.inflight.get(url);
        if (running) return running;
        const p = Promise.resolve().then(() => fetchCert(url)).finally(() => this.inflight.delete(url));
        this.inflight.set(url, p);
        return p;
    }
    get size(): number { return this.entries.size; }
}

/** Largest certificate body read (an SNS signing certificate is about 2 KB). */
export const CERT_MAX_BYTES = 64 * 1024;

/** Read a fetch body, aborting as soon as it passes `max` bytes. */
export async function readCapped(res: { headers?: { get(name: string): string | null }; body?: any; text?: () => Promise<string> }, max: number): Promise<string> {
    const declared = Number(res.headers?.get('content-length'));
    if (Number.isFinite(declared) && declared > max) throw new Error('certificate too large');
    const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
    if (!reader) {
        const text = res.text ? await res.text() : '';
        if (Buffer.byteLength(text) > max) throw new Error('certificate too large');
        return text;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > max) {
            try { await reader.cancel(); } catch { /* ignore */ }
            throw new Error('certificate too large');
        }
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
}

/** The default certificate fetch: 5 s timeout, no redirects, 64 KB cap (streamed), PEM only. */
export const defaultCertFetcher: CertFetcher = async (url: string) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000), redirect: 'error' });
    if (!res.ok) throw new Error(`certificate fetch HTTP ${res.status}`);
    const text = await readCapped(res as any, CERT_MAX_BYTES);
    if (!text.includes('-----BEGIN CERTIFICATE-----')) throw new Error('not a PEM certificate');
    return text;
};

export type SubscribeFetcher = (url: string) => Promise<{ ok: boolean; status: number }>;

const defaultSubscribeFetcher: SubscribeFetcher = async url => {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000), redirect: 'error' });
    try { await res.body?.cancel(); } catch { /* the status is all we need */ }
    return res;
};

/**
 * After a SubscriptionConfirmation has been verified: visit its
 * `SubscribeURL` (https, the topic's own sns.<region>.amazonaws.com, this
 * topic) when `autoConfirm` is not false; otherwise leave it for manual
 * confirmation.
 */
export async function confirmSnsSubscription(
    m: any,
    autoConfirm: boolean | undefined,
    fetchFn: SubscribeFetcher = defaultSubscribeFetcher,
): Promise<'confirmed' | 'manual' | 'rejected-url' | 'failed'> {
    if (autoConfirm === false) return 'manual';
    if (!isValidSnsSubscribeUrl(m?.SubscribeURL, String(m?.TopicArn || ''))) return 'rejected-url';
    try {
        const r = await fetchFn(m.SubscribeURL);
        return r.ok ? 'confirmed' : 'failed';
    } catch {
        return 'failed';
    }
}

/** How old an SNS message may be. SNS stops retrying an HTTPS endpoint within an hour;
 *  a day leaves room for slow queues and clock skew. */
export const SNS_MAX_AGE_MS = 24 * 3600_000;
/** How far in the future an SNS timestamp may be (clock skew). */
export const SNS_MAX_FUTURE_MS = 15 * 60_000;

export type SnsVerdict = 'ok' | 'bad-signature' | 'topic-not-allowed' | 'stale';

/**
 * Full SNS verification: the body's `TopicArn` on the allowlist; a
 * `Timestamp` no older than 24 hours (and not more than 15 minutes ahead);
 * SignatureVersion 1 (SHA1withRSA) or 2 (SHA256withRSA); `SigningCertURL`
 * https on the topic's own `sns.<region>.amazonaws.com(.cn)` with a
 * `/SimpleNotificationService-<hex>.pem` path in canonical form, fetched
 * (timeout, streamed 64 KB cap, cached; a failed fetch is remembered for
 * 15 s; at most 2 new fetches a minute per `client` address and 60 in all)
 * only after all of that; the certificate within its validity dates; then
 * the canonical string-to-sign must verify.
 */
export async function verifySnsMessage(
    m: any,
    topicArns: string[] | undefined,
    deps: { fetchCert: CertFetcher; cache: CertCache; now?: number; client?: string | null },
): Promise<SnsVerdict> {
    if (!m || typeof m !== 'object') return 'bad-signature';
    const allowed = (topicArns || []).filter(Boolean);
    if (!allowed.length) return 'bad-signature';
    if (typeof m.TopicArn !== 'string' || !allowed.includes(m.TopicArn)) return 'topic-not-allowed';
    const now = deps.now ?? Date.now();
    const sent = typeof m.Timestamp === 'string' ? Date.parse(m.Timestamp) : NaN;
    if (!Number.isFinite(sent)) return 'bad-signature';
    if (sent < now - SNS_MAX_AGE_MS || sent > now + SNS_MAX_FUTURE_MS) return 'stale';
    const version = String(m.SignatureVersion ?? '');
    if (version !== '1' && version !== '2') return 'bad-signature';
    if (typeof m.Signature !== 'string' || !m.Signature || m.Signature.length > 4096) return 'bad-signature';
    if (!isValidSnsCertUrl(m.SigningCertURL, m.TopicArn)) return 'bad-signature';
    const toSign = snsStringToSign(m);
    if (toSign === null) return 'bad-signature';
    let pem = deps.cache.get(m.SigningCertURL, now);
    if (!pem) {
        if (deps.cache.failedRecently(m.SigningCertURL, now)) return 'bad-signature';
        if (!deps.cache.isFetching(m.SigningCertURL) && !deps.cache.tryStartFetch(now, deps.client)) {
            // This minute's fetches (the client's or all of them) are used up: an expired copy of this very certificate still serves.
            pem = deps.cache.stale(m.SigningCertURL);
            if (!pem) return 'bad-signature';
        } else {
            try {
                pem = await deps.cache.fetchOnce(m.SigningCertURL, deps.fetchCert);
            } catch {
                deps.cache.setFailure(m.SigningCertURL, now);
                return 'bad-signature';
            }
            deps.cache.set(m.SigningCertURL, pem, now);
        }
    }
    try {
        const cert = new X509Certificate(pem);
        if (Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) < now) return 'bad-signature';
        const verifier = createVerify(version === '1' ? 'RSA-SHA1' : 'RSA-SHA256');
        verifier.update(toSign, 'utf8');
        return verifier.verify(cert.publicKey, Buffer.from(m.Signature, 'base64')) ? 'ok' : 'bad-signature';
    } catch {
        return 'bad-signature';
    }
}
