/**
 * Send attempts (0.16.3). Every send writes its `email_log` row before SMTP
 * starts, and Vendure's EmailPlugin runs a failed send job again (5 retries),
 * each run with a row of its own. These rules read a row together with the
 * other attempts of the same email, so the order card and timeline, the
 * exports, the evidence report, the Email Log list and cards, the By template
 * table and the weekly figures agree on what happened. Stored statuses are
 * never changed; this is how they are read:
 *
 * - `sending`: no SMTP outcome recorded yet (status `sent`, no reply, no
 *   error) and created less than `SENDING_WINDOW_MS` ago.
 * - `unknown` ("No reply recorded"): still no outcome after that, on a row
 *   created after the install's event timeline began (the send was cut off,
 *   e.g. by a worker restart). An older row without a reply comes from before
 *   replies were recorded (0.14.3) and keeps its stored status.
 * - A refusal is temporary for an SMTP 4xx reply and for a connection or
 *   timeout error, permanent for a 5xx reply or any other error.
 * - The next attempt of the same email (same channel, order, type, recipient
 *   and subject) created within `RETRY_WINDOW_MS` of a refused attempt's
 *   failure, or of the end of an unknown attempt's sending window, is its
 *   retry. The earlier attempt is then `retried`; the retry knows it is
 *   attempt 2 ("Sent after 1 retry").
 * - A refused attempt without a retry is `retrying` while its temporary
 *   failure can still be retried (inside the window, fewer than
 *   `EMAIL_JOB_ATTEMPTS` attempts), else `failed`. A 4xx reply that did not
 *   throw (status `deferred`) is not retried by the job and stays `deferred`.
 * - Every other row keeps its stored status (sent, delivered, deferred,
 *   bounced, complained, suppressed, or failed after a provider drop).
 *
 * `createdAt` and `updatedAt` are written by the database, so the windows are
 * measured from the database's "now" (`databaseNow`), not this process's.
 */

/** How long a missing SMTP outcome still means "sending" (nodemailer gives up on a silent socket after 10 minutes). */
export const SENDING_WINDOW_MS = 15 * 60_000;
/** A later attempt of the same email created within this time of a refused attempt's failure is its retry. */
export const RETRY_WINDOW_MS = 15 * 60_000;
/** Attempts Vendure's EmailPlugin makes at most: the first and its 5 retries (`jobQueue.add(…, { retries: 5 })`). */
export const EMAIL_JOB_ATTEMPTS = 6;

/** The `email_log` columns the rules read. */
export interface AttemptRow {
    id: number | string;
    createdAt: Date | string | null | undefined;
    /** When the row was last written: for a refused attempt, the time its failure was recorded. */
    updatedAt?: Date | string | null;
    channelId?: number | string | null;
    orderId?: number | string | null;
    type?: string | null;
    recipient?: string | null;
    subject?: string | null;
    status?: string | null;
    smtpResponse?: string | null;
    errorMessage?: string | null;
}

/**
 * What the mail server did with one attempt: nothing recorded yet
 * (`pending`), nothing ever recorded (`unknown`), accepted, or refused
 * (temporarily / permanently).
 */
export type SendOutcome = 'pending' | 'unknown' | 'accepted' | 'temporary' | 'permanent';

export type AttemptState =
    | 'sending' | 'sent' | 'delivered' | 'deferred' | 'bounced' | 'complained' | 'suppressed'
    | 'retrying' | 'retried' | 'failed' | 'unknown';

export const ATTEMPT_STATES: readonly AttemptState[] = [
    'sending', 'sent', 'delivered', 'deferred', 'bounced', 'complained', 'suppressed', 'retrying', 'retried', 'failed', 'unknown',
];

/** States the stored status alone decides (plain SQL); the others need the email's other attempts. */
export const STORED_STATES: readonly AttemptState[] = ['sending', 'sent', 'delivered', 'bounced', 'complained', 'suppressed'];

export interface AttemptInfo {
    state: AttemptState;
    outcome: SendOutcome;
    /** The mail server took the email and nothing refused or dropped it since (counted as sent / accepted). */
    accepted: boolean;
    /** The refusal was temporary (SMTP 4xx, connection or timeout error). */
    temporary: boolean;
    /** 1 for the first attempt of an email, 2 for its first retry … */
    attempt: number;
    /** The attempt this one retried. */
    retryOf: number | null;
    /** The later attempt that retried this one. */
    retriedBy: number | null;
}

