import { EvaluationClient, EvaluationState, EvalStatsProvider, LicenceStatus, RetentionOptions } from '@huloglobal/vendure-licence-sdk';
import type { IpEnrichmentOptions } from './ip-enrichment';

/**
 * Provider delivery webhooks at `POST /email-track/webhook/:provider`
 * (0.16.0). Each provider is off until configured. Every known provider
 * slug goes through the same body checks whether it is configured or not
 * (415 / 413 / 408, and 400 for a Mailgun or SES body nested deeper than 32
 * levels or with more than 1 000 arrays and objects; caps 1 MB SendGrid and
 * Postmark, 320 KB SES, 256 KB Mailgun), and an unconfigured provider
 * answers 401 exactly like a bad signature — same body read, same empty
 * body, same headers, after the same signature check run against throwaway
 * credentials — so nothing reveals which ones are enabled. Configuring a
 * provider also adds its correlation header to outgoing mail — a signed
 * correlation value, `<email_log id>-<HMAC>` — so its events match the
 * email.
 */
export interface ProviderWebhookOptions {
    /** Postmark: HTTP Basic credentials you put in the webhook URL
     *  (`https://user:pass@shop.example.com/email-track/webhook/postmark`). */
    postmark?: { username: string; password: string };
    /** SendGrid Event Webhook "Signed Event Webhook" verification key, as
     *  shown in SendGrid's UI (base64 DER) or as a PEM public key. */
    sendgrid?: { verificationKey: string };
    /** Mailgun HTTP webhook signing key (Settings → Webhooks). Mailgun signs only
     *  timestamp + token, so each token is accepted once (per server process)
     *  within the ±15-minute window. */
    mailgun?: { signingKey: string };
    /**
     * Amazon SES notifications through SNS. Only messages whose signed
     * `TopicArn` is listed are accepted (full ARNs, `arn:aws:sns:<region>:<account>:<name>`);
     * the signing certificate must come from that topic's own region,
     * `sns.<region>.amazonaws.com` (fetched at most 2 new URLs a minute per
     * client address and 60 in all, then cached). `autoConfirmSubscription`
     * (default true) visits the SNS `SubscribeURL` after the confirmation
     * message has been verified; false logs it for you to confirm by hand.
     */
    ses?: { topicArns: string[]; autoConfirmSubscription?: boolean };
    /**
     * Also record the opens and clicks a provider reports. Default false:
     * the plugin's own pixel and redirector already record them, so provider
     * engagement is ignored. When true they are added to the timeline as
     * events (source = the provider) but never counted in `email_log`; a
     * reported click URL is stored unwrapped (when it is one of the plugin's
     * own tracked links) and with secrets redacted.
     */
    recordEngagement?: boolean;
    /**
     * Per-IP limits of this endpoint. `failed`: requests that fail a body
     * check or verification (400, 401, 408, 413, 415) spend it, and an
     * address that has used it up is answered 429 before its body is read
     * (default: `rateLimit`, 60 per 60 s). `verified`: requests that pass
     * verification spend only this one, per provider and address (default
     * 1 200 per 60 s), so junk from anyone never throttles real bounces and
     * complaints. Mailgun, Postmark and SNS post one request per event — size
     * `verified` for your peak per provider IP; SNS retries an HTTPS endpoint
     * only a few times before it drops a message (unless you give the
     * subscription a longer delivery policy). Behind a reverse proxy, set
     * `trustedIpHeaders` (or Express `trust proxy`): otherwise every
     * request — the providers' included — shares the proxy's address.
     */
    rateLimit?: {
        failed?: { capacity: number; windowMs: number };
        verified?: { capacity: number; windowMs: number };
    };
}

export interface EmailTrackingPluginOptions {
    /** Public host of the Vendure server. Embedded in outgoing pixel +
     *  click URLs. Example: `https://shop.example.com`. */
    publicBaseUrl: string;

