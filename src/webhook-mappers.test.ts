import { describe, expect, it } from 'vitest';
import { bareMessageId, correlationFrom, dedupeKeyFor, mapMailgun, mapPostmark, mapSendgrid, mapSes, metadataValue, normaliseRecipient, sendgridDropSuppression, toDate } from './webhook-mappers';

// Fixtures follow the providers' documented payloads (trimmed).

describe('Postmark', () => {
    const bounce = (Type: string, TypeCode: number) => ({
        RecordType: 'Bounce', ID: 4323372036854775807, Type, TypeCode, Name: Type, Tag: 'Invitation', MessageID: '883953f4-6105-42a2-a16a-77a8eac79483',
        ServerID: 23, MessageStream: 'outbound', Description: 'The server was unable to deliver your message (ex: unknown user, mailbox not found).',
        Details: 'Test bounce details', Email: 'John@Example.com', From: 'sender@example.com', BouncedAt: '2026-11-04T12:34:56.000Z',
        DumpAvailable: true, Inactive: true, CanActivate: true, Subject: 'Test subject', Content: '<html>…full message…</html>',
        Metadata: { 'hulo-log-id': '42', a_key: 'a_value' },
    });

    it('HardBounce → bounced + suppression; SoftBounce / Transient → soft-bounce, never suppressed', () => {
        const [hard] = mapPostmark(bounce('HardBounce', 1));
        expect(hard).toMatchObject({ provider: 'postmark', type: 'bounced', suppress: 'hard-bounce', recipient: 'john@example.com', correlation: '42', providerMessageId: '883953f4-6105-42a2-a16a-77a8eac79483' });
        expect(hard.occurredAt.toISOString()).toBe('2026-11-04T12:34:56.000Z');
        expect(hard.detail).toContain('HardBounce');
        for (const t of ['SoftBounce', 'Transient', 'DnsError']) {
            const [e] = mapPostmark(bounce(t, 4096));
            expect(e).toMatchObject({ type: 'soft-bounce', suppress: null });
        }
        expect(mapPostmark(bounce('AutoResponder', 64))).toEqual([]);
    });

    it('finds the correlation metadata whatever the key case (nodemailer re-cases X-PM-Metadata-hulo-log-id)', () => {
        for (const key of ['hulo-log-id', 'Hulo-Log-ID', 'HULO-LOG-ID', 'Hulo-Log-Id']) {
            const [ev] = mapPostmark({ ...bounce('HardBounce', 1), Metadata: { [key]: '42-0123456789abcdef' } });
            expect(ev.correlation, key).toBe('42-0123456789abcdef');
        }
        expect(metadataValue({ a: 1 }, 'hulo-log-id')).toBeUndefined();
        expect(metadataValue(null, 'x')).toBeUndefined();
    });

    it('never copies the message body or the address into the payload', () => {
        const [e] = mapPostmark(bounce('HardBounce', 1));
        const json = JSON.stringify(e.payload);
        expect(json).not.toContain('full message');
        expect(json).not.toContain('John@Example.com');
        expect(e.payload).toMatchObject({ RecordType: 'Bounce', Type: 'HardBounce', ID: 4323372036854775807 });
    });

    it('SpamComplaint and Delivery', () => {
        const [c] = mapPostmark({ RecordType: 'SpamComplaint', ID: 42, Type: 'SpamComplaint', MessageID: 'm1', Email: 'a@b.example', BouncedAt: '2026-11-04T10:00:00Z' });
        expect(c).toMatchObject({ type: 'complained', suppress: 'complaint', recipient: 'a@b.example' });
        const [d] = mapPostmark({ RecordType: 'Delivery', ServerID: 23, MessageStream: 'outbound', MessageID: '00000000-0000-0000-0000-000000000000', Recipient: 'john@example.com', Tag: 'welcome-email', DeliveredAt: '2026-11-04T11:00:00Z', Details: 'Test delivery webhook details', Metadata: {} });
        expect(d).toMatchObject({ type: 'delivered', suppress: null, correlation: null, detail: 'Test delivery webhook details' });
    });

    it('Open / Click carry IP, user agent and link; SubscriptionChange only for a manual opt-out', () => {
        const [o] = mapPostmark({ RecordType: 'Open', FirstOpen: true, Client: { Name: 'Chrome' }, UserAgent: 'Mozilla/5.0 Chrome/120', Geo: { IP: '8.8.8.8' }, MessageID: 'm2', ReceivedAt: '2026-11-04T12:00:00Z', Recipient: 'john@example.com' });
        expect(o).toMatchObject({ type: 'open', ip: '8.8.8.8', userAgent: 'Mozilla/5.0 Chrome/120' });
        const [k] = mapPostmark({ RecordType: 'Click', ClickLocation: 'HTML', OriginalLink: 'https://example.com/x', MessageID: 'm2', ReceivedAt: '2026-11-04T12:01:00Z', Recipient: 'john@example.com', Geo: { IP: '8.8.8.8' } });
        expect(k).toMatchObject({ type: 'click', url: 'https://example.com/x' });
        expect(mapPostmark({ RecordType: 'SubscriptionChange', SuppressSending: true, SuppressionReason: 'HardBounce', Recipient: 'x@y.example' })).toEqual([]);
        expect(mapPostmark({ RecordType: 'SubscriptionChange', SuppressSending: true, SuppressionReason: 'ManualSuppression', Recipient: 'x@y.example', ChangedAt: '2026-11-04T12:00:00Z' })[0].type).toBe('unsubscribed');
        expect(mapPostmark({ RecordType: 'Inbound' })).toEqual([]);
        expect(mapPostmark([])).toEqual([]);
    });
});

