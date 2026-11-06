import { describe, expect, it, vi } from 'vitest';

// Entities need emitted decorator metadata, which the test transform does not produce.
vi.mock('./email-log.entity', () => ({ EmailLog: class EmailLog {} }));
vi.mock('./email-suppression.entity', () => ({ EmailSuppression: class EmailSuppression {} }));
vi.mock('./email-link.entity', () => ({ EmailLink: class EmailLink {} }));
vi.mock('./email-event.entity', () => ({ EmailEvent: class EmailEvent {} }));
vi.mock('./plugin', () => ({ EmailTrackingPlugin: { getUpdateChecker: () => null, getPackageName: () => 'x', getPackageVersion: () => '0' } }));
import { EmailTrackingController } from './email-tracking.controller';
import { setLicenceStatus, setOptions } from './options';
import { SENDING_SQL, SENDING_WINDOW_MS, UNKNOWN_SQL, UNSETTLED_SQL } from './send-attempts';

function fakeRes() {
    return { statusCode: 200, body: undefined as any, status(c: number) { this.statusCode = c; return this; }, json(b: any) { this.body = b; return this; }, setHeader() { /* */ } };
}
const admin: any = { activeUserId: 1, channelId: 1, channel: { code: '__default_channel__' }, userHasPermissions: () => true };

/** Order 9's confirmation: refused with a 421 (temporary), retried 30 s later and accepted. */
const now = Date.now();
const ago = (ms: number) => new Date(now - ms);
const attempt = (id: number, msAgo: number, over: any) => ({
    id, createdAt: ago(msAgo), updatedAt: ago(msAgo - 5_000), channelId: 1, orderId: 9, type: 'order-confirmation', recipient: 'a@example.com',
    subject: 'Order confirmation for #ABC', status: 'sent', smtpResponse: '250 2.0.0 OK', errorMessage: null, openCount: 0, clickCount: 0, ...over,
});
const retriedFailure = attempt(40, 3_600_000, { status: 'failed', smtpResponse: '421 4.3.0 Temporary System Problem', errorMessage: 'Message failed: 421 4.3.0 Temporary System Problem' });
const retry = attempt(42, 3_570_000, {});
const permanent = attempt(41, 7_200_000, { orderId: null, type: 'password-reset', recipient: 'b@example.com', subject: 'Reset your password', status: 'failed', smtpResponse: '550 5.1.1 No such user', errorMessage: 'Can\'t send mail - all recipients were rejected: 550 5.1.1 No such user' });
const waiting = attempt(43, 60_000, { orderId: 10, subject: 'Order confirmation for #DEF', status: 'failed', smtpResponse: null, errorMessage: 'Connection timeout' });
const inFlight = attempt(44, 20_000, { orderId: 11, subject: 'Order confirmation for #GHI', smtpResponse: null });

const t = (v: any) => new Date(v).getTime();
const noOutcome = (r: any) => r.status === 'sent' && r.smtpResponse === null && r.errorMessage === null;
/** How many `?` come before `fragment` in `sql`: where its parameters start (-1: not there). */
const paramAt = (sql: string, fragment: string) => { const i = sql.indexOf(fragment); return i < 0 ? -1 : (sql.slice(0, i).match(/\?/g) || []).length; };