    /** Licence JWT. Without a valid key every feature is on for a 14-day
     *  evaluation (no card); after it, the free tier: the email log, open and
     *  click recording, the suppression list (enforced at send), the per-order
     *  and per-customer email lists, bounces, complaints and provider drops,
     *  privacy export / erase and the settings stay on; the premium features
     *  (`PREMIUM_FEATURES`) stop, and their data is kept. */
    licenceKey?: string;

    /** Hosts the click rewriter recognises as already-tracked. Defaults
     *  to `[publicBaseUrl]`. */
    trackedHosts?: string[];

    // ── Security ────────────────────────────────────────────────────────
    /**
     * HMAC secret used to:
     *   1. Sign open pixel + click URLs at embed time — prevents anyone
     *      from forging arbitrary open / click events by hitting
     *      `/email-track/open/<arbitrary-id>.gif`.
     *   2. Verify bounce-webhook requests when no `bounceWebhookSecret`
     *      is set separately.
     *
     * When unset, a random secret is generated once at boot and stored in
     * `hulo_licence_store` (key `vendure-plugin-email-tracking:signing-secret`,
     * shared by server and worker), so new emails are always signed. Set
     * it explicitly to keep already-sent links valid across reinstalls or
     * database restores. Links sent before any secret existed (bare ids)
     * keep working: the pixel is served and clicks redirect to your own
     * hosts only. While a secret exists, a hit through a bare id is recorded
     * as an `unverified` event only and never counted in `email_log` (anyone
     * can type one). A generated secret is never used for the bounce webhook.
     */
    signingSecret?: string;

    /**
     * Optional dedicated HMAC secret for the `/email-track/bounce`
     * webhook. Falls back to `signingSecret` if unset.
     * Requests without a valid `X-Signature` header are rejected 401.
     */
    bounceWebhookSecret?: string;
    /** Accept bounce webhooks without a secret (legacy; anyone who knows a
     *  Message-ID could then suppress that customer). Default false. */
    allowUnauthenticatedBounceWebhook?: boolean;
    /** Proxy headers that may override `req.ip` for the visitor address.
     *  Only list what your edge sets and strips from clients, e.g.
     *  `['cf-connecting-ip']` behind Cloudflare. Default: none (`req.ip`).
     *  `x-forwarded-for` yields the right-most public hop (the one your
     *  proxy appended), never the client-supplied left-most entry. */
    trustedIpHeaders?: Array<'cf-connecting-ip' | 'true-client-ip' | 'x-real-ip' | 'x-forwarded-for'>;
    /**
     * Your reverse proxies (0.17.0): IP addresses or CIDR ranges, IPv4 or
     * IPv6, e.g. `['10.0.0.0/8', '2400:cb00::/32']`. When set, the
     * `trustedIpHeaders` are believed only for a connection that comes from
     * one of them (anyone else is their own socket address), and in
     * `X-Forwarded-For` the visitor is the right-most hop that is not one of
     * them. Unset: the 0.16 behaviour (headers believed from any peer; the
     * right-most public X-Forwarded-For hop). More ranges can be added in
     * Admin → Email Log → Settings.
     */
    trustedProxies?: string[];

    // ── Tracking switches (0.17.0) ──────────────────────────────────────
    /** Add the open pixel and record opens. Default true. Admin → Email Log → Settings overrides it. */
    trackOpens?: boolean;
    /** Rewrite links through the click redirector and record clicks. Default true. Admin → Email Log → Settings overrides it. */
    trackClicks?: boolean;
    /**
     * E-mail types sent even to an address on the suppression list. Only a
     * type the sender gave counts (the Vendure EmailPlugin event type, or
     * `sendTracked`'s `meta.type`), never one guessed from the subject.
     * Default `['password-reset']`, so a customer can always get back into
     * their account.
     */
    suppressionExemptTypes?: string[];

    /**
     * Domain allowlist for the click redirector. When non-empty, click
     * URLs whose hostname isn't on this list are refused. Prevents the
     * redirector from being abused as an open redirector by attackers
     * who get hold of a valid signed `/click/:id` URL.
     * Wildcard suffixes supported: `*.example.com`.
     */
    clickRedirectAllowedDomains?: string[];

