// Must stay the first import: it points the licence SDK away from the live server.
import './local-licence-env';
import { mergeConfig, TransactionalConnection } from '@vendure/core';
import { createTestEnvironment, MysqlInitializer, registerInitializer, testConfig } from '@vendure/testing';
import { createHmac } from 'crypto';
import * as nodemailer from 'nodemailer';
import { signValue } from '@huloglobal/vendure-licence-sdk';
import { initialData } from '../../../e2e-shared/initial-data';
import { EmailLog } from '../src/email-log.entity';
import { EmailEvent } from '../src/email-event.entity';
import { EmailSuppression } from '../src/email-suppression.entity';
import { EmailTrackingPlugin } from '../src/plugin';
import { EmailTrackingService } from '../src/email-tracking.service';
import { getOptions, setLicenceStatus } from '../src/options';
import { resetStoredPrefs, trackingSwitches } from '../src/tracking-settings';

/**
 * The 0.17.0 features on real MariaDB (the dialect production runs; the main
 * suite runs on sql.js, where the SDK's shared prefs table cannot be written).
 * Skipped unless credentials are given:
 *   ET_E2E_DB_HOST ET_E2E_DB_PORT ET_E2E_DB_USER ET_E2E_DB_PASS
 * Database `hulo_et_e2e` (dropped and recreated each run).
 */
const DB = process.env.ET_E2E_DB_HOST
    ? { host: process.env.ET_E2E_DB_HOST, port: Number(process.env.ET_E2E_DB_PORT || 3306),
        username: process.env.ET_E2E_DB_USER || 'root', password: process.env.ET_E2E_DB_PASS || '' }
    : null;
const PORT = Number(process.env.ET_MARIA_E2E_PORT || 3166);
const BASE = `http://localhost:${PORT}`;
const run = DB ? describe : describe.skip;

