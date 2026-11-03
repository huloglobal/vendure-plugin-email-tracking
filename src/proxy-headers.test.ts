import { describe, expect, it } from 'vitest';
import { getRealIp, getResolvedCountry, getResolvedRegion } from './proxy-headers';

const req = (headers: Record<string, string>, ip?: string): any => ({ headers, ip });

describe('getRealIp', () => {
    it('uses req.ip by default and ignores every proxy header (they are client-spoofable)', () => {
        expect(getRealIp(req({
            'cf-connecting-ip': '1.1.1.1', 'true-client-ip': '2.2.2.2',
            'x-real-ip': '3.3.3.3', 'x-forwarded-for': '4.4.4.4',
        }, '5.5.5.5'))).toBe('5.5.5.5');
    });
    it('honours only the headers the host trusts, in the order given', () => {
        const all = ['cf-connecting-ip', 'true-client-ip', 'x-real-ip', 'x-forwarded-for'] as const;
        expect(getRealIp(req({ 'cf-connecting-ip': '1.1.1.1', 'x-real-ip': '3.3.3.3' }, '5.5.5.5'), [...all])).toBe('1.1.1.1');
        expect(getRealIp(req({ 'true-client-ip': '2.2.2.2', 'x-real-ip': '3.3.3.3' }), [...all])).toBe('2.2.2.2');
        expect(getRealIp(req({ 'x-real-ip': '3.3.3.3' }), [...all])).toBe('3.3.3.3');
        expect(getRealIp(req({ 'x-forwarded-for': '4.4.4.4' }), ['x-forwarded-for'])).toBe('4.4.4.4');
    });
    it('takes the right-most public XFF hop: entries the client sent itself cannot pick the IP', () => {
        // Client sent "X-Forwarded-For: 1.2.3.4"; the trusted proxy appended the real peer.
        expect(getRealIp(req({ 'x-forwarded-for': '1.2.3.4, 198.51.100.7' }), ['x-forwarded-for'])).toBe('198.51.100.7');
        // A fresh spoofed value per request must not mint a fresh rate-limit bucket.
        const seen = new Set([1, 2, 3].map(n => getRealIp(req({ 'x-forwarded-for': `9.9.9.${n}, 198.51.100.7` }), ['x-forwarded-for'])));
        expect([...seen]).toEqual(['198.51.100.7']);
    });
    it('skips our own private proxy hops in XFF and strips the IPv4-mapped prefix', () => {
        expect(getRealIp(req({ 'x-forwarded-for': '  203.0.113.1 , 10.0.0.1 , 10.0.0.2 ' }), ['x-forwarded-for'])).toBe('203.0.113.1');
        expect(getRealIp(req({ 'x-forwarded-for': '6.6.6.6, ::ffff:203.0.113.5, 192.168.1.25' }), ['x-forwarded-for'])).toBe('203.0.113.5');
        expect(getRealIp(req({}, '::ffff:203.0.113.9'))).toBe('203.0.113.9');
    });
    it('falls back to req.ip then null', () => {
        expect(getRealIp(req({}, '5.5.5.5'))).toBe('5.5.5.5');
        expect(getRealIp(req({}))).toBeNull();
    });
});

describe('getResolvedCountry', () => {
    it('reads cf-ipcountry', () => {
        expect(getResolvedCountry(req({ 'cf-ipcountry': 'gb' }))).toBe('GB');
    });
    it('ignores CF placeholders XX and T1', () => {
        expect(getResolvedCountry(req({ 'cf-ipcountry': 'XX' }))).toBeNull();
        expect(getResolvedCountry(req({ 'cf-ipcountry': 'T1' }))).toBeNull();
    });
    it('parses Akamai edgescape', () => {
        expect(getResolvedCountry(req({ 'x-akamai-edgescape': 'georegion=246,country_code=US,region_code=CA' }))).toBe('US');
    });
    it('reads the Fastly country header', () => {
        expect(getResolvedCountry(req({ 'x-country-code': 'de' }))).toBe('DE');
        expect(getResolvedCountry(req({ 'x-country-code': 'not-a-code' }))).toBeNull();
    });
    it('returns null when nothing present', () => {
        expect(getResolvedCountry(req({}))).toBeNull();
    });
});

describe('getResolvedRegion', () => {
    it('reads cf-region-code', () => {
        expect(getResolvedRegion(req({ 'cf-region-code': 'eng' }))).toBe('ENG');
        expect(getResolvedRegion(req({ 'cf-region-code': 'CA' }))).toBe('CA');
    });
    it('rejects malformed region codes and empties', () => {
        expect(getResolvedRegion(req({ 'cf-region-code': 'TOOLONG' }))).toBeNull();
        expect(getResolvedRegion(req({}))).toBeNull();
    });
});
