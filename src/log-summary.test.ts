import { describe, expect, it, vi } from 'vitest';

// Entities need emitted decorator metadata, which the test transform does not produce.
vi.mock('./email-log.entity', () => ({ EmailLog: class EmailLog {} }));
vi.mock('./email-suppression.entity', () => ({ EmailSuppression: class EmailSuppression {} }));
vi.mock('./email-link.entity', () => ({ EmailLink: class EmailLink {} }));
vi.mock('./email-event.entity', () => ({ EmailEvent: class EmailEvent {} }));
vi.mock('./plugin', () => ({ EmailTrackingPlugin: { getUpdateChecker: () => null, getPackageName: () => 'x', getPackageVersion: () => '0' } }));
import { EmailTrackingController } from './email-tracking.controller';
import { setOptions } from './options';

function fakeRes() {
    return { statusCode: 200, body: undefined as any, status(c: number) { this.statusCode = c; return this; }, json(b: any) { this.body = b; return this; }, setHeader() { /* */ } };
}
const admin: any = { activeUserId: 1, channelId: 1, channel: { code: '__default_channel__' }, userHasPermissions: () => true };

describe('GET /email-track/log/summary and the status filter', () => {
    it('returns every status and a total over all of them (delivered and suppressed included)', async () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com' });
        const rows = [
            { status: 'sent', n: 3, opens: 2, clicks: 1 }, { status: 'delivered', n: 5, opens: 4, clicks: 0 },
            { status: 'failed', n: 2, opens: 0, clicks: 0 }, { status: 'bounced', n: 8, opens: 0, clicks: 0 },
            { status: 'suppressed', n: 1, opens: 0, clicks: 0 },
        ];
        const conn: any = { rawConnection: { options: { type: 'mysql' }, query: async () => rows } };
        const c = new EmailTrackingController(conn, {} as any, {} as any);
        const res = fakeRes();
        await c.logSummary(admin, { query: {} } as any, res as any);
        expect(res.body).toMatchObject({ total: 19, sent: 3, delivered: 5, failed: 2, deferred: 0, bounced: 8, complained: 0, suppressed: 1, opens: 6, clicks: 1, fromDays: 30 });
    });

    it('?status=sent,delivered filters on both; a bad value is a 400', async () => {
        const seen: any[] = [];
        const conn: any = { rawConnection: { options: { type: 'mysql' }, query: async (sql: string, params: any[]) => { seen.push({ sql, params }); return /COUNT/.test(sql) ? [{ total: 0 }] : []; } } };
        const c = new EmailTrackingController(conn, {} as any, {} as any);
        const res = fakeRes();
        await c.listLog(admin, { query: { status: 'sent,delivered' } } as any, res as any);
        expect(seen[0].sql).toContain('status IN (?, ?)');
        expect(seen[0].params.slice(0, 2)).toEqual(['sent', 'delivered']);
        const one = fakeRes();
        await c.listLog(admin, { query: { status: 'bounced' } } as any, one as any);
        expect(seen[2].sql).toContain('WHERE status = ?');
        const bad = fakeRes();
        await c.listLog(admin, { query: { status: 'x'.repeat(40) } } as any, bad as any);
        expect(bad.statusCode).toBe(400);
    });
});
