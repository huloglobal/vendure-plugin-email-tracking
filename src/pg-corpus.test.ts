/**
 * Postgres corpus test — every raw SQL statement in `src/**` is translated
 * by the licence-sdk dialect adapter and executed against a scratch
 * PostgreSQL database. Skipped unless `HULO_PG_URL` is set, e.g.
 *
 *   HULO_PG_URL=postgres://hulo_pg:hulo_pg_local@localhost:5432/hulo_et_pg npx vitest run
 *
 * The scratch database gets TypeORM-quoted stand-ins for `email_log`,
 * `email_link`, `email_suppression`, `customer`, `order`,
 * `order_channels_channel` and `channel`, the exact DDL TypeORM generates
 * for `email_event` (0.16.0), plus the SDK's `hulo_licence_store`. Each statement
 * runs inside a rolled-back transaction, so the seed rows survive and the
 * run is idempotent. SELECTs must return rows with their camelCase aliases
 * intact (the adapter restores them from PG's lower-cased identifiers).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createDbAdapter, translateSql } from '@huloglobal/vendure-licence-sdk';

// The composed retention deletes come from batchedDelete; entities need decorator metadata the transform lacks.
vi.mock('./email-log.entity', () => ({ EmailLog: class EmailLog {} }));
vi.mock('./email-suppression.entity', () => ({ EmailSuppression: class EmailSuppression {} }));
vi.mock('./email-event.entity', () => ({ EmailEvent: class EmailEvent {} }));
import { batchedDelete } from './email-tracking.service';
import { EmailEventService } from './email-event.service';
import { applyStatusChange, nextStatus, STATUS_RANK, statusChangeForEvent } from './event-types';
import { databaseClockSkewMinutes } from './db-clock';
import { databaseNow } from './send-attempts';
import { ACCEPTED_SQL, ATTEMPT_COLUMNS, NO_OUTCOME_SQL, SENDING_SQL, UNKNOWN_SQL, UNSETTLED_SQL } from './send-attempts';

const PG_URL = process.env.HULO_PG_URL;

const DDL = [
    `DROP TABLE IF EXISTS email_log`,
    `DROP TABLE IF EXISTS email_link`,
    `DROP TABLE IF EXISTS email_suppression`,
    `DROP TABLE IF EXISTS customer`,
    `DROP TABLE IF EXISTS "order"`,
    `DROP TABLE IF EXISTS order_channels_channel`,
    `DROP TABLE IF EXISTS channel`,
    `DROP TABLE IF EXISTS hulo_licence_store`,
    `DROP TABLE IF EXISTS email_event`,
    // Exactly what TypeORM generates for EmailEvent on PostgreSQL (README → Upgrading to 0.16.0).
    `CREATE TABLE "email_event" ("createdAt" TIMESTAMP NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "emailLogId" integer, "orderId" integer, "customerId" integer, "channelId" integer, "type" character varying(32) NOT NULL, "source" character varying(32) NOT NULL, "occurredAt" TIMESTAMP(3) NOT NULL, "messageId" character varying(255), "providerMessageId" character varying(255), "dedupeKey" character varying(64), "recipientHash" character varying(64), "ip" character varying(64), "ipHash" character varying(64), "country" character varying(8), "region" character varying(64), "city" character varying(128), "timezone" character varying(64), "asn" character varying(16), "org" character varying(255), "isProxy" boolean, "isVpn" boolean, "isTor" boolean, "isHosting" boolean, "isMobile" boolean, "enrichedBy" character varying(32), "enrichedAt" TIMESTAMP(3), "userAgent" text, "client" character varying(64), "platform" character varying(32), "isBot" boolean, "classification" character varying(16), "classificationReasons" character varying(255), "url" text, "linkIndex" integer, "linkText" character varying(128), "detail" text, "payload" text, "id" SERIAL NOT NULL, CONSTRAINT "PK_6620d7d3a9919b2ca7b12ba423e" PRIMARY KEY ("id"))`,
    `CREATE UNIQUE INDEX "UQ_email_event_dedupe" ON "email_event" ("dedupeKey")`,
    `CREATE INDEX "IDX_email_event_created" ON "email_event" ("createdAt")`,
    `CREATE INDEX "IDX_email_event_provider_message" ON "email_event" ("providerMessageId")`,
    `CREATE INDEX "IDX_email_event_log" ON "email_event" ("emailLogId", "occurredAt")`,
    `CREATE INDEX "IDX_email_event_order" ON "email_event" ("orderId", "occurredAt")`,
    `CREATE TABLE email_log (
        id SERIAL PRIMARY KEY,
        "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW(),
        type VARCHAR(255) NOT NULL,
        recipient VARCHAR(255) NOT NULL,
        subject VARCHAR(512) NOT NULL,
        "fromAddress" VARCHAR(512),
        bcc VARCHAR(512),
        "replyTo" VARCHAR(512),
        context VARCHAR(255),
        "channelId" INTEGER NOT NULL DEFAULT 1,
        "customerId" INTEGER,
        "orderId" INTEGER,
        "orderCode" VARCHAR(255),
        "invoiceId" INTEGER,
        "applicationId" INTEGER,
        status VARCHAR(255) NOT NULL DEFAULT 'sent',
        "smtpResponse" VARCHAR(512),
        "smtpMessageId" VARCHAR(512),
        "errorMessage" TEXT,
        "openCount" INTEGER NOT NULL DEFAULT 0,
        "firstOpenedAt" TIMESTAMP,
        "lastOpenedAt" TIMESTAMP,
        "firstOpenIp" VARCHAR(255),
        "firstOpenUserAgent" TEXT,
        "opensJson" TEXT,
        "clickCount" INTEGER NOT NULL DEFAULT 0,
        "clicksJson" TEXT,
        "firstClickedAt" TIMESTAMP,
        tracked BOOLEAN NOT NULL DEFAULT TRUE
    )`,
    `CREATE TABLE email_link (
        id SERIAL PRIMARY KEY,
        "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW(),
        "emailLogId" INTEGER,
        "orderId" INTEGER,
        "invoiceId" INTEGER,
        "customerId" INTEGER,
        "supportTicketId" INTEGER,
        "linkToken" VARCHAR(64) NOT NULL UNIQUE,
        "linkIndex" INTEGER NOT NULL DEFAULT 0,
        "linkLabel" VARCHAR(255),
        "linkText" VARCHAR(512),
        "templateSection" VARCHAR(64),
        "linkType" VARCHAR(32) NOT NULL,
        "destinationUrlRedacted" TEXT,
        "destinationUrlHost" VARCHAR(255),
        "destinationUrlPath" VARCHAR(512),
        "destinationUrlHash" VARCHAR(64),
        "signedDestinationToken" VARCHAR(64),
        "isTrackingEnabled" BOOLEAN NOT NULL DEFAULT TRUE,
        "isSensitive" BOOLEAN NOT NULL DEFAULT FALSE,
        "expiresAt" TIMESTAMP(3)
    )`,
    `CREATE TABLE email_suppression (
        id SERIAL PRIMARY KEY,
        "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW(),
        recipient VARCHAR(320) NOT NULL UNIQUE,
        reason VARCHAR(32) NOT NULL,
        note TEXT,
        "channelId" INTEGER
    )`,
    `CREATE TABLE customer (
        id SERIAL PRIMARY KEY,
        "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
        "deletedAt" TIMESTAMP,
        "emailAddress" VARCHAR(255) NOT NULL
    )`,
    `CREATE TABLE "order" (
        id SERIAL PRIMARY KEY,
        "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
        code VARCHAR(255) NOT NULL,
        "customerId" INTEGER
    )`,
    `CREATE TABLE order_channels_channel (
        "orderId" INTEGER NOT NULL,
        "channelId" INTEGER NOT NULL,
        PRIMARY KEY ("orderId", "channelId")
    )`,
    `CREATE TABLE channel (
        id SERIAL PRIMARY KEY,
        code VARCHAR(255) NOT NULL,
        token VARCHAR(255) NOT NULL
    )`,
    `CREATE TABLE hulo_licence_store (
        pluginid VARCHAR(128) PRIMARY KEY,
        licencekey TEXT NOT NULL,
        updatedat TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
];

const SEED = [
    `INSERT INTO email_log (type, recipient, subject, "channelId", "customerId", "orderId", "orderCode", status, "smtpMessageId", "openCount", "clickCount")
     VALUES ('order-confirmation', 'a@example.com', 'Order confirmation for #ABCDEFGHIJ12', 1, 1, 1, 'ABCDEFGHIJ12', 'sent', 'msg-1@example.com', 2, 1),
            ('password-reset', 'b@example.com', 'Reset your password', 2, NULL, NULL, NULL, 'bounced', 'msg-2@example.com', 0, 0),
            ('order-confirmation', 'a@example.com', 'Order confirmation for #ABCDEFGHIJ12', 1, 1, 1, 'ABCDEFGHIJ12', 'failed', NULL, 0, 0)`,
    `INSERT INTO email_link ("emailLogId", "linkToken", "linkType", "destinationUrlHost", "expiresAt")
     VALUES (1, REPEAT('a', 64), 'order_view', 'shop.example.com', NOW() - INTERVAL '1 day')`,
    `INSERT INTO email_suppression (recipient, reason, note, "channelId") VALUES ('dead@example.com', 'hard-bounce', 'seed', 1)`,
    `INSERT INTO customer ("emailAddress") VALUES ('a@example.com')`,
    `INSERT INTO "order" (code, "customerId") VALUES ('ABCDEFGHIJ12', 1)`,
    `INSERT INTO order_channels_channel ("orderId", "channelId") VALUES (1, 1), (1, 2)`,
    `INSERT INTO channel (code, token) VALUES ('__default_channel__', '1'), ('second', '2')`,
    `INSERT INTO hulo_licence_store (pluginid, licencekey) VALUES ('vendure-plugin-email-tracking:signing-secret', 'secret')`,
    `INSERT INTO email_event ("emailLogId", "orderId", "customerId", "channelId", type, source, "occurredAt", "messageId", "providerMessageId", "dedupeKey")
     VALUES (1, 1, 1, 1, 'sent', 'smtp', NOW() - INTERVAL '2 hours', 'msg-1@example.com', 'queue-1', NULL),
            (1, 1, 1, 1, 'open', 'pixel', NOW() - INTERVAL '1 hour', NULL, NULL, NULL),
            (1, 1, 1, 1, 'bounced', 'sendgrid', NOW(), 'msg-1@example.com', NULL, REPEAT('d', 64))`,
    `UPDATE email_event SET classification = 'machine_likely', "classificationReasons" = 'gmail-proxy' WHERE type = 'open'`,
];

/** Stand-in for a `${expr}` interpolation inside an SQL template literal. */
function standIn(expr: string): string {
    const e = expr.trim();
    if (/^(w|\w*Clause)$/.test(e)) return ' WHERE `customerId` = ? AND recipient LIKE ? AND `createdAt` >= ?';
    // The shared fragments of send-attempts.ts, as they are.
    if (/^(columns|ATTEMPT_COLUMNS)$/.test(e)) return ATTEMPT_COLUMNS;
    if (e === 'SENDING_SQL') return SENDING_SQL;
    if (e === 'UNKNOWN_SQL') return UNKNOWN_SQL;
    if (e === 'UNSETTLED_SQL') return UNSETTLED_SQL;
    if (e === 'NO_OUTCOME_SQL') return NO_OUTCOME_SQL;
    if (e === 'ACCEPTED_SQL') return ACCEPTED_SQL;
    // relatedAttempts: one window per recipient (two here).
    if (e === 'windows') return '(recipient = ? AND `createdAt` >= ? AND `createdAt` <= ?) OR (recipient = ? AND `createdAt` >= ? AND `createdAt` <= ?)';
    if (/^where$/.test(e)) return '`createdAt` < DATE_SUB(NOW(), INTERVAL ? DAY)';
    if (/^table$/.test(e)) return 'email_log';
    if (/RETENTION_BATCH/.test(e)) return '5000';
    if (/^marks$/.test(e)) return '?, ?, ?, ?, ?';
    if (/channelId/.test(e)) return ' AND `channelId` = ?';
    throw new Error(`pg-corpus: no stand-in for interpolation \${${e}} — add one to standIn()`);
}

