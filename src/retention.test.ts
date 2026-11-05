import { describe, expect, it, vi } from 'vitest';

// TypeORM entities need emitted decorator metadata, which the test transform does not produce.
vi.mock('./email-log.entity', () => ({ EmailLog: class EmailLog {} }));
vi.mock('./email-suppression.entity', () => ({ EmailSuppression: class EmailSuppression {} }));
import { batchedDelete, RETENTION_BATCH } from './email-tracking.service';

describe('batchedDelete', () => {
    /** A table of ids 1..n; SELECT returns the next batch of the ones still there, DELETE removes up to the given id. */
    function fakeTable(n: number, deleteResult: any = [[], 2]) {
        let rows = Array.from({ length: n }, (_v, i) => i + 1);
        const calls: Array<{ sql: string; params: any[] }> = [];
        const db = {
            query: async (sql: string, params: any[] = []) => {
                calls.push({ sql, params });
                if (sql.startsWith('SELECT')) return rows.slice(0, RETENTION_BATCH).map(id => ({ id }));
                const upTo = params[0];
                rows = rows.filter(id => id > upTo);
                // What TypeORM's DataSource.query hands back for a DELETE on Postgres: [rows, rowCount] — useless as a count.
                return deleteResult;
            },
        };
        return { db, calls, left: () => rows.length };
    }

    it('selects then deletes batch by batch until no full batch is left, counting the rows it selected', async () => {
        const t = fakeTable(RETENTION_BATCH * 2 + 1234);
        const total = await batchedDelete(t.db, 'email_log', '`createdAt` < DATE_SUB(NOW(), INTERVAL ? DAY)', [365], 0);
        expect(total).toBe(RETENTION_BATCH * 2 + 1234);
        expect(t.left()).toBe(0);
        expect(t.calls.filter(c => c.sql.startsWith('DELETE'))).toHaveLength(3);
        expect(t.calls[0]).toEqual({ sql: `SELECT id FROM email_log WHERE \`createdAt\` < DATE_SUB(NOW(), INTERVAL ? DAY) ORDER BY id ASC LIMIT ${RETENTION_BATCH}`, params: [365] });
        expect(t.calls[1].sql).toBe('DELETE FROM email_log WHERE id <= ? AND (`createdAt` < DATE_SUB(NOW(), INTERVAL ? DAY))');
        expect(t.calls[1].params).toEqual([RETENTION_BATCH, 365]);
    });

    it('does not trust the driver\'s affected-rows figure (TypeORM on Postgres reports 2 for every DELETE)', async () => {
        const t = fakeTable(12_000, { affectedRows: 2 });
        expect(await batchedDelete(t.db, 'email_event', '`createdAt` < DATE_SUB(NOW(), INTERVAL ? DAY)', [30], 0)).toBe(12_000);
        expect(t.left()).toBe(0);
    });

    it('stops after one SELECT when nothing is left', async () => {
        const t = fakeTable(0);
        expect(await batchedDelete(t.db, 'email_link', '`expiresAt` < NOW()', [], 0)).toBe(0);
        expect(t.calls).toHaveLength(1);
    });
});

describe('sweepRetention', () => {
    it('with maxRows, unlinked events older than the oldest email kept go too; events keep at least 3 days', async () => {
        const { EmailTrackingService } = await import('./email-tracking.service');
        const { setOptions } = await import('./options');
        const calls: Array<{ sql: string; params: any[] }> = [];
        const oldest = new Date('2026-10-01T00:00:00Z');
        const conn: any = {
            rawConnection: {
                options: { type: 'mysql' },
                query: async (sql: string, params: any[] = []) => {
                    calls.push({ sql, params });
                    if (/^SELECT COUNT\(\*\) AS n FROM email_log/.test(sql)) return [{ n: 10 }];
                    if (/^SELECT id FROM email_log ORDER BY id ASC LIMIT 1 OFFSET/.test(sql)) return [{ id: 8 }];
                    if (/^SELECT `createdAt` FROM email_log/.test(sql)) return [{ createdAt: oldest }];
                    return [];
                },
            },
        };
        const svc = new EmailTrackingService(conn, { isWorker: true } as any, {} as any);
        setOptions({ publicBaseUrl: 'https://shop.example.com', retention: { days: 1, maxRows: 3 } });
        await svc.sweepRetention();
        const selects = calls.filter(c => /^SELECT id FROM email_event/.test(c.sql));
        expect(selects.map(c => [c.sql.replace(/ ORDER BY.*$/, ''), c.params])).toEqual([
            ['SELECT id FROM email_event WHERE `createdAt` < DATE_SUB(NOW(), INTERVAL ? DAY)', [3]],
            ['SELECT id FROM email_event WHERE `emailLogId` < ?', [8]],
            ['SELECT id FROM email_event WHERE `emailLogId` IS NULL AND `createdAt` < ?', [oldest]],
        ]);
    });
});