/** Milliseconds since the epoch: Dates, ISO strings and the UTC `YYYY-MM-DD HH:MM:SS[.fff]` strings sqlite returns. */
export function timeOf(v: unknown): number | null {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
    const s = String(v);
    const naive = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s);
    const t = Date.parse(naive ? s.replace(' ', 'T') + 'Z' : s);
    return Number.isFinite(t) ? t : null;
}

/** The reply code a server reply starts with ("250 2.0.0 OK", "421-4.3.0 …"); null when there is none. */
export function replyCode(text: unknown): number | null {
    const m = /^\s*([2-5]\d\d)(?=[\s-]|$)/.exec(String(text ?? ''));
    return m ? Number(m[1]) : null;
}

/** The SMTP code inside a nodemailer error message ("Message failed: 421 4.3.0 …", "Invalid login: 535-5.7.8 …"). */
export function errorReplyCode(text: unknown): number | null {
    const s = String(text ?? '');
    const m = /(?:^|:\s+)([45]\d\d)(?=[\s-]|$)/.exec(s) || /(?:^|\s)([45]\d\d)[\s-][45]\.\d{1,3}\.\d{1,3}\b/.exec(s);
    return m ? Number(m[1]) : null;
}

const CONNECTION_ERROR = /\b(?:ETIMEDOUT|ESOCKET|ECONNECTION|ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN|EDNS)\b|timed?\s?out|connection (?:closed|lost|reset|refused)|unexpected socket close|socket hang up|greeting never received|network socket disconnected/i;

/** A failure without an SMTP reply that the next attempt may not meet: timeouts, refused or dropped connections, DNS. */
export function isConnectionError(message: unknown): boolean {
    return CONNECTION_ERROR.test(String(message ?? ''));
}

/** Temporary refusal (SMTP 4xx, connection or timeout error) as opposed to a permanent one (5xx, anything else). */
export function isTemporaryFailure(smtpResponse: unknown, errorMessage: unknown): boolean {
    const code = replyCode(smtpResponse) ?? errorReplyCode(errorMessage);
    if (code !== null && code >= 400) return code < 500;
    return isConnectionError(errorMessage);
}

/** No SMTP outcome on the row: written before the send and never given a reply or an error since. */
function hasNoOutcome(row: AttemptRow): boolean {
    return String(row.status || 'sent') === 'sent' && (row.smtpResponse === null || row.smtpResponse === undefined) && !row.errorMessage;
}

/** What the mail server did with one attempt, from its row alone (`pending`: no outcome recorded). */
export function sendOutcome(row: AttemptRow): SendOutcome {
    const status = String(row.status || 'sent');
    if (status === 'suppressed') return 'permanent';
    const code = replyCode(row.smtpResponse);
    if (code !== null && code >= 400) return code >= 500 ? 'permanent' : 'temporary';
    if (status === 'failed') {
        // A 2xx reply: accepted, then dropped by the provider. Without one, the send threw.
        if (code !== null) return 'accepted';
        return isTemporaryFailure(null, row.errorMessage) ? 'temporary' : 'permanent';
    }
    if (hasNoOutcome(row)) return 'pending';
    return 'accepted';
}

/** The row's state may depend on a later attempt (refused, or no outcome recorded): the rows whose other attempts are read. */
export function mayHaveRetry(row: AttemptRow): boolean {
    const status = String(row.status || 'sent');
    return status === 'failed' || status === 'deferred' || hasNoOutcome(row);
}

/** Attempts of one email share this key: same channel, order, type, recipient and subject. */
export function emailKey(row: AttemptRow): string {
    const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
    return JSON.stringify([s(row.channelId), s(row.orderId), s(row.type), s(row.recipient).trim(), s(row.subject)]);
}

/** When a refused attempt's failure was recorded (its last write), else when it started. */
function failedAt(row: AttemptRow): number {
    const created = timeOf(row.createdAt) ?? 0;
    const updated = timeOf(row.updatedAt);
    return updated !== null && updated >= created ? updated : created;
}

const KEPT: ReadonlySet<string> = new Set(['sent', 'delivered', 'deferred', 'bounced', 'complained']);

export interface AttemptOptions {
    /** The attempt's outcome is known from elsewhere (its send event), so a missing reply never reads as sending or unknown. */
    recorded?: (id: number) => boolean;
    /**
     * When the install's event timeline began (`TimelineStart`). A row
     * without an outcome created before it comes from before replies were
     * recorded and keeps its stored status; null: none reads as unknown.
     */
    timelineFrom?: number | null;
}