/** Split a VALUES list on top-level commas (NOW() and friends keep their parentheses). */
function splitTopLevel(list: string): string[] {
    const out: string[] = [];
    let depth = 0; let cur = ''; let inSingle = false;
    for (const ch of list) {
        if (ch === "'") inSingle = !inSingle;
        if (!inSingle && ch === '(') depth++;
        if (!inSingle && ch === ')') depth--;
        if (!inSingle && depth === 0 && ch === ',') { out.push(cur); cur = ''; continue; }
        cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out.map(v => v.trim());
}

/** A value of the column's type for each `?` of an INSERT … (cols) VALUES (…); null when not that shape. */
function insertParams(sql: string): any[] | null {
    const m = /^INSERT\s+(?:IGNORE\s+)?INTO\s+\S+\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]*)\)\s*$/i.exec(sql.trim());
    if (!m) return null;
    const cols = m[1].split(',').map(c => c.trim().replace(/[`"]/g, ''));
    const vals = splitTopLevel(m[2]);
    if (cols.length !== vals.length) throw new Error(`pg-corpus: ${cols.length} columns but ${vals.length} values in ${sql}`);
    const out: any[] = [];
    cols.forEach((c, i) => {
        if (vals[i] !== '?') return;
        if (/At$/.test(c)) out.push(new Date());
        else if (/^is[A-Z]/.test(c)) out.push(true);
        else if (/(Id|Index|Count)$/.test(c)) out.push(1);
        else out.push('x');
    });
    return out;
}

/** Bind a plausible value for each `?`, judged from the SQL just before it. */
function paramsFor(sql: string): any[] {
    const fromInsert = insertParams(sql);
    if (fromInsert) return fromInsert;
    const out: any[] = [];
    let inSingle = false;
    for (let i = 0; i < sql.length; i++) {
        const ch = sql[i];
        if (ch === "'") inSingle = !inSingle;
        if (ch !== '?' || inSingle) continue;
        const before = sql.slice(Math.max(0, i - 48), i);
        if (/INTERVAL\s*$/i.test(before)) out.push(30);
        else if (/OFFSET\s*$/i.test(before)) out.push(0);
        else if (/LIMIT\s*$/i.test(before)) out.push(10);
        else if (/(At`?|NOW\(\))\s*(>=|>)\s*$/.test(before)) out.push(new Date('2000-01-01T00:00:00Z'));
        else if (/(At`?|NOW\(\))\s*(<=|<)\s*$/.test(before)) out.push(new Date('2100-01-01T00:00:00Z'));
        else if (/(At`?|NOW\(\))\s*(=|,)\s*$/.test(before)) out.push(new Date());
        else if (/LIKE\s*$/i.test(before)) out.push('%example%');
        else if (/\(recipient\s*=\s*$/.test(before)) out.push('a@example.com'); // relatedAttempts' windows: a seeded recipient
        else if (/(code|token|recipient|smtpMessageId`?|emailAddress`?\))\s*=\s*(LOWER\()?\s*$/i.test(before)) out.push('1');
        else out.push('1');
    }
    return out;
}