describe('SendGrid', () => {
    const base = { email: 'example@test.com', timestamp: 1762257600, 'smtp-id': '<14c5d75ce93.dfd.64b469@ismtpd-555>', sg_message_id: '14c5d75ce93.dfd.64b469.filter0001.16648.5515E0B88.0', category: ['cat facts'] };

    it('bounce vs blocked vs dropped vs deferred, with sg_event_id as the dedupe identity', () => {
        const events = mapSendgrid([
            { ...base, event: 'bounce', type: 'bounce', sg_event_id: 'ev-bounce', reason: '500 unknown recipient', status: '5.0.0', 'hulo-log-id': '7' },
            { ...base, event: 'bounce', type: 'blocked', sg_event_id: 'ev-blocked', reason: '550 blocked by policy' },
            { ...base, event: 'dropped', sg_event_id: 'ev-drop1', reason: 'Bounced Address' },
            { ...base, event: 'dropped', sg_event_id: 'ev-drop2', reason: 'Unsubscribed Address' },
            { ...base, event: 'dropped', sg_event_id: 'ev-drop3', reason: 'Spam Reporting Address' },
            { ...base, event: 'deferred', sg_event_id: 'ev-def', response: '400 try again later', attempt: '5' },
            { ...base, event: 'delivered', sg_event_id: 'ev-del', response: '250 OK' },
            { ...base, event: 'processed', sg_event_id: 'ev-proc' },
            { ...base, event: 'spamreport', sg_event_id: 'ev-spam' },
            { ...base, event: 'group_unsubscribe', sg_event_id: 'ev-unsub', asm_group_id: 10 },
        ]);
        expect(events.map(e => [e.type, e.suppress])).toEqual([
            ['bounced', 'hard-bounce'], ['soft-bounce', null], ['dropped', 'hard-bounce'], ['dropped', null], ['dropped', 'complaint'],
            ['deferred', null], ['delivered', null], ['complained', 'complaint'], ['unsubscribed', null],
        ]);
        expect(events[0]).toMatchObject({ eventKey: 'ev-bounce', correlation: '7', messageId: '14c5d75ce93.dfd.64b469@ismtpd-555', recipient: 'example@test.com' });
        expect(events[0].occurredAt.toISOString()).toBe(new Date(1762257600 * 1000).toISOString());
        expect(events[0].payload).toMatchObject({ event: 'bounce', sg_event_id: 'ev-bounce', category: ['cat facts'] });
    });

    it('dropped: only the documented bad-address reasons suppress, matched exactly', () => {
        // SendGrid's documented drop reasons.
        expect(sendgridDropSuppression('Bounced Address')).toBe('hard-bounce');
        expect(sendgridDropSuppression('Invalid')).toBe('hard-bounce');
        expect(sendgridDropSuppression(' invalid ')).toBe('hard-bounce');
        expect(sendgridDropSuppression('Spam Reporting Address')).toBe('complaint');
        for (const r of ['Invalid SMTPAPI header', 'Spam Content (if spam checker app enabled)', 'Unsubscribed Address',
            'Recipient List over Package Quota', 'Invalid Address Format?', '', undefined]) {
            expect(sendgridDropSuppression(r), String(r)).toBeNull();
        }
        const [smtpapi] = mapSendgrid([{ email: 'ok@example.com', timestamp: 1762250000, event: 'dropped', sg_event_id: 'd-smtpapi', reason: 'Invalid SMTPAPI header' }]);
        expect(smtpapi).toMatchObject({ type: 'dropped', suppress: null });
    });

    it('reads the correlation id from unique_args / custom_args too, and ignores engagement fields it does not know', () => {
        expect(mapSendgrid([{ ...base, event: 'delivered', sg_event_id: 'a', unique_args: { 'hulo-log-id': '9' } }])[0].correlation).toBe('9');
        expect(mapSendgrid([{ ...base, event: 'delivered', sg_event_id: 'b', custom_args: { 'hulo-log-id': '10' } }])[0].correlation).toBe('10');
        const [click] = mapSendgrid([{ ...base, event: 'click', sg_event_id: 'c', url: 'https://example.com', useragent: 'Mozilla/5.0', ip: '1.2.3.4' }]);
        expect(click).toMatchObject({ type: 'click', url: 'https://example.com', userAgent: 'Mozilla/5.0', ip: '1.2.3.4' });
        expect(mapSendgrid({ not: 'an array' })).toEqual([]);
    });
});