/** The outcome as of `now`: a missing one is `pending` while the send may still run, then `unknown` (or the stored status, before the timeline). */
function outcomeAt(row: AttemptRow, id: number, now: number, opts: AttemptOptions): SendOutcome {
    const outcome = sendOutcome(row);
    if (outcome !== 'pending') return outcome;
    if (opts.recorded?.(id)) return 'accepted';
    const created = timeOf(row.createdAt) ?? 0;
    // `<=`: the same instant `SENDING_SQL` counts from (`createdAt >= now − window`).
    if (now - created <= SENDING_WINDOW_MS) return 'pending';
    const from = opts.timelineFrom ?? null;
    return from !== null && created >= from ? 'unknown' : 'accepted';
}

/** Until when a later attempt of the same email counts as this one's retry; null when this one is never retried. */
function retryDeadline(row: AttemptRow, info: AttemptInfo): number | null {
    // Cut off mid-send: it ran for at most the sending window, then the retry window.
    if (info.outcome === 'unknown') return (timeOf(row.createdAt) ?? 0) + SENDING_WINDOW_MS + RETRY_WINDOW_MS;
    // Refused at submit and stored so (`failed` / `deferred`): what the SQL counts read as refused too.
    const status = String(row.status || 'sent');
    const refused = (info.outcome === 'temporary' || info.outcome === 'permanent') && (status === 'failed' || status === 'deferred');
    return refused ? failedAt(row) + RETRY_WINDOW_MS : null;
}

function stateOf(row: AttemptRow, info: AttemptInfo, now: number): AttemptState {
    const status = String(row.status || 'sent');
    if (status === 'suppressed') return 'suppressed';
    if (info.outcome === 'pending') return 'sending';
    if (info.outcome === 'accepted') return status === 'failed' ? 'failed' : KEPT.has(status) ? (status as AttemptState) : 'sent';
    if (info.retriedBy !== null) return 'retried';
    if (info.outcome === 'unknown') return 'unknown';
    if (status === 'failed') {
        const canRetry = info.temporary && info.attempt < EMAIL_JOB_ATTEMPTS && now - failedAt(row) <= RETRY_WINDOW_MS;
        return canRetry ? 'retrying' : 'failed';
    }
    // A 4xx reply that did not throw (`deferred`): the job is done, nothing runs it again. Any other stored status stands.
    return KEPT.has(status) ? (status as AttemptState) : 'failed';
}

/**
 * Every row's AttemptInfo, read with the other rows: pass all attempts that
 * may belong to the same emails (an order's emails, or the rows around the
 * ones shown — `relatedAttempts`). `now`: the database's (`databaseNow`).
 */
export function attemptStates(rows: readonly AttemptRow[], now = Date.now(), opts: AttemptOptions = {}): Map<number, AttemptInfo> {
    const byId = new Map<number, AttemptRow>();
    for (const r of rows) {
        const id = Number(r?.id);
        if (Number.isInteger(id) && id > 0 && !byId.has(id)) byId.set(id, r);
    }
    const sorted = [...byId.entries()].sort((a, b) => a[0] - b[0]);
    const out = new Map<number, AttemptInfo>();
    const previous = new Map<string, number>();
    for (const [id, row] of sorted) {
        const outcome = outcomeAt(row, id, now, opts);
        const info: AttemptInfo = {
            state: 'sent', outcome, accepted: false, temporary: outcome === 'temporary', attempt: 1, retryOf: null, retriedBy: null,
        };
        const key = emailKey(row);
        const prevId = previous.get(key);
        if (prevId !== undefined) {
            const prev = out.get(prevId)!;
            const deadline = retryDeadline(byId.get(prevId)!, prev);
            if (deadline !== null && (timeOf(row.createdAt) ?? 0) <= deadline) {
                prev.retriedBy = id;
                info.retryOf = prevId;
                info.attempt = prev.attempt + 1;
            }
        }
        previous.set(key, id);
        out.set(id, info);
    }
    for (const [id, row] of sorted) {
        const info = out.get(id)!;
        info.state = stateOf(row, info, now);
        info.accepted = info.outcome === 'accepted' && KEPT.has(info.state);
    }
    return out;
}

/** "1 retry", "2 retries". */
export function retriesText(n: number): string {
    return `${n} ${n === 1 ? 'retry' : 'retries'}`;
}

// ── Database helpers (the queries run through the caller's dialect adapter) ──

/** SQL: no SMTP outcome on the row (status `sent`, no reply, no error). */
export const NO_OUTCOME_SQL = "(status = 'sent' AND `smtpResponse` IS NULL AND `errorMessage` IS NULL)";

/**
 * SQL: a send still in flight, as `attemptStates` reads it. One `?`: the
 * earliest `createdAt` that still counts (`sendingSince()`), so SQL counts and
 * the rows' states use the same instant.
 */
