import { describe, expect, it } from 'vitest';
import {
    ACCEPTED_SQL, AttemptRow, attemptInfosFor, attemptStates, databaseNow, EMAIL_JOB_ATTEMPTS, errorReplyCode, eventTimelineStart, isConnectionError,
    isTemporaryFailure, mayHaveRetry, RELATED_SPAN_MS, relatedAttempts, replyCode, RETRY_WINDOW_MS, SENDING_SQL, SENDING_WINDOW_MS, sendingSince,
    sendOutcome, sqlTime, TimelineStart, UNKNOWN_SQL, unknownParams, UNSETTLED_SQL, unsettledSince,
} from './send-attempts';

/** 2026-11-05 at hh:mm:ss.ms UTC. */
const T = (hh: number, mm: number, ss = 0, ms = 0) => Date.UTC(2026, 10, 5, hh, mm, ss, ms);
const row = (over: Partial<AttemptRow> & Pick<AttemptRow, 'id'>): AttemptRow => ({
    createdAt: new Date(T(20, 0)), updatedAt: null, channelId: 1, orderId: 4303, type: 'order-confirmation', recipient: 'buyer@example.com',
    subject: 'Order confirmation for #ZQ898ZQ3J55JGZ4Z', status: 'sent', smtpResponse: '250 2.0.0 OK', errorMessage: null, ...over,
});
const GMAIL_421 = '421-4.3.0 Temporary System Problem.  Try again later (10). For more information, go to\n421 4.3.0  https://support.google.com/a/answer/3221692 a1-20020a';

describe('SMTP replies and errors', () => {
    it('reads the reply code a reply starts with, and the one inside a nodemailer error message', () => {
        expect(replyCode('250 2.0.0 OK 1730839541 a1-20020a')).toBe(250);
        expect(replyCode(GMAIL_421)).toBe(421);
        expect(replyCode('550')).toBe(550);
        expect(replyCode('')).toBeNull();
        expect(replyCode(null)).toBeNull();
        expect(replyCode('Ok: queued')).toBeNull();
        expect(errorReplyCode('Message failed: 421 4.3.0 Temporary System Problem')).toBe(421);
        expect(errorReplyCode('Invalid login: 535-5.7.8 Username and Password not accepted')).toBe(535);
        expect(errorReplyCode("Can't send mail - all recipients were rejected: 550 5.1.1 <x>: Recipient address rejected")).toBe(550);
        expect(errorReplyCode('Mail command failed - 451 4.7.1 Greylisted')).toBe(451);
        // A port is not a reply code.
        expect(errorReplyCode('connect ETIMEDOUT 74.125.140.108:465')).toBeNull();
        expect(errorReplyCode('Connection timeout')).toBeNull();
    });

    it('temporary: SMTP 4xx, timeouts and dropped or refused connections; permanent: 5xx and anything else', () => {
        expect(isTemporaryFailure(GMAIL_421, 'Message failed: 421 4.3.0 Temporary System Problem')).toBe(true);
        expect(isTemporaryFailure(null, 'Message failed: 451 4.7.1 Try again later')).toBe(true);
        for (const m of ['Connection timeout', 'Greeting never received', 'Timeout', 'connect ETIMEDOUT 74.125.140.108:465', 'read ECONNRESET',
            'Connection closed unexpectedly', 'Unexpected socket close', 'getaddrinfo EAI_AGAIN smtp.gmail.com', 'socket hang up',
            'Client network socket disconnected before secure TLS connection was established']) {
            expect(isConnectionError(m), m).toBe(true);
            expect(isTemporaryFailure(null, m), m).toBe(true);
        }
        expect(isTemporaryFailure('550 5.1.1 No such user', 'Message failed: 550 5.1.1 No such user')).toBe(false);
        expect(isTemporaryFailure('535-5.7.8 Username and Password not accepted', 'Invalid login')).toBe(false);
        expect(isTemporaryFailure(null, 'Template "order-confirmation" not found')).toBe(false);
        // The reply wins over a message that mentions a timeout.
        expect(isTemporaryFailure('554 5.7.0 Timeout policy', 'Timeout policy')).toBe(false);
    });
});

