import { afterEach, describe, expect, it, vi } from 'vitest';

// TypeORM entities need emitted decorator metadata, which the test transform does not produce.
vi.mock('./email-log.entity', () => ({ EmailLog: class EmailLog {} }));
vi.mock('./email-event.entity', () => ({ EmailEvent: class EmailEvent {} }));
import { EmailLog } from './email-log.entity';
import { OrderActivityService } from './order-activity.service';
import { setLicenceStatus, setOptions } from './options';
import { buildEvidenceReport } from './evidence-report';
import { inflateSync } from 'zlib';

/** 2026-11-05 at hh:mm:ss.ms UTC. */
const T = (hh: number, mm: number, ss = 0, ms = 0) => new Date(Date.UTC(2026, 10, 5, hh, mm, ss, ms));
const GMAIL_421 = '421 4.3.0 Temporary System Problem.  Try again later (10).';
const order: any = {
    id: 4303, code: 'ZQ898ZQ3J55JGZ4Z', state: 'PaymentSettled', currencyCode: 'GBP', totalWithTax: 4798, orderPlacedAt: T(20, 33),
    payments: [], channels: [], customer: { emailAddress: 'buyer@example.com', firstName: 'Bea', lastName: 'Buyer' },
};
const log = (over: any) => ({
    id: 9001, createdAt: T(20, 33, 8, 990), updatedAt: T(20, 33, 8, 990), channelId: 1, orderId: 4303, orderCode: order.code,
    type: 'order-confirmation', recipient: 'buyer@example.com', subject: 'Order confirmation for #ZQ898ZQ3J55JGZ4Z', status: 'sent',
    smtpResponse: null, errorMessage: null, openCount: 0, clickCount: 0, opensJson: null, clicksJson: null, firstOpenedAt: null, ...over,
});
const smtpEvent = (id: number, emailLogId: number, type: string, at: Date, detail: string) => ({
    id, emailLogId, orderId: 4303, customerId: 3, channelId: 1, type, source: 'smtp', occurredAt: at, createdAt: at, detail, classificationReasons: null,
});

/** The service over a fake database holding `logs` and `events`; `timelineFrom`: the first send event's `createdAt` on the install. */
function service(logs: any[], events: any[], timelineFrom: Date | null) {
    const chain = (rows: any[]) => {
        const qb: any = { where: () => qb, andWhere: () => qb, orderBy: () => qb, addOrderBy: () => qb, take: () => qb };
        qb.getMany = async () => rows.slice().sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime() || b.id - a.id);
        qb.getCount = async () => rows.length;
        return qb;
    };
    const raw = {
        options: { type: 'mysql' },
        query: async (sql: string) => {
            if (/GROUP BY `emailLogId`/.test(sql)) {
                const ids = [...new Set(events.map(e => e.emailLogId))];
                return ids.map(id => {
                    const mine = events.filter(e => e.emailLogId === id);
                    return { emailLogId: id, firstAt: mine.map(e => e.occurredAt).sort((a, b) => a - b)[0], sends: mine.filter(e => e.source === 'smtp').length, statuses: 0, delivered: 0 };
                });
            }
            if (/FROM email_event WHERE source = 'smtp'/.test(sql)) return timelineFrom ? [{ createdAt: timelineFrom }] : [];
            return [];
        },
        getRepository: (entity: any) => (entity === EmailLog ? { find: async () => logs } : { createQueryBuilder: () => chain(events) }),
    };
    const history = { getHistoryForOrder: async () => ({ items: [], totalItems: 0 }) };
    return new OrderActivityService({ rawConnection: raw } as any, {} as any, history as any, { entityOptions: {}, apiOptions: {} } as any);
}

async function card(svc: OrderActivityService) {
    const page = await svc.page({} as any, order, { filter: 'all', take: 100, order: 'desc' });
    return { items: page.items, summary: await svc.summary(order, page.context) };
}

const installStarted = T(10, 0); // the first send event of this install (0.16 went live that morning)

