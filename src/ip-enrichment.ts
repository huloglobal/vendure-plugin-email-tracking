import { Logger } from '@vendure/core';
import { canonicalIp, isPrivateOrReservedIp } from './ip-utils';

const loggerCtx = 'EmailTrackingIpEnrichment';

/** What a lookup provider may return. Every field is optional. */
export interface IpEnrichmentResult {
    country?: string | null;
    region?: string | null;
    city?: string | null;
    timezone?: string | null;
    /** Autonomous system number, e.g. `AS5089` (a bare number is accepted). */
    asn?: string | number | null;
    org?: string | null;
    isProxy?: boolean | null;
    isVpn?: boolean | null;
    isTor?: boolean | null;
    /** Datacentre / hosting network. */
    isHosting?: boolean | null;
    isMobile?: boolean | null;
}

/** A result clamped to the `email_event` column widths. */
export interface ClampedEnrichment {
    country: string | null;
    region: string | null;
    city: string | null;
    timezone: string | null;
    asn: string | null;
    org: string | null;
    isProxy: boolean | null;
    isVpn: boolean | null;
    isTor: boolean | null;
    isHosting: boolean | null;
    isMobile: boolean | null;
    enrichedBy: string;
}

export type IpEnrichmentOptions = (
    | {
        /** ipinfo.io with an access token (sent as a Bearer header). */
        provider: 'ipinfo';
        token: string;
    }
    | {
        /** ip-api.com. Without `key` the free endpoint is used: plain HTTP,
         *  45 requests a minute, non-commercial use only under ip-api's terms.
         *  With `key`, `https://pro.ip-api.com`. */
        provider: 'ip-api';
        key?: string;
    }
    | {
        /** Your own lookup (e.g. a local database). Return null when unknown. */
        provider: 'custom';
        lookup: (ip: string) => Promise<IpEnrichmentResult | null> | IpEnrichmentResult | null;
        /** Stored in `enrichedBy`. Default `custom`. */
        name?: string;
    }
) & {
    /** How long one IP's result is reused. Default 24 hours. */
    cacheTtlMs?: number;
    /** Lookups per minute; over budget the event is simply not enriched
     *  (nothing is queued). Default 40 for the free ip-api endpoint, else 120. */
    maxLookupsPerMinute?: number;
};

export const ENRICHMENT_TIMEOUT_MS = 5_000;
const MAX_CACHE_ENTRIES = 10_000;

const cut = (v: unknown, n: number): string | null => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s ? s.slice(0, n) : null;
};
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/** `AS5089 Virgin Media Limited` / `as5089` / `5089` → `AS5089` (the number only). */
export function asnNumber(v: unknown): string | null {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return Number.isInteger(v) && v >= 0 && v <= 4294967295 ? `AS${v}` : null;
    const m = /^\s*(?:AS)?(\d{1,10})\b/i.exec(String(v));
    if (!m) return null;
    const n = Number(m[1]);
    return n <= 4294967295 ? `AS${n}` : null;
}

/** Clamp every value to its column (ip-api's `as` carries the operator name — keep the number only). */
export function clampEnrichment(r: IpEnrichmentResult, enrichedBy: string): ClampedEnrichment {
    const country = cut(r.country, 8);
    return {
        country: country ? country.toUpperCase() : null,
        region: cut(r.region, 64),
        city: cut(r.city, 128),
        timezone: cut(r.timezone, 64),
        asn: asnNumber(r.asn),
        org: cut(r.org, 255),
        isProxy: bool(r.isProxy),
        isVpn: bool(r.isVpn),
        isTor: bool(r.isTor),
        isHosting: bool(r.isHosting),
        isMobile: bool(r.isMobile),
        enrichedBy: cut(enrichedBy, 32) || 'custom',
    };
}