    /**
     * Rate limit for the public tracking endpoints (pixel, click redirect,
     * bounce webhook, evidence PDF), keyed by IP. Two values:
     * `{ capacity, windowMs }`. Default 60 requests / 60s. Also the default
     * failure allowance of the provider webhooks (`providerWebhooks.rateLimit`).
     */
    rateLimit?: { capacity: number; windowMs: number };

    /**
     * Secret salt for the IP hashes in `email_log`'s open / click history
     * (`sha256(salt|ip)`) and the key of the `email_event` hashes (HMAC of the
     * IP and of the recipient address). Unset, `email_log` uses a public
     * default salt — anyone with a hash can recover the IP by trying every
     * address — and `email_event` uses the install's signing secret; a boot
     * warning says so. Set it to a long random value in production, and keep
     * it stable (changing it changes every new hash). */
    ipSalt?: string;

    /**
     * Store hashed IPs instead of raw IPs in open / click history and in
     * `email_event.ip`. Hashed IPs still let you see "same network"
     * patterns; with a secret `ipSalt` they cannot be reversed by trying
     * addresses (with the default salt they can). Default: `true`.
     */
    hashIpsInHistory?: boolean;

    // ── Retention ───────────────────────────────────────────────────────
    /**
     * Automatic pruning of the `email_log` table. Default `{ days: 365 }`;
     * `{ days: 180 }` keeps the last 180 days and `{ days: null }` keeps
     * everything. Optionally set `maxRows` as a safety cap. The sweeper runs
     * every 24h on the worker and is unref'd so it never blocks shutdown.
     * The `email_event` timeline is pruned with the same `days` (at least 3,
     * so a provider's replay window never outlives its dedupe row), with the
     * events of the email rows `maxRows` removes, and — under `maxRows` —
     * the unlinked events older than the oldest email kept.
     */
    retention?: RetentionOptions;

    // ── Delivery + enrichment (0.16.0, all opt-in) ───────────────────────
    /** Provider delivery webhooks (Postmark, SendGrid, Mailgun, Amazon SES).
     *  Unset: every provider endpoint is refused (401, after the body
     *  checks) and no header is added. */
    providerWebhooks?: ProviderWebhookOptions;

    /**
     * IP enrichment for open and click events: an asynchronous lookup of
     * country, region, city, ASN, organisation, timezone and proxy / VPN /
     * datacentre / mobile flags. OFF unless set — with no value the plugin
     * makes no third-party calls. Only the IP address is sent; private and
     * reserved addresses never are. Results are cached per IP (`cacheTtlMs`,
     * default 24 h) and lookups beyond `maxLookupsPerMinute` are dropped.
     *
     *   { provider: 'ipinfo', token }      https://ipinfo.io
     *   { provider: 'ip-api', key? }       free endpoint without a key (HTTP,
     *                                      45/min, non-commercial); pro with one
     *   { provider: 'custom', lookup(ip) } your own source
     */
    ipEnrichment?: IpEnrichmentOptions;
}

/** The public salt used when `ipSalt` is not set (kept for the 0.15-compatible `email_log` hashes). */
export const DEFAULT_IP_SALT = 'hulo-email-tracking-default-salt';

const DEFAULTS: Required<Omit<EmailTrackingPluginOptions, 'licenceKey' | 'trackedHosts' | 'signingSecret' | 'bounceWebhookSecret' | 'clickRedirectAllowedDomains' | 'providerWebhooks' | 'ipEnrichment' | 'trustedProxies' | 'suppressionExemptTypes'>> = {
    publicBaseUrl: 'http://localhost:3000',
    rateLimit: { capacity: 60, windowMs: 60_000 },
    ipSalt: DEFAULT_IP_SALT,
    hashIpsInHistory: true,
    retention: { days: 365 },
    allowUnauthenticatedBounceWebhook: false,
    trustedIpHeaders: [],
    trackOpens: true,
    trackClicks: true,
};

