import { describe, expect, it, vi } from 'vitest';

// TypeORM entities need emitted decorator metadata, which the test transform does not produce.
vi.mock('./email-log.entity', () => ({ EmailLog: class EmailLog {} }));
vi.mock('./email-event.entity', () => ({ EmailEvent: class EmailEvent {} }));
import {
    CAPPED_REASON, EmailEventService, ENGAGEMENT_EVENTS_PER_DAY, eventIpHash, EVENT_INSERT_COLUMNS, mergeLocation, providerClickUrl, recipientHash,
    scrubAddresses, UNSIGNED_EVENTS_PER_DAY, UNSIGNED_REASON, utcDayStart,
} from './email-event.service';
import { DEFAULT_IP_SALT, setOptions } from './options';
import { IpEnricher } from './ip-enrichment';
import { correlationToken, wrapTrackedHtml } from './outgoing-mail';
import { applyStatusChange, nextStatus, STATUS_RANK } from './event-types';
import type { ProviderEvent } from './webhook-mappers';

interface Fake {
    sql: Array<{ sql: string; params: any[] }>;
    updates: Array<{ id: any; patch: any }>;
    inserted: any[];
}

function service(opts: { type?: string; logs?: any[]; insert?: (sql: string, params: any[]) => any; throwOn?: RegExp; sendEvent?: any } = {}) {
    const fake: Fake = { sql: [], updates: [], inserted: [] };
    let nextId = 100;
    const repo = {
        findOne: async ({ where }: any) => {
            if (where?.dedupeKey) return fake.inserted.find(r => r.dedupeKey === where.dedupeKey) || null;
            if (where?.emailLogId !== undefined && where?.source === 'smtp') return opts.sendEvent || null;
            if (where?.id) return (opts.logs || []).find(l => l.id === where.id) || null;
            if (where?.smtpMessageId) {
                const ids: string[] = where.smtpMessageId._value || [where.smtpMessageId];
                return (opts.logs || []).find(l => ids.includes(l.smtpMessageId)) || null;
            }
            return null;
        },
        insert: async (row: any) => { fake.inserted.push(row); return { identifiers: [{ id: nextId++ }] }; },
        update: async (id: any, patch: any) => { fake.updates.push({ id, patch }); return { affected: 1 }; },
    };
    const conn: any = {
        rawConnection: {
            options: { type: opts.type || 'mysql' },
            query: async (sql: string, params: any[]) => {
                if (opts.throwOn && opts.throwOn.test(sql)) throw new Error("Table 'shop.email_event' doesn't exist");
                fake.sql.push({ sql, params });
                if (/^INSERT IGNORE INTO email_event/.test(sql)) return opts.insert ? opts.insert(sql, params) : { affectedRows: 1, insertId: nextId++ };
                return { affectedRows: 1 };
            },
            getRepository: () => repo,
        },
    };
    return { svc: new EmailEventService(conn), fake };
}

const pe = (over: Partial<ProviderEvent> = {}): ProviderEvent => ({
    provider: 'sendgrid', type: 'bounced', occurredAt: new Date('2026-11-04T12:00:00Z'), recipient: 'jane@example.com', eventKey: 'ev-1',
    correlation: null, messageId: 'm1@shop', providerMessageId: null, detail: '550 no such user', suppress: 'hard-bounce',
    ip: null, userAgent: null, url: null, payload: { event: 'bounce' }, ...over,
});