describe('Mailgun', () => {
    const wrap = (ed: any) => ({ signature: { timestamp: '1529006854', token: 'a8ce0edb2dd8301dee6c2405235584e45aa91d1e9f979f3de0', signature: 'x' }, 'event-data': ed });
    const failed = (severity: string, reason: string) => wrap({
        event: 'failed', id: `ev-${severity}-${reason}`, timestamp: 1762257600.123, severity, reason, 'log-level': 'error', recipient: 'Alice@Example.com',
        'delivery-status': { code: 550, message: '5.1.1 The email account that you tried to reach does not exist', description: '', 'attempt-no': 1 },
        message: { headers: { 'message-id': '20130503182626.18666.16540@sandbox.mailgun.org', to: 'Alice <alice@example.com>' } },
        'user-variables': { 'hulo-log-id': '15' },
    });

    it('failed: severity permanent vs temporary, suppress-* reasons, with the event-data id', () => {
        expect(mapMailgun(failed('permanent', 'bounce'))[0]).toMatchObject({ type: 'bounced', suppress: 'hard-bounce', eventKey: 'ev-permanent-bounce', correlation: '15', recipient: 'alice@example.com', messageId: '20130503182626.18666.16540@sandbox.mailgun.org' });
        expect(mapMailgun(failed('temporary', 'generic'))[0]).toMatchObject({ type: 'deferred', suppress: null });
        expect(mapMailgun(failed('permanent', 'suppress-bounce'))[0]).toMatchObject({ type: 'dropped', suppress: 'hard-bounce' });
        expect(mapMailgun(failed('permanent', 'suppress-complaint'))[0]).toMatchObject({ type: 'dropped', suppress: 'complaint' });
        expect(mapMailgun(failed('permanent', 'suppress-unsubscribe'))[0]).toMatchObject({ type: 'dropped', suppress: null });
        expect(mapMailgun(failed('permanent', 'old'))[0]).toMatchObject({ type: 'dropped', suppress: null });
        const e = mapMailgun(failed('permanent', 'bounce'))[0];
        expect(e.detail).toContain('SMTP 550');
        expect(e.occurredAt.getTime()).toBe(1762257600123);
        expect(e.payload).toMatchObject({ event: 'failed', severity: 'permanent', 'delivery-status.code': 550 });
    });

    it('delivered, complained, unsubscribed, opened and accepted', () => {
        expect(mapMailgun(wrap({ event: 'delivered', id: 'd1', timestamp: 1762257600, recipient: 'a@b.example' }))[0].type).toBe('delivered');
        expect(mapMailgun(wrap({ event: 'complained', id: 'c1', timestamp: 1762257600, recipient: 'a@b.example' }))[0]).toMatchObject({ type: 'complained', suppress: 'complaint' });
        expect(mapMailgun(wrap({ event: 'unsubscribed', id: 'u1', timestamp: 1762257600, recipient: 'a@b.example' }))[0].type).toBe('unsubscribed');
        const [o] = mapMailgun(wrap({ event: 'opened', id: 'o1', timestamp: 1762257600, recipient: 'a@b.example', ip: '50.56.129.169', 'client-info': { 'user-agent': 'Mozilla/5.0' } }));
        expect(o).toMatchObject({ type: 'open', ip: '50.56.129.169', userAgent: 'Mozilla/5.0' });
        expect(mapMailgun(wrap({ event: 'accepted', id: 'a1', timestamp: 1762257600 }))).toEqual([]);
        expect(mapMailgun({})).toEqual([]);
    });
});

