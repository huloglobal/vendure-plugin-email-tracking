import { describe, expect, it, vi } from 'vitest';
import * as nodemailer from 'nodemailer';

// TypeORM entities need emitted decorator metadata, which the test transform does not produce.
vi.mock('./email-log.entity', () => ({ EmailLog: class EmailLog {} }));
import { CapturingSender, TrackingEmailSender, statusFromSmtpResponse } from './tracking-email-sender';
import { setOptions } from './options';
import { verifyClickSignature } from './click-signature';
import { attemptStates } from './send-attempts';

describe('CapturingSender', () => {
    it('keeps nodemailer info on the EmailDetails of that send only', async () => {
        const sender = new CapturingSender();
        const transporter = { sendMail: async (m: any) => ({ messageId: `<${m.subject}@x>`, response: '250 2.0.0 OK' }) };
        const a: any = { recipient: 'a@x', subject: 'A', body: '<p>a</p>' };
        const b: any = { recipient: 'b@x', subject: 'B', body: '<p>b</p>' };
        await Promise.all([(sender as any).sendMail(a, transporter), (sender as any).sendMail(b, transporter)]);
        expect(sender.takeInfo(a)?.messageId).toBe('<A@x>');
        expect(sender.takeInfo(b)?.messageId).toBe('<B@x>');
        expect(sender.takeInfo(a)).toBeNull(); // removed on read
    });

    it('maps the SMTP reply code to a status like sendTracked', () => {
        expect(statusFromSmtpResponse('250 2.0.0 OK')).toBe('sent');
        expect(statusFromSmtpResponse('450 4.2.1 try later')).toBe('deferred');
        expect(statusFromSmtpResponse('550 5.1.1 no such user')).toBe('failed');
        expect(statusFromSmtpResponse('421-4.3.0 Temporary System Problem')).toBe('deferred');
        expect(statusFromSmtpResponse(undefined)).toBe('sent');
        // A reply without a code is not a refusal: the SES transport answers with the message id (it read as code 100018, failed).
        expect(statusFromSmtpResponse('0100018b9c3f5a4e-6d1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b-000000')).toBe('sent');
        expect(statusFromSmtpResponse('Messages queued for delivery')).toBe('sent');
    });
});