/** A database that answers each of the Email Log's statements; `dbNow` its clock, `timelineFrom` its first send event. */
function fakeDb(groups: any[], rows: any[], opts: { dbNow?: Date; timelineFrom?: Date } = {}) {
    const seen: Array<{ sql: string; params: any[] }> = [];
    const ordered = (sql: string, list: any[]) => (/ORDER BY id DESC/.test(sql) ? list.slice().sort((a, b) => b.id - a.id) : list.slice().sort((a, b) => a.id - b.id));
    const sending = (sql: string, params: any[]) => { const i = paramAt(sql, SENDING_SQL); return (r: any) => i >= 0 && noOutcome(r) && t(r.createdAt) >= t(params[i]); };
    const unknown = (sql: string, params: any[]) => {
        const i = paramAt(sql, UNKNOWN_SQL);
        return (r: any) => i >= 0 && noOutcome(r) && t(r.createdAt) < t(params[i]) && t(r.createdAt) >= t(params[i + 1]);
    };
    const query = async (sql: string, params: any[] = []) => {
        seen.push({ sql, params });
        if (/LOCALTIMESTAMP/.test(sql)) return opts.dbNow ? [{ dbNow: opts.dbNow }] : [];
        if (/FROM email_event/.test(sql)) return opts.timelineFrom ? [{ createdAt: opts.timelineFrom }] : [];
        if (/GROUP BY status/.test(sql)) return groups;
        if (/AS sending/.test(sql)) return [{ sending: rows.filter(sending(sql, params)).length, noReply: rows.filter(unknown(sql, params)).length }];
        if (/COUNT\(\*\) AS total/.test(sql)) return [{ total: rows.length }];
        if (/recipient = \?/.test(sql)) {
            const windows: any[][] = [];
            for (let i = 0; i + 2 < params.length; i += 3) windows.push(params.slice(i, i + 3));
            return ordered(sql, rows.filter(r => windows.some(([who, from, to]) => r.recipient === who && t(r.createdAt) >= t(from) && t(r.createdAt) <= t(to))));
        }
        if (/status IN \('failed', 'deferred'\)/.test(sql)) {
            const isSending = sending(sql, params);
            const isUnknown = unknown(sql, params);
            return ordered(sql, rows.filter(r => r.status === 'failed' || r.status === 'deferred' || isUnknown(r) || isSending(r)));
        }
        return ordered(sql, rows);
    };
    return { conn: { rawConnection: { options: { type: 'mysql' }, query } } as any, seen };
}

describe('GET /email-track/log/summary and the status filter', () => {
    it('returns every status and a total over all of them; a send in flight is not sent; a retried attempt is not a failure', async () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com' });
        const groups = [
            { status: 'sent', n: 3, opens: 2, clicks: 1 }, { status: 'delivered', n: 5, opens: 4, clicks: 0 },
            { status: 'failed', n: 2, opens: 0, clicks: 0 }, { status: 'bounced', n: 8, opens: 0, clicks: 0 },
            { status: 'suppressed', n: 1, opens: 0, clicks: 0 },
        ];
        const { conn, seen } = fakeDb(groups, [retriedFailure, permanent, retry, inFlight]);
        const c = new EmailTrackingController(conn, {} as any, {} as any);
        const res = fakeRes();
        await c.logSummary(admin, { query: {} } as any, res as any);
        expect(res.body).toMatchObject({
            total: 19, sent: 2, sending: 1, delivered: 5, failed: 1, retried: 1, retrying: 0, deferred: 0, bounced: 8, complained: 0,
            suppressed: 1, opens: 6, clicks: 1, fromDays: 30, deliveryEvents: false,
        });
        // total = every state's count: the cards add up.
        const b = res.body;
        expect(b.sent + b.sending + b.delivered + b.failed + b.retried + b.retrying + b.deferred + b.bounced + b.complained + b.suppressed).toBe(b.total);
        // The period is the list's own bound (a date, not DATE_SUB), so a card and its list agree.
        const grouped = seen.find(x => /GROUP BY status/.test(x.sql))!;
        expect(grouped.sql).toContain('`createdAt` >= ?');
        expect(Math.abs(new Date(grouped.params[0]).getTime() - (now - 30 * 86_400_000))).toBeLessThan(60_000);
    });

    it('the summary follows the list filters; fromDays=all has no period; providers configured say delivery can be reported', async () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com', providerWebhooks: { sendgrid: { verificationKey: 'k' } } });
        setLicenceStatus({ valid: true } as any);
        const { conn, seen } = fakeDb([], []);
        const c = new EmailTrackingController(conn, {} as any, {} as any);
        const res = fakeRes();
        await c.logSummary(admin, { query: { fromDays: 'all', recipient: 'a@example.com', status: 'failed', state: 'retried' } } as any, res as any);
        expect(res.body).toMatchObject({ fromDays: null, deliveryEvents: true, deliveryEventsReason: null, total: 0 });
        // The free tier does not record a provider's deliveries: the Delivered card says so rather than "no provider webhook".
        setLicenceStatus({ valid: false, message: 'unlicensed' } as any);
        const free = fakeRes();
        await c.logSummary(admin, { query: {} } as any, free as any);
        expect(free.body).toMatchObject({ deliveryEvents: false, deliveryEventsReason: 'free-tier' });
        const grouped = seen.find(x => /GROUP BY status/.test(x.sql))!;
        expect(grouped.sql).toContain('recipient LIKE ?');
        expect(grouped.sql).not.toContain('`createdAt` >= ?');
        expect(grouped.sql).not.toMatch(/status = \?|status IN \(\?/); // a card never narrows itself by the list's status
        const bad = fakeRes();
        await c.logSummary(admin, { query: { fromDays: 'soon' } } as any, bad as any);
        expect(bad.statusCode).toBe(400);
        setOptions({ publicBaseUrl: 'https://shop.example.com' });
        const none = fakeRes();
        await c.logSummary(admin, { query: {} } as any, none as any);
        expect(none.body).toMatchObject({ deliveryEvents: false, deliveryEventsReason: 'no-webhook' });
    });

    it('?status=sent,delivered filters on both; a bad value is a 400', async () => {
        const seen: any[] = [];
        const conn: any = { rawConnection: { options: { type: 'mysql' }, query: async (sql: string, params: any[]) => { seen.push({ sql, params }); return /COUNT/.test(sql) ? [{ total: 0 }] : []; } } };
        const c = new EmailTrackingController(conn, {} as any, {} as any);
        const lists = () => seen.filter(x => /FROM email_log/.test(x.sql) && /LIMIT \? OFFSET \?/.test(x.sql));
        const res = fakeRes();
        await c.listLog(admin, { query: { status: 'sent,delivered' } } as any, res as any);
        expect(lists()[0].sql).toContain('status IN (?, ?)');
        expect(lists()[0].params.slice(0, 2)).toEqual(['sent', 'delivered']);
        const one = fakeRes();
        await c.listLog(admin, { query: { status: 'bounced' } } as any, one as any);
        expect(lists()[1].sql).toContain('WHERE status = ?');
        const bad = fakeRes();
        await c.listLog(admin, { query: { status: 'x'.repeat(40) } } as any, bad as any);
        expect(bad.statusCode).toBe(400);
    });
});