describe('sendOutcome: what the mail server did, from the row alone', () => {
    it('pending until a reply or an error is recorded; accepted, temporary or permanent after', () => {
        expect(sendOutcome(row({ id: 1, smtpResponse: null }))).toBe('pending');
        expect(sendOutcome(row({ id: 1, smtpResponse: undefined }))).toBe('pending');
        expect(sendOutcome(row({ id: 1 }))).toBe('accepted');
        expect(sendOutcome(row({ id: 1, smtpResponse: '' }))).toBe('accepted'); // finished, no reply text captured
        expect(sendOutcome(row({ id: 1, status: 'failed', smtpResponse: GMAIL_421, errorMessage: 'Message failed: 421 4.3.0' }))).toBe('temporary');
        expect(sendOutcome(row({ id: 1, status: 'failed', smtpResponse: null, errorMessage: 'Connection timeout' }))).toBe('temporary');
        expect(sendOutcome(row({ id: 1, status: 'failed', smtpResponse: '', errorMessage: 'Message failed: 421 4.7.0 Try later' }))).toBe('temporary');
        expect(sendOutcome(row({ id: 1, status: 'failed', smtpResponse: '550 5.1.1 No such user' }))).toBe('permanent');
        expect(sendOutcome(row({ id: 1, status: 'failed', smtpResponse: null, errorMessage: 'Invalid template' }))).toBe('permanent');
        // A 4xx / 5xx reply that did not throw (`deferred` / `failed` from the reply code).
        expect(sendOutcome(row({ id: 1, status: 'deferred', smtpResponse: '451 4.7.1 greylisted' }))).toBe('temporary');
        // Accepted, then a provider: deferred, dropped (failed), bounced, delivered.
        expect(sendOutcome(row({ id: 1, status: 'deferred', errorMessage: '421 4.7.0 try later' }))).toBe('accepted');
        expect(sendOutcome(row({ id: 1, status: 'failed', errorMessage: 'Unsubscribed Address' }))).toBe('accepted');
        expect(sendOutcome(row({ id: 1, status: 'bounced', errorMessage: '550 5.1.1 user unknown' }))).toBe('accepted');
        expect(sendOutcome(row({ id: 1, status: 'delivered', smtpResponse: null }))).toBe('accepted');
        expect(sendOutcome(row({ id: 1, status: 'suppressed', smtpResponse: null }))).toBe('permanent');
    });
});

