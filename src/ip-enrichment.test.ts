import { describe, expect, it } from 'vitest';
import { asnNumber, clampEnrichment, IpEnricher, parseIpApi, parseIpinfo } from './ip-enrichment';

// Shapes from the providers' documentation.
const IP_API_OK = {
    status: 'success', countryCode: 'GB', regionName: 'England', city: 'London', timezone: 'Europe/London',
    isp: 'Virgin Media', org: 'Virgin Media Limited', as: 'AS5089 Virgin Media Limited', proxy: false, hosting: false, mobile: false,
};
const IPINFO_STD = {
    ip: '8.8.8.8', city: 'Mountain View', region: 'California', country: 'US', loc: '37.4,-122.1',
    org: 'AS15169 Google LLC', timezone: 'America/Los_Angeles',
    privacy: { vpn: false, proxy: false, tor: false, relay: false, hosting: true, service: '' },
};
const IPINFO_LITE = { ip: '1.1.1.1', asn: 'AS13335', as_name: 'Cloudflare, Inc.', as_domain: 'cloudflare.com', country_code: 'AU', country: 'Australia' };

describe('enrichment parsers', () => {
    it('ip-api: maps fields and keeps the AS number only', () => {
        const r = clampEnrichment(parseIpApi(IP_API_OK)!, 'ip-api.com');
        expect(r).toMatchObject({
            country: 'GB', region: 'England', city: 'London', timezone: 'Europe/London', asn: 'AS5089', org: 'Virgin Media Limited',
            isProxy: false, isHosting: false, isMobile: false, isVpn: null, isTor: null, enrichedBy: 'ip-api.com',
        });
        expect(parseIpApi({ status: 'fail', message: 'reserved range' })).toBeNull();
        expect(parseIpApi(null)).toBeNull();
    });

    it('ip-api: falls back to isp and the AS name for org', () => {
        expect(parseIpApi({ ...IP_API_OK, org: '' })!.org).toBe('Virgin Media');
        expect(parseIpApi({ ...IP_API_OK, org: '', isp: '' })!.org).toBe('Virgin Media Limited');
    });

    it('ipinfo standard response: ASN from org, privacy flags, hosting', () => {
        const r = clampEnrichment(parseIpinfo(IPINFO_STD)!, 'ipinfo.io');
        expect(r).toMatchObject({ country: 'US', region: 'California', city: 'Mountain View', asn: 'AS15169', org: 'Google LLC', isHosting: true, isVpn: false, isTor: false, isProxy: false });
        expect(parseIpinfo({ ip: '10.0.0.1', bogon: true })).toBeNull();
    });

    it('ipinfo lite response', () => {
        const r = clampEnrichment(parseIpinfo(IPINFO_LITE)!, 'ipinfo.io');
        expect(r).toMatchObject({ country: 'AU', asn: 'AS13335', org: 'Cloudflare, Inc.', isHosting: null });
    });

    it('ipinfo: relay counts as proxy, carrier as mobile', () => {
        const r = parseIpinfo({ ...IPINFO_STD, privacy: { vpn: false, proxy: false, tor: false, relay: true, hosting: false }, carrier: { name: 'EE' } })!;
        expect(r.isProxy).toBe(true);
        expect(r.isMobile).toBe(true);
        expect(r.isHosting).toBe(false);
    });

    it('clamps every value to its column and normalises the ASN', () => {
        const long = 'x'.repeat(500);
        const r = clampEnrichment({ country: 'gbr-long', region: long, city: long, timezone: long, org: long, asn: 'as4294967295 Big', isVpn: 'yes' as any }, 'c'.repeat(50));
        expect(r.country).toBe('GBR-LONG');
        expect(r.region!.length).toBe(64);
        expect(r.city!.length).toBe(128);
        expect(r.timezone!.length).toBe(64);
        expect(r.org!.length).toBe(255);
        expect(r.asn).toBe('AS4294967295');
        expect(r.isVpn).toBeNull();
        expect(r.enrichedBy.length).toBe(32);
        expect(asnNumber(5089)).toBe('AS5089');
        expect(asnNumber('AS99999999999')).toBeNull();
        expect(asnNumber('Virgin')).toBeNull();
    });
});

function fakeFetch(body: any, calls: string[], status = 200) {
    return async (url: string) => { calls.push(url); return { ok: status === 200, status, json: async () => body }; };
}