export const SENDING_SQL = `(${NO_OUTCOME_SQL} AND \`createdAt\` >= ?)`;

/**
 * SQL: no outcome was ever recorded (`unknown`, unless a later attempt
 * retried it). Two `?`: `unknownParams()`.
 */
export const UNKNOWN_SQL = `(${NO_OUTCOME_SQL} AND \`createdAt\` < ? AND \`createdAt\` >= ?)`;

/** SQL: no outcome yet or none ever (`sending` or `unknown`). One `?`: `unsettledSince()`. */
export const UNSETTLED_SQL = `(${NO_OUTCOME_SQL} AND \`createdAt\` >= ?)`;

/**
 * SQL: accepted by the mail server — `AttemptInfo.accepted`: sent, delivered,
 * bounced, complained, or deferred by the provider after acceptance; never a
 * failed or suppressed one, a 4xx / 5xx reply, a send still in flight or one
 * without any reply recorded. One `?`, as `UNSETTLED_SQL`.
 */
export const ACCEPTED_SQL = `(status IN ('sent', 'delivered', 'deferred', 'bounced', 'complained') AND COALESCE(\`smtpResponse\`, '') NOT LIKE '4%' AND COALESCE(\`smtpResponse\`, '') NOT LIKE '5%' AND NOT ${UNSETTLED_SQL})`;

/** The columns of `AttemptRow`, for SELECT lists. */
export const ATTEMPT_COLUMNS = 'id, `createdAt`, `updatedAt`, `channelId`, `orderId`, type, recipient, subject, status, `smtpResponse`, `errorMessage`';

/** How far apart the attempts of one email can be: five retries, each a send and the wait before the next. */
export const RELATED_SPAN_MS = (EMAIL_JOB_ATTEMPTS - 1) * (SENDING_WINDOW_MS + RETRY_WINDOW_MS);

const SQLITE_TYPES = new Set(['sqlite', 'sqljs', 'better-sqlite3', 'capacitor', 'cordova', 'expo', 'nativescript', 'react-native']);

/** A Date as a query parameter: sqlite drivers cannot bind one, so there it is the UTC string TypeORM stores. */
export function sqlTime(d: Date, dbType: string | undefined): Date | string {
    return SQLITE_TYPES.has(String(dbType || '')) ? d.toISOString().replace('T', ' ').replace('Z', '') : d;
}

/** The parameter of `SENDING_SQL` for `now`. */
export function sendingSince(now: number, dbType: string | undefined): Date | string {
    return sqlTime(new Date(now - SENDING_WINDOW_MS), dbType);
}

/** The parameter of `UNSETTLED_SQL` / `ACCEPTED_SQL`: rows without an outcome created from then on are sending or unknown. */
export function unsettledSince(now: number, timelineFrom: number | null, dbType: string | undefined): Date | string {
    const since = now - SENDING_WINDOW_MS;
    return sqlTime(new Date(timelineFrom !== null && timelineFrom < since ? timelineFrom : since), dbType);
}

/** The two parameters of `UNKNOWN_SQL`. Without a timeline start no row is unknown (the two bounds then exclude each other). */
export function unknownParams(now: number, timelineFrom: number | null, dbType: string | undefined): Array<Date | string> {
    return [sendingSince(now, dbType), sqlTime(new Date(timelineFrom ?? now), dbType)];
}

type Query = (sql: string, params?: any[]) => Promise<any>;

/**
 * "Now" as the database reads it back through the driver: `createdAt` and
 * `updatedAt` are written by the database, so the windows compare with its
 * clock, and a database session in another time zone than this process
 * shifts nothing. Date.now() on sqlite (it stores UTC) and when the query
 * fails.
 */
export async function databaseNow(query: Query, dbType: string | undefined): Promise<number> {
    if (!/^(mysql|mariadb|postgres)$/.test(String(dbType || ''))) return Date.now();
    try {
        const rows = await query('SELECT LOCALTIMESTAMP AS `dbNow`');
        return timeOf(Array.isArray(rows) ? rows[0]?.dbNow : undefined) ?? Date.now();
    } catch {
        return Date.now();
    }
}

/**
 * The `createdAt` of the install's first send event: when its event timeline
 * (0.16.0) began. Null: no send event yet, or no `email_event` table.
 */
export async function eventTimelineStart(query: Query): Promise<number | null> {
    try {
        const rows = await query("SELECT `createdAt` FROM email_event WHERE source = 'smtp' AND `emailLogId` IS NOT NULL ORDER BY id ASC LIMIT 1");
        return timeOf(Array.isArray(rows) ? rows[0]?.createdAt : undefined);
    } catch {
        return null;
    }
}