describe('EmailEventService.buildRow', () => {
    it('hashes the IP per hashIpsInHistory, never stores the recipient in clear, classifies opens', () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com', ipSalt: 'salt', hashIpsInHistory: true });
        const { svc } = service();
        const row = svc.buildRow({
            type: 'open', source: 'pixel', log: { id: 5, orderId: 9, customerId: 3, channelId: 2 }, ip: '81.2.69.142',
            userAgent: 'Mozilla/5.0 (via ggpht.com GoogleImageProxy)', recipient: 'Jane@Example.com', geo: { country: 'GB', region: 'ENG', city: 'London', timezone: 'Europe/London' },
        });
        expect(row).toMatchObject({ emailLogId: 5, orderId: 9, customerId: 3, channelId: 2, type: 'open', source: 'pixel', country: 'GB', client: 'Gmail (prefetch)', isBot: true, classification: 'machine_likely' });
        expect(row.ip).toMatch(/^[0-9a-f]{32}$/);
        expect(row.ip).not.toContain('81.2');
        expect(row.ipHash).toBe(row.ip);
        expect(row.recipientHash).toBe(recipientHash('jane@example.com', 'salt'));
        expect(row.ipHash).toBe(eventIpHash('81.2.69.142', 'salt'));
        expect(row.classificationReasons).toContain('gmail-proxy');
        expect(Object.keys(row).sort()).toEqual([...EVENT_INSERT_COLUMNS].sort());
        setOptions({ publicBaseUrl: 'https://shop.example.com', ipSalt: 'salt', hashIpsInHistory: false });
        expect(svc.buildRow({ type: 'click', source: 'redirect', ip: '81.2.69.142' }).ip).toBe('81.2.69.142');
    });

    it('clamps text columns and keeps only a bounded payload', () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com' });
        const { svc } = service();
        const row = svc.buildRow({
            type: 'sent', source: 'smtp', messageId: `<${'m'.repeat(400)}@x>`, detail: 'd'.repeat(5000), url: 'u'.repeat(5000), linkText: 't'.repeat(500),
            payload: { links: Array.from({ length: 300 }, (_v, i) => ({ i, t: 'x'.repeat(120), s: false, h: 'f'.repeat(16) })) },
        });
        expect(row.messageId.length).toBe(255);
        expect(row.messageId.startsWith('<')).toBe(false);
        expect(row.detail.length).toBe(2000);
        expect(row.url.length).toBe(2000);
        expect(row.linkText.length).toBe(120);
        expect(row.payload.length).toBeLessThanOrEqual(16_000);
        expect(row.classification).toBeNull(); // only opens and clicks are classified
    });
});

describe('event hashes: keyed, never the public default salt once a secret exists', () => {
    it('without ipSalt the HMAC key is the signing secret; the canonical IP is hashed', () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com', signingSecret: 'install-secret' });
        const { svc } = service();
        const a = svc.buildRow({ type: 'open', source: 'pixel', ip: '2001:4860:4860:0:0:0:0:8888', recipient: 'pm-ok@example.com' });
        const b = svc.buildRow({ type: 'open', source: 'pixel', ip: '[2001:4860:4860::8888]' });
        expect(a.ipHash).toBe(b.ipHash); // one address, one hash, whatever the notation
        expect(a.ipHash).toBe(eventIpHash('2001:4860:4860::8888', 'install-secret'));
        expect(a.ipHash).not.toBe(eventIpHash('2001:4860:4860::8888', DEFAULT_IP_SALT));
        expect(a.recipientHash).toBe(recipientHash('pm-ok@example.com', 'install-secret'));
        expect(a.recipientHash).not.toBe(recipientHash('pm-ok@example.com', DEFAULT_IP_SALT));
        setOptions({ publicBaseUrl: 'https://shop.example.com', signingSecret: 'install-secret', hashIpsInHistory: false });
        expect(svc.buildRow({ type: 'click', source: 'redirect', ip: '::ffff:8.8.8.8' }).ip).toBe('8.8.8.8');
    });

    it('an unsigned-link hit is flagged and never enriched', async () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com', signingSecret: 'install-secret' });
        const { svc } = service();
        const row = svc.buildRow({ type: 'open', source: 'pixel', ip: '8.8.8.8', userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537.36', unsigned: true });
        expect(row.classificationReasons.split(',')[0]).toBe(UNSIGNED_REASON);
        const lookup = vi.fn(() => ({ country: 'US' }));
        svc.setEnricher(new IpEnricher({ provider: 'custom', lookup }));
        await svc.record({ type: 'open', source: 'pixel', ip: '8.8.8.8', unsigned: true });
        await new Promise(r => setTimeout(r, 10));
        expect(lookup).not.toHaveBeenCalled();
    });
});