describe('attemptStates: order 4303 (Gmail SMTP, no provider webhooks)', () => {
    // The confirmation's first attempt: written 20:33:08.99, SMTP hung, Google 421 4.3.0 at 20:35:14.
    const a1Sending = row({ id: 9001, createdAt: new Date(T(20, 33, 8, 990)), updatedAt: new Date(T(20, 33, 8, 990)), smtpResponse: null });
    const a1Failed = row({ ...a1Sending, updatedAt: new Date(T(20, 35, 14)), status: 'failed', smtpResponse: GMAIL_421, errorMessage: 'Message failed: 421 4.3.0 Temporary System Problem' });
    // The job's retry: a new row at 20:35:41, 250 OK.
    const a2 = row({ id: 9002, createdAt: new Date(T(20, 35, 41)), updatedAt: new Date(T(20, 35, 42)) });

    it('20:34:46, while SMTP hangs: sending — never sent', () => {
        const s = attemptStates([a1Sending], T(20, 34, 46)).get(9001)!;
        expect(s).toMatchObject({ state: 'sending', outcome: 'pending', accepted: false, attempt: 1, retryOf: null, retriedBy: null });
    });

    it('20:35:20, after the 421 and before the retry: deferred, retrying — not failed', () => {
        expect(attemptStates([a1Failed], T(20, 35, 20)).get(9001)).toMatchObject({ state: 'retrying', outcome: 'temporary', temporary: true, accepted: false });
    });

    it('20:36:00: the retry is linked both ways — the email was sent after 1 retry', () => {
        const s = attemptStates([a2, a1Failed], T(20, 36));
        expect(s.get(9001)).toMatchObject({ state: 'retried', retriedBy: 9002, retryOf: null, attempt: 1, accepted: false });
        expect(s.get(9002)).toMatchObject({ state: 'sent', retryOf: 9001, retriedBy: null, attempt: 2, accepted: true });
    });

    it('no retry within the window: the retries are over, so it failed', () => {
        expect(attemptStates([a1Failed], T(20, 35, 14) + RETRY_WINDOW_MS + 1).get(9001)!.state).toBe('failed');
        // A later attempt after the window is a new email of its own.
        const late = row({ id: 9003, createdAt: new Date(T(20, 35, 14) + RETRY_WINDOW_MS + 60_000) });
        const s = attemptStates([a1Failed, late], T(23, 0));
        expect(s.get(9001)).toMatchObject({ state: 'failed', retriedBy: null });
        expect(s.get(9003)).toMatchObject({ state: 'sent', attempt: 1, retryOf: null });
    });

    it('a send whose reply never arrived stops reading as sending after the window; a send event settles it at once', () => {
        expect(attemptStates([a1Sending], T(20, 33, 8, 990) + SENDING_WINDOW_MS).get(9001)!.state).toBe('sending');
        expect(attemptStates([a1Sending], T(20, 33, 8, 990) + SENDING_WINDOW_MS + 1).get(9001)!.state).toBe('sent');
        expect(attemptStates([a1Sending], T(20, 34, 46), { recorded: id => id === 9001 }).get(9001)).toMatchObject({ state: 'sent', accepted: true });
    });
});