/** `eventTimelineStart`, read until there is one and then kept: it does not move (retention prunes the first events only with the emails of their time). */
export class TimelineStart {
    private known: number | null = null;

    async get(query: Query): Promise<number | null> {
        if (this.known === null) this.known = await eventTimelineStart(query);
        return this.known;
    }
}

/** What the send states are read against: the database's "now" and when the event timeline began. */
export interface SendClock {
    now: number;
    timelineFrom: number | null;
}

export async function sendClock(query: Query, dbType: string | undefined, timeline: TimelineStart): Promise<SendClock> {
    const [now, timelineFrom] = await Promise.all([databaseNow(query, dbType), timeline.get(query)]);
    return { now, timelineFrom };
}

/** Windows per lookup (three parameters each) and rows per lookup. */
const RELATED_RANGES = 200;
const RELATED_ROWS = 10_000;
/** Lookups per call (one window per seed at worst, for the CSV export's 50 000 rows) and rows per call. */
const RELATED_LOOKUPS = 250;
const RELATED_MAX_ROWS = 50_000;

/**
 * The rows that may be other attempts of the same emails as `seeds`: same
 * recipient, within `RELATED_SPAN_MS` of a seed. Each recipient's windows are
 * merged where they overlap and read newest first, `RELATED_RANGES` per
 * lookup and the newest rows first, so a cap only ever drops the oldest links.
 */
export async function relatedAttempts(query: Query, seeds: readonly AttemptRow[], dbType: string | undefined): Promise<AttemptRow[]> {
    const byRecipient = new Map<string, number[]>();
    for (const s of seeds) {
        const at = timeOf(s.createdAt);
        const recipient = s.recipient ? String(s.recipient) : '';
        if (at === null || !recipient) continue;
        const times = byRecipient.get(recipient);
        if (times) times.push(at);
        else byRecipient.set(recipient, [at]);
    }
    const ranges: Array<{ recipient: string; from: number; to: number }> = [];
    for (const [recipient, times] of byRecipient) {
        let current: { recipient: string; from: number; to: number } | null = null;
        for (const at of times.sort((a, b) => b - a)) {
            if (current && at + RELATED_SPAN_MS >= current.from) {
                current.from = at - RELATED_SPAN_MS;
                continue;
            }
            current = { recipient, from: at - RELATED_SPAN_MS, to: at + RELATED_SPAN_MS };
            ranges.push(current);
        }
    }
    ranges.sort((a, b) => b.to - a.to);
    const out: AttemptRow[] = [];
    for (let i = 0, lookups = 0; i < ranges.length && lookups < RELATED_LOOKUPS && out.length < RELATED_MAX_ROWS; i += RELATED_RANGES, lookups++) {
        const batch = ranges.slice(i, i + RELATED_RANGES);
        const windows = batch.map(() => '(recipient = ? AND `createdAt` >= ? AND `createdAt` <= ?)').join(' OR ');
        const rows = await query(
            `SELECT ${ATTEMPT_COLUMNS} FROM email_log WHERE ${windows} ORDER BY id DESC LIMIT ?`,
            [...batch.flatMap(r => [r.recipient, sqlTime(new Date(r.from), dbType), sqlTime(new Date(r.to), dbType)]), RELATED_ROWS],
        );
        if (Array.isArray(rows)) out.push(...rows);
    }
    return out;
}

/**
 * AttemptInfo for `rows`, read with the attempts around `seeds` (default:
 * the rows themselves) from the database. A failed lookup leaves the rows
 * to be read on their own (no retry links), never failing the caller.
 */
export async function attemptInfosFor(
    query: Query, rows: readonly AttemptRow[],
    opts: { now?: number; timelineFrom?: number | null; seeds?: readonly AttemptRow[]; dbType?: string } = {},
): Promise<Map<number, AttemptInfo>> {
    const seeds = opts.seeds ?? rows;
    let related: AttemptRow[] = [];
    if (seeds.length) {
        try { related = await relatedAttempts(query, seeds, opts.dbType); } catch { related = []; }
    }
    return attemptStates([...rows, ...related], opts.now ?? Date.now(), { timelineFrom: opts.timelineFrom ?? null });
}

/** The extra fields an Email Log row is returned with. */
export function stateFields(info: AttemptInfo | undefined): { state: AttemptState | null; attempt: number; retryOf: number | null; retriedBy: number | null } {
    return { state: info?.state ?? null, attempt: info?.attempt ?? 1, retryOf: info?.retryOf ?? null, retriedBy: info?.retriedBy ?? null };
}