describe('Amazon SES', () => {
    const mail = {
        timestamp: '2026-11-04T12:00:00.000Z', source: 'shop@example.com', messageId: '0100018b5e6f7a8b-1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d-000000',
        destination: ['jane@example.com', 'bob@example.com'],
        commonHeaders: { from: ['shop@example.com'], to: ['jane@example.com'], messageId: '<abc.123@shop.example.com>', subject: 'Your order' },
        tags: { 'hulo-log-id': ['33'] },
    };

    it('Bounce Permanent vs Transient, one event per bounced recipient', () => {
        const perm = mapSes({ notificationType: 'Bounce', mail, bounce: { bounceType: 'Permanent', bounceSubType: 'General', timestamp: '2026-11-04T12:00:05.000Z', feedbackId: 'fb-1', reportingMTA: 'dsn; a.example', bouncedRecipients: [{ emailAddress: 'jane@example.com', action: 'failed', status: '5.1.1', diagnosticCode: 'smtp; 550 5.1.1 user unknown' }, { emailAddress: 'bob@example.com', status: '5.1.1' }] } }, 'sns-1');
        expect(perm).toHaveLength(2);
        expect(perm[0]).toMatchObject({ provider: 'ses', type: 'bounced', suppress: 'hard-bounce', recipient: 'jane@example.com', correlation: '33', messageId: 'abc.123@shop.example.com', providerMessageId: mail.messageId, eventKey: 'sns-1|jane@example.com' });
        expect(perm[0].detail).toContain('Permanent/General');
        expect(perm[1].eventKey).toBe('sns-1|bob@example.com');
        const trans = mapSes({ notificationType: 'Bounce', mail, bounce: { bounceType: 'Transient', bounceSubType: 'MailboxFull', timestamp: '2026-11-04T12:00:05.000Z', bouncedRecipients: [{ emailAddress: 'jane@example.com' }] } }, 'sns-2');
        expect(trans[0]).toMatchObject({ type: 'soft-bounce', suppress: null });
    });

    it('Complaint, Delivery, DeliveryDelay (event publishing), Reject, and Send ignored', () => {
        expect(mapSes({ notificationType: 'Complaint', mail, complaint: { complainedRecipients: [{ emailAddress: 'jane@example.com' }], timestamp: '2026-11-04T13:00:00Z', complaintFeedbackType: 'abuse' } }, 's3')[0])
            .toMatchObject({ type: 'complained', suppress: 'complaint' });
        expect(mapSes({ notificationType: 'Delivery', mail, delivery: { timestamp: '2026-11-04T12:00:02Z', recipients: ['jane@example.com'], smtpResponse: '250 ok', processingTimeMillis: 500 } }, 's4')[0])
            .toMatchObject({ type: 'delivered', detail: '250 ok' });
        expect(mapSes({ eventType: 'DeliveryDelay', mail, deliveryDelay: { timestamp: '2026-11-04T12:10:00Z', delayType: 'MailboxFull', delayedRecipients: [{ emailAddress: 'jane@example.com', status: '4.2.2', diagnosticCode: '452 mailbox full' }] } }, 's5')[0])
            .toMatchObject({ type: 'deferred' });
        expect(mapSes({ eventType: 'Reject', mail, reject: { reason: 'Bad content' } }, 's6').map(e => e.type)).toEqual(['dropped', 'dropped']);
        expect(mapSes({ eventType: 'Send', mail, send: {} }, 's7')).toEqual([]);
    });
});

describe('helpers', () => {
    it('normalises ids, recipients, dates and correlation values', () => {
        expect(bareMessageId('<a@b>')).toBe('a@b');
        expect(normaliseRecipient('Jane Doe <Jane@Example.COM>')).toBe('jane@example.com');
        expect(normaliseRecipient('not an address')).toBeNull();
        expect(correlationFrom('12')).toBe('12');
        expect(correlationFrom(['12-0123456789abcdef'])).toBe('12-0123456789abcdef');
        expect(correlationFrom('12; DROP')).toBeNull();
        expect(correlationFrom('12-xyz')).toBeNull();
        expect(correlationFrom(null)).toBeNull();
        expect(toDate(Date.UTC(2026, 10, 4, 12) / 1000).toISOString()).toBe('2026-11-04T12:00:00.000Z');
        expect(toDate('2026-11-04T12:00:00Z').toISOString()).toBe('2026-11-04T12:00:00.000Z');
        const now = new Date('2030-01-01T00:00:00Z');
        expect(toDate('garbage', now)).toBe(now);
    });
    it('dedupe keys are SHA-256 hex and provider-scoped', () => {
        const a = dedupeKeyFor('sendgrid', 'x');
        expect(a).toMatch(/^[0-9a-f]{64}$/);
        expect(dedupeKeyFor('mailgun', 'x')).not.toBe(a);
        expect(dedupeKeyFor('sendgrid', 'x')).toBe(a);
    });
});