describe('EmailEventService.record', () => {
    it('INSERT IGNORE on MySQL / Postgres: new row → id, ignored row → duplicate', async () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com' });
        const { svc, fake } = service({ insert: () => ({ affectedRows: 1, insertId: 41 }) });
        expect(await svc.record({ type: 'sent', source: 'smtp', dedupeKey: 'k' })).toEqual({ id: 41, duplicate: false, failed: false });
        expect(fake.sql[0].sql).toMatch(/^INSERT IGNORE INTO email_event/);
        expect(fake.sql[0].params).toHaveLength(EVENT_INSERT_COLUMNS.length);
        const dup = service({ insert: () => ({ affectedRows: 0, insertId: 0 }) });
        expect(await dup.svc.record({ type: 'bounced', source: 'sendgrid', dedupeKey: 'k' })).toEqual({ id: null, duplicate: true, failed: false });
    });

    it('sqlite: the repository path with a dedupe lookup', async () => {
        const { svc, fake } = service({ type: 'sqljs' });
        expect((await svc.record({ type: 'bounced', source: 'ses', dedupeKey: 'abc' })).id).toBe(100);
        expect((await svc.record({ type: 'bounced', source: 'ses', dedupeKey: 'abc' })).duplicate).toBe(true);
        expect(fake.inserted).toHaveLength(1);
    });

    it('never throws: a missing table (before the migration) is reported as failed', async () => {
        const { svc } = service({ throwOn: /email_event/ });
        expect(await svc.record({ type: 'open', source: 'pixel' })).toEqual({ id: null, duplicate: false, failed: true });
    });
});