let cachedOptions: EmailTrackingPluginOptions = { ...DEFAULTS };
let cachedStatus: LicenceStatus | null = null;

export function setOptions(opts: EmailTrackingPluginOptions): void {
    cachedOptions = {
        ...DEFAULTS,
        ...opts,
        publicBaseUrl: opts.publicBaseUrl.replace(/\/$/, ''),
    };
}

export function getOptions(): EmailTrackingPluginOptions {
    return cachedOptions;
}

/** True when no `ipSalt` was configured (the public default is in use). */
export function isDefaultIpSalt(): boolean {
    return !cachedOptions.ipSalt || cachedOptions.ipSalt === DEFAULT_IP_SALT;
}

/**
 * The key of the `email_event` hashes (IP and recipient HMACs): the
 * configured `ipSalt`, else the install's signing secret (configured or
 * generated), else — only while neither exists — the public default salt.
 */
export function eventHashKey(): string {
    if (!isDefaultIpSalt()) return cachedOptions.ipSalt as string;
    return cachedOptions.signingSecret || DEFAULT_IP_SALT;
}

let signingSecretGenerated = false;

/** Apply the per-install secret generated at boot (only when none is configured). */
export function applyGeneratedSigningSecret(secret: string): void {
    if (cachedOptions.signingSecret) return;
    cachedOptions = { ...cachedOptions, signingSecret: secret };
    signingSecretGenerated = true;
}

export function isSigningSecretGenerated(): boolean {
    return signingSecretGenerated;
}

/** The secret the operator configured — `undefined` when the active one was generated.
 *  The bounce webhook only ever authenticates against a configured secret. */
export function configuredSigningSecret(): string | undefined {
    return signingSecretGenerated ? undefined : cachedOptions.signingSecret;
}

export function setLicenceStatus(status: LicenceStatus): void {
    cachedStatus = status;
}

let evalClient: EvaluationClient | null = null;
let statsProvider: EvalStatsProvider | null = null;

/** Start the server-anchored 14-day evaluation for unlicensed installs. */
export function startEvaluation(packageName: string, packageVersion: string): void {
    if (!evalClient) {
        evalClient = new EvaluationClient({ packageName, packageVersion });
        if (statsProvider) evalClient.setStatsProvider(statsProvider);
    }
    // After a deactivation the existing (stopped) client must run again.
    evalClient.start();
}

/** Install the 30-day usage-stats provider (numbers only, no PII). The
 *  evaluation client and the heartbeat both read it, so licensed installs
 *  keep reporting after purchase and a client created later (after a
 *  deactivation) picks it up too. */
export function setStatsProvider(fn: EvalStatsProvider): void {
    statsProvider = fn;
    evalClient?.setStatsProvider(fn);
}

export function getStatsProvider(): EvalStatsProvider | null {
    return statsProvider;
}

export function stopEvaluation(): void {
    evalClient?.stop();
}

export function getEvalState(): EvaluationState | null {
    return evalClient?.getState() ?? null;
}

export function getEvalInstanceId(): string | null {
    return evalClient?.getInstanceId() ?? null;
}

/** Licensed installs AND installs inside the evaluation window get the
 *  full feature set. */
export function hasPremiumAccess(): boolean {
    if (getLicenceStatus()?.valid) return true;
    return !!evalClient?.getState()?.active;
}

export function getLicenceStatus(): LicenceStatus | null {
    return cachedStatus;
}

export function trackingBaseUrl(): string {
    return cachedOptions.publicBaseUrl;
}

export function ownTrackingPrefixes(): string[] {
    const list = cachedOptions.trackedHosts && cachedOptions.trackedHosts.length
        ? cachedOptions.trackedHosts
        : [cachedOptions.publicBaseUrl];
    return list.map(h => h.replace(/\/$/, '') + '/email-track/');
}
