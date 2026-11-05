import { describe, expect, it, vi } from 'vitest';

// TypeORM entities need emitted decorator metadata, which the test transform does not produce.
vi.mock('./email-log.entity', () => ({ EmailLog: class EmailLog {} }));
vi.mock('./email-event.entity', () => ({ EmailEvent: class EmailEvent {} }));
vi.mock('./email-suppression.entity', () => ({ EmailSuppression: class EmailSuppression {} }));
import { getWebhookLimits, TokenBuckets, WebhookLimits, WEBHOOK_VERIFIED_DEFAULT } from './http-helpers';
import { lookupGeo, resetGeoLookup } from './geo-lookup';
import { historyPageSize } from './order-activity.service';
import { databaseClockSkewMinutes } from './db-clock';
import { isSensitiveUrl, redactSensitiveUrl } from './link-meta';
import { EmailTrackingService } from './email-tracking.service';
import { setOptions } from './options';

describe('webhook rate limits', () => {
    it('token buckets can be checked without spending, and refill over the window', () => {
        const b = new TokenBuckets(2, 60_000);
        expect(b.has('a', 0)).toBe(true);
        expect(b.take('a', 0)).toBe(true);
        expect(b.take('a', 0)).toBe(true);
        expect(b.has('a', 0)).toBe(false);
        expect(b.take('a', 0)).toBe(false);
        expect(b.has('a', 30_000)).toBe(true); // one token back after half the window
        expect(b.has('b', 0)).toBe(true);
    });

    it('junk spends only the failure allowance; verified requests have their own, per provider', () => {
        const l = new WebhookLimits({ capacity: 2, windowMs: 60_000 }, { capacity: 3, windowMs: 60_000 });
        const ip = '203.0.113.50';
        for (let i = 0; i < 3; i++) expect(l.allowVerified('mailgun', ip)).toBe(true);
        expect(l.allowVerified('mailgun', ip)).toBe(false);
        expect(l.allowVerified('sendgrid', ip)).toBe(true); // another provider's allowance
        expect(l.blocked(ip)).toBe(false); // verified traffic never blocks the address
        l.chargeFailure(ip); l.chargeFailure(ip);
        expect(l.blocked(ip)).toBe(true);
        expect(l.allowVerified('sendgrid', ip)).toBe(true); // … and junk never throttles verified traffic
        expect(l.blocked(null)).toBe(false);
    });

    it('defaults: failures follow rateLimit, verified 1 200 a minute; rebuilt when the options change', () => {
        setOptions({ publicBaseUrl: 'https://s.example', rateLimit: { capacity: 1, windowMs: 60_000 } });
        const a = getWebhookLimits();
        a.chargeFailure('198.51.100.1');
        expect(a.blocked('198.51.100.1')).toBe(true);
        expect(getWebhookLimits()).toBe(a);
        setOptions({ publicBaseUrl: 'https://s.example', providerWebhooks: { rateLimit: { failed: { capacity: 5, windowMs: 60_000 } } } });
        const b = getWebhookLimits();
        expect(b).not.toBe(a);
        b.chargeFailure('198.51.100.1');
        expect(b.blocked('198.51.100.1')).toBe(false);
        expect(WEBHOOK_VERIFIED_DEFAULT).toEqual({ capacity: 1200, windowMs: 60_000 });
    });
});

describe('GeoLite2 lookup never waits on the network', () => {
    it('a reader that never loads (its updater cannot reach GitHub): one bounded wait, then empty results at once', async () => {
        let loads = 0;
        resetGeoLookup(() => { loads++; return new Promise(() => { /* never */ }); });
        const t0 = Date.now();
        expect(await lookupGeo('8.8.8.8', 50)).toEqual({ country: null, region: null, city: null, timezone: null });
        expect(Date.now() - t0).toBeLessThan(1000);
        const t1 = Date.now();
        for (let i = 0; i < 5; i++) await lookupGeo('8.8.4.4', 5000);
        expect(Date.now() - t1).toBeLessThan(200);
        expect(loads).toBe(1);
        resetGeoLookup();
    });

    it('a reader that loads is used; a missing module is not tried again; private addresses are never looked up', async () => {
        let loads = 0;
        resetGeoLookup(async () => { loads++; return { city: () => ({ country: { isoCode: 'US' }, city: { names: { en: 'Mountain View' } }, location: { timeZone: 'America/Los_Angeles' } }) }; });
        expect(await lookupGeo('8.8.8.8')).toEqual({ country: 'US', region: null, city: 'Mountain View', timezone: 'America/Los_Angeles' });
        expect(await lookupGeo('10.0.0.1')).toEqual({ country: null, region: null, city: null, timezone: null });
        expect(loads).toBe(1);
        resetGeoLookup(async () => { loads++; throw new Error('Cannot find module geolite2-redist'); });
        await lookupGeo('8.8.8.8');
        await lookupGeo('8.8.8.8');
        expect(loads).toBe(2);
        resetGeoLookup();
    });
});