describe('TrackingEmailSender via the Vendure pipeline', () => {
    it('decodes HTML entities in tracked query strings before wrapping links', () => {
        setOptions({ publicBaseUrl: 'https://track.example.com', signingSecret: 'test-secret' });
        const sender = new TrackingEmailSender();
        const html = [
            '<a href="https://elite-software.co.uk/password-reset?token&#x3D;example">reset</a>',
            '<a href="https://shop.example.com/x?a=1&amp;b=2">shop</a>',
        ].join('');

        const rewritten = (sender as any).wrapHtml(html, 7);
        const targets = [...rewritten.matchAll(/<a\b[^>]*\bhref="([^"]+)"/gi)]
            .map(match => new URL(match[1]).searchParams.get('u'));

        expect(targets).toEqual([
            'https://elite-software.co.uk/password-reset?token=example',
            'https://shop.example.com/x?a=1&b=2',
        ]);
        expect(new URL(targets[0]!).searchParams.get('token')).toBe('example');
        expect(new URL(targets[1]!).searchParams.get('b')).toBe('2');
    });

    it('binds every rewritten link to its destination (s = HMAC over token and u)', () => {
        setOptions({ publicBaseUrl: 'https://track.example.com', signingSecret: 'test-secret' });
        const rewritten = (new TrackingEmailSender() as any).wrapHtml('<a href="https://partner.example/x?a=1&amp;b=2">x</a>', 7);
        const href = new URL(/href="([^"]+)"/.exec(rewritten)![1]);
        const token = href.pathname.split('/').pop()!;
        expect(verifyClickSignature(token, href.searchParams.get('u')!, href.searchParams.get('s'), 'test-secret')).toBe(true);
        expect(verifyClickSignature(token, 'https://evil.example/', href.searchParams.get('s'), 'test-secret')).toBe(false);
    });

    it('records Message-ID (without brackets) and the SMTP response on the row after inner.send', async () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com', signingSecret: 'test-secret' });
        const saved: any[] = [];
        const updates: any[] = [];
        const sql: string[] = [];
        const repo = {
            create: (p: any) => ({ ...p }),
            save: async (row: any) => { const r = { ...row, id: 7 }; saved.push(r); return r; },
            update: async (id: number, patch: any) => { updates.push({ id, patch }); return { affected: 1 }; },
        };
        const sender = new TrackingEmailSender();
        (sender as any).connection = {
            rawConnection: { options: { type: 'mysql' }, query: async (q: string) => { sql.push(q); return []; }, getRepository: () => repo },
        };
        const email: any = { recipient: 'c@example.com', subject: 'Welcome', body: '<html><body><a href="https://shop.example.com/x?a=1&amp;b=2">x</a></body></html>', from: 'shop@example.com' };
        // A stream transport never touches the network; nodemailer still mints a Message-ID.
        await sender.send(email, { type: 'smtp', streamTransport: true, buffer: true } as any);
        expect(saved).toHaveLength(1);
        expect(email.body).toContain('/email-track/click/7.');
        expect(email.body).toContain('/email-track/open/7.');
        expect(updates).toHaveLength(1);
        expect(updates[0].id).toBe(7);
        expect(updates[0].patch.smtpMessageId).toMatch(/^[^<>]+@[^<>]+$/);
        // Never the status: the row was created `sent`, and a provider event may have moved it since.
        expect(updates[0].patch).not.toHaveProperty('status');
        expect(sql.filter(q => /^UPDATE email_log SET status/.test(q))).toEqual([]);
    });

    it('a 4xx / 5xx reply changes the status only from the optimistic `sent` (a provider event that arrived first stands)', async () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com', signingSecret: 'test-secret' });
        const sql: Array<{ q: string; p: any[] }> = [];
        const updates: any[] = [];
        const repo = { create: (p: any) => ({ ...p }), save: async (row: any) => ({ ...row, id: 12 }), update: async (id: number, patch: any) => { updates.push(patch); return { affected: 1 }; } };
        const sender = new TrackingEmailSender();
        (sender as any).connection = { rawConnection: { options: { type: 'mysql' }, query: async (q: string, p: any[]) => { sql.push({ q, p }); return { affectedRows: 0 }; }, getRepository: () => repo } };
        (sender as any).events = { record: async () => ({ id: 1, duplicate: false, failed: false }) };
        (sender as any).inner.getSmtpTransport = () => ({ sendMail: async () => ({ messageId: '<d@shop>', response: '451 4.7.1 greylisted' }) });
        await sender.send({ recipient: 'g@example.com', subject: 's', body: '<p>x</p>', from: 'f@x' } as any, { type: 'smtp' } as any);
        expect(updates[0]).toMatchObject({ smtpResponse: '451 4.7.1 greylisted' });
        expect(updates[0]).not.toHaveProperty('status');
        const guarded = sql.filter(x => /^UPDATE email_log SET status/.test(x.q));
        expect(guarded).toEqual([{ q: "UPDATE email_log SET status = ? WHERE id = ? AND status = 'sent'", p: ['deferred', 12] }]);
    });
});

