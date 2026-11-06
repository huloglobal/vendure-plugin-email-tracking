import { describe, expect, it } from 'vitest';
import {
    canonicalJson, compareItems, decodeCursor, encodeCursor, eventIdOfKey, eventItem, evidenceItems, formatMoney, historyItem, isUnsignedItem,
    legacyItems, linkLabel, matchesFilter, pageOf, parseFilter, redacted, sendLabel, sortKeyOf, timelineSha256, TimelineItem, toIso, withAttempt,
} from './timeline';
import type { AttemptInfo } from './send-attempts';

const T = (s: number) => new Date(Date.UTC(2026, 10, 4, 10, 0, s));

const ev = (id: number, sec: number, type: string, extra: any = {}) => ({
    id, occurredAt: T(sec), type, source: type === 'open' ? 'pixel' : type === 'click' ? 'redirect' : 'smtp',
    emailLogId: 1, orderId: 9, customerId: 3, channelId: 1, classification: type === 'open' ? 'machine_likely' : null,
    classificationReasons: type === 'open' ? 'gmail-proxy,bot-ua' : null, country: 'GB', city: 'London', ip: 'hash', userAgent: 'UA full',
    payload: '{"links":[]}', dedupeKey: null, ...extra,
});
const hist = (id: number, sec: number, type: string, data: any, extra: any = {}) => ({ id, createdAt: T(sec), type, data, isPublic: false, ...extra });

describe('timeline items', () => {
    it('maps an event row, redacting sensitive URLs and keeping the full block only for the full export', () => {
        const red = eventItem(ev(5, 1, 'click', { url: 'https://shop.example.com/reset?token=abc&x=1', linkText: 'Reset password', linkIndex: 2 }), { id: 1, type: 'password-reset', subject: 's' }, false);
        expect(red).toMatchObject({ id: 'e5', kind: 'event', type: 'click', label: 'Link clicked', url: 'https://shop.example.com/reset?[redacted]', linkIndex: 2, linkText: 'Reset password', emailType: 'password-reset' });
        expect(red.full).toBeUndefined();
        const full = eventItem(ev(6, 2, 'open'), undefined, true);
        expect(full.reasons).toEqual(['gmail-proxy', 'bot-ua']);
        expect(full.full).toMatchObject({ userAgent: 'UA full', payload: { links: [] }, dedupeKey: null });
        expect(redacted(full).full).toBeUndefined();
    });

    it('labels Vendure history, with payment amounts and private notes', () => {
        const payments = [{ id: '4', amount: 1250, method: 'stripe', state: 'Settled', refunds: [{ id: '8', total: 500, reason: 'damaged' }] }];
        expect(historyItem(hist(1, 0, 'ORDER_STATE_TRANSITION', { from: 'ArrangingPayment', to: 'PaymentSettled' }), payments, 'GBP', false))
            .toMatchObject({ id: 'h1', kind: 'history', label: 'Order state changed', detail: 'ArrangingPayment → PaymentSettled' });
        expect(historyItem(hist(2, 0, 'ORDER_PAYMENT_TRANSITION', { paymentId: 4, from: 'Created', to: 'Settled' }), payments, 'GBP', false).detail)
            .toBe('Created → Settled — GBP 12.50 via stripe');
        expect(historyItem(hist(3, 0, 'ORDER_REFUND_TRANSITION', { refundId: 8, from: 'Pending', to: 'Settled' }), payments, 'GBP', false).detail)
            .toBe('Pending → Settled — GBP 5.00');
        const note = historyItem(hist(4, 0, 'ORDER_NOTE', { note: 'Called the customer' }, { administrator: { firstName: 'Ann', lastName: 'Admin' } }), [], 'GBP', true);
        expect(note).toMatchObject({ label: 'Note (private)', detail: 'Called the customer', actor: 'Ann Admin' });
        expect(note.full).toMatchObject({ isPublic: false, data: { note: 'Called the customer' } });
        expect(historyItem(hist(5, 0, 'MY_CUSTOM_TYPE', { a: 1 }), [], 'GBP', false)).toMatchObject({ label: 'MY_CUSTOM_TYPE', detail: '{"a":1}' });
    });

    it('synthesises legacy items for emails without events, skipping JSON entries already covered by events', () => {
        const log = {
            id: 1, createdAt: T(0), updatedAt: T(30), type: 'order-confirmation', subject: 'Order #ABC', status: 'bounced', smtpResponse: '250 OK',
            errorMessage: '550 no such user',
            opensJson: JSON.stringify([{ ts: T(5).toISOString(), ip: 'h1', ua: 'Mozilla/5.0 (via ggpht.com GoogleImageProxy)', client: 'Gmail (prefetch)' }, { ts: T(20).toISOString(), ip: 'h2', ua: 'x' }]),
            clicksJson: JSON.stringify([{ ts: T(6).toISOString(), url: 'https://shop.example.com/a?code=1', ip: 'h1' }]),
        };
        const all = legacyItems(log, undefined, false);
        expect(all.map(i => [i.id, i.type])).toEqual([['l1-s', 'sent'], ['l1-st', 'bounced'], ['l1-o0', 'open'], ['l1-o1', 'open'], ['l1-c0', 'click']]);
        expect(all.every(i => i.legacy && i.kind === 'legacy')).toBe(true);
        expect(all[2]).toMatchObject({ classification: 'machine_likely', client: 'Gmail (prefetch)' });
        expect(all[4].url).toBe('https://shop.example.com/a?[redacted]');
        // With events from second 10 on, a send outcome and a status event: only the early JSON entries remain.
        const some = legacyItems(log, { firstAt: T(10).toISOString(), hasSend: true, hasStatus: true }, false);
        expect(some.map(i => i.id)).toEqual(['l1-o0', 'l1-c0']);
        expect(legacyItems({ ...log, status: 'failed', opensJson: null, clicksJson: 'not json' }, undefined, false).map(i => i.type)).toEqual(['failed']);
    });

    it('never synthesises a "recorded before 0.16.0" status for an email that has its own send event', () => {
        // Sent by 0.16.0, the SMTP reply said 421: the send event is `deferred` (source smtp), no webhook status event.
        const log = { id: 4, createdAt: T(1), updatedAt: T(2), status: 'deferred', subject: 'Receipt', smtpResponse: '421 4.7.0 Try again later', opensJson: null, clicksJson: null };
        expect(legacyItems(log, { firstAt: T(1).toISOString(), hasSend: true, hasStatus: false }, false)).toEqual([]);
        // The same row without any event (sent before 0.16.0) still gets its legacy items.
        expect(legacyItems(log, undefined, false).map(i => i.id)).toEqual(['l4-s', 'l4-st']);
    });

    it('the full export of a legacy click never carries the raw URL of the old click history', () => {
        const log = { id: 5, createdAt: T(1), updatedAt: T(1), status: 'sent', clicksJson: JSON.stringify([{ ts: T(2).toISOString(), url: 'https://shop.example.com/account/reset?token=LIVE-TOKEN', ua: 'x' }]) };
        const [click] = legacyItems(log, { firstAt: null, hasSend: true, hasStatus: false }, true);
        expect(click.url).toBe('https://shop.example.com/account/reset?[redacted]');
        expect(JSON.stringify(click.full)).not.toContain('LIVE-TOKEN');
        expect((click.full as any).entry.ua).toBe('x');
    });
});