describe('order activity for order 4303 (Gmail SMTP, no provider webhooks)', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('20:34:46, while SMTP hangs: "Sending…", not legacy, not sent; nothing accepted yet', async () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com' });
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(T(20, 34, 46));
        const { items, summary } = await card(service([log({})], [], installStarted));
        expect(items.map(i => [i.id, i.kind, i.type, i.label, i.legacy])).toEqual([['l9001-s', 'log', 'sending', 'Sending…', false]]);
        expect(summary.emails).toMatchObject({ total: 1, attempts: 1, sent: 0, sending: 1, retrying: 0, failed: 0, delivered: 0 });
        expect(summary.deliveryEvents).toBe(false);
    });

    it('20:35:20, after the 421: "Deferred, retrying" — amber, not a red failure', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(T(20, 35, 20));
        const failed = log({ status: 'failed', updatedAt: T(20, 35, 14), smtpResponse: GMAIL_421, errorMessage: `Message failed: ${GMAIL_421}` });
        const { items, summary } = await card(service([failed], [smtpEvent(1, 9001, 'failed', T(20, 35, 14), GMAIL_421)], installStarted));
        expect(items.map(i => [i.type, i.label, i.sendState])).toEqual([['failed', 'Deferred, retrying', 'retrying']]);
        expect(summary.emails).toMatchObject({ total: 1, sent: 0, retrying: 1, failed: 0 });
    });

    it('20:36:00, after the retry: "Sent after 1 retry", the refused attempt linked to it; one email, accepted', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(T(20, 36));
        const logs = [
            log({ status: 'failed', updatedAt: T(20, 35, 14), smtpResponse: GMAIL_421, errorMessage: `Message failed: ${GMAIL_421}` }),
            log({ id: 9002, createdAt: T(20, 35, 41), updatedAt: T(20, 35, 42), smtpResponse: '250 2.0.0 OK 1730838942' }),
        ];
        const events = [smtpEvent(1, 9001, 'failed', T(20, 35, 14), GMAIL_421), smtpEvent(2, 9002, 'sent', T(20, 35, 42), '250 2.0.0 OK 1730838942')];
        const svc = service(logs, events, installStarted);
        const { items, summary } = await card(svc);
        expect(items.map(i => [i.emailLogId, i.label, i.sendState, i.retryOf, i.retriedBy])).toEqual([
            [9002, 'Sent after 1 retry', 'sent', 9001, null],
            [9001, 'Deferred, retried', 'retried', null, 9002],
        ]);
        expect(items[1].detail).toBe(`${GMAIL_421} — retried as email #9002`);
        expect(items.every(i => !i.legacy)).toBe(true);
        expect(summary.emails).toMatchObject({ total: 1, attempts: 2, sent: 1, sending: 0, retrying: 0, failed: 0 });

        // The exports and the PDF read the same items and figures.
        const all = await svc.allItems({} as any, order, 'all', false);
        expect(all.items.map(i => i.label)).toEqual(['Deferred, retried', 'Sent after 1 retry']);
        const pdf = buildEvidenceReport({
            shop: 'shop.example.com', summary, items: all.items, truncated: false, generatedAt: T(20, 37), generatedBy: 'admin (user #1)',
            timelineSha256: 'a'.repeat(64), producer: 'test',
        });
        const text = pdfText(pdf);
        // `·` prints as WinAnsi \267.
        expect(text).toContain('(Emails: 1 \\(2 attempts\\) \\267 1 accepted by the mail server \\267 delivery not reported \\(no provider webhook is configured\\) \\267 0 opened');
        expect(text).toContain('(Sent after 1 retry) Tj');
    });

    it('the legacy badge only for emails created before the event timeline began', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(T(21, 0));
        const old = log({ id: 8000, createdAt: T(9, 0), updatedAt: T(9, 0), subject: 'Your order shipped', smtpResponse: '250 OK' });
        // Created after it, with a reply recorded but no send event (its event could not be written): read from the log, not legacy.
        const later = log({ id: 9010, createdAt: T(20, 50), updatedAt: T(20, 50), subject: 'Your invoice', type: 'invoice', smtpResponse: '250 OK' });
        const { items } = await card(service([old, later], [], installStarted));
        expect(items.map(i => [i.emailLogId, i.kind, i.legacy, i.label])).toEqual([
            [9010, 'log', false, 'Email sent'],
            [8000, 'legacy', true, 'Email sent'],
        ]);
        // No send event on the install at all yet: every email without events is from before the timeline — unless it is being sent.
        const fresh = await card(service([old, log({ id: 9020, createdAt: T(20, 59), subject: 'Your receipt', type: 'receipt' })], [], null));
        expect(fresh.items.map(i => [i.emailLogId, i.type, i.legacy])).toEqual([[9020, 'sending', false], [8000, 'sent', true]]);
    });

    it('with a provider webhook configured (and its delivery events recorded: not the free tier) the summary says delivery can be reported', async () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com', providerWebhooks: { postmark: { username: 'u', password: 'p' } } });
        setLicenceStatus({ valid: true } as any);
        const { summary } = await card(service([log({ smtpResponse: '250 OK' })], [], installStarted));
        expect(summary.deliveryEvents).toBe(true);
        setLicenceStatus({ valid: false, message: 'unlicensed' } as any);
        expect((await card(service([log({ smtpResponse: '250 OK' })], [], installStarted))).summary.deliveryEvents).toBe(false);
        setOptions({ publicBaseUrl: 'https://shop.example.com' });
    });

    it('a send cut off before its reply (worker restart) and the job\'s re-run: "No reply recorded, retried", then "Sent after 1 retry" — one email', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(T(21, 0));
        const logs = [
            log({ id: 9101, createdAt: T(20, 40), updatedAt: T(20, 40) }), // no reply, no error, no send event: cut off
            log({ id: 9102, createdAt: T(20, 41), updatedAt: T(20, 41, 3), smtpResponse: '250 2.0.0 OK 1730839263' }),
        ];
        const { items, summary } = await card(service(logs, [smtpEvent(3, 9102, 'sent', T(20, 41, 3), '250 2.0.0 OK 1730839263')], installStarted));
        expect(items.map(i => [i.emailLogId, i.kind, i.type, i.label, i.sendState, i.legacy])).toEqual([
            [9102, 'event', 'sent', 'Sent after 1 retry', 'sent', false],
            [9101, 'log', 'unknown', 'No reply recorded, retried', 'retried', false],
        ]);
        expect(items[1].detail).toBe('“Order confirmation for #ZQ898ZQ3J55JGZ4Z” — no reply from the mail server was recorded — retried as email #9102');
        expect(summary.emails).toMatchObject({ total: 1, attempts: 2, sent: 1, sending: 0, unknown: 0, failed: 0 });
        // Never re-run: it reads "No reply recorded" and is not counted as accepted.
        const alone = await card(service([logs[0]], [], installStarted));
        expect(alone.items.map(i => [i.type, i.label, i.sendState])).toEqual([['unknown', 'No reply recorded', 'unknown']]);
        expect(alone.summary.emails).toMatchObject({ total: 1, sent: 0, unknown: 1 });
        // A 4xx reply that did not throw, and a suppressed email, are counted too (the card says why nothing was accepted).
        const other = await card(service([
            log({ id: 9201, status: 'deferred', smtpResponse: '451 4.7.1 Greylisted', createdAt: T(20, 0) }),
            log({ id: 9202, status: 'suppressed', errorMessage: 'Recipient is on the suppression list', type: 'invoice', subject: 'Invoice', createdAt: T(20, 1) }),
        ], [], installStarted));
        expect(other.summary.emails).toMatchObject({ total: 2, sent: 0, deferred: 1, suppressed: 1 });
    });
});

/** The PDF's page streams, inflated. */
function pdfText(buf: Buffer): string {
    const s = buf.toString('latin1');
    const out: string[] = [];
    const re = /stream\r?\n/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
        const start = m.index + m[0].length;
        const end = s.indexOf('endstream', start);
        try { out.push(inflateSync(Buffer.from(s.slice(start, end), 'latin1')).toString('latin1')); } catch { /* not a deflated stream */ }
    }
    return out.join('\n');
}