/** ip-api.com JSON (`fields=status,message,countryCode,regionName,city,timezone,isp,org,as,proxy,hosting,mobile`). */
export function parseIpApi(j: any): IpEnrichmentResult | null {
    if (!j || typeof j !== 'object' || j.status !== 'success') return null;
    const asName = typeof j.as === 'string' ? j.as.replace(/^\s*AS\d+\s*/i, '').trim() : '';
    return {
        country: j.countryCode ?? null,
        region: j.regionName ?? null,
        city: j.city ?? null,
        timezone: j.timezone ?? null,
        asn: typeof j.as === 'string' ? j.as : null,
        org: j.org || j.isp || asName || null,
        isProxy: bool(j.proxy),
        isHosting: bool(j.hosting),
        isMobile: bool(j.mobile),
        isVpn: null,
        isTor: null,
    };
}

/** ipinfo.io JSON — the standard `/json` response (with the privacy, ASN and
 *  carrier blocks where the plan includes them) and the Lite response. */
export function parseIpinfo(j: any): IpEnrichmentResult | null {
    if (!j || typeof j !== 'object' || j.bogon || j.error) return null;
    const orgRaw = typeof j.org === 'string' ? j.org : '';
    const orgAsn = /^\s*(AS\d+)\s+(.+)$/i.exec(orgRaw);
    const asnObj = j.asn && typeof j.asn === 'object' ? j.asn : null;
    const privacy = j.privacy && typeof j.privacy === 'object' ? j.privacy : {};
    const hosting = privacy.hosting === true || asnObj?.type === 'hosting' || j.company?.type === 'hosting';
    const anyPrivacy = Object.keys(privacy).length > 0 || !!asnObj || !!j.company;
    return {
        country: j.country_code || j.country || null,
        region: j.region ?? null,
        city: j.city ?? null,
        timezone: j.timezone ?? null,
        asn: (typeof j.asn === 'string' ? j.asn : asnObj?.asn) || (orgAsn ? orgAsn[1] : null),
        org: j.as_name || asnObj?.name || (orgAsn ? orgAsn[2] : orgRaw) || j.company?.name || null,
        isVpn: bool(privacy.vpn),
        isProxy: privacy.proxy === true || privacy.relay === true ? true : bool(privacy.proxy),
        isTor: bool(privacy.tor),
        isHosting: hosting ? true : (anyPrivacy ? false : null),
        isMobile: j.carrier ? true : null,
    };
}

type FetchFn = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

interface CacheEntry { value: ClampedEnrichment | null; expires: number; }

/**
 * Looks up one IP with the configured provider, behind a per-IP cache and a
 * per-minute budget. Private / reserved addresses (and anything that is not
 * a plain address, such as a `%zone` suffix) are never looked up; the cache
 * key, the provider URL and a custom `lookup(ip)` all get the canonical
 * address (`canonicalIp`), so notation variants of one address share one
 * lookup. An over-budget lookup is dropped (returns null), never queued.
 * Never throws.
 */
export class IpEnricher {
    readonly providerName: string;
    private readonly cache = new Map<string, CacheEntry>();
    private readonly inflight = new Map<string, Promise<ClampedEnrichment | null>>();
    private readonly ttl: number;
    private readonly budget: number;
    private windowStart = 0;
    private windowCount = 0;
    private droppedLogged = 0;

    constructor(
        private readonly opts: IpEnrichmentOptions,
        private readonly deps: { fetch?: FetchFn; now?: () => number } = {},
    ) {
        this.providerName = opts.provider === 'custom' ? (opts.name || 'custom')
            : opts.provider === 'ipinfo' ? 'ipinfo.io' : 'ip-api.com';
        this.ttl = Math.max(60_000, opts.cacheTtlMs ?? 24 * 3600_000);
        const freeIpApi = opts.provider === 'ip-api' && !opts.key;
        this.budget = Math.max(1, Math.floor(opts.maxLookupsPerMinute ?? (freeIpApi ? 40 : 120)));
    }

