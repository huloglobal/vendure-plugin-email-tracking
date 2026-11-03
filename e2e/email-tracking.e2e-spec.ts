import { mergeConfig, TransactionalConnection } from '@vendure/core';
import { createTestEnvironment, E2E_DEFAULT_CHANNEL_TOKEN, registerInitializer, SqljsInitializer, testConfig } from '@vendure/testing';
import * as path from 'path';
import { initialData } from '../../../e2e-shared/initial-data';
import { EmailLog } from '../src/email-log.entity';
import { EmailTrackingPlugin } from '../src/plugin';
import { EmailTrackingService } from '../src/email-tracking.service';
import { getOptions } from '../src/options';
import { signValue } from '@huloglobal/vendure-licence-sdk';
import gql from 'graphql-tag';

registerInitializer('sqljs', new SqljsInitializer(path.join(__dirname, '__data__')));

const PORT = 3060;

describe('@huloglobal/vendure-plugin-email-tracking', () => {
    const config = mergeConfig(testConfig, {
        apiOptions: { port: PORT },
        plugins: [
            EmailTrackingPlugin.init({
                publicBaseUrl: `http://localhost:${PORT}`,
                signingSecret: 'e2e-signing-secret',
            }),
        ],
    });
    const { server, adminClient } = createTestEnvironment(config);

    beforeAll(async () => {
        await server.init({ initialData, productsCsvPath: '', customerCount: 0 } as any);
    }, 60_000);

    afterAll(async () => {
        await server.destroy();
    });

    it('boots, exposes EmailTrackingService, and EmailLog table is queryable', async () => {
        const tracking = (server as any).app.get(EmailTrackingService);
        expect(tracking).toBeDefined();
        const conn: TransactionalConnection = (server as any).app.get(TransactionalConnection);
        const repo = conn.rawConnection.getRepository(EmailLog);
        const count = await repo.count();
        expect(count).toBe(0);
    });

    it('always serves the 1×1 GIF but does not record opens when unlicensed', async () => {
        // Two contracts verified on this unlicensed instance:
        //   1. The pixel is ALWAYS served (200, real GIF bytes) so emails
        //      never show a broken image and we never leak whether the id
        //      or signature was valid.
        //   2. Open tracking is a paid feature — without a licence the open
        //      must NOT be recorded (openCount stays 0). This is the gate
        //      that makes the plugin commercially viable.
        const conn: TransactionalConnection = (server as any).app.get(TransactionalConnection);
        const repo = conn.rawConnection.getRepository(EmailLog);
        const row = await repo.save(repo.create({
            type: 'test',
            recipient: 'a@b.test',
            subject: 'hi',
            fromAddress: 'from@test.local',
            status: 'sent',
            tracked: true,
            channelId: 1,
            openCount: 0,
            clickCount: 0,
        } as Partial<EmailLog>));

        const res = await fetch(`http://localhost:${PORT}/email-track/open/${row.id}.gif`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/gif');
        const body = Buffer.from(await res.arrayBuffer());
        expect(body.length).toBeGreaterThan(20);
        // No-store so privacy prefetchers are re-counted per fetch once licensed.
        expect(res.headers.get('cache-control')).toContain('no-store');

        // recordOpen() is fire-and-forget; give it a moment, then confirm the
        // licence gate held — nothing was recorded.
        await new Promise(r => setTimeout(r, 150));
        const reloaded = await repo.findOne({ where: { id: row.id } });
        expect(reloaded?.openCount).toBe(0);
        expect(JSON.parse(reloaded?.opensJson || '[]')).toHaveLength(0);
    });

    it('rejects click redirect to invalid url and accepts a valid one', async () => {
        const conn: TransactionalConnection = (server as any).app.get(TransactionalConnection);
        const repo = conn.rawConnection.getRepository(EmailLog);
        const row = await repo.save(repo.create({
            type: 'test', recipient: 'c@d.test', subject: 'click', fromAddress: 'from@test.local',
            status: 'sent', tracked: true, channelId: 1, openCount: 0, clickCount: 0,
        } as Partial<EmailLog>));

        const bad = await fetch(`http://localhost:${PORT}/email-track/click/${row.id}?u=javascript:alert(1)`);
        expect(bad.status).toBe(400);

        // A bare (unsigned, legacy) id may only redirect to the shop's own hosts (since 0.14.2).
        const foreign = await fetch(`http://localhost:${PORT}/email-track/click/${row.id}?u=${encodeURIComponent('https://example.com/p')}`, { redirect: 'manual' });
        expect(foreign.status).toBe(400);

        const own = `http://localhost:${PORT}/products/p`;
        const good = await fetch(`http://localhost:${PORT}/email-track/click/${row.id}?u=${encodeURIComponent(own)}`, { redirect: 'manual' });
        expect([301, 302, 303, 307, 308]).toContain(good.status);
        expect(good.headers.get('location')).toBe(own);

        // An unknown per-link token (64-hex) is refused rather than redirected.
        const unknown = await fetch(`http://localhost:${PORT}/email-track/click/${'a'.repeat(64)}?u=${encodeURIComponent(own)}&s=00`, { redirect: 'manual' });
        expect(unknown.status).toBe(404);
    });

    // Security 0.15.3: a signed `<id>.<hmac>` token used to authenticate only the
    // email, not the destination, so any recipient could point `u` anywhere.
    it('does not let a signed email-log token redirect to a destination it was not issued for', async () => {
        const conn: TransactionalConnection = (server as any).app.get(TransactionalConnection);
        const repo = conn.rawConnection.getRepository(EmailLog);
        const row = await repo.save(repo.create({
            type: 'test', recipient: 'e@f.test', subject: 'signed', fromAddress: 'from@test.local',
            status: 'sent', tracked: true, channelId: 1, openCount: 0, clickCount: 0,
        } as Partial<EmailLog>));
        const secret = getOptions().signingSecret;
        expect(secret).toBeTruthy();
        const token = signValue(String(row.id), secret!);
        const evil = await fetch(`http://localhost:${PORT}/email-track/click/${token}?u=${encodeURIComponent('https://evil.example/phish')}`, { redirect: 'manual' });
        expect(evil.status).toBe(400);
        expect(evil.headers.get('location')).toBeNull();

        // A link the plugin actually rewrote still reaches its (external) destination...
        const tracking: EmailTrackingService = (server as any).app.get(EmailTrackingService);
        const html = tracking.wrapHtml('<a href="https://partner.example/offer?a=1&amp;b=2">x</a>', Number(row.id));
        const href = /href="([^"]+)"/.exec(html)![1];
        const ok = await fetch(href, { redirect: 'manual' });
        expect(ok.status).toBe(302);
        expect(ok.headers.get('location')).toBe('https://partner.example/offer?a=1&b=2');
        // ...but swapping its `u` for another URL is refused.
        const swapped = new URL(href);
        swapped.searchParams.set('u', 'https://evil.example/phish');
        const bad = await fetch(swapped.toString(), { redirect: 'manual' });
        expect(bad.status).toBe(400);
        // Emails sent before 0.15.3 (signed id, no `s`) still reach the shop's own hosts.
        const own = `http://localhost:${PORT}/products/p`;
        const legacy = await fetch(`http://localhost:${PORT}/email-track/click/${token}?u=${encodeURIComponent(own)}`, { redirect: 'manual' });
        expect(legacy.status).toBe(302);
        expect(legacy.headers.get('location')).toBe(own);
    });

    // Security 0.15.3: the log list was channel-scoped but the single-row reads were not.
    it('does not show a channel admin an email logged on another channel', async () => {
        await adminClient.asSuperAdmin();
        const zones: any = await adminClient.query(gql`query { zones { items { id } } }`);
        const zoneId = zones.zones.items[0].id;
        const ch: any = await adminClient.query(gql`mutation($input: CreateChannelInput!) { createChannel(input: $input) { ... on Channel { id } } }`, {
            input: { code: 'second', token: 'second-token', defaultLanguageCode: 'en', pricesIncludeTax: true, defaultCurrencyCode: 'GBP', defaultShippingZoneId: zoneId, defaultTaxZoneId: zoneId },
        });
        const role: any = await adminClient.query(gql`mutation($input: CreateRoleInput!) { createRole(input: $input) { id } }`, {
            input: { code: 'ch2-reader', description: 'ch2 reader', permissions: ['ReadCustomer'], channelIds: [ch.createChannel.id] },
        });
        await adminClient.query(gql`mutation($input: CreateAdministratorInput!) { createAdministrator(input: $input) { id } }`, {
            input: { firstName: 'C', lastName: 'Two', emailAddress: 'ch2@test.local', password: 'ch2-pass', roleIds: [role.createRole.id] },
        });

        const conn: TransactionalConnection = (server as any).app.get(TransactionalConnection);
        const repo = conn.rawConnection.getRepository(EmailLog);
        const row = await repo.save(repo.create({
            type: 'test', recipient: 'secret@default.test', subject: 'default channel only', fromAddress: 'from@test.local',
            status: 'sent', tracked: true, channelId: 1, openCount: 0, clickCount: 0,
        } as Partial<EmailLog>));

        await adminClient.asUserWithCredentials('ch2@test.local', 'ch2-pass');
        adminClient.setChannelToken('second-token');
        try {
            const r: any = await adminClient.query(gql`query($id: ID!) { huloEmailLog(id: $id) { id recipient } }`, { id: String(row.id) });
            expect(r.huloEmailLog).toBeNull();
            const rest = await adminClient.fetch(`http://localhost:${PORT}/email-track/log/${row.id}`);
            expect(rest.status).toBe(404);
        } finally {
            adminClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
            await adminClient.asSuperAdmin();
        }
        // The default-channel admin still sees it.
        const r2: any = await adminClient.query(gql`query($id: ID!) { huloEmailLog(id: $id) { id recipient } }`, { id: String(row.id) });
        expect(r2.huloEmailLog.recipient).toBe('secret@default.test');
    });
});