describe('GET /email-track/log?state=: the list a card opens', () => {
    it('state=failed lists only emails that failed for good; retried and retrying attempts have their own states', async () => {
        const { conn } = fakeDb([], [retriedFailure, permanent, retry, waiting, inFlight]);
        const c = new EmailTrackingController(conn, {} as any, {} as any);
        const failed = fakeRes();
        await c.listLog(admin, { query: { state: 'failed', fromDays: '30' } } as any, failed as any);
        expect(failed.body.total).toBe(1);
        expect(failed.body.items.map((r: any) => [r.id, r.state])).toEqual([[41, 'failed']]);
        expect(failed.body.fromDays).toBe(30);
        const retried = fakeRes();
        await c.listLog(admin, { query: { state: 'retried' } } as any, retried as any);
        expect(retried.body.items.map((r: any) => [r.id, r.state, r.retriedBy])).toEqual([[40, 'retried', 42]]);
        const progress = fakeRes();
        await c.listLog(admin, { query: { state: 'sending,retrying' } } as any, progress as any);
        expect(progress.body.items.map((r: any) => [r.id, r.state])).toEqual([[44, 'sending'], [43, 'retrying']]);
    });

    it('rows of a plain list carry their state and retry links; sent leaves out sends in flight; unknown states are a 400', async () => {
        const { conn, seen } = fakeDb([], [retry, retriedFailure]);
        const c = new EmailTrackingController(conn, {} as any, {} as any);
        const res = fakeRes();
        await c.listLog(admin, { query: {} } as any, res as any);
        expect(res.body.items.map((r: any) => [r.id, r.state, r.attempt, r.retryOf, r.retriedBy])).toEqual([[42, 'sent', 2, 40, null], [40, 'retried', 1, null, 42]]);
        const sent = fakeRes();
        await c.listLog(admin, { query: { state: 'sent,delivered' } } as any, sent as any);
        const sql = seen.filter(x => /LIMIT \? OFFSET \?/.test(x.sql)).pop()!;
        // Sent: neither in flight nor without any reply recorded.
        expect(sql.sql).toContain(`(status = 'sent' AND NOT ${UNSETTLED_SQL}) OR status = ?`);
        expect(UNSETTLED_SQL).toBe("((status = 'sent' AND `smtpResponse` IS NULL AND `errorMessage` IS NULL) AND `createdAt` >= ?)");
        const since = new Date(sql.params[0]).getTime();
        expect(Math.abs(since - (Date.now() - SENDING_WINDOW_MS))).toBeLessThan(60_000);
        expect(sql.params[1]).toBe('delivered');
        const bad = fakeRes();
        await c.listLog(admin, { query: { state: 'sent,lost' } } as any, bad as any);
        expect(bad.statusCode).toBe(400);
    });
});