describe('TrackingEmailSender 0.16.0: outcome events and correlation headers', () => {
    it('CapturingSender adds the parked headers to that send only, and forgets them', async () => {
        const sender = new CapturingSender();
        const seen: any[] = [];
        const transporter = { sendMail: async (m: any) => { seen.push(m); return { messageId: '<a@x>', response: '250 Ok: queued as Q1' }; } };
        const a: any = { recipient: 'a@x', subject: 'A', body: '<p>a</p>' };
        const b: any = { recipient: 'b@x', subject: 'B', body: '<p>b</p>' };
        sender.setExtraHeaders(a, { 'X-SMTPAPI': '{"unique_args":{"hulo-log-id":"7-0123456789abcdef"}}' });
        await (sender as any).sendMail(a, transporter);
        await (sender as any).sendMail(b, transporter);
        expect(seen[0].headers).toEqual({ 'X-SMTPAPI': '{"unique_args":{"hulo-log-id":"7-0123456789abcdef"}}' });
        expect(seen[1].headers).toBeUndefined();
        sender.takeInfo(a);
        await (sender as any).sendMail(a, transporter);
        expect(seen[2].headers).toBeUndefined();
    });

    it('records the send outcome with the link list and the provider id from the SMTP reply', async () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com', signingSecret: 'test-secret', providerWebhooks: { sendgrid: { verificationKey: 'k' } } });
        const repo = {
            create: (p: any) => ({ ...p }),
            save: async (row: any) => ({ ...row, id: 9, orderId: 4, customerId: 2, channelId: 1 }),
            update: async () => ({ affected: 1 }),
        };
        const recorded: any[] = [];
        const sender = new TrackingEmailSender();
        (sender as any).connection = { rawConnection: { options: { type: 'mysql' }, query: async () => [], getRepository: () => repo } };
        (sender as any).events = { record: async (e: any) => { recorded.push(e); return { id: 1, duplicate: false, failed: false }; } };
        const seen: any[] = [];
        // Stand in for the SMTP transport the email plugin would build.
        (sender as any).inner.getSmtpTransport = () => ({ sendMail: async (m: any) => { seen.push(m); return { messageId: '<m9@shop>', response: '250 2.0.0 Ok: queued as 4ZQ9' }; } });
        const email: any = { recipient: 'c@example.com', subject: 'Welcome', from: 'shop@example.com',
            body: '<html><body><a href="https://shop.example.com/a">Shop now</a><a href="https://shop.example.com/r?token=1">Reset</a></body></html>' };
        await sender.send(email, { type: 'smtp' } as any);
        expect(seen[0].headers['X-SMTPAPI'].prepared).toBe(true);
        expect(JSON.parse(seen[0].headers['X-SMTPAPI'].value).unique_args['hulo-log-id']).toMatch(/^9-[0-9a-f]{16}$/);
        expect(recorded).toHaveLength(1);
        expect(recorded[0]).toMatchObject({ type: 'sent', source: 'smtp', messageId: '<m9@shop>', providerMessageId: '4ZQ9', log: { id: 9, orderId: 4, customerId: 2, channelId: 1 } });
        expect(recorded[0].payload.signed).toBe(true);
        expect(recorded[0].payload.links.map((l: any) => [l.i, l.t, l.s])).toEqual([[0, 'Shop now', false], [1, 'Reset', true]]);
    });

    it('the message on the wire carries the correlation headers as raw JSON (Vendure sender → nodemailer)', async () => {
        setOptions({
            publicBaseUrl: 'https://shop.example.com', signingSecret: 'test-secret',
            providerWebhooks: { sendgrid: { verificationKey: 'k' }, mailgun: { signingKey: 'k' }, postmark: { username: 'u', password: 'p' } },
        });
        const repo = { create: (p: any) => ({ ...p }), save: async (row: any) => ({ ...row, id: 11 }), update: async () => ({ affected: 1 }) };
        const sender = new TrackingEmailSender();
        (sender as any).connection = { rawConnection: { options: { type: 'mysql' }, query: async () => [], getRepository: () => repo } };
        (sender as any).events = { record: async () => ({ id: 1, duplicate: false, failed: false }) };
        const stream = nodemailer.createTransport({ streamTransport: true, buffer: true });
        let raw = '';
        (sender as any).inner.getSmtpTransport = () => ({ sendMail: async (m: any) => { const info: any = await stream.sendMail(m); raw = info.message.toString('utf8'); return info; } });
        await sender.send({ recipient: 'e@example.com', subject: 'Receipt', from: 'shop@example.com', body: '<p>Thanks</p>' } as any, { type: 'smtp' } as any);
        const unfolded = raw.replace(/\r\n[ \t]+/g, ' ');
        expect(unfolded).not.toContain('=?UTF-8?');
        const smtpapi = /^X-SMTPAPI: (.*)$/m.exec(unfolded)![1].trim();
        expect(JSON.parse(smtpapi).unique_args['hulo-log-id']).toMatch(/^11-[0-9a-f]{16}$/);
        expect(JSON.parse(/^X-Mailgun-Variables: (.*)$/m.exec(unfolded)![1].trim())['hulo-log-id']).toMatch(/^11-[0-9a-f]{16}$/);
        expect(/^X-Pm-Metadata-Hulo-Log-ID: (\S+)/mi.exec(unfolded)![1]).toMatch(/^11-[0-9a-f]{16}$/);
    });

    it('the row is written before SMTP starts and reads as sending until the reply is recorded; no reply captured is recorded as an empty one', async () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com', signingSecret: 'test-secret' });
        const saved: any[] = [];
        const updates: any[] = [];
        const repo = {
            create: (p: any) => ({ ...p }),
            save: async (row: any) => { const r = { ...row, id: 13, createdAt: new Date() }; saved.push(r); return r; },
            update: async (id: number, patch: any) => { updates.push({ id, patch }); return { affected: 1 }; },
        };
        const recorded: any[] = [];
        const sender = new TrackingEmailSender();
        (sender as any).connection = { rawConnection: { options: { type: 'mysql' }, query: async () => [], getRepository: () => repo } };
        (sender as any).events = { record: async (e: any) => { recorded.push(e); return { id: 1, duplicate: false, failed: false }; } };
        let during: string | undefined;
        // A transport whose reply could not be captured; the row as it stands while SMTP runs.
        (sender as any).inner.send = async () => { during = attemptStates([saved[0]]).get(13)?.state; };
        await sender.send({ recipient: 'n@example.com', subject: 'Receipt', body: '<p>x</p>', from: 'f@x' } as any, { type: 'smtp' } as any);
        expect(saved[0]).toMatchObject({ status: 'sent' });
        expect(saved[0].smtpResponse).toBeUndefined();
        expect(during).toBe('sending');
        expect(updates).toEqual([{ id: 13, patch: { smtpResponse: '' } }]);
        expect(recorded[0]).toMatchObject({ type: 'sent', source: 'smtp' });
        expect(attemptStates([{ ...saved[0], ...updates[0].patch }]).get(13)).toMatchObject({ state: 'sent', accepted: true });
    });

    it('records a failed send and still throws the SMTP error', async () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com', signingSecret: 'test-secret' });
        const repo = { create: (p: any) => ({ ...p }), save: async (row: any) => ({ ...row, id: 10 }), update: async () => ({ affected: 1 }) };
        const recorded: any[] = [];
        const sender = new TrackingEmailSender();
        (sender as any).connection = { rawConnection: { options: { type: 'mysql' }, query: async () => [], getRepository: () => repo } };
        (sender as any).events = { record: async (e: any) => { recorded.push(e); return { id: 1, duplicate: false, failed: false }; } };
        (sender as any).inner.getSmtpTransport = () => ({ sendMail: async () => { const e: any = new Error('550 relay denied'); e.response = '550 5.7.1 relay denied'; throw e; } });
        await expect(sender.send({ recipient: 'd@example.com', subject: 'x', body: '<p>x</p>', from: 'f@x' } as any, { type: 'smtp' } as any)).rejects.toThrow('550 relay denied');
        expect(recorded[0]).toMatchObject({ type: 'failed', source: 'smtp' });
        expect(recorded[0].detail).toContain('550 5.7.1 relay denied');
    });
});
