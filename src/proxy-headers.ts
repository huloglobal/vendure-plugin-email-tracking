import { Request } from 'express';

/**
 * Reverse-proxy aware visitor IP extraction.
 *
 * Order of precedence:
 *   1. Cloudflare's `CF-Connecting-IP` (always the real client IP,
 *      regardless of how many proxies sit in front of the worker).
 *   2. `True-Client-IP` (Akamai / Cloudflare Enterprise).
 *   3. `X-Real-IP` (nginx / Caddy default when proxying).
 *   4. `X-Forwarded-For`: the right-most public hop, i.e. the address
 *      your own proxy appended. Every entry left of it was sent by the
 *      client and is never trusted.
 *   5. Express's `req.ip` — only useful when `app.set('trust proxy', ...)`
 *      has been set on the Vendure host, otherwise this is the socket
 *      address of the last hop.
 *
 * Returns `null` if none of the headers are populated and `req.ip`
 * isn't available — the caller should treat this as "unknown" and
 * skip IP-dependent enrichment rather than fail.
 */
export type TrustedIpHeader = 'cf-connecting-ip' | 'true-client-ip' | 'x-real-ip' | 'x-forwarded-for';

const PRIVATE_HOP = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd][0-9a-f]{2}:|fe80:)/i;

/** Right-most hop that is not one of our own (private / loopback)
 *  proxies. The left-most entry is whatever the client put in its own
 *  X-Forwarded-For header, so trusting it lets anyone pick their IP. */
function clientFromXff(raw: string): string {
    const hops = raw.split(',').map(h => h.trim().replace(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i, '$1')).filter(Boolean);
    for (let i = hops.length - 1; i >= 0; i--) {
        if (!PRIVATE_HOP.test(hops[i])) return hops[i];
    }
    return hops[hops.length - 1] || '';
}

/**
 * The visitor's IP: Express's `req.ip` (honours the host's `trust proxy`)
 * unless the host lists proxy headers it trusts. Trusting a header from
 * any peer lets a client spoof its address to dodge the per-IP limiter
 * and poison the stored open/click IPs.
 */
export function getRealIp(req: Request, trusted: TrustedIpHeader[] = []): string | null {
    const headers = req.headers || {};
    for (const name of trusted) {
        const raw = String(headers[name] || '').trim();
        if (!raw) continue;
        const value = name === 'x-forwarded-for' ? clientFromXff(raw) : raw;
        if (value) return value.replace(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i, '$1').slice(0, 64);
    }
    const ip = String((req as any).ip || '').trim();
    return ip ? ip.replace(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i, '$1').slice(0, 64) : null;
}

/**
 * Cloudflare / Akamai populate the visitor's resolved country on the
 * inbound request when the corresponding feature is enabled. Reading
 * the upstream value avoids a per-request GeoIP lookup. Returns the
 * ISO 3166-1 alpha-2 country code or `null` if no proxy header is
 * present.
 */
export function getResolvedCountry(req: Request): string | null {
    const headers = req.headers || {};
    const cf = String(headers['cf-ipcountry'] || '').trim().toUpperCase();
    if (cf && cf !== 'XX' && cf !== 'T1') return cf;

    const akamai = String(headers['x-akamai-edgescape'] || '').trim();
    if (akamai) {
        const m = akamai.match(/country_code=([A-Z]{2})/i);
        if (m) return m[1].toUpperCase();
    }

    const fastly = String(headers['x-country-code'] || '').trim().toUpperCase();
    if (fastly && /^[A-Z]{2}$/.test(fastly)) return fastly;

    return null;
}

/**
 * Cloudflare's `cf-region-code` carries the ISO 3166-2 subdivision
 * (e.g. `ENG`, `SCT`, `CA`) when the "Send subdivision data" option is
 * enabled in the dashboard. Returns the bare code without the country
 * prefix, or `null` if unavailable.
 */
export function getResolvedRegion(req: Request): string | null {
    const headers = req.headers || {};
    const cf = String(headers['cf-region-code'] || '').trim().toUpperCase();
    if (cf && /^[A-Z0-9]{1,4}$/.test(cf)) return cf;
    return null;
}