describe('the Email Log: sends cut off before their reply, and the database clock', () => {
    const timelineFrom = ago(10 * 86_400_000); // the install's first send event
    // Order 12: cut off mid-send 30 minutes ago, never re-run. Order 13: cut off 40 minutes ago, the stalled job ran again a minute later.
    const cutOff = attempt(45, 30 * 60_000, { orderId: 12, subject: 'Order confirmation for #JKL', smtpResponse: null, updatedAt: ago(30 * 60_000) });
    const cutOffRerun = attempt(46, 40 * 60_000, { orderId: 13, subject: 'Order confirmation for #MNO', smtpResponse: null, updatedAt: ago(40 * 60_000) });
    const rerun = attempt(47, 39 * 60_000, { orderId: 13, subject: 'Order confirmation for #MNO' });
    // Sent before the event timeline began, when no reply was recorded (before 0.14.3): it stays sent.
    const old = attempt(30, 20 * 86_400_000, { orderId: 7, subject: 'Order confirmation for #OLD', smtpResponse: null, updatedAt: ago(20 * 86_400_000) });

    it('"no reply recorded" is neither sent nor failed; a re-run makes it retried; the cards add up and open the same rows', async () => {
        const rows = [old, cutOff, cutOffRerun, rerun, inFlight];
        const groups = [{ status: 'sent', n: 5, opens: 0, clicks: 0 }];
        const { conn } = fakeDb(groups, rows, { timelineFrom });
        const c = new EmailTrackingController(conn, {} as any, {} as any);
        const res = fakeRes();
        await c.logSummary(admin, { query: { fromDays: 'all' } } as any, res as any);
        expect(res.body).toMatchObject({ total: 5, sent: 2, sending: 1, unknown: 1, retried: 1, failed: 0 });
        const b = res.body;
        expect(b.sent + b.sending + b.delivered + b.failed + b.retried + b.retrying + b.deferred + b.bounced + b.complained + b.suppressed + b.unknown).toBe(b.total);
        const unknown = fakeRes();
        await c.listLog(admin, { query: { state: 'unknown', fromDays: 'all' } } as any, unknown as any);
        expect(unknown.body.items.map((r: any) => [r.id, r.state])).toEqual([[45, 'unknown']]);
        const retried = fakeRes();
        await c.listLog(admin, { query: { state: 'retried', fromDays: 'all' } } as any, retried as any);
        expect(retried.body.items.map((r: any) => [r.id, r.state, r.retriedBy])).toEqual([[46, 'retried', 47]]);
        const list = fakeRes();
        await c.listLog(admin, { query: { fromDays: 'all' } } as any, list as any);
        expect(list.body.items.map((r: any) => [r.id, r.state, r.attempt])).toEqual([
            [47, 'sent', 2], [46, 'retried', 1], [45, 'unknown', 1], [44, 'sending', 1], [30, 'sent', 1],
        ]);
    });

    it('the windows run on the database\'s clock: an hour behind this process, a send a minute old is still sending, a refusal still retrying', async () => {
        const dbNow = new Date(now - 3_600_000);
        const justStarted = { ...inFlight, createdAt: new Date(dbNow.getTime() - 60_000) };
        const justRefused = { ...waiting, createdAt: new Date(dbNow.getTime() - 120_000), updatedAt: new Date(dbNow.getTime() - 100_000) };
        const { conn, seen } = fakeDb([{ status: 'sent', n: 1, opens: 0, clicks: 0 }, { status: 'failed', n: 1, opens: 0, clicks: 0 }], [justStarted, justRefused], { dbNow, timelineFrom });
        const c = new EmailTrackingController(conn, {} as any, {} as any);
        const res = fakeRes();
        await c.logSummary(admin, { query: {} } as any, res as any);
        expect(res.body).toMatchObject({ sent: 0, sending: 1, retrying: 1, failed: 0, unknown: 0 });
        const counted = seen.find(x => /AS sending/.test(x.sql))!;
        expect(t(counted.params[0])).toBe(dbNow.getTime() - SENDING_WINDOW_MS);
        const grouped = seen.find(x => /GROUP BY status/.test(x.sql))!;
        expect(t(grouped.params[0])).toBe(dbNow.getTime() - 30 * 86_400_000); // the period counts back from the database's now too
    });
});