interface Stmt { file: string; sql: string; }

/** String literals (template, single- and double-quoted) in one TS source,
 *  found with a small scanner so escaped quotes and backticks inside other
 *  strings and comments cannot derail it (a regex does). Template literals
 *  keep their `${expr}` interpolations verbatim. */
function scanLiterals(src: string): string[] {
    const out: string[] = [];
    let i = 0;
    const n = src.length;
    const readQuoted = (q: string): string => {
        // src[i] === q
        let j = i + 1;
        let buf = '';
        while (j < n && src[j] !== q) {
            if (src[j] === '\\') { buf += src[j + 1] === q || src[j + 1] === '`' ? src[j + 1] : src[j] + src[j + 1]; j += 2; continue; }
            if (q !== '`' && src[j] === '\n') break;
            buf += src[j]; j++;
        }
        i = j + 1;
        return buf;
    };
    const readTemplate = (): string => {
        let j = i + 1;
        let buf = '';
        while (j < n && src[j] !== '`') {
            if (src[j] === '\\') { buf += src[j + 1] === '`' || src[j + 1] === '$' ? src[j + 1] : src[j] + src[j + 1]; j += 2; continue; }
            if (src[j] === '$' && src[j + 1] === '{') {
                // Copy the interpolation verbatim, skipping strings inside it.
                let depth = 1; let k = j + 2; let expr = '';
                while (k < n && depth > 0) {
                    const c = src[k];
                    if (c === "'" || c === '"') {
                        const q = c; let m = k + 1; let inner = '';
                        while (m < n && src[m] !== q) { if (src[m] === '\\') { inner += src[m + 1] === '`' ? '`' : src[m] + src[m + 1]; m += 2; continue; } inner += src[m]; m++; }
                        expr += q + inner + q; k = m + 1; continue;
                    }
                    if (c === '{') depth++;
                    if (c === '}') { depth--; if (depth === 0) { k++; break; } }
                    expr += c; k++;
                }
                buf += '${' + expr + '}';
                j = k; continue;
            }
            buf += src[j]; j++;
        }
        i = j + 1;
        return buf;
    };
    while (i < n) {
        const c = src[i];
        if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
        if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
        if (c === "'" || c === '"') { out.push(readQuoted(c)); continue; }
        if (c === '`') { out.push(readTemplate()); continue; }
        i++;
    }
    return out;
}