describe('order history page size', () => {
    it('never asks Vendure for more than the list limit of the request\'s API type', () => {
        expect(historyPageSize('custom', { shopListQueryLimit: 100, adminListQueryLimit: 1000 })).toBe(100);
        expect(historyPageSize('custom', { shopListQueryLimit: 50, adminListQueryLimit: 1000 })).toBe(50);
        expect(historyPageSize('admin', { shopListQueryLimit: 50, adminListQueryLimit: 1000 })).toBe(100);
        expect(historyPageSize('admin', { shopListQueryLimit: 500, adminListQueryLimit: 20 })).toBe(20);
        expect(historyPageSize(undefined, undefined)).toBe(100);
        expect(historyPageSize('shop', { shopListQueryLimit: 0 })).toBe(100);
    });
});

describe('database clock check', () => {
    const now = Date.parse('2026-11-04T21:00:00Z');
    it('reads LOCALTIMESTAMP through the driver and reports the skew in minutes', async () => {
        const sql: string[] = [];
        const q = (v: unknown) => async (s: string) => { sql.push(s); return [{ dbNow: v }]; };
        expect(await databaseClockSkewMinutes(q(new Date(now + 5 * 3600_000)), 'postgres', now)).toBe(300);
        expect(await databaseClockSkewMinutes(q(new Date(now + 20_000)), 'mysql', now)).toBe(0);
        expect(await databaseClockSkewMinutes(q('2026-11-04 21:00:00'), 'mariadb', Date.parse('2026-11-04T21:00:00'))).toBe(0);
        expect(sql[0]).toBe('SELECT LOCALTIMESTAMP AS `dbNow`');
        expect(await databaseClockSkewMinutes(q(new Date()), 'sqljs', now)).toBeNull();
        expect(await databaseClockSkewMinutes(async () => { throw new Error('denied'); }, 'mysql', now)).toBeNull();
    });
});

describe('recorded URLs never carry an email address', () => {
    it('a query value holding an address is redacted like a secret', () => {
        expect(isSensitiveUrl('https://shop.example.com/track?email=bea%40example.com&order=7')).toBe(true);
        expect(redactSensitiveUrl('https://shop.example.com/track?email=bea@example.com&order=7')).toBe('https://shop.example.com/track?[redacted]');
        expect(redactSensitiveUrl('https://shop.example.com/p?id=3&ref=newsletter')).toBe('https://shop.example.com/p?id=3&ref=newsletter');
        expect(redactSensitiveUrl('https://shop.example.com/p?handle=@shop')).toBe('https://shop.example.com/p?handle=@shop');
    });
});

describe('bare (unsigned) ids while a signing secret exists: an event only, never email_log', () => {
    function tracking(sendInfo: any) {
        const sql: string[] = [];
        const updates: any[] = [];
        const engagement: any[] = [];
        const repo = {
            findOne: async ({ where }: any) => (where?.id === 4 ? { id: 4, orderId: 9, customerId: 2, channelId: 1, opensJson: '[]', clicksJson: '[]' } : null),
            update: async (id: any, patch: any) => { updates.push({ id, patch }); return { affected: 1 }; },
        };
        const conn: any = { rawConnection: { options: { type: 'mysql' }, query: async (q: string) => { sql.push(q); return { affectedRows: 1 }; }, getRepository: () => repo } };
        const events: any = {
            sendInfo: async () => sendInfo,
            linksFor: async () => null,
            recordEngagement: async (e: any) => { engagement.push(e); return { id: 1, duplicate: false, failed: false, capped: false }; },
        };
        const svc = new EmailTrackingService(conn, { isWorker: false } as any, events);
        return { svc, sql, updates, engagement };
    }

    it('records the open and the click as unverified events and leaves the counters, first-open fields and history alone', async () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com', signingSecret: 'configured-secret' });
        const t = tracking(null); // sent before 0.16.0: no send event
        await t.svc.recordOpen(4, '81.2.69.142', 'Mozilla/5.0', { signed: false });
        await t.svc.recordClick(4, 'https://shop.example.com/p', '81.2.69.142', 'Mozilla/5.0', undefined, { signed: false });
        expect(t.sql.filter(q => /UPDATE email_log/.test(q))).toEqual([]);
        expect(t.updates).toEqual([]);
        expect(t.engagement.map(e => [e.type, e.unsigned, e.log.id, e.log.orderId])).toEqual([['open', true, 4, 9], ['click', true, 4, 9]]);
    });

    it('a signed hit still counts; a bare id of an email whose links were signed is not recorded at all', async () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com', signingSecret: 'configured-secret' });
        const counted = tracking(null);
        await counted.svc.recordOpen(4, null, 'Mozilla/5.0', { signed: true });
        expect(counted.sql.filter(q => /UPDATE email_log SET `openCount`/.test(q))).toHaveLength(1);
        expect(counted.engagement).toHaveLength(1);
        const forged = tracking({ signed: true, links: [] });
        await forged.svc.recordOpen(4, null, 'Mozilla/5.0', { signed: false });
        expect(forged.sql).toEqual([]);
        expect(forged.engagement).toEqual([]);
    });

    it('without any signing secret (every link a bare id) the counters work as in 0.15.4', async () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com' });
        const t = tracking(null);
        await t.svc.recordOpen(4, null, 'Mozilla/5.0', { signed: false });
        expect(t.sql.filter(q => /UPDATE email_log SET `openCount`/.test(q))).toHaveLength(1);
        expect(t.engagement[0].unsigned).toBe(true);
    });
});