describe('EmailEventService.ingest', () => {
    const suppressSpy = () => {
        const calls: any[] = [];
        return { calls, fn: async (...a: any[]) => { calls.push(a); } };
    };

    it('linked hard bounce: event, status precedence update, suppression', async () => {
        const logs = [{ id: 7, orderId: 9, customerId: 3, channelId: 2, recipient: 'jane@example.com', status: 'sent', smtpMessageId: 'm1@shop' }];
        const { svc, fake } = service({ logs });
        const s = suppressSpy();
        expect(await svc.ingest(pe(), { premium: false, recordEngagement: false, suppress: s.fn })).toBe('recorded');
        const update = fake.sql.find(q => q.sql.startsWith('UPDATE email_log SET status'))!;
        expect(update.params.slice(0, 3)).toEqual(['bounced', '550 no such user', 7]);
        expect(update.params.slice(3).sort()).toEqual(['deferred', 'delivered', 'sent']);
        expect(update.sql).toMatch(/status IN \(\?, \?, \?\)$/);
        expect(s.calls).toEqual([['jane@example.com', 'hard-bounce', expect.stringContaining('email #7'), 2]]);
        const insert = fake.sql.find(q => q.sql.startsWith('INSERT IGNORE'))!;
        const col = (c: string) => insert.params[EVENT_INSERT_COLUMNS.indexOf(c as any)];
        expect(col('emailLogId')).toBe(7);
        expect(col('orderId')).toBe(9);
        expect(col('dedupeKey')).toMatch(/^[0-9a-f]{64}$/);
    });

    it('a verified bounce for an address we cannot match still suppresses it', async () => {
        const { svc, fake } = service({ logs: [] });
        const s = suppressSpy();
        expect(await svc.ingest(pe({ messageId: 'unknown@x' }), { premium: true, recordEngagement: false, suppress: s.fn })).toBe('recorded');
        expect(fake.sql.some(q => q.sql.startsWith('UPDATE email_log'))).toBe(false);
        expect(s.calls[0][0]).toBe('jane@example.com');
    });

    it('a provider retry (duplicate) has no effects', async () => {
        const { svc, fake } = service({ logs: [{ id: 7, smtpMessageId: 'm1@shop' }], insert: () => ({ affectedRows: 0 }) });
        const s = suppressSpy();
        expect(await svc.ingest(pe(), { premium: true, recordEngagement: false, suppress: s.fn })).toBe('duplicate');
        expect(s.calls).toEqual([]);
        expect(fake.sql.some(q => q.sql.startsWith('UPDATE'))).toBe(false);
    });

    it('gating: delivered needs premium; soft bounces never suppress; engagement needs recordEngagement', async () => {
        const { svc } = service({ logs: [{ id: 7, smtpMessageId: 'm1@shop' }] });
        const s = suppressSpy();
        expect(await svc.ingest(pe({ type: 'delivered', suppress: null }), { premium: false, recordEngagement: false, suppress: s.fn })).toBe('skipped');
        expect(await svc.ingest(pe({ type: 'delivered', suppress: null, eventKey: 'd' }), { premium: true, recordEngagement: false, suppress: s.fn })).toBe('recorded');
        expect(await svc.ingest(pe({ type: 'soft-bounce', suppress: null, eventKey: 's' }), { premium: false, recordEngagement: false, suppress: s.fn })).toBe('recorded');
        expect(await svc.ingest(pe({ type: 'open', suppress: null, eventKey: 'o' }), { premium: true, recordEngagement: false, suppress: s.fn })).toBe('skipped');
        expect(await svc.ingest(pe({ type: 'open', suppress: null, eventKey: 'o' }), { premium: false, recordEngagement: true, suppress: s.fn })).toBe('skipped');
        expect(await svc.ingest(pe({ type: 'open', suppress: null, eventKey: 'o' }), { premium: true, recordEngagement: true, suppress: s.fn })).toBe('recorded');
        expect(s.calls).toEqual([]);
    });

    it('a failed effect removes the event row again, so the provider\'s retry is processed in full', async () => {
        const logs = [{ id: 7, smtpMessageId: 'm1@shop', status: 'sent' }];
        const { svc, fake } = service({ logs });
        const boom = async () => { throw new Error('db down'); };
        await expect(svc.ingest(pe(), { premium: true, recordEngagement: false, suppress: boom })).rejects.toThrow('db down');
        const del = fake.sql.find(q => q.sql.startsWith('DELETE FROM email_event'))!;
        expect(del.sql).toBe('DELETE FROM email_event WHERE `dedupeKey` = ?');
        expect(del.params[0]).toMatch(/^[0-9a-f]{64}$/);
    });

    it('a drop for a reason other than a bad address moves only sent / deferred to failed', async () => {
        const { svc, fake } = service({ logs: [{ id: 7, smtpMessageId: 'm1@shop', status: 'bounced' }] });
        await svc.ingest(pe({ type: 'dropped', suppress: null, eventKey: 'drop-1', detail: 'Unsubscribed Address' }), { premium: true, recordEngagement: false, suppress: async () => undefined });
        const update = fake.sql.find(q => q.sql.startsWith('UPDATE email_log SET status'))!;
        expect(update.params[0]).toBe('failed');
        expect(update.params.slice(3)).toEqual(['sent', 'deferred']);
    });

    it('a provider click is stored unwrapped (our own tracked link) and redacted, with the link it was', async () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com', signingSecret: 'install-secret' });
        const html = '<a href="https://shop.example.com/account/reset?token=SECRET-RESET">Reset your password</a>';
        const wrapped = wrapTrackedHtml(html, 7);
        const tracked = /href="([^"]+)"/.exec(wrapped.html)![1].replace(/&amp;/g, '&');
        const { svc, fake } = service({ logs: [{ id: 7, smtpMessageId: 'm1@shop' }], sendEvent: { id: 1, payload: JSON.stringify({ signed: true, links: wrapped.links }) } });
        await svc.ingest(pe({ type: 'click', suppress: null, eventKey: 'c1', url: tracked, ip: '8.8.8.8', userAgent: 'Mozilla/5.0' }), { premium: true, recordEngagement: true, suppress: async () => undefined });
        const insert = fake.sql.find(q => q.sql.startsWith('INSERT IGNORE'))!;
        const col = (c: string) => insert.params[EVENT_INSERT_COLUMNS.indexOf(c as any)];
        expect(col('url')).toBe('https://shop.example.com/account/reset?[redacted]');
        expect(JSON.stringify(insert.params)).not.toContain('SECRET-RESET');
        expect([col('linkIndex'), col('linkText')]).toEqual([0, 'Reset your password']);
        // Any other provider-reported URL is redacted the same way.
        expect(providerClickUrl('https://x.example/magic?session=S&jwt=eyJ').url).toBe('https://x.example/magic?[redacted]');
        expect(providerClickUrl('https://shop.example.com/email-track/click/7.abc?s=1').url).toBe('https://shop.example.com/email-track/click/[redacted]');
        expect(providerClickUrl('javascript:alert(1)').url).toBeNull();
    });

    it('correlation prefers the signed id we put on the mail; a value another install signed falls through to the Message-ID', async () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com', signingSecret: 'this-install' });
        const logs = [{ id: 3, smtpMessageId: 'other@x' }, { id: 8, smtpMessageId: 'm1@shop' }];
        const { svc } = service({ logs });
        expect((await svc.findLogFor({ correlation: correlationToken(3), messageId: 'm1@shop', providerMessageId: null }))!.id).toBe(3);
        expect((await svc.findLogFor({ correlation: correlationToken(3, 'another-shop'), messageId: 'm1@shop', providerMessageId: null }))!.id).toBe(8);
        expect((await svc.findLogFor({ correlation: '3', messageId: '<m1@shop>', providerMessageId: null }))!.id).toBe(8);
        expect(await svc.findLogFor({ correlation: correlationToken(99), messageId: null, providerMessageId: null })).toBeNull();
    });
});

