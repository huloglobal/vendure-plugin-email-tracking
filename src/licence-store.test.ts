import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./email-log.entity', () => ({ EmailLog: class EmailLog {} }));
vi.mock('./email-suppression.entity', () => ({ EmailSuppression: class EmailSuppression {} }));
vi.mock('./email-link.entity', () => ({ EmailLink: class EmailLink {} }));
vi.mock('./email-event.entity', () => ({ EmailEvent: class EmailEvent {} }));
vi.mock('./plugin', () => ({ EmailTrackingPlugin: { activateRuntimeLicence: vi.fn(), getUpdateChecker: () => null, getPackageName: () => 'x', getPackageVersion: () => '0' } }));

import { EmailTrackingController } from './email-tracking.controller';
import { EmailTrackingPlugin } from './plugin';

/**
 * On PostgreSQL the licence SDK rewrites `ON DUPLICATE KEY UPDATE` as
 * `ON CONFLICT (...) DO UPDATE`, using the conflict columns that
 * `LicenceStore.save` passes as the query function's third argument. The
 * controller's wrapper dropped that argument (0.16.0 and earlier), so
 * activating a key in the admin applied it, answered 500 and never stored it.
 */
function postgres() {
    const rows = new Map<string, string>();
    const upserts: string[] = [];
    const rawConnection = {
        options: { type: 'postgres' },
        async query(sql: string, params: any[] = []) {
            if (sql.startsWith('INSERT INTO hulo_licence_store')) {
                upserts.push(sql);
                rows.set(params[0], params[1]);
            }
            return [];
        },
    };
    return { connection: { rawConnection } as any, rows, upserts };
}

function fakeRes() {
    const res: any = {
        statusCode: 200,
        body: undefined as unknown,
        status(code: number) { res.statusCode = code; return res; },
        json(body: unknown) { res.body = body; return res; },
        setHeader() { return res; },
    };
    return res;
}

const superAdmin: any = { activeUserId: 1, userHasPermissions: () => true };

afterEach(() => vi.clearAllMocks());

describe('licence key store on PostgreSQL', () => {
    it('activating a key in the admin stores it with an ON CONFLICT upsert', async () => {
        (EmailTrackingPlugin.activateRuntimeLicence as any).mockReturnValue({ valid: true, message: 'Licensed' });
        const db = postgres();
        const res = fakeRes();
        await new EmailTrackingController(db.connection, {} as any, {} as any).licenceActivate(superAdmin, res, { key: 'a.licence.key' });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ licensed: true, message: 'Licensed' });
        expect(db.upserts).toEqual([expect.stringContaining('ON CONFLICT (pluginId) DO UPDATE SET')]);
        expect(db.rows.get('vendure-plugin-email-tracking')).toBe('a.licence.key');
    });
});
