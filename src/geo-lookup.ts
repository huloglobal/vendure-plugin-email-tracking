/**
 * Best-effort MaxMind GeoLite2 lookup for IPs seen on opens / clicks.
 *
 * The dependency is intentionally soft — geolite2-redist and
 * @maxmind/geoip2-node are NOT package.json dependencies of this plugin.
 * If they're present at runtime (typically because the visitor-analytics
 * plugin is also installed), we use them; otherwise we return nulls.
 *
 * This keeps the email-tracking plugin's install size small while still
 * enriching with geo when the data is already on disk.
 *
 * geolite2-redist's `open()` resolves only after its auto-updater has
 * checked the database checksum on GitHub (raw.githubusercontent.com); when
 * GitHub cannot be reached it never resolves. So the reader is loaded once
 * per process in the background, the first lookups wait for it at most
 * `GEO_READER_WAIT_MS`, and after one such wait has run out every lookup
 * returns an empty result at once until the reader is ready. A recording
 * never waits on the network.
 */
let reader: any | null = null;
let loading: Promise<void> | null = null;
let unavailable = false;
let waitedOut = false;

/** Longest a lookup waits for the GeoLite2 reader to load. */
export const GEO_READER_WAIT_MS = 1_000;

export interface GeoLookup {
    country: string | null;
    region: string | null;
    city: string | null;
    timezone: string | null;
}

const EMPTY: GeoLookup = { country: null, region: null, city: null, timezone: null };

/** How the reader is opened; replaced by the tests. */
export type GeoReaderLoader = () => Promise<any | null>;

const defaultLoader: GeoReaderLoader = async () => {
    const geolite2 = await import('geolite2-redist');
    const { Reader } = await import('@maxmind/geoip2-node');
    return (geolite2 as any).open('GeoLite2-City', (p: string) => (Reader as any).open(p));
};
let loader: GeoReaderLoader = defaultLoader;

/** Test hook: a different reader loader, and a fresh state. */
export function resetGeoLookup(l: GeoReaderLoader | null = null): void {
    loader = l || defaultLoader;
    reader = null;
    loading = null;
    unavailable = false;
    waitedOut = false;
}

export async function lookupGeo(ip: string | null | undefined, waitMs = GEO_READER_WAIT_MS): Promise<GeoLookup> {
    if (!ip || isLocal(ip)) return EMPTY;
    const r = await getReader(waitMs);
    if (!r) return EMPTY;
    try {
        const res = r.city(ip);
        return {
            country: res?.country?.isoCode?.slice(0, 8) || null,
            region: res?.subdivisions?.[0]?.isoCode?.slice(0, 8) || null,
            city: res?.city?.names?.en?.slice(0, 100) || null,
            timezone: res?.location?.timeZone?.slice(0, 64) || null,
        };
    } catch {
        return EMPTY;
    }
}

async function getReader(waitMs: number): Promise<any | null> {
    if (reader) return reader;
    if (unavailable) return null;
    if (!loading) {
        // One load per process, whatever happens: a module that is not installed
        // (or fails to open) is not tried again.
        loading = (async () => {
            try {
                reader = (await loader()) || null;
                if (!reader) unavailable = true;
            } catch {
                reader = null;
                unavailable = true;
            }
        })();
    }
    if (waitedOut) return null; // still loading in the background
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
        loading.then(() => false),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), Math.max(0, waitMs)); (timer as any).unref?.(); }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut) {
        waitedOut = true;
        return null;
    }
    return reader;
}

function isLocal(ip: string): boolean {
    if (ip === '::1' || ip.startsWith('127.') || ip.startsWith('10.')
        || ip.startsWith('192.168.') || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip)) {
        return true;
    }
    return false;
}