describe('ordering, filters and the cursor', () => {
    const items: TimelineItem[] = [
        eventItem(ev(10, 3, 'open'), undefined, false),
        historyItem(hist(1, 1, 'ORDER_STATE_TRANSITION', { from: 'A', to: 'B' }), [], 'GBP', false),
        eventItem(ev(11, 3, 'click'), undefined, false),
        historyItem(hist(2, 3, 'ORDER_NOTE', { note: 'n' }), [], 'GBP', false),
        ...legacyItems({ id: 2, createdAt: T(2), updatedAt: T(2), status: 'sent', opensJson: JSON.stringify([{ ts: T(3).toISOString() }]) }, undefined, false),
        eventItem(ev(12, 4, 'bounced'), undefined, false),
        eventItem(ev(9, 0, 'sent'), undefined, false),
    ];

    it('sorts by time, then history < legacy < event at the same instant, then id', () => {
        const ids = items.slice().sort(compareItems).map(i => i.id);
        expect(ids).toEqual(['e9', 'h1', 'l2-s', 'h2', 'l2-o0', 'e10', 'e11', 'e12']);
    });

    it('filters: emails, opens, clicks, delivery, order & payment, notes', () => {
        const by = (f: any) => items.filter(i => matchesFilter(i, parseFilter(f))).map(i => i.id).sort();
        expect(by('opens')).toEqual(['e10', 'l2-o0']);
        expect(by('clicks')).toEqual(['e11']);
        expect(by('delivery')).toEqual(['e12']);
        expect(by('order')).toEqual(['h1']);
        expect(by('notes')).toEqual(['h2']);
        expect(by('emails')).toEqual(['e10', 'e11', 'e12', 'e9', 'l2-o0', 'l2-s']);
        expect(by('all')).toHaveLength(items.length);
        expect(parseFilter('nonsense')).toBe('all');
    });

    it('pages by cursor without gaps or overlap, both directions', () => {
        for (const dir of ['asc', 'desc'] as const) {
            const seen: string[] = [];
            let cursor = null;
            for (let guard = 0; guard < 10; guard++) {
                const p = pageOf(items, cursor, 3, dir);
                seen.push(...p.items.map(i => i.id));
                if (!p.hasMore) { expect(p.nextCursor).toBeNull(); break; }
                cursor = decodeCursor(p.nextCursor);
                expect(cursor).not.toBeNull();
            }
            const expected = items.slice().sort(compareItems).map(i => i.id);
            expect(seen).toEqual(dir === 'asc' ? expected : expected.reverse());
        }
    });

    it('cursor encoding round-trips and rejects garbage', () => {
        const k = sortKeyOf(items[0]);
        expect(decodeCursor(encodeCursor(k))).toEqual(k);
        expect(eventIdOfKey(k.k)).toBe(10);
        expect(decodeCursor('not-base64-json')).toBeNull();
        expect(decodeCursor(Buffer.from('[1,9,"x"]').toString('base64url'))).toBeNull();
        expect(decodeCursor(undefined)).toBeNull();
    });
});