run('@huloglobal/vendure-plugin-email-tracking 0.17.0 (MariaDB)', () => {
    registerInitializer('mysql', new MysqlInitializer());
    const config = mergeConfig(testConfig, {
        apiOptions: { port: PORT },
        dbConnectionOptions: {
            type: 'mysql' as const, host: DB!.host, port: DB!.port,
            username: DB!.username, password: DB!.password, database: 'hulo_et_e2e', synchronize: true,
        },
        plugins: [EmailTrackingPlugin.init({ publicBaseUrl: BASE, signingSecret: 'et-maria-secret', bounceWebhookSecret: 'et-maria-bounce' })],
    });
    const { server, adminClient } = createTestEnvironment(config);
    const svc = () => (server as any).app.get(EmailTrackingService) as EmailTrackingService;
    const conn = () => (server as any).app.get(TransactionalConnection) as TransactionalConnection;
    const logs = () => conn().rawConnection.getRepository(EmailLog);
    const stream = () => nodemailer.createTransport({ streamTransport: true, buffer: true });
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    const until = async (cond: () => Promise<boolean>, ms = 5000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) { if (await cond()) return; await sleep(50); }
        throw new Error('condition not met');
    };

    beforeAll(async () => {
        await server.init({ initialData, productsCsvPath: '', customerCount: 0 } as any);
        setLicenceStatus({ valid: false, message: 'e2e: free tier' } as any);
        await adminClient.asSuperAdmin();
    }, 120_000);
    afterAll(async () => { resetStoredPrefs(); await server.destroy(); });

    it('the tracking settings persist in hulo_plugin_prefs and stop open recording at once', async () => {
        const save = (body: any) => adminClient.fetch(`${BASE}/email-track/settings`, { method: 'POST', body: JSON.stringify(body) });
        expect(await (await save({ trackOpens: false, trustedProxies: '10.0.0.0/8' })).json()).toMatchObject({ trackOpens: false, trustedProxies: ['10.0.0.0/8'] });
        const rows: any[] = await conn().rawConnection.query(
            "SELECT prefKey, prefValue FROM hulo_plugin_prefs WHERE pluginId = 'vendure-plugin-email-tracking' AND prefKey LIKE 'tracking.%' ORDER BY prefKey");
        expect(rows.map(r => [r.prefKey, r.prefValue])).toEqual([['tracking.opens', 'off'], ['tracking.trustedProxies', '10.0.0.0/8']]);
        // Another process picks them up from the table.
        resetStoredPrefs();
        expect(trackingSwitches().opens).toBe(true);
        await svc().refreshSettings();
        expect(trackingSwitches().opens).toBe(false);
        const row = await logs().save(logs().create({ type: 't', recipient: 'p@example.com', subject: 's', fromAddress: 'f@x', status: 'sent', tracked: true, channelId: 1 } as Partial<EmailLog>));
        await fetch(`${BASE}/email-track/open/${signValue(String(row.id), getOptions().signingSecret!)}.gif`, { headers: { 'user-agent': 'Mozilla/5.0 (X11) AppleWebKit/537.36 Chrome/120 Safari/537.36' } });
        await sleep(200);
        expect((await logs().findOne({ where: { id: row.id } }))!.openCount).toBe(0);
        await save({ trackOpens: true, trustedProxies: '' });
        expect(trackingSwitches().opens).toBe(true);
    });

    it('free tier: a person\'s open counts, a scanner\'s goes to machineCount', async () => {
        const row = await logs().save(logs().create({ type: 't', recipient: 'q@example.com', subject: 's', fromAddress: 'f@x', status: 'sent', tracked: true, channelId: 1 } as Partial<EmailLog>));
        const token = signValue(String(row.id), getOptions().signingSecret!);
        await fetch(`${BASE}/email-track/open/${token}.gif`, { headers: { 'user-agent': 'Mozilla/5.0 (X11) AppleWebKit/537.36 Chrome/120 Safari/537.36' } });
        await fetch(`${BASE}/email-track/open/${token}.gif`, { headers: { 'user-agent': 'curl/8.4.0' } });
        await until(async () => { const r = await logs().findOne({ where: { id: row.id } }); return r!.openCount === 1 && r!.machineCount === 1; });
    });

    it('suppression at send, strict per-recipient bounces, and privacy export / erase', async () => {
        await svc().addSuppression('Gone <GONE@example.com>', 'manual');
        expect(await conn().rawConnection.getRepository(EmailSuppression).findOne({ where: { recipient: 'gone@example.com' } })).toBeTruthy();
        const blocked = await svc().sendTracked(stream(), { from: 's@x.com', to: 'gone@example.com', subject: 's', html: '<p>x</p>' }, { type: 'promo' });
        expect(blocked.status).toBe('suppressed');
        const sent = await svc().sendTracked(stream(), { from: 's@x.com', to: 'a@example.com, b@example.com', subject: 's', html: '<p>x</p>' }, { type: 'order-confirmation' });
        const body = JSON.stringify({ messageId: sent.smtpMessageId, status: 'bounced', bounceType: 'hard', recipient: 'b@example.com' });
        const r = await fetch(`${BASE}/email-track/bounce`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': createHmac('sha256', 'et-maria-bounce').update(body).digest('hex') }, body });
        expect(await r.json()).toMatchObject({ matched: true, suppressed: 1 });
        expect(await svc().suppressedAmong(['a@example.com', 'b@example.com'])).toEqual(['b@example.com']);

        const exp = await svc().privacyExport('B@example.com');
        expect(exp!.emails.map(e => e.id)).toEqual([Number(sent.id)]);
        expect(exp!.suppression).toMatchObject({ recipient: 'b@example.com', reason: 'hard-bounce' });
        const erased = await svc().privacyErase('b@example.com');
        expect(erased).toMatchObject({ emails: 1, suppressionRetained: true });
        expect(erased!.events).toBeGreaterThan(0);
        expect(await logs().findOne({ where: { id: sent.id } })).toBeNull();
        expect(await conn().rawConnection.getRepository(EmailEvent).count({ where: { emailLogId: Number(sent.id) } })).toBe(0);
    });

    it('the weekly report stays off without premium; its settings are kept', async () => {
        await svc().digest.updateSettings({ recipient: 'ops@example.com' });
        expect(await svc().digest.tick(new Date(Date.now() + 30 * 86_400_000))).toBe(false);
        expect((await svc().digestSettings()).recipient).toBe('ops@example.com');
        const widget = await (await adminClient.fetch(`${BASE}/email-track/widget`)).json();
        expect(widget.stats.find((s: any) => s.label === 'Failed or bounced')).toBeTruthy();
    });
});
