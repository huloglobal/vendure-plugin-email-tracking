import { describe, expect, it, vi } from 'vitest';

// TypeORM entities need emitted decorator metadata, which the test transform does not produce.
vi.mock('./email-log.entity', () => ({ EmailLog: class EmailLog {} }));
import { CapturingSender, TrackingEmailSender, statusFromSmtpResponse } from './tracking-email-sender';
import { setOptions } from './options';
import { verifyClickSignature } from './click-signature';

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
        expect(statusFromSmtpResponse(undefined)).toBe('sent');
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
        const repo = {
            create: (p: any) => ({ ...p }),
            save: async (row: any) => { const r = { ...row, id: 7 }; saved.push(r); return r; },
            update: async (id: number, patch: any) => { updates.push({ id, patch }); return { affected: 1 }; },
        };
        const sender = new TrackingEmailSender();
        (sender as any).connection = {
            rawConnection: { options: { type: 'mysql' }, query: async () => [], getRepository: () => repo },
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
        expect(updates[0].patch.status).toBe('sent');
    });
});