describe('attemptStates: retry links and final outcomes', () => {
    const base = T(9, 0);
    const failedAt = (id: number, minute: number, over: Partial<AttemptRow> = {}) => row({
        id, createdAt: new Date(base + minute * 60_000), updatedAt: new Date(base + minute * 60_000 + 30_000),
        status: 'failed', smtpResponse: '421 4.7.0 Try again later', errorMessage: 'Message failed: 421 4.7.0 Try again later', ...over,
    });

    it('a permanent refusal is failed at once, and retried once a later attempt comes', () => {
        const perm = failedAt(1, 0, { smtpResponse: '550 5.4.5 Daily sending quota exceeded', errorMessage: 'Message failed: 550 5.4.5' });
        expect(attemptStates([perm], base + 60_000).get(1)).toMatchObject({ state: 'failed', temporary: false });
        const s = attemptStates([perm, row({ id: 2, createdAt: new Date(base + 90_000) })], base + 120_000);
        expect(s.get(1)).toMatchObject({ state: 'retried', temporary: false, retriedBy: 2 });
        expect(s.get(2)).toMatchObject({ state: 'sent', attempt: 2 });
    });

    it('six temporary refusals: the job has no retry left, so the sixth failed at once; each earlier one was retried', () => {
        const rows = Array.from({ length: EMAIL_JOB_ATTEMPTS }, (_v, i) => failedAt(i + 1, i));
        const s = attemptStates(rows, base + EMAIL_JOB_ATTEMPTS * 60_000);
        expect(rows.map(r => [s.get(Number(r.id))!.attempt, s.get(Number(r.id))!.state])).toEqual([
            [1, 'retried'], [2, 'retried'], [3, 'retried'], [4, 'retried'], [5, 'retried'], [6, 'failed'],
        ]);
    });

    it('only the same email links: same channel, order, type, recipient and subject; an accepted email is never retried', () => {
        const f = failedAt(1, 0);
        const others = [
            row({ id: 2, createdAt: new Date(base + 60_000), subject: 'Your order has shipped' }),
            row({ id: 3, createdAt: new Date(base + 60_000), orderId: 4304 }),
            row({ id: 4, createdAt: new Date(base + 60_000), recipient: 'other@example.com' }),
            row({ id: 5, createdAt: new Date(base + 60_000), channelId: 2 }),
            row({ id: 6, createdAt: new Date(base + 60_000), type: 'invoice' }),
        ];
        const s = attemptStates([f, ...others], base + 2 * 60_000);
        expect(s.get(1)).toMatchObject({ state: 'retrying', retriedBy: null });
        for (const o of others) expect(s.get(Number(o.id))).toMatchObject({ attempt: 1, retryOf: null });
        // A resend after an accepted email is an email of its own.
        const s2 = attemptStates([row({ id: 7, createdAt: new Date(base) }), row({ id: 8, createdAt: new Date(base + 60_000) })], base + 120_000);
        expect(s2.get(7)).toMatchObject({ state: 'sent', retriedBy: null });
        expect(s2.get(8)).toMatchObject({ state: 'sent', attempt: 1, retryOf: null });
    });

    it('only rows stored as failed or deferred are linked: a sent row with a refusal reply (its status update failed) reads sent, as SQL counts it', () => {
        const odd = row({ id: 1, status: 'sent', smtpResponse: '421 4.7.0 Try again later', createdAt: new Date(base) });
        const s = attemptStates([odd, row({ id: 2, createdAt: new Date(base + 60_000) })], base + 120_000);
        expect(s.get(1)).toMatchObject({ state: 'sent', accepted: false, retriedBy: null });
        expect(s.get(2)).toMatchObject({ attempt: 1, retryOf: null });
    });

    it('a 4xx reply that did not throw stays deferred (the job is done); a provider deferral is deferred and was accepted', () => {
        const reply = row({ id: 1, status: 'deferred', smtpResponse: '451 4.7.1 greylisted', createdAt: new Date(base) });
        expect(attemptStates([reply], base + 60_000).get(1)).toMatchObject({ state: 'deferred', accepted: false, temporary: true });
        const provider = row({ id: 2, status: 'deferred', errorMessage: '421 mailbox busy', createdAt: new Date(base) });
        expect(attemptStates([provider], base + 60_000).get(2)).toMatchObject({ state: 'deferred', accepted: true });
    });

    it('stored statuses stand for accepted emails; a provider drop reads failed; suppressed is never linked', () => {
        const s = attemptStates([
            row({ id: 1, status: 'delivered' }), row({ id: 2, status: 'bounced', recipient: 'b@example.com' }),
            row({ id: 3, status: 'complained', recipient: 'c@example.com' }), row({ id: 4, status: 'failed', errorMessage: 'Spam Content', recipient: 'd@example.com' }),
            row({ id: 5, status: 'suppressed', smtpResponse: null, recipient: 'e@example.com' }),
            row({ id: 6, recipient: 'e@example.com', createdAt: new Date(T(20, 1)) }),
        ], T(21, 0));
        expect([1, 2, 3, 4, 5, 6].map(id => [s.get(id)!.state, s.get(id)!.accepted])).toEqual([
            ['delivered', true], ['bounced', true], ['complained', true], ['failed', false], ['suppressed', false], ['sent', true],
        ]);
        expect(s.get(6)!.retryOf).toBeNull();
    });
});