describe('IP enrichment write-back', () => {
    it('stores the result and re-classifies with the datacentre flag; GeoLite2 location wins', async () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com' });
        const { svc, fake } = service();
        const enricher = new IpEnricher({ provider: 'custom', lookup: () => ({ country: 'US', city: 'Ashburn', asn: 'AS14618 Amazon', org: 'Amazon.com', isHosting: true }) });
        svc.setEnricher(enricher);
        svc.scheduleEnrichment(55, '54.239.28.85', 'Mozilla/5.0 (Windows NT 10.0) Chrome/120 Safari/537.36', 'click', { country: 'GB', region: null, city: null, timezone: null });
        await new Promise(r => setTimeout(r, 20));
        expect(fake.updates).toHaveLength(1);
        const { id, patch } = fake.updates[0];
        expect(id).toBe(55);
        expect(patch).toMatchObject({ asn: 'AS14618', org: 'Amazon.com', isHosting: true, enrichedBy: 'custom', classification: 'machine_likely' });
        // GeoLite2 said GB, the provider US: no US city is put next to the GB country.
        expect(patch.country).toBeUndefined();
        expect(patch.city).toBeUndefined();
        expect(patch.classificationReasons).toContain('datacentre');
        expect(patch.enrichedAt).toBeInstanceOf(Date);
    });

    it('merges the location as a unit', () => {
        const ie = { country: 'IE', region: 'Leinster', city: 'Dublin', timezone: 'Europe/Dublin' };
        // GeoLite2 country only, provider elsewhere: nothing of the provider's.
        expect(mergeLocation({ country: 'US', region: null, city: null, timezone: 'America/Chicago' }, ie)).toEqual({});
        // Same country: the provider's city comes with its region and timezone.
        expect(mergeLocation({ country: 'US', region: null, city: null, timezone: 'America/Chicago' },
            { country: 'US', region: 'California', city: 'Mountain View', timezone: 'America/Los_Angeles' }))
            .toEqual({ region: 'California', city: 'Mountain View', timezone: 'America/Los_Angeles' });
        // A GeoLite2 city is kept whole.
        expect(mergeLocation({ country: 'GB', region: 'ENG', city: 'London', timezone: 'Europe/London' }, { country: 'GB', region: 'Scotland', city: 'Glasgow', timezone: 'Europe/London' })).toEqual({});
        // No GeoLite2 at all: the provider's whole.
        expect(mergeLocation(null, ie)).toEqual(ie);
        expect(mergeLocation({ country: null, region: null, city: null, timezone: null }, ie)).toEqual(ie);
    });

    it('does nothing without the option, or for private addresses', async () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com' });
        const { svc, fake } = service();
        expect(svc.getEnricher()).toBeNull();
        svc.scheduleEnrichment(1, '8.8.8.8', null, 'open', null);
        const lookup = vi.fn(() => null);
        svc.setEnricher(new IpEnricher({ provider: 'custom', lookup }));
        svc.scheduleEnrichment(1, '10.0.0.5', null, 'open', null);
        await new Promise(r => setTimeout(r, 10));
        expect(lookup).not.toHaveBeenCalled();
        expect(fake.updates).toEqual([]);
    });
});