describe('IpEnricher', () => {
    it('never looks up private / reserved addresses', async () => {
        const calls: string[] = [];
        const e = new IpEnricher({ provider: 'ip-api' }, { fetch: fakeFetch(IP_API_OK, calls) });
        for (const ip of ['10.0.0.1', '192.168.0.2', '::1', '::ffff:127.0.0.1', 'fe80::1']) expect(await e.lookup(ip)).toBeNull();
        expect(calls).toEqual([]);
    });

    it('uses the free HTTP endpoint without a key and https://pro.ip-api.com with one', async () => {
        const calls: string[] = [];
        await new IpEnricher({ provider: 'ip-api' }, { fetch: fakeFetch(IP_API_OK, calls) }).lookup('81.2.69.142');
        await new IpEnricher({ provider: 'ip-api', key: 'K1' }, { fetch: fakeFetch(IP_API_OK, calls) }).lookup('81.2.69.142');
        expect(calls[0]).toMatch(/^http:\/\/ip-api\.com\/json\/81\.2\.69\.142\?fields=/);
        expect(calls[1]).toMatch(/^https:\/\/pro\.ip-api\.com\/json\/81\.2\.69\.142\?key=K1&fields=/);
    });

    it('sends the ipinfo token as a bearer header, not in the URL', async () => {
        let seen: any = null;
        const e = new IpEnricher({ provider: 'ipinfo', token: 'tok' }, {
            fetch: async (url: string, init: any) => { seen = { url, init }; return { ok: true, status: 200, json: async () => IPINFO_STD }; },
        });
        await e.lookup('8.8.8.8');
        expect(seen.url).toBe('https://ipinfo.io/8.8.8.8/json');
        expect(seen.init.headers.authorization).toBe('Bearer tok');
        expect(seen.init.signal).toBeDefined();
    });

    it('caches per IP for the TTL, then looks up again', async () => {
        const calls: string[] = [];
        let now = 1_000_000;
        const e = new IpEnricher({ provider: 'ip-api', cacheTtlMs: 60_000 }, { fetch: fakeFetch(IP_API_OK, calls), now: () => now });
        await e.lookup('81.2.69.142');
        expect(e.peek('81.2.69.142')).toMatchObject({ country: 'GB' });
        await e.lookup('81.2.69.142');
        expect(calls).toHaveLength(1);
        now += 61_000;
        expect(e.peek('81.2.69.142')).toBeUndefined();
        await e.lookup('81.2.69.142');
        expect(calls).toHaveLength(2);
    });

    it('drops lookups over the per-minute budget instead of queueing them', async () => {
        const calls: string[] = [];
        let now = 5_000_000;
        const e = new IpEnricher({ provider: 'ip-api', key: 'k', maxLookupsPerMinute: 2 }, { fetch: fakeFetch(IP_API_OK, calls), now: () => now });
        expect(await e.lookup('8.8.8.1')).not.toBeNull();
        expect(await e.lookup('8.8.8.2')).not.toBeNull();
        expect(await e.lookup('8.8.8.3')).toBeNull(); // dropped
        expect(calls).toHaveLength(2);
        expect(await e.lookup('8.8.8.1')).not.toBeNull(); // cache hit costs nothing
        now += 60_001;
        expect(await e.lookup('8.8.8.3')).not.toBeNull();
        expect(calls).toHaveLength(3);
    });

    it('defaults the budget to 40/min for the free ip-api endpoint', async () => {
        const calls: string[] = [];
        const e = new IpEnricher({ provider: 'ip-api' }, { fetch: fakeFetch(IP_API_OK, calls), now: () => 0 });
        for (let i = 1; i <= 45; i++) await e.lookup(`8.8.${Math.floor(i / 200)}.${i}`);
        expect(calls).toHaveLength(40);
    });

    it('does not cache a transient failure; caches a "no data" answer', async () => {
        const calls: string[] = [];
        const failing = new IpEnricher({ provider: 'ip-api', key: 'k' }, { fetch: fakeFetch({}, calls, 503) });
        expect(await failing.lookup('8.8.4.4')).toBeNull();
        expect(failing.peek('8.8.4.4')).toBeUndefined();
        const nodata = new IpEnricher({ provider: 'ip-api', key: 'k' }, { fetch: fakeFetch({ status: 'fail' }, calls) });
        expect(await nodata.lookup('8.8.4.4')).toBeNull();
        expect(nodata.peek('8.8.4.4')).toBeNull();
    });

    it('looks up the validated, canonical address only: no zone ids, one cache entry per address', async () => {
        const calls: string[] = [];
        const e = new IpEnricher({ provider: 'ip-api', key: 'k' }, { fetch: fakeFetch(IP_API_OK, calls) });
        // From a trusted header: a zone suffix (with a path / query in it) is refused outright.
        expect(await e.lookup('2001:4860:4860::8888%/../../x?y=1')).toBeNull();
        expect(await e.lookup('2001:4860:4860::8888%eth0')).toBeNull();
        expect(calls).toEqual([]);
        await e.lookup('[2001:4860::1]');
        await e.lookup('2001:4860:0:0:0:0:0:1');
        await e.lookup('2001:4860::0001');
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatch(/^https:\/\/pro\.ip-api\.com\/json\/2001%3A4860%3A%3A1\?/);
        // NAT64 / 6to4 forms of a private IPv4 address are never sent.
        for (const ip of ['64:ff9b::10.0.0.1', '64:ff9b::a00:1', '2002:a00:1::1', '64:ff9b:1::8.8.8.8']) expect(await e.lookup(ip), ip).toBeNull();
        expect(calls).toHaveLength(1);
        const seen: string[] = [];
        const custom = new IpEnricher({ provider: 'custom', lookup: (ip: string) => { seen.push(ip); return { country: 'US' }; } });
        await custom.lookup('::ffff:8.8.8.8');
        await custom.lookup('[2606:4700:4700::1111]');
        expect(seen).toEqual(['8.8.8.8', '2606:4700:4700::1111']);
    });

    it('shares one in-flight lookup for concurrent events from the same IP', async () => {
        const calls: string[] = [];
        const e = new IpEnricher({ provider: 'ip-api', key: 'k' }, { fetch: fakeFetch(IP_API_OK, calls) });
        await Promise.all([e.lookup('9.9.9.9'), e.lookup('9.9.9.9'), e.lookup('9.9.9.9')]);
        expect(calls).toHaveLength(1);
    });

    it('custom provider: clamps its result and survives a throwing lookup', async () => {
        const ok = new IpEnricher({ provider: 'custom', name: 'geo-db', lookup: () => ({ country: 'de', asn: 3320, isHosting: true }) });
        expect(await ok.lookup('91.0.0.1')).toMatchObject({ country: 'DE', asn: 'AS3320', isHosting: true, enrichedBy: 'geo-db' });
        const bad = new IpEnricher({ provider: 'custom', lookup: () => { throw new Error('down'); } });
        expect(await bad.lookup('91.0.0.1')).toBeNull();
    });
});