describe('attemptStates: a send cut off before its reply (a worker restart mid-SMTP)', () => {
    const timelineFrom = T(12, 37); // the install's first send event
    // Attempt 1 never records a reply or an error; the stalled job runs again at 20:01 and is accepted.
    const cut = row({ id: 1, createdAt: new Date(T(20, 0)), updatedAt: new Date(T(20, 0)), smtpResponse: null });
    const rerun = row({ id: 2, createdAt: new Date(T(20, 1)), updatedAt: new Date(T(20, 1, 2)) });

    it('sending for the window, then "no reply recorded": never accepted', () => {
        expect(attemptStates([cut], T(20, 5), { timelineFrom }).get(1)).toMatchObject({ state: 'sending', outcome: 'pending', accepted: false });
        expect(attemptStates([cut], T(20, 20), { timelineFrom }).get(1)).toMatchObject({ state: 'unknown', outcome: 'unknown', accepted: false });
        expect(mayHaveRetry(cut)).toBe(true);
        expect(mayHaveRetry(rerun)).toBe(false);
    });

    it('the re-run is its retry: one email, sent after 1 retry', () => {
        const s = attemptStates([cut, rerun], T(20, 20), { timelineFrom });
        expect(s.get(1)).toMatchObject({ state: 'retried', outcome: 'unknown', retriedBy: 2, accepted: false });
        expect(s.get(2)).toMatchObject({ state: 'sent', attempt: 2, retryOf: 1, accepted: true });
        // While attempt 1 may still be running, the two are not linked yet.
        expect(attemptStates([cut, rerun], T(20, 5), { timelineFrom }).get(2)).toMatchObject({ attempt: 1, retryOf: null });
        // A later attempt after the send window and the retry window is an email of its own.
        const late = row({ id: 3, createdAt: new Date(T(20, 0) + SENDING_WINDOW_MS + RETRY_WINDOW_MS + 60_000) });
        expect(attemptStates([cut, late], T(23, 0), { timelineFrom }).get(1)).toMatchObject({ state: 'unknown', retriedBy: null });
    });

    it('a row from before the event timeline (no reply was recorded then, before 0.14.3) keeps its stored status, as without a timeline', () => {
        const old = row({ id: 4, createdAt: new Date(T(9, 0)), updatedAt: new Date(T(9, 0)), smtpResponse: null });
        expect(attemptStates([old], T(21, 0), { timelineFrom }).get(4)).toMatchObject({ state: 'sent', accepted: true });
        expect(attemptStates([cut], T(21, 0), { timelineFrom: null }).get(1)).toMatchObject({ state: 'sent', accepted: true });
        expect(attemptStates([cut], T(21, 0)).get(1)).toMatchObject({ state: 'sent', accepted: true });
        // A send event settles it either way.
        expect(attemptStates([cut], T(21, 0), { timelineFrom, recorded: () => true }).get(1)).toMatchObject({ state: 'sent', accepted: true });
    });
});