    private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }

    /** The cached result: `undefined` when the IP is not cached (or expired). */
    peek(rawIp: string): ClampedEnrichment | null | undefined {
        const ip = canonicalIp(rawIp);
        if (!ip) return undefined;
        const e = this.cache.get(ip);
        if (!e) return undefined;
        if (e.expires <= this.now()) { this.cache.delete(ip); return undefined; }
        return e.value;
    }

    /** True when a lookup would fit in this minute's budget (and counts it). */
    private takeBudget(): boolean {
        const t = this.now();
        if (t - this.windowStart >= 60_000) { this.windowStart = t; this.windowCount = 0; }
        if (this.windowCount >= this.budget) return false;
        this.windowCount++;
        return true;
    }

    async lookup(rawIp: string): Promise<ClampedEnrichment | null> {
        if (isPrivateOrReservedIp(rawIp)) return null;
        const ip = canonicalIp(rawIp);
        if (!ip) return null;
        const hit = this.peek(ip);
        if (hit !== undefined) return hit;
        const running = this.inflight.get(ip);
        if (running) return running;
        if (!this.takeBudget()) {
            const t = this.now();
            if (t - this.droppedLogged > 60_000) {
                this.droppedLogged = t;
                Logger.verbose(`IP enrichment budget (${this.budget}/min) reached — events in this minute stay unenriched`, loggerCtx);
            }
            return null;
        }
        const p = this.fetchOne(ip)
            .then(r => {
                if (r !== undefined) this.remember(ip, r);
                return r ?? null;
            })
            .catch(() => null)
            .finally(() => this.inflight.delete(ip));
        this.inflight.set(ip, p);
        return p;
    }

    private remember(ip: string, value: ClampedEnrichment | null) {
        if (this.cache.size >= MAX_CACHE_ENTRIES) {
            const oldest = this.cache.keys().next().value;
            if (oldest !== undefined) this.cache.delete(oldest);
        }
        this.cache.set(ip, { value, expires: this.now() + this.ttl });
    }

    /** `undefined` = transient failure (not cached); null = the provider knows nothing. */
    private async fetchOne(ip: string): Promise<ClampedEnrichment | null | undefined> {
        const o = this.opts;
        try {
            if (o.provider === 'custom') {
                const r = await withTimeout(Promise.resolve(o.lookup(ip)), ENRICHMENT_TIMEOUT_MS);
                return r ? clampEnrichment(r, this.providerName) : null;
            }
            const f: FetchFn = this.deps.fetch || ((url, init) => fetch(url, init) as any);
            const fields = 'status,message,countryCode,regionName,city,timezone,isp,org,as,proxy,hosting,mobile';
            let url: string;
            const init: any = { signal: AbortSignal.timeout(ENRICHMENT_TIMEOUT_MS), headers: { accept: 'application/json' }, redirect: 'error' };
            if (o.provider === 'ipinfo') {
                url = `https://ipinfo.io/${encodeURIComponent(ip)}/json`;
                init.headers.authorization = `Bearer ${o.token}`;
            } else if (o.key) {
                url = `https://pro.ip-api.com/json/${encodeURIComponent(ip)}?key=${encodeURIComponent(o.key)}&fields=${fields}`;
            } else {
                url = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=${fields}`;
            }
            const res = await f(url, init);
            if (!res.ok) return undefined;
            const body = await res.json();
            const parsed = o.provider === 'ipinfo' ? parseIpinfo(body) : parseIpApi(body);
            return parsed ? clampEnrichment(parsed, this.providerName) : null;
        } catch (e: any) {
            Logger.verbose(`IP enrichment lookup failed (${this.providerName}): ${e?.message || e}`, loggerCtx);
            return undefined;
        }
    }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
        (t as any).unref?.();
        p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
    });
}

/** The one-line boot notice for the free ip-api endpoint. */
export function ipApiFreeTierWarning(): string {
    return 'email-tracking: ipEnrichment uses the free ip-api.com endpoint — plain HTTP (the IP address travels unencrypted), '
        + 'limited to 45 requests a minute, and licensed for non-commercial use only. Set ipEnrichment.key for https://pro.ip-api.com, or use provider \'ipinfo\'.';
}