describe('canonical hash', () => {
    it('sorts keys at every level, drops undefined, and is stable', () => {
        expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"x":2,"y":1}]},"b":1}');
        const items = [eventItem(ev(1, 1, 'open'), undefined, false)];
        const h = timelineSha256(items);
        expect(h).toMatch(/^[0-9a-f]{64}$/);
        expect(timelineSha256(JSON.parse(JSON.stringify(items)))).toBe(h);
        // The full-export block never changes the hash.
        expect(timelineSha256([eventItem(ev(1, 1, 'open'), undefined, true)])).toBe(h);
    });

    it('toIso reads Dates and the UTC strings sqlite returns', () => {
        expect(toIso('2026-11-04 10:00:00.123')).toBe('2026-11-04T10:00:00.123Z');
        expect(toIso(T(1))).toBe('2026-11-04T10:00:01.000Z');
        expect(toIso('2026-11-04T10:00:00+01:00')).toBe('2026-11-04T09:00:00.000Z');
        expect(toIso('')).toBeNull();
        expect(toIso('nope')).toBeNull();
    });
});

describe('0.16.0 review: labels, legacy status time, evidence selection, money precision', () => {
    it('names a clicked link "Link #n: text" (linkIndex is 0-based) and labels a cap marker row', () => {
        expect(linkLabel(1, 'Reset your password')).toBe('Link #2: Reset your password');
        expect(linkLabel(0, null)).toBe('Link #1');
        expect(linkLabel(null, 'Shop now')).toBe('Shop now');
        expect(linkLabel(null, null)).toBeNull();
        const click = eventItem(ev(9, 3, 'click', { url: 'https://shop.example.com/p', linkText: 'Reset your password', linkIndex: 1 }), undefined, false);
        expect(click).toMatchObject({ detail: 'Link #2: Reset your password', linkIndex: 1, linkText: 'Reset your password' });
        const marker = eventItem(ev(10, 4, 'open', { classification: null, classificationReasons: 'events-capped', detail: '100 opens were stored …' }), undefined, false);
        expect(marker).toMatchObject({ label: 'Further opens not stored', classification: null, reasons: ['events-capped'] });
        const bare = eventItem(ev(11, 5, 'open', { classification: 'unverified', classificationReasons: 'unsigned-token,gmail-proxy' }), undefined, false);
        expect(bare.classification).toBe('unverified');
        expect(isUnsignedItem(bare)).toBe(true);
    });

    it('a legacy status row sits at the send time, which later writes (opens, clicks) never move', () => {
        const log = { id: 8, createdAt: T(0), updatedAt: T(50), type: 'order-confirmation', subject: 'S', status: 'bounced', errorMessage: '550 user unknown' };
        const before = legacyItems(log, undefined, false).find(i => i.id === 'l8-st')!;
        const after = legacyItems({ ...log, updatedAt: T(59) }, { firstAt: T(58).toISOString(), hasSend: false, hasStatus: false }, false).find(i => i.id === 'l8-st')!;
        expect(before.at).toBe(T(0).toISOString());
        expect(after.at).toBe(before.at);
        expect(before.detail).toContain('time not recorded');
        // Same instant as the legacy "sent" row, and after it.
        const all = legacyItems(log, undefined, false);
        expect(all.slice().sort(compareItems).map(i => i.id).slice(0, 2)).toEqual(['l8-s', 'l8-st']);
    });

    it('the evidence report leaves private notes out (unless asked) and unknown history payloads always', () => {
        const items = [
            historyItem(hist(1, 0, 'ORDER_NOTE', { note: 'PRIVATE: flagged by the fraud team' }, { isPublic: false }), [], 'GBP', false),
            historyItem(hist(2, 1, 'ORDER_NOTE', { note: 'Your parcel is on its way' }, { isPublic: true }), [], 'GBP', false),
            historyItem(hist(3, 2, 'MY_PLUGIN_ENTRY', { internalScore: 97, staff: 'ann' }), [], 'GBP', false),
            historyItem(hist(4, 3, 'ORDER_STATE_TRANSITION', { from: 'A', to: 'B' }), [], 'GBP', false),
        ];
        expect(items.map(i => i.visibility)).toEqual(['private', 'public', undefined, undefined]);
        const standard = evidenceItems(items, { internalNotes: false });
        expect(standard.internalNotesLeftOut).toBe(1);
        expect(standard.items.map(i => i.id)).toEqual(['h2', 'h3', 'h4']);
        expect(standard.items.find(i => i.id === 'h3')).toMatchObject({ label: 'MY_PLUGIN_ENTRY', detail: null });
        const withNotes = evidenceItems(items, { internalNotes: true });
        expect(withNotes.internalNotesLeftOut).toBe(0);
        expect(withNotes.items.find(i => i.id === 'h1')).toMatchObject({ label: 'Note (internal)', detail: 'PRIVATE: flagged by the fraud team' });
        // The admin timeline is unchanged.
        expect(items[0].label).toBe('Note (private)');
        expect(timelineSha256(standard.items)).not.toBe(timelineSha256(items));
    });

    it('money follows the host MoneyStrategy precision', () => {
        expect(formatMoney(12345, 'GBP')).toBe('GBP 123.45');
        expect(formatMoney(12345, 'KWD', 3)).toBe('KWD 12.345');
        expect(formatMoney(500, 'JPY', 0)).toBe('JPY 500');
        expect(formatMoney(12345, 'GBP', -1 as any)).toBe('GBP 123.45');
        const payments = [{ id: '4', amount: 12500, method: 'card', state: 'Settled', refunds: [] }];
        expect(historyItem(hist(5, 0, 'ORDER_PAYMENT_TRANSITION', { paymentId: 4, from: 'Created', to: 'Settled' }), payments, 'KWD', false, 3).detail)
            .toBe('Created → Settled — KWD 12.500 via card');
    });
});