describe('the SQL that counts the same way', () => {
    it('SENDING_SQL, UNSETTLED_SQL and ACCEPTED_SQL take one parameter, UNKNOWN_SQL two, at the instants the helpers give', () => {
        expect(SENDING_SQL.split('?')).toHaveLength(2);
        expect(UNSETTLED_SQL.split('?')).toHaveLength(2);
        expect(ACCEPTED_SQL.split('?')).toHaveLength(2);
        expect(UNKNOWN_SQL.split('?')).toHaveLength(3);
        expect(ACCEPTED_SQL).toContain(`NOT ${UNSETTLED_SQL}`);
        const now = T(12, 0);
        expect((sendingSince(now, 'mysql') as Date).getTime()).toBe(now - SENDING_WINDOW_MS);
        expect(sendingSince(now, 'sqljs')).toBe('2026-11-05 11:45:00.000');
        expect(sqlTime(new Date(now), 'better-sqlite3')).toBe('2026-11-05 12:00:00.000');
        expect(sqlTime(new Date(now), 'postgres')).toBeInstanceOf(Date);
        // Rows without an outcome from the timeline start on are sending or unknown; before it they are from before replies were recorded.
        expect(unsettledSince(now, T(9, 0), 'sqljs')).toBe('2026-11-05 09:00:00.000');
        expect(unsettledSince(now, null, 'sqljs')).toBe('2026-11-05 11:45:00.000');
        expect(unsettledSince(now, T(11, 55), 'sqljs')).toBe('2026-11-05 11:45:00.000'); // a timeline younger than the sending window
        expect(unknownParams(now, T(9, 0), 'sqljs')).toEqual(['2026-11-05 11:45:00.000', '2026-11-05 09:00:00.000']);
        // Without a timeline start the bounds exclude each other: createdAt < now − 15 min and createdAt >= now.
        expect(unknownParams(now, null, 'sqljs')).toEqual(['2026-11-05 11:45:00.000', '2026-11-05 12:00:00.000']);
    });

    it('relatedAttempts: each recipient\'s windows merged where they overlap, newest first, 200 a lookup, newest rows first', async () => {
        const calls: Array<{ sql: string; params: any[] }> = [];
        const query = async (sql: string, params: any[] = []) => { calls.push({ sql, params }); return [{ id: 99 }]; };
        const seeds = [
            row({ id: 1, createdAt: new Date(T(9, 0)), recipient: 'a@example.com' }),
            row({ id: 2, createdAt: new Date(T(10, 0)), recipient: 'b@example.com' }),
            row({ id: 3, createdAt: new Date(T(9, 0) + 9 * 86_400_000), recipient: 'a@example.com' }),
            row({ id: 4, createdAt: new Date(T(9, 30)), recipient: 'a@example.com' }), // overlaps id 1: one window
            row({ id: 5, createdAt: null, recipient: 'c@example.com' }),
        ];
        const out = await relatedAttempts(query, seeds, 'mysql');
        expect(out).toHaveLength(1);
        expect(calls).toHaveLength(1);
        expect(calls[0].sql).toMatch(/WHERE \(recipient = \? AND `createdAt` >= \? AND `createdAt` <= \?\) OR \(recipient = \? AND .* ORDER BY id DESC LIMIT \?$/);
        const windows = (params: any[]) => {
            const out: Array<[string, number, number]> = [];
            for (let i = 0; i + 2 < params.length; i += 3) out.push([params[i], (params[i + 1] as Date).getTime(), (params[i + 2] as Date).getTime()]);
            return out;
        };
        expect(windows(calls[0].params)).toEqual([
            ['a@example.com', T(9, 0) + 9 * 86_400_000 - RELATED_SPAN_MS, T(9, 0) + 9 * 86_400_000 + RELATED_SPAN_MS],
            ['b@example.com', T(10, 0) - RELATED_SPAN_MS, T(10, 0) + RELATED_SPAN_MS],
            ['a@example.com', T(9, 0) - RELATED_SPAN_MS, T(9, 30) + RELATED_SPAN_MS],
        ]);
        expect(calls[0].params[calls[0].params.length - 1]).toBe(10_000);
        // 450 windows: three lookups, the newest 200 first.
        const many = Array.from({ length: 450 }, (_v, i) => row({ id: i + 1, recipient: `r${i}@example.com`, createdAt: new Date(T(0, 0) + i * 60_000) }));
        calls.length = 0;
        await relatedAttempts(query, many, 'mysql');
        expect(calls.map(c => (c.params.length - 1) / 3)).toEqual([200, 200, 50]);
        expect(calls[0].params[0]).toBe('r449@example.com');
        expect(calls[2].params[calls[2].params.length - 4]).toBe('r0@example.com');
    });

    it('a year of occasional refusals: every one, the newest included, is read with its retry (one lookup)', async () => {
        // The review's case: 60 refusals 8 days apart, each retried 90 s later and accepted, then order 4303 today.
        const now = T(21, 0);
        const rows: AttemptRow[] = [];
        let id = 1;
        for (let w = 60; w >= 1; w--) {
            const at = now - w * 8 * 86_400_000;
            const email = { orderId: 1000 + w, recipient: `buyer${w}@example.com`, subject: `Order confirmation for #W${w}` };
            rows.push(row({ id: id++, ...email, createdAt: new Date(at), updatedAt: new Date(at + 60_000), status: 'failed', smtpResponse: '421 4.3.0 Temporary System Problem', errorMessage: 'Message failed: 421 4.3.0' }));
            rows.push(row({ id: id++, ...email, createdAt: new Date(at + 90_000), updatedAt: new Date(at + 91_000) }));
        }
        rows.push(row({ id: id++, createdAt: new Date(T(20, 33, 8)), updatedAt: new Date(T(20, 35, 14)), status: 'failed', smtpResponse: GMAIL_421, errorMessage: 'Message failed: 421 4.3.0' }));
        const newest = id - 1;
        rows.push(row({ id: id++, createdAt: new Date(T(20, 35, 41)), updatedAt: new Date(T(20, 35, 42)) }));
        let lookups = 0;
        const query = async (_sql: string, params: any[] = []) => {
            lookups++;
            const windows: Array<[string, number, number]> = [];
            for (let i = 0; i + 2 < params.length; i += 3) windows.push([params[i], (params[i + 1] as Date).getTime(), (params[i + 2] as Date).getTime()]);
            return rows.filter(r => windows.some(([who, from, to]) => r.recipient === who && (r.createdAt as Date).getTime() >= from && (r.createdAt as Date).getTime() <= to))
                .sort((a, b) => Number(b.id) - Number(a.id)).slice(0, params[params.length - 1]);
        };
        // As the Failed card reads them: the refused rows, newest first, are the seeds.
        const refused = rows.filter(r => r.status === 'failed').sort((a, b) => Number(b.id) - Number(a.id));
        const infos = await attemptInfosFor(query, refused, { now, dbType: 'mysql' });
        expect(lookups).toBe(1);
        expect(refused.map(r => infos.get(Number(r.id))!.state)).toEqual(refused.map(() => 'retried'));
        expect(infos.get(newest)).toMatchObject({ state: 'retried', retriedBy: newest + 1 });
    });

    it('databaseNow: the database\'s clock on MySQL, MariaDB and PostgreSQL, this process\'s on sqlite or when it cannot be read', async () => {
        const dbNow = new Date(T(19, 35)); // a database an hour behind this process
        const seen: string[] = [];
        const query = async (sql: string) => { seen.push(sql); return [{ dbNow }]; };
        for (const type of ['mysql', 'mariadb', 'postgres']) expect(await databaseNow(query, type)).toBe(dbNow.getTime());
        expect(seen).toEqual(Array(3).fill('SELECT LOCALTIMESTAMP AS `dbNow`'));
        const before = Date.now();
        expect(await databaseNow(query, 'sqljs')).toBeGreaterThanOrEqual(before);
        expect(seen).toHaveLength(3);
        expect(await databaseNow(async () => { throw new Error('gone'); }, 'mysql')).toBeGreaterThanOrEqual(before);
        expect(await databaseNow(async () => [{}], 'postgres')).toBeGreaterThanOrEqual(before);
    });

    it('the event timeline start: the first send event, kept once known, read again while there is none', async () => {
        let calls = 0;
        let first: any[] = [];
        const query = async (sql: string) => { calls++; expect(sql).toContain("FROM email_event WHERE source = 'smtp'"); return first; };
        expect(await eventTimelineStart(async () => { throw new Error('no such table: email_event'); })).toBeNull();
        const start = new TimelineStart();
        expect(await start.get(query)).toBeNull();
        first = [{ createdAt: new Date(T(12, 37)) }];
        expect(await start.get(query)).toBe(T(12, 37));
        first = [{ createdAt: new Date(T(13, 0)) }];
        expect(await start.get(query)).toBe(T(12, 37));
        expect(calls).toBe(2);
    });

    it('attemptInfosFor reads the rows on their own when the lookup fails (no retry links), and never throws', async () => {
        const failing = async () => { throw new Error('no such function: DATE_SUB'); };
        const f = row({ id: 1, status: 'failed', smtpResponse: null, errorMessage: 'Connection timeout', createdAt: new Date(T(9, 0)), updatedAt: new Date(T(9, 0)) });
        const infos = await attemptInfosFor(failing, [f], { now: T(9, 1) });
        expect(infos.get(1)).toMatchObject({ state: 'retrying' });
        const found = await attemptInfosFor(async () => [row({ id: 2, createdAt: new Date(T(9, 0, 30)) })], [f], { now: T(9, 1) });
        expect(found.get(1)).toMatchObject({ state: 'retried', retriedBy: 2 });
        expect(found.get(2)).toMatchObject({ state: 'sent', attempt: 2, retryOf: 1 });
    });
});