describe('status precedence: the guarded UPDATE equals nextStatus() for every pair', () => {
    it('applyStatus sends one placeholder per replaceable status, never truncated', async () => {
        const statuses = Object.keys(STATUS_RANK) as Array<keyof typeof STATUS_RANK>;
        for (const incoming of statuses) {
            const { svc, fake } = service();
            await svc.applyStatus(1, incoming);
            const q = fake.sql.find(x => x.sql.startsWith('UPDATE email_log SET status'));
            const from = q ? q.params.slice(3) : [];
            for (const current of statuses) {
                expect(applyStatusChange(current, { to: incoming, from }), `${current} + ${incoming}`).toBe(nextStatus(current, incoming));
            }
        }
    });
});

describe('0.16.0 review: unverified bare-id hits, per-email caps, addresses scrubbed', () => {
    it('a bare-id hit is classified unverified — never human or machine — with its UA reasons kept as chips', () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com', ipSalt: 'salt' });
        const { svc } = service();
        const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
        const signed = svc.buildRow({ type: 'open', source: 'pixel', userAgent: ua });
        expect(signed.classification).toBe('human_likely');
        const bare = svc.buildRow({ type: 'open', source: 'pixel', userAgent: ua, unsigned: true });
        expect(bare.classification).toBe('unverified');
        expect(bare.classificationReasons.split(',')[0]).toBe(UNSIGNED_REASON);
        const proxy = svc.buildRow({ type: 'click', source: 'redirect', userAgent: 'Mozilla/5.0 (via ggpht.com GoogleImageProxy)', unsigned: true });
        expect(proxy.classification).toBe('unverified');
        expect(proxy.classificationReasons).toContain('gmail-proxy');
    });

    it('email addresses in the detail and the payload become <address>; message ids are kept', () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com' });
        const { svc } = service();
        const row = svc.buildRow({
            type: 'bounced', source: 'ses', recipient: 'zoe@example.com',
            detail: '550 5.1.1 <zoe@example.com>: Recipient address rejected; forwarded to zoe.l+shop@mail.example.co.uk',
            payload: { diagnosticCode: 'smtp; 550 5.1.1 user zoe@example.com unknown', 'smtp-id': '<14c5d75ce93.dfd.64b469@ismtpd-555>', nested: { list: ['a@b.example', 'plain'] } },
        });
        expect(row.detail).toBe('550 5.1.1 <address>: Recipient address rejected; forwarded to <address>');
        const p = JSON.parse(row.payload);
        expect(p.diagnosticCode).toBe('smtp; 550 5.1.1 user <address> unknown');
        expect(p['smtp-id']).toBe('<14c5d75ce93.dfd.64b469@ismtpd-555>');
        expect(p.nested.list).toEqual(['<address>', 'plain']);
        expect(JSON.stringify(row)).not.toMatch(/zoe|a@b\.example/);
        expect(scrubAddresses("Recipient 'bea@example.com' rejected")).toBe("Recipient '<address>' rejected");
        expect(scrubAddresses('250 2.0.0 OK 1699999999 a1b2c3 - gsmtp')).toBe('250 2.0.0 OK 1699999999 a1b2c3 - gsmtp');
    });

    function capService(counts: { signed: number; unsigned: number }) {
        const sql: string[] = [];
        const inserted: any[] = [];
        let nextId = 500;
        const conn: any = {
            rawConnection: {
                options: { type: 'mysql' },
                query: async (q: string, params: any[]) => {
                    sql.push(q);
                    if (/^SELECT COUNT\(\*\) AS n FROM email_event/.test(q)) return [{ n: /= 'unverified'$/.test(q) ? counts.unsigned : counts.signed }];
                    if (/^INSERT IGNORE INTO email_event/.test(q)) {
                        const row = Object.fromEntries(EVENT_INSERT_COLUMNS.map((c, i) => [c, params[i]]));
                        if (row.dedupeKey && inserted.some(r => r.dedupeKey === row.dedupeKey)) return { affectedRows: 0 };
                        inserted.push(row);
                        return { affectedRows: 1, insertId: nextId++ };
                    }
                    return { affectedRows: 1 };
                },
                getRepository: () => ({}),
            },
        };
        return { svc: new EmailEventService(conn), sql, inserted };
    }

    it('stores opens until the email has ENGAGEMENT_EVENTS_PER_DAY of them today, then one marker row, then nothing', async () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com' });
        const counts = { signed: ENGAGEMENT_EVENTS_PER_DAY - 1, unsigned: 0 };
        const { svc, sql, inserted } = capService(counts);
        const at = new Date('2026-11-04T21:00:00Z');
        const hit = { type: 'open' as const, source: 'pixel' as const, occurredAt: at, log: { id: 7, orderId: 3 }, userAgent: 'Mozilla/5.0', ip: '10.0.0.1' };
        expect((await svc.recordEngagement(hit)).capped).toBe(false);
        expect(inserted).toHaveLength(1);
        expect(inserted[0].classification).not.toBeNull();
        counts.signed = ENGAGEMENT_EVENTS_PER_DAY;
        const capped = await svc.recordEngagement(hit);
        expect(capped).toMatchObject({ capped: true, id: null });
        expect(inserted).toHaveLength(2);
        expect(inserted[1]).toMatchObject({ type: 'open', classification: null, classificationReasons: CAPPED_REASON, ip: null, userAgent: null, emailLogId: 7 });
        expect(inserted[1].detail).toContain('2026-11-04 (UTC)');
        const countsBefore = sql.filter(q => /COUNT/.test(q)).length;
        expect((await svc.recordEngagement(hit)).capped).toBe(true);
        expect(inserted).toHaveLength(2); // no second marker, no row
        expect(sql.filter(q => /COUNT/.test(q)).length).toBe(countsBefore); // and no more count queries today
        // The next UTC day starts afresh.
        counts.signed = 0;
        expect((await svc.recordEngagement({ ...hit, occurredAt: new Date('2026-11-05T00:00:01Z') })).capped).toBe(false);
        expect(inserted).toHaveLength(3);
        // The day's count starts at midnight UTC.
        const countSql = sql.filter(q => /COUNT/.test(q));
        expect(countSql[0]).toBe("SELECT COUNT(*) AS n FROM email_event WHERE `emailLogId` = ? AND type = ? AND `occurredAt` >= ? AND COALESCE(classification, '') <> 'unverified'");
        expect(utcDayStart(at).toISOString()).toBe('2026-11-04T00:00:00.000Z');
    });

    it('a burst of concurrent hits never passes the cap together: exactly the cap is stored, and the marker states the count', async () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com' });
        const inserted: any[] = [];
        let nextId = 900;
        const tick = () => new Promise(r => setTimeout(r, 1));
        const conn: any = {
            rawConnection: {
                options: { type: 'mysql' },
                query: async (q: string, params: any[]) => {
                    await tick(); // every statement takes a while, as over a real connection
                    if (/^SELECT COUNT\(\*\) AS n FROM email_event/.test(q)) {
                        const unverified = /= 'unverified'$/.test(q);
                        return [{ n: inserted.filter(r => r.emailLogId === params[0] && r.type === params[1] && !String(r.classificationReasons || '').startsWith(CAPPED_REASON)
                            && (r.classification === 'unverified') === unverified).length }];
                    }
                    if (/^INSERT IGNORE INTO email_event/.test(q)) {
                        const row = Object.fromEntries(EVENT_INSERT_COLUMNS.map((c, i) => [c, params[i]]));
                        if (row.dedupeKey && inserted.some(r => r.dedupeKey === row.dedupeKey)) return { affectedRows: 0 };
                        inserted.push(row);
                        return { affectedRows: 1, insertId: nextId++ };
                    }
                    return { affectedRows: 1 };
                },
                getRepository: () => ({}),
            },
        };
        const svc = new EmailEventService(conn);
        const at = new Date('2026-11-04T10:00:00Z');
        const hit = { type: 'open' as const, source: 'pixel' as const, occurredAt: at, log: { id: 77 }, unsigned: true, userAgent: 'curl/8' };
        const results = await Promise.all(Array.from({ length: UNSIGNED_EVENTS_PER_DAY + 15 }, () => svc.recordEngagement(hit)));
        expect(results.filter(r => !r.capped)).toHaveLength(UNSIGNED_EVENTS_PER_DAY);
        const markers = inserted.filter(r => String(r.classificationReasons).startsWith(CAPPED_REASON));
        expect(inserted).toHaveLength(UNSIGNED_EVENTS_PER_DAY + 1);
        expect(markers).toHaveLength(1);
        expect(markers[0].detail).toBe(`${UNSIGNED_EVENTS_PER_DAY} opens through unsigned links were stored for this email on 2026-11-04 (UTC); further ones that day are not recorded.`);
        // Another email (another key) is not held up behind this one's queue.
        expect((await svc.recordEngagement({ ...hit, log: { id: 78 } })).capped).toBe(false);
    });

    it('bare-id hits have a cap of their own (UNSIGNED_EVENTS_PER_DAY), counted apart from the signed ones', async () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com' });
        const counts = { signed: 0, unsigned: UNSIGNED_EVENTS_PER_DAY };
        const { svc, inserted } = capService(counts);
        const hit = { type: 'click' as const, source: 'redirect' as const, log: { id: 8 }, unsigned: true, userAgent: 'curl/8' };
        expect((await svc.recordEngagement(hit)).capped).toBe(true);
        expect(inserted).toHaveLength(1);
        expect(inserted[0].classificationReasons).toBe(`${CAPPED_REASON},${UNSIGNED_REASON}`);
        expect(inserted[0].detail).toContain('not recorded');
        // Signed clicks of the same email are still stored.
        expect((await svc.recordEngagement({ ...hit, unsigned: false })).capped).toBe(false);
        expect(inserted).toHaveLength(2);
        expect(UNSIGNED_EVENTS_PER_DAY).toBeLessThan(ENGAGEMENT_EVENTS_PER_DAY);
    });
});
