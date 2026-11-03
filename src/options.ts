import { EvaluationClient, EvaluationState, EvalStatsProvider, LicenceStatus, RetentionOptions } from '@huloglobal/vendure-licence-sdk';

export interface EmailTrackingPluginOptions {
    /** Public host of the Vendure server. Embedded in outgoing pixel +
     *  click URLs. Example: `https://shop.example.com`. */
    publicBaseUrl: string;

    /** Licence JWT. Without a valid key the plugin runs in
     *  evaluation mode (basic logging, no tracking endpoints). */
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
     * hosts only. A generated secret is never used for the bounce webhook.
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
     * Domain allowlist for the click redirector. When non-empty, click
     * URLs whose hostname isn't on this list are refused. Prevents the
     * redirector from being abused as an open redirector by attackers
     * who get hold of a valid signed `/click/:id` URL.
     * Wildcard suffixes supported: `*.example.com`.
     */
    clickRedirectAllowedDomains?: string[];

    /**
     * Rate limit for the public tracking endpoints, keyed by IP. Two
     * values: `{ capacity, windowMs }`. Default 60 requests / 60s.
     */
    rateLimit?: { capacity: number; windowMs: number };

    /**
     * Per-install salt for hashing IPs stored in open / click history
     * rows. Defaults to a process-static salt — set this in production
     * so the hash is stable across deploys. */
    ipSalt?: string;

    /**
     * Store hashed IPs instead of raw IPs in open / click history. Hashed
     * IPs still let you see "same network" patterns but can't be
     * de-anonymised. Default: `true`.
     */
    hashIpsInHistory?: boolean;

    // ── Retention ───────────────────────────────────────────────────────
    /**
     * Automatic pruning of the `email_log` table. `{ days: 180 }` keeps
     * the last 180 days. `{ days: null }` (default) keeps everything.
     * Optionally set `maxRows` as a safety cap. The sweeper runs every
     * 24h and is unref'd so it never blocks shutdown.
     */
    retention?: RetentionOptions;
}

const DEFAULTS: Required<Omit<EmailTrackingPluginOptions, 'licenceKey' | 'trackedHosts' | 'signingSecret' | 'bounceWebhookSecret' | 'clickRedirectAllowedDomains'>> = {
    publicBaseUrl: 'http://localhost:3000',
    rateLimit: { capacity: 60, windowMs: 60_000 },
    ipSalt: 'hulo-email-tracking-default-salt',
    hashIpsInHistory: true,
    retention: { days: 365 },
    allowUnauthenticatedBounceWebhook: false,
    trustedIpHeaders: [],
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