describe('By template and the weekly figures count emails that went out', () => {
    it('sent is accepted by the mail server, the rates are over it, failed counts emails that failed for good', async () => {
        const { EmailTrackingService } = await import('./email-tracking.service');
        const calls: Array<{ sql: string; params: any[] }> = [];
        const conn: any = {
            rawConnection: {
                options: { type: 'mysql' },
                query: async (sql: string, params: any[] = []) => {
                    calls.push({ sql, params });
                    if (/GROUP BY type/.test(sql)) return [
                        { type: 'order-confirmation', sent: '3', opened: '3', clicked: '1', bounced: '0', suppressed: '0', totalOpens: '7', totalClicks: '1' },
                        { type: 'password-reset', sent: 0, opened: 0, clicked: 0, bounced: 0, suppressed: 0, totalOpens: 0, totalClicks: 0 },
                    ];
                    if (/recipient = \?/.test(sql)) return [retriedFailure, retry, permanent];
                    if (/status IN \('failed', 'deferred'\)/.test(sql)) return [permanent, retriedFailure];
                    return [];
                },
            },
        };
        const svc = new EmailTrackingService(conn, { isWorker: false } as any, {} as any);
        const types = await svc.statsByTemplate(30, null);
        expect(types).toEqual([
            { type: 'order-confirmation', sent: 3, opened: 3, clicked: 1, bounced: 0, failed: 0, suppressed: 0, totalOpens: 7, totalClicks: 1, openRate: 1, clickRate: 1 / 3, ctor: 1 / 3 },
            { type: 'password-reset', sent: 0, opened: 0, clicked: 0, bounced: 0, failed: 1, suppressed: 0, totalOpens: 0, totalClicks: 0, openRate: 0, clickRate: 0, ctor: 0 },
        ]);
        const grouped = calls.find(c => /GROUP BY type/.test(c.sql))!;
        expect(grouped.sql).not.toMatch(/COUNT\(\*\)\s+AS sent/);
        expect(grouped.sql).toContain("status IN ('sent', 'delivered', 'deferred', 'bounced', 'complained')");
        expect(grouped.sql).toContain("NOT LIKE '4%'");

        calls.length = 0;
        await svc.aggregate(new Date('2026-11-01T00:00:00Z'), new Date('2026-11-08T00:00:00Z'));
        const tracked = calls.find(c => /AS tracked/.test(c.sql))!;
        expect(tracked.sql).toMatch(/SUM\(CASE WHEN \(status IN \('sent', 'delivered', 'deferred', 'bounced', 'complained'\)[\s\S]*AS tracked/);
        expect(tracked.params).toHaveLength(3); // the bound of sends without an outcome, then the window
    });
});

describe('sendTracked reads the reply code', () => {
    it('an SES message id (no reply code) is a sent email, not a failed one', async () => {
        const { EmailTrackingService } = await import('./email-tracking.service');
        setOptions({ publicBaseUrl: 'https://shop.example.com', signingSecret: 'test-secret' });
        const queries: string[] = [];
        const recorded: any[] = [];
        const repo = {
            create: (p: any) => ({ ...p }),
            save: async (r: any) => ({ ...r, id: 77 }),
            update: async () => ({ affected: 1 }),
            findOne: async () => ({ id: 77, status: 'sent' }),
        };
        const conn: any = { rawConnection: { options: { type: 'mysql' }, query: async (sql: string) => { queries.push(sql); return []; }, getRepository: () => repo } };
        const svc = new EmailTrackingService(conn, { isWorker: false } as any, { record: async (e: any) => { recorded.push(e); return { id: 1 }; } } as any);
        const transporter: any = {
            sendMail: async () => ({ messageId: '<0100018b9c3f5a4e@email.amazonses.com>', response: '0100018b9c3f5a4e-6d1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b-000000' }),
        };
        const row = await svc.sendTracked(transporter, { to: 'n@example.com', from: 'shop@example.com', subject: 'Receipt', html: '<p>x</p>' }, { type: 'receipt' } as any);
        expect(row.status).toBe('sent');
        expect(queries.some(q => /UPDATE email_log SET status/.test(q))).toBe(false);
        expect(recorded[0]).toMatchObject({ type: 'sent', source: 'smtp' });
        setOptions({ publicBaseUrl: 'https://shop.example.com' });
    });
});