/** Every string literal in src/**.ts that is a whole SQL statement. */
function extractCorpus(dir: string): Stmt[] {
    const out: Stmt[] = [];
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'));
    for (const f of files) {
        for (const lit of scanLiterals(fs.readFileSync(path.join(dir, f), 'utf8'))) {
            const trimmed = lit.trim();
            // A real statement, not a route path or a keyword quoted in a comment.
            if (!/^(SELECT\s+\S|INSERT\s+(IGNORE\s+)?INTO\s|UPDATE\s+\S+\s+SET\s|DELETE\s+FROM\s|CREATE\s+TABLE\s|ALTER\s+TABLE\s)/i.test(trimmed)) continue;
            const sql = trimmed.replace(/\$\{([^}]*)\}/g, (_all, expr) => standIn(expr));
            out.push({ file: f, sql });
        }
    }
    return out;
}

describe.skipIf(!PG_URL)('Postgres SQL corpus (HULO_PG_URL)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Client } = require('pg');
    const client = new Client({ connectionString: PG_URL });
    const raw = {
        options: { type: 'postgres' },
        query: async (sql: string, params?: any[]) => (await client.query(sql, params)).rows,
    };
    const adapter = createDbAdapter(raw);
    const corpus = extractCorpus(path.join(__dirname));

    beforeAll(async () => {
        await client.connect();
        for (const s of DDL) await client.query(s);
        for (const s of SEED) await client.query(s);
    }, 30_000);

    afterAll(async () => { await client.end(); });

    it(`finds the statements (${corpus.length})`, () => {
        expect(corpus.length).toBeGreaterThanOrEqual(18);
    });

    it('leaves no MySQL-ism behind after translation', () => {
        for (const { file, sql } of corpus) {
            const t = translateSql(sql, 'postgres');
            expect(t, `${file}: ${sql}`).not.toMatch(/`|\bDATE_SUB\b|\bDATE_ADD\b|INSERT\s+IGNORE|ON\s+DUPLICATE|\bIF\s*\(|GROUP_CONCAT|AUTO_INCREMENT|\bDATETIME\b/i);
            expect(t.replace(/'(?:[^']|'')*'/g, ''), `${file}: unnumbered placeholder in ${sql}`).not.toContain('?');
        }
    });

    it('executes every statement and keeps camelCase aliases on result rows', async () => {
        const failures: string[] = [];
        for (const { file, sql } of corpus) {
            const params = paramsFor(sql);
            const isRead = /^SELECT/i.test(sql);
            await client.query('BEGIN');
            try {
                const res = await adapter.query(sql, params, isRead ? undefined : { needAffected: true });
                if (isRead) {
                    expect(Array.isArray(res), `${file}: ${sql}`).toBe(true);
                    const aliases = Array.from(sql.matchAll(/\bAS\s+`?([A-Za-z_][A-Za-z0-9_]*)`?/g)).map(m => m[1]).filter(a => /[A-Z]/.test(a) && /[a-z]/.test(a));
                    for (const row of res as any[]) {
                        for (const a of aliases) expect(row, `${file}: alias ${a} lost in ${sql}`).toHaveProperty(a);
                    }
                    if (/^SELECT\s+id,\s+`createdAt`/i.test(sql) || /GROUP BY (status|type)/i.test(sql)) {
                        expect((res as any[]).length, `${file}: expected seed rows for ${sql}`).toBeGreaterThan(0);
                    }
                }
            } catch (e: any) {
                failures.push(`${file}: ${e?.message}\n    ${sql.replace(/\s+/g, ' ').slice(0, 220)}`);
            } finally {
                await client.query('ROLLBACK');
            }
        }
        expect(failures, failures.join('\n')).toEqual([]);
    }, 60_000);

    it('runs the composed retention deletes for every table (batchedDelete)', async () => {
        const db = { query: (sql: string, params?: any[], opts?: any) => adapter.query(sql, params, opts) };
        const cases: Array<[any, string, any[]]> = [
            ['email_log', '`createdAt` < DATE_SUB(NOW(), INTERVAL ? DAY)', [365]],
            ['email_link', '`expiresAt` IS NOT NULL AND `expiresAt` < NOW()', []],
            ['email_event', '`createdAt` < DATE_SUB(NOW(), INTERVAL ? DAY)', [1]],
            ['email_event', '`emailLogId` < ?', [2]],
        ];
        const deleted: number[] = [];
        for (const [table, where, params] of cases) {
            await client.query('BEGIN');
            try { deleted.push(await batchedDelete(db, table, where, params, 0)); } finally { await client.query('ROLLBACK'); }
        }
        // Seed: no year-old email; one expired link; events created just now (their occurredAt is older,
        // but retention cuts on createdAt), so the age cut removes none and the id cut all three of email #1.
        expect(deleted).toEqual([0, 1, 0, 3]);
    }, 30_000);

    it('retention through a TypeORM DataSource (DELETE results are [rows, count] there): 12 000 old events, all pruned', async () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { DataSource } = require('typeorm');
        const ds = new DataSource({ type: 'postgres', url: PG_URL, entities: [], synchronize: false, logging: false });
        await ds.initialize();
        try {
            await ds.query(`DELETE FROM email_event WHERE source = 'volume'`);
            await ds.query(`INSERT INTO email_event ("createdAt", "updatedAt", type, source, "occurredAt")
                            SELECT NOW() - INTERVAL '40 days', NOW(), 'open', 'volume', NOW() - INTERVAL '40 days' FROM generate_series(1, 12000)`);
            const db = createDbAdapter(ds);
            const deleted = await batchedDelete(db, 'email_event', "source = 'volume' AND `createdAt` < DATE_SUB(NOW(), INTERVAL ? DAY)", [30], 0);
            expect(deleted).toBe(12_000);
            const [{ n }] = await ds.query(`SELECT COUNT(*)::int AS n FROM email_event WHERE source = 'volume'`);
            expect(n).toBe(0);
        } finally {
            await ds.query(`DELETE FROM email_event WHERE source = 'volume'`).catch(() => undefined);
            await ds.destroy();
        }
    }, 60_000);

    it('the per-email daily cap counts that email\'s rows of the type since midnight UTC, bare-id and signed ones apart', async () => {
        const svc = new EmailEventService({ rawConnection: raw } as any);
        await client.query('BEGIN');
        try {
            const today = new Date();
            const midnight = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
            const yesterday = new Date(midnight.getTime() - 3600_000);
            const add = (at: Date, cls: string | null, type = 'open', log = 77) => client.query(
                `INSERT INTO email_event ("emailLogId", type, source, "occurredAt", classification) VALUES ($1, $2, 'pixel', $3, $4)`, [log, type, at, cls]);
            for (let i = 0; i < 3; i++) await add(new Date(midnight.getTime() + 60_000 * (i + 1)), 'human_likely');
            await add(new Date(midnight.getTime() + 120_000), null); // a cap marker counts with the signed rows
            for (let i = 0; i < 2; i++) await add(new Date(midnight.getTime() + 180_000), 'unverified');
            await add(yesterday, 'human_likely');
            await add(new Date(midnight.getTime() + 60_000), 'human_likely', 'click');
            await add(new Date(midnight.getTime() + 60_000), 'human_likely', 'open', 78);
            const count = (unsigned: boolean, type: 'open' | 'click' = 'open') => (svc as any).countEngagement(77, type, unsigned, midnight);
            expect(await count(false)).toBe(4);
            expect(await count(true)).toBe(2);
            expect(await count(false, 'click')).toBe(1);
        } finally {
            await client.query('ROLLBACK');
        }
    }, 30_000);

    it('the SMTP reply changes the status only from the optimistic `sent`', async () => {
        const db = createDbAdapter(raw);
        for (const [current, after] of [['sent', 'deferred'], ['bounced', 'bounced'], ['delivered', 'delivered'], ['complained', 'complained']]) {
            await client.query('BEGIN');
            try {
                const { rows } = await client.query(`INSERT INTO email_log (type, recipient, subject, status) VALUES ('t', 'p@example.com', 's', $1) RETURNING id`, [current]);
                await db.query("UPDATE email_log SET status = ? WHERE id = ? AND status = 'sent'", ['deferred', rows[0].id], { needAffected: true });
                expect((await client.query('SELECT status FROM email_log WHERE id = $1', [rows[0].id])).rows[0].status).toBe(after);
            } finally {
                await client.query('ROLLBACK');
            }
        }
    }, 30_000);

    it('the boot clock check sees a database session in another time zone', async () => {
        const db = createDbAdapter(raw);
        const query = (sql: string) => db.query(sql);
        await client.query("SET TIME ZONE 'Asia/Kathmandu'"); // UTC+05:45 all year
        try {
            const processOffset = -new Date().getTimezoneOffset();
            expect(await databaseClockSkewMinutes(query, 'postgres')).toBe(345 - processOffset);
        } finally {
            await client.query('RESET TIME ZONE');
        }
        const sameZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        await client.query(`SET TIME ZONE '${sameZone.replace(/'/g, '')}'`);
        try {
            expect(await databaseClockSkewMinutes(query, 'postgres')).toBe(0);
        } finally {
            await client.query('RESET TIME ZONE');
        }
    }, 30_000);

    it('the send windows read the database session\'s clock, as the timestamps it writes read back', async () => {
        const db = createDbAdapter(raw);
        const query = (sql: string, params?: any[]) => db.query(sql, params);
        await client.query("SET TIME ZONE 'Asia/Kathmandu'"); // UTC+05:45 all year
        try {
            const processOffset = -new Date().getTimezoneOffset();
            expect(Math.round((await databaseNow(query, 'postgres') - Date.now()) / 60_000)).toBe(345 - processOffset);
        } finally {
            await client.query('RESET TIME ZONE');
        }
    }, 30_000);

    it('the guarded status UPDATE gives exactly nextStatus() for every current × incoming pair', async () => {
        const svc = new EmailEventService({ rawConnection: raw } as any);
        const all = Object.keys(STATUS_RANK) as Array<keyof typeof STATUS_RANK>;
        const wrong: string[] = [];
        for (const current of all) {
            for (const incoming of all) {
                await client.query('BEGIN');
                try {
                    const { rows } = await client.query(`INSERT INTO email_log (type, recipient, subject, status) VALUES ('t', 'p@example.com', 's', $1) RETURNING id`, [current]);
                    await svc.applyStatus(rows[0].id, incoming, 'reason');
                    const after = (await client.query('SELECT status FROM email_log WHERE id = $1', [rows[0].id])).rows[0].status;
                    if (after !== nextStatus(current, incoming)) wrong.push(`${current} + ${incoming} → ${after}`);
                    const drop = statusChangeForEvent('dropped', null)!;
                    await client.query('UPDATE email_log SET status = $1 WHERE id = $2', [current, rows[0].id]);
                    await svc.applyStatus(rows[0].id, drop, 'Unsubscribed Address');
                    const afterDrop = (await client.query('SELECT status FROM email_log WHERE id = $1', [rows[0].id])).rows[0].status;
                    if (afterDrop !== applyStatusChange(current, drop)) wrong.push(`${current} + non-address drop → ${afterDrop}`);
                } finally {
                    await client.query('ROLLBACK');
                }
            }
        }
        expect(wrong).toEqual([]);
    }, 60_000);
});