describe('0.16.3: send attempts on the timeline', () => {
    const info = (over: Partial<AttemptInfo>): AttemptInfo => ({
        state: 'sent', outcome: 'accepted', accepted: true, temporary: false, attempt: 1, retryOf: null, retriedBy: null, ...over,
    });
    const inFlight = { id: 9001, createdAt: T(0), updatedAt: T(0), type: 'order-confirmation', subject: 'Order confirmation for #ZQ898ZQ3J55JGZ4Z', status: 'sent', smtpResponse: null };

    it('a row still being sent reads "Sending…": kind log, never legacy, never "Email sent"', () => {
        const [item] = legacyItems(inFlight, undefined, false, { legacy: false, attempt: info({ state: 'sending', outcome: 'pending', accepted: false }) });
        expect(item).toMatchObject({ id: 'l9001-s', kind: 'log', legacy: false, type: 'sending', label: 'Sending…', sendState: 'sending', source: 'email_log' });
        expect(item.detail).toBe('“Order confirmation for #ZQ898ZQ3J55JGZ4Z” — no reply from the mail server yet');
        expect(matchesFilter(item, 'emails')).toBe(true);
        expect(matchesFilter(item, 'delivery')).toBe(false);
    });

    it('a row that never recorded a reply reads "No reply recorded" ("…, retried" once the job ran it again), never "Email sent"', () => {
        const [item] = legacyItems(inFlight, undefined, false, { legacy: false, attempt: info({ state: 'unknown', outcome: 'unknown', accepted: false }) });
        expect(item).toMatchObject({ kind: 'log', legacy: false, type: 'unknown', label: 'No reply recorded', sendState: 'unknown' });
        expect(item.detail).toBe('“Order confirmation for #ZQ898ZQ3J55JGZ4Z” — no reply from the mail server was recorded');
        expect(matchesFilter(item, 'emails')).toBe(true);
        const [again] = legacyItems(inFlight, undefined, false, { legacy: false, attempt: info({ state: 'retried', outcome: 'unknown', accepted: false, retriedBy: 9002 }) });
        expect(again).toMatchObject({ type: 'unknown', label: 'No reply recorded, retried', sendState: 'retried', retriedBy: 9002 });
        expect(again.detail).toBe('“Order confirmation for #ZQ898ZQ3J55JGZ4Z” — no reply from the mail server was recorded — retried as email #9002');
    });

    it('legacy only when asked (the row predates the event timeline); a later row without a send event is kind log', () => {
        const sent = { ...inFlight, smtpResponse: '250 2.0.0 OK' };
        expect(legacyItems(sent, undefined, false)[0]).toMatchObject({ kind: 'legacy', legacy: true, type: 'sent', label: 'Email sent' });
        const later = legacyItems({ ...sent, status: 'delivered', opensJson: JSON.stringify([{ ts: T(5).toISOString(), ua: 'x' }]) }, undefined, false, { legacy: false, attempt: info({ state: 'delivered' }) });
        expect(later.map(i => [i.id, i.kind, i.legacy])).toEqual([['l9001-s', 'log', false], ['l9001-st', 'log', false], ['l9001-o0', 'log', false]]);
        expect(later[1].detail).toContain('status from the email log');
        expect(later[1].detail).not.toContain('0.16.0');
    });

    it('smtp send events are told with how their attempt ended, linked to the other attempt; other events are untouched', () => {
        const failed = eventItem(ev(20, 1, 'failed', { emailLogId: 9001, detail: '421 4.3.0 Temporary System Problem' }), undefined, false);
        const retried = withAttempt(failed, info({ state: 'retried', outcome: 'temporary', temporary: true, accepted: false, retriedBy: 9002 }));
        expect(retried).toMatchObject({ label: 'Deferred, retried', sendState: 'retried', retryOf: null, retriedBy: 9002, type: 'failed' });
        expect(retried.detail).toBe('421 4.3.0 Temporary System Problem — retried as email #9002');
        expect(withAttempt(failed, info({ state: 'retrying', outcome: 'temporary', temporary: true, accepted: false }))).toMatchObject({ label: 'Deferred, retrying', sendState: 'retrying' });
        expect(withAttempt(failed, info({ state: 'failed', outcome: 'permanent', accepted: false, attempt: 6, retryOf: 9005 })).label).toBe('Send failed after 5 retries');
        expect(withAttempt(failed, info({ state: 'retried', outcome: 'permanent', accepted: false, retriedBy: 9002 })).label).toBe('Send failed, retried');
        expect(withAttempt(failed, info({ state: 'failed', outcome: 'permanent', accepted: false })).label).toBe('Send failed');
        const sent = eventItem(ev(21, 28, 'sent', { emailLogId: 9002, detail: '250 2.0.0 OK' }), undefined, false);
        const after = withAttempt(sent, info({ attempt: 2, retryOf: 9001 }));
        expect(after).toMatchObject({ label: 'Sent after 1 retry', sendState: 'sent', retryOf: 9001, retriedBy: null });
        expect(after.detail).toBe('250 2.0.0 OK — retry of email #9001');
        expect(withAttempt(sent, info({})).label).toBe('Email sent');
        expect(sendLabel('sent', info({ attempt: 3, retryOf: 2 }))).toBe('Sent after 2 retries');
        const open = eventItem(ev(22, 30, 'open'), undefined, false);
        expect(withAttempt(open, info({ state: 'retried' }))).toBe(open);
        const provider = eventItem(ev(23, 31, 'deferred', { source: 'sendgrid' }), undefined, false);
        expect(withAttempt(provider, info({ state: 'retried', retriedBy: 9002 }))).toBe(provider);
        expect(withAttempt(sent, undefined)).toBe(sent);
    });

    it('a log item sorts with the legacy items at the same instant, and its cursor round-trips', () => {
        const [item] = legacyItems(inFlight, undefined, false, { legacy: false, attempt: info({ state: 'sending', outcome: 'pending', accepted: false }) });
        const key = sortKeyOf(item);
        expect(key.r).toBe(1);
        expect(decodeCursor(encodeCursor(key))).toEqual(key);
        const history = historyItem(hist(1, 0, 'ORDER_STATE_TRANSITION', { from: 'A', to: 'B' }), [], 'GBP', false);
        const event = eventItem(ev(3, 0, 'sent'), undefined, false);
        expect([event, item, history].sort(compareItems).map(i => i.kind)).toEqual(['history', 'log', 'event']);
    });
});
