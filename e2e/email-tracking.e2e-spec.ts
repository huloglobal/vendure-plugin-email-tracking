// Must stay the first import: it points the licence SDK away from the live server.
import { E2E_PORT } from './local-licence-env';
import { LanguageCode, mergeConfig, PaymentMethodHandler, TransactionalConnection } from '@vendure/core';
import { createTestEnvironment, E2E_DEFAULT_CHANNEL_TOKEN, registerInitializer, SqljsInitializer, testConfig } from '@vendure/testing';
import { createHmac, generateKeyPairSync, sign } from 'crypto';
import { inflateSync } from 'zlib';
import * as nodemailer from 'nodemailer';
import * as path from 'path';
import { initialData } from '../../../e2e-shared/initial-data';
import { EmailLog } from '../src/email-log.entity';
import { EmailEvent } from '../src/email-event.entity';
import { EmailSuppression } from '../src/email-suppression.entity';
import { EmailTrackingPlugin } from '../src/plugin';
import { EmailTrackingService } from '../src/email-tracking.service';
import { getOptions, setLicenceStatus } from '../src/options';
import { applyStoredPrefs, resetStoredPrefs } from '../src/tracking-settings';
import { signValue } from '@huloglobal/vendure-licence-sdk';
import gql from 'graphql-tag';

registerInitializer('sqljs', new SqljsInitializer(path.join(__dirname, '__data__')));

const PORT = E2E_PORT;
const BASE = `http://localhost:${PORT}`;

// Provider webhook credentials for this run (generated, never real).
const sendgridKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const SENDGRID_KEY = sendgridKeys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const MAILGUN_KEY = 'e2e-mailgun-signing-key';
const POSTMARK = { username: 'pm-hooks', password: 'pm-secret' };

/** Settles every payment at once, so the order gets real payment history. */
const testPaymentHandler = new PaymentMethodHandler({
    code: 'et-e2e-payment',
    description: [{ languageCode: LanguageCode.en, value: 'E2E payment' }],
    args: {},
    createPayment: (_ctx, _order, amount) => ({ amount, state: 'Settled' as const, transactionId: 'et-e2e-tx' }),
    settlePayment: () => ({ success: true }),
});

describe('@huloglobal/vendure-plugin-email-tracking', () => {
    const config = mergeConfig(testConfig, {
        apiOptions: { port: PORT },
        paymentOptions: { paymentMethodHandlers: [testPaymentHandler] },
        plugins: [
            EmailTrackingPlugin.init({
                publicBaseUrl: `http://localhost:${PORT}`,
                signingSecret: 'e2e-signing-secret',
                providerWebhooks: { postmark: POSTMARK, sendgrid: { verificationKey: SENDGRID_KEY }, mailgun: { signingKey: MAILGUN_KEY }, recordEngagement: true },
            }),
        ],
    });
    const { server, adminClient, shopClient } = createTestEnvironment(config);

    beforeAll(async () => {
        await server.init({ initialData, productsCsvPath: '', customerCount: 0 } as any);
    }, 60_000);

    afterAll(async () => {
        setLicenceStatus({ valid: false, message: 'e2e done' } as any);
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

    it('always serves the 1×1 GIF, and records opens in the free tier (0.17.0) — never a bare id, never a bot as an open', async () => {
        // 1. The pixel is ALWAYS served (200, real GIF bytes) so emails never
        //    show a broken image and we never leak whether the id was valid.
        // 2. Open recording is free since 0.17.0: a signed open counts on this
        //    unlicensed instance; a bare id while a secret exists is an event
        //    only; a machine fetch is counted in machineCount, not openCount.
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
        expect(res.headers.get('cache-control')).toContain('no-store');
        await new Promise(r => setTimeout(r, 150));
        expect((await repo.findOne({ where: { id: row.id } }))?.openCount).toBe(0); // bare id: event only

        const token = signValue(String(row.id), getOptions().signingSecret!);
        await fetch(`http://localhost:${PORT}/email-track/open/${token}.gif`, { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' } });
        await fetch(`http://localhost:${PORT}/email-track/open/${token}.gif`, { headers: { 'user-agent': 'python-requests/2.31' } });
        const deadline = Date.now() + 5000;
        let reloaded = await repo.findOne({ where: { id: row.id } });
        while (Date.now() < deadline && !((reloaded?.openCount ?? 0) >= 1 && (reloaded?.machineCount ?? 0) >= 1)) {
            await new Promise(r => setTimeout(r, 50));
            reloaded = await repo.findOne({ where: { id: row.id } });
        }
        expect(reloaded?.openCount).toBe(1);
        expect(reloaded?.machineCount).toBe(1);
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
    // ── 0.16.0: provider webhooks, the event timeline, order activity ────────

    const conn = () => (server as any).app.get(TransactionalConnection) as TransactionalConnection;
    const num = (id: string | number) => Number(String(id).replace(/^T_/, ''));
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    /** Clicks are recorded after the redirect has been sent: wait for the row instead of guessing a delay. */
    const until = async (cond: () => Promise<boolean>, ms = 5000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) { if (await cond()) return; await sleep(25); }
        throw new Error('timed out waiting for the recording');
    };
    /** The text of every content stream of a PDF from the built-in writer. */
    const pdfText = (buf: Buffer) => {
        const s = buf.toString('latin1');
        const out: string[] = [];
        const re = /<< \/Length (\d+)( \/Filter \/FlateDecode)? >>\nstream\n/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(s))) {
            const data = buf.subarray(m.index + m[0].length, m.index + m[0].length + Number(m[1]));
            out.push(m[2] ? inflateSync(data).toString('latin1') : data.toString('latin1'));
        }
        return out.join('\n');
    };
    const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
    const hook = (provider: string, body: string, headers: Record<string, string> = {}) =>
        fetch(`${BASE}/email-track/webhook/${provider}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
    const mailgunBody = (ts: number, token: string, eventData: any) => JSON.stringify({
        signature: { timestamp: String(ts), token, signature: createHmac('sha256', MAILGUN_KEY).update(String(ts) + token).digest('hex') },
        'event-data': eventData,
    });
    const sendgridSigned = (body: string) => {
        const ts = String(Math.floor(Date.now() / 1000));
        const sig = sign('sha256', Buffer.concat([Buffer.from(ts), Buffer.from(body)]), { key: sendgridKeys.privateKey, dsaEncoding: 'der' }).toString('base64');
        return { 'x-twilio-email-event-webhook-signature': sig, 'x-twilio-email-event-webhook-timestamp': ts };
    };

    it('provider webhooks: unknown slug 404; unconfigured provider or bad credentials 401 with an empty body', async () => {
        expect((await hook('nope', '{}')).status).toBe(404);
        const ses = await hook('ses', JSON.stringify({ Type: 'Notification' }), { 'content-type': 'text/plain; charset=UTF-8' });
        expect(ses.status).toBe(401);
        expect(await ses.text()).toBe('');
        // Nothing tells a provider that is not configured (ses) from one that is (sendgrid): same 401 and headers, same body checks.
        const headersOf = (r: Response) => { const out: string[] = []; r.headers.forEach((v, k) => { if (k !== 'date') out.push(`${k}: ${v}`); }); return out.sort(); };
        const badSg = await hook('sendgrid', '[]', { 'x-twilio-email-event-webhook-signature': 'AAAA', 'x-twilio-email-event-webhook-timestamp': '1' });
        const offSes = await hook('ses', '{}');
        expect([badSg.status, offSes.status]).toEqual([401, 401]);
        expect(headersOf(offSes)).toEqual(headersOf(badSg));
        expect(offSes.headers.get('connection')).toBe('close');
        for (const [slug, type] of [['ses', 'application/x-www-form-urlencoded'], ['sendgrid', 'application/x-www-form-urlencoded'], ['mailgun', 'text/plain']]) {
            expect([slug, type, (await hook(slug, '{}', { 'content-type': type })).status]).toEqual([slug, type, 415]);
        }
        const pm = await hook('postmark', JSON.stringify({ RecordType: 'Bounce' }), { authorization: basic('pm-hooks', 'wrong') });
        expect(pm.status).toBe(401);
        expect(await pm.text()).toBe('');
        expect((await hook('postmark', JSON.stringify({ RecordType: 'Bounce' }))).status).toBe(401);
        expect((await hook('sendgrid', '[]', { 'x-twilio-email-event-webhook-signature': 'AAAA', 'x-twilio-email-event-webhook-timestamp': '1' })).status).toBe(401);
        const stale = Math.floor(Date.now() / 1000) - 3600;
        expect((await hook('mailgun', mailgunBody(stale, 'tok-stale', { event: 'delivered', id: 'x' }))).status).toBe(401);
        // Accepted, nothing to record: a Postmark record type the timeline does not use.
        expect((await hook('postmark', JSON.stringify({ RecordType: 'Inbound' }), { authorization: basic('pm-hooks', 'pm-secret') })).status).toBe(204);
    });

    let order: { id: number; code: string; customerId: number };

    it('sets up a real order: checkout, settled payment and a private note in Vendure history', async () => {
        await adminClient.asSuperAdmin();
        const { taxCategories } = await adminClient.query(gql`{ taxCategories { items { id } } }`);
        if (!taxCategories.items.length) await adminClient.query(gql`mutation { createTaxCategory(input: { name: "Standard", isDefault: true }) { id } }`);
        const { createProduct } = await adminClient.query(gql`mutation {
            createProduct(input: { enabled: true, translations: [{ languageCode: en, name: "ET e2e key", slug: "et-e2e-key", description: "" }] }) { id }
        }`);
        const { createProductVariants } = await adminClient.query(gql`mutation ($productId: ID!) {
            createProductVariants(input: [{ productId: $productId, sku: "ET-E2E", price: 1250, trackInventory: FALSE, stockOnHand: 100, translations: [{ languageCode: en, name: "ET e2e key" }] }]) { id }
        }`, { productId: createProduct.id });
        const { createShippingMethod } = await adminClient.query(gql`mutation {
            createShippingMethod(input: {
                code: "et-e2e-ship", fulfillmentHandler: "manual-fulfillment",
                checker: { code: "default-shipping-eligibility-checker", arguments: [{ name: "orderMinimum", value: "0" }] },
                calculator: { code: "default-shipping-calculator", arguments: [{ name: "rate", value: "0" }, { name: "includesTax", value: "auto" }, { name: "taxRate", value: "0" }] },
                translations: [{ languageCode: en, name: "E2E delivery" }]
            }) { id }
        }`);
        await adminClient.query(gql`mutation {
            createPaymentMethod(input: { code: "et-e2e-payment", enabled: true, translations: [{ languageCode: en, name: "E2E payment" }], handler: { code: "et-e2e-payment", arguments: [] } }) { id }
        }`);
        await shopClient.asAnonymousUser();
        const add = await shopClient.query(gql`mutation ($id: ID!) { addItemToOrder(productVariantId: $id, quantity: 1) { ... on Order { id code } ... on ErrorResult { errorCode message } } }`, { id: createProductVariants[0].id });
        expect(add.addItemToOrder.code).toBeTruthy();
        await shopClient.query(gql`mutation { setCustomerForOrder(input: { emailAddress: "buyer@example.com", firstName: "Bea", lastName: "Buyer" }) { ... on Order { id } ... on ErrorResult { errorCode message } } }`);
        await shopClient.query(gql`mutation { setOrderShippingAddress(input: { fullName: "Bea Buyer", streetLine1: "1 High St", city: "London", postalCode: "SW1A 1AA", countryCode: "GB" }) { ... on Order { id } } }`);
        await shopClient.query(gql`mutation ($id: [ID!]!) { setOrderShippingMethod(shippingMethodId: $id) { ... on Order { id } ... on ErrorResult { errorCode message } } }`, { id: [createShippingMethod.id] });
        const t = await shopClient.query(gql`mutation { transitionOrderToState(state: "ArrangingPayment") { ... on Order { id state } ... on OrderStateTransitionError { errorCode message transitionError } } }`);
        expect(t.transitionOrderToState.state).toBe('ArrangingPayment');
        const paid = await shopClient.query(gql`mutation { addPaymentToOrder(input: { method: "et-e2e-payment", metadata: {} }) { ... on Order { id code state customer { id } } ... on ErrorResult { errorCode message } } }`);
        expect(paid.addPaymentToOrder.state).toBe('PaymentSettled');
        order = { id: num(paid.addPaymentToOrder.id), code: paid.addPaymentToOrder.code, customerId: num(paid.addPaymentToOrder.customer.id) };
        await adminClient.query(gql`mutation ($id: ID!) { addNoteToOrder(input: { id: $id, note: "Customer called about delivery", isPublic: false }) { id } }`, { id: paid.addPaymentToOrder.id });
    }, 60_000);

    it('order activity endpoints need a session and are premium (402 unlicensed)', async () => {
        expect((await fetch(`${BASE}/email-track/orders/${order.id}/activity`)).status).toBe(401);
        await adminClient.asSuperAdmin();
        const r = await adminClient.fetch(`${BASE}/email-track/orders/${order.id}/activity`);
        expect(r.status).toBe(402);
        expect((await r.json()).error).toBe('premium-feature');
        expect((await adminClient.fetch(`${BASE}/email-track/orders/${order.id}/evidence-link`, { method: 'POST' })).status).toBe(402);
    });

    let emailA: EmailLog;

    it('records the send, a classified pixel open and a click (with link index and text, token redacted)', async () => {
        setLicenceStatus({ valid: true, message: 'e2e licence' } as any);
        const tracking: EmailTrackingService = (server as any).app.get(EmailTrackingService);
        const html = `<html><body><p>Thanks!</p><a href="https://partner.example/offer?a=1&amp;b=2">See the <b>offer</b></a>`
            + `<a href="${BASE}/account/reset?token=abc123">Reset your password</a></body></html>`;
        emailA = await tracking.sendTracked(nodemailer.createTransport({ streamTransport: true, buffer: true }),
            { from: 'shop@example.com', to: 'buyer@example.com', subject: `Order confirmation for #${order.code}`, html },
            { type: 'order-confirmation', orderId: order.id, orderCode: order.code, customerId: order.customerId, channelId: 1 });
        expect(emailA.status).toBe('sent');
        const events = () => conn().rawConnection.getRepository(EmailEvent).find({ where: { emailLogId: Number(emailA.id) }, order: { id: 'ASC' } });
        const sent = (await events())[0];
        expect(sent).toMatchObject({ type: 'sent', source: 'smtp', orderId: order.id, customerId: order.customerId });
        expect(sent.messageId).toBe(emailA.smtpMessageId);
        expect(JSON.parse(sent.payload!).links).toHaveLength(2);

        const token = signValue(String(emailA.id), getOptions().signingSecret!);
        const px = await fetch(`${BASE}/email-track/open/${token}.gif`, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)' } });
        expect(px.status).toBe(200);
        const hrefs = [...tracking.wrapHtml(html, Number(emailA.id)).matchAll(/href="([^"]+)"/g)].map(m => m[1]);
        const c1 = await fetch(hrefs[0], { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' } });
        expect(c1.status).toBe(302);
        expect(c1.headers.get('location')).toBe('https://partner.example/offer?a=1&b=2');
        const clicksJsonLength = async () => JSON.parse((await conn().rawConnection.getRepository(EmailLog).findOne({ where: { id: emailA.id } }))!.clicksJson || '[]').length;
        await until(async () => (await clicksJsonLength()) === 1);
        const c2 = await fetch(hrefs[1], { redirect: 'manual' });
        expect(c2.headers.get('location')).toBe(`${BASE}/account/reset?token=abc123`); // the redirect keeps the real URL
        await until(async () => (await clicksJsonLength()) === 2);
        await sleep(100);

        const all = await events();
        const open = all.find(e => e.type === 'open')!;
        expect(open).toMatchObject({ source: 'pixel', classification: 'machine_likely', client: 'Gmail (prefetch)', isBot: true });
        expect(open.classificationReasons).toContain('gmail-proxy');
        expect(open.ip).toMatch(/^[0-9a-f]{32}$/); // hashIpsInHistory (default)
        const clicks = all.filter(e => e.type === 'click');
        expect(clicks.map(c => [c.linkIndex, c.linkText])).toEqual([[0, 'See the offer'], [1, 'Reset your password']]);
        expect(clicks[0].classification).toBe('human_likely');
        expect(clicks[1].url).toBe(`${BASE}/account/reset?[redacted]`);
        const row = await conn().rawConnection.getRepository(EmailLog).findOne({ where: { id: emailA.id } });
        expect(row!.openCount).toBe(1);
        expect(row!.clickCount).toBe(2);
        expect(JSON.parse(row!.clicksJson).map((c: any) => c.url)).toEqual(['https://partner.example/offer?a=1&b=2', `${BASE}/account/reset?[redacted]`]);
    });

    it('a signed SendGrid bounce (exact raw body): event row, status bounced, suppression; a retry is a no-op', async () => {
        const body = JSON.stringify([{
            email: 'buyer@example.com', timestamp: Math.floor(Date.now() / 1000), 'smtp-id': `<${emailA.smtpMessageId}>`, event: 'bounce', type: 'bounce',
            sg_event_id: 'e2e-sg-bounce-1', sg_message_id: 'q1.filter0001', reason: '550 5.1.1 The email account does not exist', status: '5.1.1',
        }], null, 2); // pretty-printed: only the exact bytes verify
        const headers = sendgridSigned(body);
        expect((await hook('sendgrid', body, headers)).status).toBe(204);
        expect((await hook('sendgrid', body, headers)).status).toBe(204); // provider retry
        expect((await hook('sendgrid', body.replace('5.1.1 The', '5.1.1 Tampered'), headers)).status).toBe(401);
        const bounces = await conn().rawConnection.getRepository(EmailEvent).find({ where: { emailLogId: Number(emailA.id), type: 'bounced' } });
        expect(bounces).toHaveLength(1);
        expect(bounces[0]).toMatchObject({ source: 'sendgrid', orderId: order.id });
        expect(bounces[0].dedupeKey).toMatch(/^[0-9a-f]{64}$/);
        const row = await conn().rawConnection.getRepository(EmailLog).findOne({ where: { id: emailA.id } });
        expect(row!.status).toBe('bounced');
        expect(row!.errorMessage).toContain('550 5.1.1');
        const sup = await conn().rawConnection.getRepository(EmailSuppression).findOne({ where: { recipient: 'buyer@example.com' } });
        expect(sup?.reason).toBe('hard-bounce');
    });

    it('a signed Mailgun delivered event is recorded but never overrides the bounce; its token cannot be replayed', async () => {
        const ts = Math.floor(Date.now() / 1000);
        const body = mailgunBody(ts, 'e2e-mailgun-tok-1', {
            event: 'delivered', id: 'e2e-mg-delivered-1', timestamp: ts, recipient: 'buyer@example.com',
            message: { headers: { 'message-id': emailA.smtpMessageId } }, 'delivery-status': { code: 250, message: 'OK' },
        });
        expect((await hook('mailgun', body)).status).toBe(204);
        expect((await hook('mailgun', body)).status).toBe(401); // replayed token
        const delivered = await conn().rawConnection.getRepository(EmailEvent).find({ where: { emailLogId: Number(emailA.id), type: 'delivered' } });
        expect(delivered).toHaveLength(1);
        expect((await conn().rawConnection.getRepository(EmailLog).findOne({ where: { id: emailA.id } }))!.status).toBe('bounced');
    });

    it('correlation: the sender adds a signed id for configured providers; events link by it, or by the provider id from the SMTP reply', async () => {
        const tracking: EmailTrackingService = (server as any).app.get(EmailTrackingService);
        let captured: any = null;
        const fakeSmtp: any = { sendMail: async (m: any) => { captured = m; return { messageId: '<corr-e2e@shop>', response: '250 2.0.0 Ok: queued as QCORR123' }; } };
        const email = await tracking.sendTracked(fakeSmtp, { from: 'shop@example.com', to: 'corr@example.com', subject: 'Receipt', html: '<p>Hi</p>' },
            { type: 'receipt', orderId: order.id, orderCode: order.code, channelId: 1 });
        expect(captured.headers['X-SMTPAPI'].prepared).toBe(true); // sent as raw JSON, never RFC 2047-encoded
        const smtpapi = JSON.parse(captured.headers['X-SMTPAPI'].value);
        expect(smtpapi.unique_args['hulo-log-id']).toMatch(new RegExp(`^${email.id}-[0-9a-f]{16}$`));
        expect(captured.headers['X-Mailgun-Variables']).toBeDefined();
        expect(captured.headers['X-PM-Metadata-hulo-log-id']).toBe(smtpapi.unique_args['hulo-log-id']);
        expect(captured.headers['X-SES-MESSAGE-TAGS']).toBeUndefined(); // SES is not configured in this run
        const sent = await conn().rawConnection.getRepository(EmailEvent).findOne({ where: { emailLogId: Number(email.id), type: 'sent' } });
        expect(sent!.providerMessageId).toBe('QCORR123');

        const ts = Math.floor(Date.now() / 1000);
        const delivered = JSON.stringify([{ email: 'corr@example.com', timestamp: ts, event: 'delivered', sg_event_id: 'e2e-corr-1', response: '250 OK', 'hulo-log-id': smtpapi.unique_args['hulo-log-id'] }]);
        expect((await hook('sendgrid', delivered, sendgridSigned(delivered))).status).toBe(204);
        expect((await conn().rawConnection.getRepository(EmailLog).findOne({ where: { id: email.id } }))!.status).toBe('delivered');
        // A value signed by another install is ignored; the SendGrid id (queue id prefix) still links it.
        const deferred = JSON.stringify([{ email: 'corr@example.com', timestamp: ts, event: 'deferred', sg_event_id: 'e2e-corr-2', sg_message_id: 'QCORR123.filterdrecv-1-2', response: '421 try later', 'hulo-log-id': `${email.id}-0123456789abcdef` }]);
        expect((await hook('sendgrid', deferred, sendgridSigned(deferred))).status).toBe(204);
        const ev = await conn().rawConnection.getRepository(EmailEvent).findOne({ where: { type: 'deferred', source: 'sendgrid', emailLogId: Number(email.id) } });
        expect(ev).not.toBeNull();
        expect((await conn().rawConnection.getRepository(EmailLog).findOne({ where: { id: email.id } }))!.status).toBe('delivered'); // never back to deferred
    });

    it('a provider bounce that lands while the SMTP call is still in flight is never overwritten by its reply', async () => {
        const tracking: EmailTrackingService = (server as any).app.get(EmailTrackingService);
        for (const [n, reply] of [[1, '250 2.0.0 Ok: queued as QRACE1'], [2, '451 4.7.1 Try again later']] as const) {
            // The correlation header makes the event linkable at once: SendGrid reports the bounce before our write of the reply.
            const racing: any = {
                sendMail: async (m: any) => {
                    const corr = JSON.parse(m.headers['X-SMTPAPI'].value).unique_args['hulo-log-id'];
                    const body = JSON.stringify([{ email: `send-race${n}@example.com`, timestamp: Math.floor(Date.now() / 1000), event: 'bounce', type: 'bounce', sg_event_id: `e2e-send-race-${n}`, reason: '550 5.1.1 unknown user', status: '5.1.1', 'hulo-log-id': corr }]);
                    expect((await hook('sendgrid', body, sendgridSigned(body))).status).toBe(204);
                    return { messageId: `<send-race-${n}@shop>`, response: reply };
                },
            };
            const email = await tracking.sendTracked(racing, { from: 'shop@example.com', to: `send-race${n}@example.com`, subject: 'Race', html: '<p>x</p>' }, { type: 'receipt', channelId: 1 });
            expect(email.status).toBe('bounced');
            const row = await conn().rawConnection.getRepository(EmailLog).findOne({ where: { id: email.id } });
            expect(row).toMatchObject({ status: 'bounced', smtpResponse: reply, smtpMessageId: `send-race-${n}@shop` });
            const types = (await conn().rawConnection.getRepository(EmailEvent).find({ where: { emailLogId: Number(email.id) }, order: { id: 'ASC' } })).map(e => `${e.source}:${e.type}`);
            expect(types).toEqual(['sendgrid:bounced', `smtp:${n === 1 ? 'sent' : 'deferred'}`]);
        }
    });

    it('a Postmark delivery for an unknown message is recorded unlinked, with a recipient hash only', async () => {
        const r = await hook('postmark', JSON.stringify({ RecordType: 'Delivery', MessageID: 'pm-unknown-1', Recipient: 'someone@example.com', DeliveredAt: new Date().toISOString(), Details: 'Test delivery' }),
            { authorization: basic('pm-hooks', 'pm-secret') });
        expect(r.status).toBe(204);
        const ev = await conn().rawConnection.getRepository(EmailEvent).findOne({ where: { providerMessageId: 'pm-unknown-1' } });
        expect(ev).toMatchObject({ type: 'delivered', source: 'postmark', emailLogId: null });
        expect(ev!.recipientHash).toMatch(/^[0-9a-f]{64}$/);
        expect(JSON.stringify(ev)).not.toContain('someone@example.com');
    });

    it('body gates: compressed provider bodies 415, unknown slugs 404 before any read, /bounce takes JSON only', async () => {
        const { gzipSync } = await import('zlib');
        const gz = gzipSync(Buffer.from('[]'));
        const sg = await fetch(`${BASE}/email-track/webhook/sendgrid`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: gz });
        expect(sg.status).toBe(415);
        // 5 MB of zeros, 5 KB on the wire, to an unknown slug: refused without inflating it.
        const bomb = gzipSync(Buffer.alloc(5 * 1024 * 1024));
        const t0 = Date.now();
        const unknown = await fetch(`${BASE}/email-track/webhook/unknownprov`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body: bomb });
        expect(unknown.status).toBe(404);
        expect(Date.now() - t0).toBeLessThan(2000);
        // A web page's cross-site "simple" request (text/plain) never reaches the bounce handler.
        const csrf = await fetch(`${BASE}/email-track/bounce`, { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8', origin: 'https://evil.test' }, body: '{"messageId":"x","status":"complained"}' });
        expect(csrf.status).toBe(415);
        const big = await fetch(`${BASE}/email-track/bounce`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messageId: 'x', reason: 'r'.repeat(200 * 1024) }) });
        expect(big.status).toBe(413);
    });

    it('Mailgun: concurrent requests carrying one signed token — exactly one is accepted', async () => {
        const ts = Math.floor(Date.now() / 1000);
        const bodies = [0, 1, 2, 3, 4].map(i => mailgunBody(ts, 'e2e-mailgun-race', {
            event: 'complained', id: `e2e-mg-race-${i}`, timestamp: ts, recipient: `race${i}@example.com`,
        }));
        const statuses = (await Promise.all(bodies.map(b => hook('mailgun', b)))).map(r => r.status).sort();
        expect(statuses).toEqual([204, 401, 401, 401, 401]);
        const sups = await conn().rawConnection.getRepository(EmailSuppression).find();
        expect(sups.filter(x => /^race\d@example\.com$/.test(x.recipient))).toHaveLength(1);
    });

    it('SendGrid: a drop for "Invalid SMTPAPI header" never suppresses; "Bounced Address" does', async () => {
        const ts = Math.floor(Date.now() / 1000);
        const body = JSON.stringify([
            { email: 'sg-drop-smtpapi@example.com', timestamp: ts, event: 'dropped', sg_event_id: 'e2e-drop-smtpapi', reason: 'Invalid SMTPAPI header' },
            { email: 'sg-drop-bounced@example.com', timestamp: ts, event: 'dropped', sg_event_id: 'e2e-drop-bounced', reason: 'Bounced Address' },
        ]);
        expect((await hook('sendgrid', body, sendgridSigned(body))).status).toBe(204);
        const repo = conn().rawConnection.getRepository(EmailSuppression);
        expect(await repo.findOne({ where: { recipient: 'sg-drop-smtpapi@example.com' } })).toBeNull();
        expect((await repo.findOne({ where: { recipient: 'sg-drop-bounced@example.com' } }))?.reason).toBe('hard-bounce');
    });

    it('a provider click on the wrapped reset link is stored unwrapped and redacted, with the link it was', async () => {
        const tracking: EmailTrackingService = (server as any).app.get(EmailTrackingService);
        const html = `<a href="https://partner.example/offer?a=1&amp;b=2">See the <b>offer</b></a><a href="${BASE}/account/reset?token=abc123">Reset your password</a>`;
        const tracked = [...tracking.wrapHtml(html, Number(emailA.id)).matchAll(/href="([^"]+)"/g)].map(m => m[1].replace(/&amp;/g, '&'))[1];
        expect(tracked).toContain('abc123');
        const ts = Math.floor(Date.now() / 1000);
        const body = JSON.stringify([{ email: 'buyer@example.com', timestamp: ts, event: 'click', sg_event_id: 'e2e-sg-click-reset', 'smtp-id': `<${emailA.smtpMessageId}>`, url: tracked, ip: '8.8.8.8', useragent: 'Mozilla/5.0' }]);
        expect((await hook('sendgrid', body, sendgridSigned(body))).status).toBe(204);
        const ev = await conn().rawConnection.getRepository(EmailEvent).findOne({ where: { source: 'sendgrid', type: 'click', emailLogId: Number(emailA.id) } });
        expect(ev).toMatchObject({ url: `${BASE}/account/reset?[redacted]`, linkIndex: 1, linkText: 'Reset your password' });
        expect(JSON.stringify(ev)).not.toContain('abc123');
    });

    it('order activity JSON: email events, legacy rows and Vendure history merged chronologically, with filters and cursor pages', async () => {
        // An email sent "before 0.16.0": a log row with JSON history and no event rows, created before the event timeline began
        // (since 0.16.3 only such rows are legacy; a later row without a send event is still being sent).
        const repo = conn().rawConnection.getRepository(EmailLog);
        const shipped = await repo.save(repo.create({
            type: 'shipping-update', recipient: 'buyer@example.com', subject: 'Your order shipped', fromAddress: 'shop@example.com', status: 'sent', tracked: true,
            channelId: 1, orderId: order.id, orderCode: order.code, customerId: order.customerId, openCount: 1, clickCount: 0,
            opensJson: JSON.stringify([{ ts: new Date(Date.now() - 1000).toISOString(), ip: 'abc', ua: 'Mozilla/5.0 (iPhone) AppleWebKit Mobile', client: 'Apple Mail', platform: 'iOS', isBot: false }]),
        } as Partial<EmailLog>));
        await repo.update(shipped.id, { createdAt: new Date(Date.now() - 2 * 86_400_000) } as any);
        await adminClient.asSuperAdmin();
        const res = await adminClient.fetch(`${BASE}/email-track/orders/${order.id}/activity?take=100`);
        expect(res.status).toBe(200);
        const body = await res.json();
        const types = body.items.map((i: any) => i.type);
        for (const t of ['sent', 'open', 'click', 'bounced', 'delivered', 'ORDER_STATE_TRANSITION', 'ORDER_PAYMENT_TRANSITION', 'ORDER_NOTE']) expect(types).toContain(t);
        const legacy = body.items.filter((i: any) => i.legacy);
        expect(legacy.map((i: any) => i.type).sort()).toEqual(['open', 'sent']);
        const ats = body.items.map((i: any) => Date.parse(i.at));
        expect(ats).toEqual([...ats].sort((a, b) => a - b));
        expect(body.items.find((i: any) => i.type === 'ORDER_PAYMENT_TRANSITION').detail).toMatch(/Created → Settled — [A-Z]{3} 12\.50 via et-e2e-payment/);
        expect(body.items.find((i: any) => i.type === 'ORDER_NOTE')).toMatchObject({ label: 'Note (private)', detail: 'Customer called about delivery' });
        expect(body.items.every((i: any) => i.full === undefined)).toBe(true);
        expect(body.summary.order).toMatchObject({ code: order.code, customerEmail: 'buyer@example.com', state: 'PaymentSettled' });
        // The order confirmation (a provider reported delivery, then the bounce), the receipt (delivered) and the legacy shipping update.
        expect(body.summary.emails).toMatchObject({ total: 3, sent: 3, delivered: 2, bounced: 1, opened: 2, clicked: 1 });
        expect(body.summary.opens.machine).toBeGreaterThanOrEqual(1);
        expect(body.warning).toMatch(/approximate/);

        const only = async (f: string) => (await (await adminClient.fetch(`${BASE}/email-track/orders/${order.id}/activity?filter=${f}`)).json()).items.map((i: any) => i.type);
        expect(new Set(await only('opens'))).toEqual(new Set(['open']));
        expect(await only('notes')).toEqual(['ORDER_NOTE']);
        expect((await only('order')).every((t: string) => t.startsWith('ORDER_') && t !== 'ORDER_NOTE')).toBe(true);
        expect(new Set(await only('delivery'))).toEqual(new Set(['bounced', 'delivered', 'deferred']));

        const seen: string[] = [];
        let cursor = '';
        for (let i = 0; i < 20; i++) {
            const page = await (await adminClient.fetch(`${BASE}/email-track/orders/${order.id}/activity?take=3${cursor ? `&cursor=${cursor}` : ''}`)).json();
            seen.push(...page.items.map((x: any) => x.id));
            if (i > 0) expect(page.summary).toBeUndefined();
            if (!page.hasMore) break;
            cursor = page.nextCursor;
        }
        expect(seen).toEqual(body.items.map((x: any) => x.id));
        const latest = await (await adminClient.fetch(`${BASE}/email-track/orders/${order.id}/activity?take=2&order=desc`)).json();
        expect(latest.items.map((x: any) => x.id)).toEqual(body.items.slice(-2).reverse().map((x: any) => x.id));
    });

    it('CSV export is redacted and formula-safe', async () => {
        const res = await adminClient.fetch(`${BASE}/email-track/orders/${order.id}/activity.csv`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/csv');
        const bytes = Buffer.from(await res.arrayBuffer());
        expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM: Excel reads → and — correctly
        const csv = bytes.toString('utf8').replace(/^\uFEFF/, '');
        expect(csv.split('\n')[0]).toBe('time_utc,kind,source,type,event,email_type,email_log_id,detail,classification,reasons,city,region,country,org,asn,proxy,vpn,tor,datacentre,mobile,client,platform,bot,ip_as_stored,url,link_index,link_text,actor,legacy');
        expect(csv).toContain('"ORDER_NOTE"');
        expect(csv).not.toContain('abc123');
        const clicksOnly = await adminClient.fetch(`${BASE}/email-track/orders/${order.id}/activity.csv?filter=clicks`);
        expect(clicksOnly.headers.get('content-disposition')).toMatch(/activity-clicks-\d{4}-\d{2}-\d{2}\.csv/);
    });

    it('evidence PDF: a 5-minute signed link that needs no session; tampered or re-pointed links get 403', async () => {
        const link = await (await adminClient.fetch(`${BASE}/email-track/orders/${order.id}/evidence-link`, { method: 'POST' })).json();
        expect(link.url).toMatch(new RegExp(`^/email-track/orders/${order.id}/evidence\\.pdf\\?exp=\\d+&uid=\\d+&sig=[0-9a-f]{64}$`));
        expect(Date.parse(link.expiresAt) - Date.now()).toBeLessThanOrEqual(300_000);
        const pdf = await fetch(`${BASE}${link.url}`); // no session
        expect(pdf.status).toBe(200);
        expect(pdf.headers.get('content-type')).toBe('application/pdf');
        const bytes = Buffer.from(await pdf.arrayBuffer());
        expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
        expect(bytes.subarray(-6).toString('latin1')).toBe('%%EOF\n');
        const tampered = link.url.replace(/sig=([0-9a-f])/, (_m: string, c: string) => `sig=${c === '0' ? '1' : '0'}`);
        expect((await fetch(`${BASE}${tampered}`)).status).toBe(403);
        expect((await fetch(`${BASE}${link.url.replace(`/orders/${order.id}/`, `/orders/${order.id + 1}/`)}`)).status).toBe(403);
        expect((await fetch(`${BASE}${link.url.replace(/uid=\d+/, 'uid=999')}`)).status).toBe(403);

        // The private note stays out of the report by default; its SHA-256 matches activity.json?evidence=1.
        const text = pdfText(bytes);
        expect(text).not.toContain('Customer called about delivery');
        expect(text).toContain('private note left out');
        const printed = /\(Timeline SHA-256: ([0-9a-f]{64})\) Tj/.exec(text)![1];
        const ev = await (await adminClient.fetch(`${BASE}/email-track/orders/${order.id}/activity.json?evidence=1`)).json();
        expect(ev).toMatchObject({ evidence: true, internalNotes: false, internalNotesLeftOut: 1, timelineSha256: printed });
        expect(ev.items.some((i: any) => i.type === 'ORDER_NOTE')).toBe(false);
        // The notes choice is part of the signature: it cannot be added to a standard link.
        expect((await fetch(`${BASE}${link.url.replace('&sig=', '&notes=internal&sig=')}`)).status).toBe(403);
        const withNotes = await (await adminClient.fetch(`${BASE}/email-track/orders/${order.id}/evidence-link`, { method: 'POST', body: JSON.stringify({ internalNotes: true }) })).json();
        expect(withNotes.url).toMatch(/&notes=internal&sig=[0-9a-f]{64}$/);
        const text2 = pdfText(Buffer.from(await (await fetch(`${BASE}${withNotes.url}`)).arrayBuffer()));
        expect(text2).toContain('(Customer called about delivery) Tj');
        expect(text2).toContain('(Note \\(internal\\)) Tj');
        const printed2 = /\(Timeline SHA-256: ([0-9a-f]{64})\) Tj/.exec(text2)![1];
        const ev2 = await (await adminClient.fetch(`${BASE}/email-track/orders/${order.id}/activity.json?evidence=1&internalNotes=1`)).json();
        expect(ev2.timelineSha256).toBe(printed2);
        expect(printed2).not.toBe(printed);
        // Stripping the notes flag from an internal-notes link breaks its signature too.
        expect((await fetch(`${BASE}${withNotes.url.replace('&notes=internal', '')}`)).status).toBe(403);
    });

    it('the full export needs ExportEmailEvidence (SuperAdmin has it); the redacted export does not', async () => {
        await adminClient.asSuperAdmin();
        const perms: any = await adminClient.query(gql`{ __type(name: "Permission") { enumValues { name } } }`);
        expect(perms.__type.enumValues.map((v: any) => v.name)).toContain('ExportEmailEvidence');
        const full = await adminClient.fetch(`${BASE}/email-track/orders/${order.id}/activity.json?full=1`);
        expect(full.status).toBe(200);
        const fullBody = await full.json();
        expect(fullBody.full).toBe(true);
        const ev = fullBody.items.find((i: any) => i.type === 'open' && i.kind === 'event');
        expect(ev.full.userAgent).toContain('GoogleImageProxy');
        const red = await (await adminClient.fetch(`${BASE}/email-track/orders/${order.id}/activity.json`)).json();
        expect(red.timelineSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(red.items.every((i: any) => i.full === undefined)).toBe(true);

        const role: any = await adminClient.query(gql`mutation($input: CreateRoleInput!) { createRole(input: $input) { id } }`, {
            input: { code: 'order-reader', description: 'orders, no evidence export', permissions: ['ReadOrder', 'ReadCustomer'] },
        });
        await adminClient.query(gql`mutation($input: CreateAdministratorInput!) { createAdministrator(input: $input) { id } }`, {
            input: { firstName: 'O', lastName: 'Reader', emailAddress: 'orders@test.local', password: 'orders-pass', roleIds: [role.createRole.id] },
        });
        await adminClient.asUserWithCredentials('orders@test.local', 'orders-pass');
        try {
            expect((await adminClient.fetch(`${BASE}/email-track/orders/${order.id}/activity.json`)).status).toBe(200);
            const denied = await adminClient.fetch(`${BASE}/email-track/orders/${order.id}/activity.json?full=1`);
            expect(denied.status).toBe(403);
        } finally {
            await adminClient.asSuperAdmin();
        }
    });

    it('bare (unsigned) ids: a forged hit on a signed email is not recorded; on an older email it is recorded as unsigned and counted apart', async () => {
        const logs = conn().rawConnection.getRepository(EmailLog);
        const events = conn().rawConnection.getRepository(EmailEvent);
        const before = (await logs.findOne({ where: { id: emailA.id } }))!.openCount;
        const eventsBefore = await events.count({ where: { emailLogId: Number(emailA.id), type: 'open' } });
        expect((await fetch(`${BASE}/email-track/open/${emailA.id}.gif`)).status).toBe(200); // the pixel is always served
        const forgedClick = await fetch(`${BASE}/email-track/click/${emailA.id}?u=${encodeURIComponent(`${BASE}/products/p`)}`, { redirect: 'manual' });
        expect(forgedClick.status).toBe(302); // own host: redirected, but not recorded
        await sleep(300);
        expect((await logs.findOne({ where: { id: emailA.id } }))!.openCount).toBe(before);
        expect(await events.count({ where: { emailLogId: Number(emailA.id), type: 'open' } })).toBe(eventsBefore);
        expect(await events.count({ where: { emailLogId: Number(emailA.id), type: 'click', source: 'redirect' } })).toBe(2);

        // An email with no 0.16.0 send event (sent before it): its bare id is recorded as an unverified event only —
        // anyone can enumerate ids, so the hit never moves email_log or the summary headline.
        const old = await logs.save(logs.create({
            type: 'order-confirmation', recipient: 'buyer@example.com', subject: 'Old order mail', fromAddress: 'shop@example.com', status: 'sent', tracked: true,
            channelId: 1, orderId: order.id, orderCode: order.code, customerId: order.customerId, openCount: 0, clickCount: 0,
        } as Partial<EmailLog>));
        const headline = async () => (await (await adminClient.fetch(`${BASE}/email-track/orders/${order.id}/activity?take=500`)).json()).summary;
        const headlineBefore = await headline();
        for (let i = 0; i < 3; i++) {
            expect((await fetch(`${BASE}/email-track/open/${old.id}.gif`, { headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' } })).status).toBe(200);
        }
        expect((await fetch(`${BASE}/email-track/click/${old.id}?u=${encodeURIComponent(`${BASE}/products/p`)}`, { redirect: 'manual' })).status).toBe(302);
        await until(async () => (await events.count({ where: { emailLogId: Number(old.id) } })) === 4);
        const flagged = await events.find({ where: { emailLogId: Number(old.id) }, order: { id: 'ASC' } });
        expect(flagged.map(e => [e.type, e.classification])).toEqual([['open', 'unverified'], ['open', 'unverified'], ['open', 'unverified'], ['click', 'unverified']]);
        expect(flagged.every(e => e.classificationReasons!.startsWith('unsigned-token') && e.enrichedAt === null)).toBe(true);
        const after = await logs.findOne({ where: { id: old.id } });
        expect(after).toMatchObject({ openCount: 0, clickCount: 0, firstOpenedAt: null, firstClickedAt: null, opensJson: null, clicksJson: null });
        const summary = await headline();
        expect(summary.emails).toEqual(headlineBefore.emails); // opened, first open, clicked: unchanged
        expect([summary.opens.recorded, summary.opens.human, summary.opens.machine, summary.opens.unknown])
            .toEqual([headlineBefore.opens.recorded, headlineBefore.opens.human, headlineBefore.opens.machine, headlineBefore.opens.unknown]);
        expect(summary.opens.unsigned).toBe(3);
        expect(summary.clicks.unsigned).toBe(1);
        const page = await (await adminClient.fetch(`${BASE}/email-track/orders/${order.id}/activity?take=500`)).json();
        const item = page.items.find((i: any) => i.emailLogId === Number(old.id) && i.type === 'open');
        expect(item.classification).toBe('unverified');
        expect(item.reasons).toContain('unsigned-token');
    });

    it('the Email Log: the Sent card filter covers sent and delivered; the summary counts every status', async () => {
        await adminClient.asSuperAdmin();
        const logs = conn().rawConnection.getRepository(EmailLog);
        const list = await (await adminClient.fetch(`${BASE}/email-track/log?status=sent,delivered&take=500`)).json();
        expect(list.total).toBe(await logs.count({ where: [{ status: 'sent' }, { status: 'delivered' }] as any }));
        expect(new Set(list.items.map((r: any) => r.status))).toEqual(new Set(['sent', 'delivered']));
        expect((await adminClient.fetch(`${BASE}/email-track/log?status=${'x'.repeat(40)}`)).status).toBe(400);
        // log/summary binds its period as a date (no DATE_SUB since 0.16.3), so it runs on sql.js too.
        const s = await (await adminClient.fetch(`${BASE}/email-track/log/summary?fromDays=30`)).json();
        expect(s.delivered).toBeGreaterThanOrEqual(1);
        const states = ['sent', 'sending', 'delivered', 'failed', 'retrying', 'retried', 'deferred', 'bounced', 'complained', 'suppressed', 'unknown'];
        expect(s.total).toBe(states.reduce((n, k) => n + (s[k] || 0), 0));
        // The Sent card opens the list by state, over the card's own period: the same emails.
        const card = await (await adminClient.fetch(`${BASE}/email-track/log?state=sent,delivered&fromDays=30&take=500`)).json();
        expect(card.total).toBe(s.sent + s.delivered);
        const failed = await (await adminClient.fetch(`${BASE}/email-track/log?state=failed&fromDays=30&take=500`)).json();
        expect(failed.total).toBe(s.failed);
    });

    it('the Email Log CSV export answers (log/:id no longer takes it): BOM, quoted cells, a status list, never cached; only digits name an email', async () => {
        await adminClient.asSuperAdmin();
        const logs = conn().rawConnection.getRepository(EmailLog);
        /** A CSV with every cell quoted (inner quotes doubled) — rows on \n. */
        const parseCsv = (text: string) => {
            const rows: string[][] = [];
            let row: string[] = [];
            let cell = '';
            let quoted = false;
            for (let i = 0; i < text.length; i++) {
                const c = text[i];
                if (quoted) {
                    if (c !== '"') cell += c;
                    else if (text[i + 1] === '"') { cell += '"'; i++; }
                    else quoted = false;
                } else if (c === '"') quoted = true;
                else if (c === ',') { row.push(cell); cell = ''; }
                else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
                else cell += c;
            }
            if (cell || row.length) { row.push(cell); rows.push(row); }
            return rows;
        };
        const res = await adminClient.fetch(`${BASE}/email-track/log/export.csv?status=sent,delivered`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/csv');
        expect(res.headers.get('cache-control')).toBe('private, no-store');
        expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="email-log-\d{4}-\d{2}-\d{2}\.csv"$/);
        const bytes = Buffer.from(await res.arrayBuffer());
        expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
        const rows = parseCsv(bytes.toString('utf8').replace(/^\uFEFF/, ''));
        expect(rows[0].join(',')).toBe('createdAt,type,recipient,subject,status,openCount,clickCount,customerId,orderCode,invoiceId,smtpMessageId,errorMessage,state');
        expect(rows.length - 1).toBe(await logs.count({ where: [{ status: 'sent' }, { status: 'delivered' }] as any }));
        expect(new Set(rows.slice(1).map(r => r[4]))).toEqual(new Set(['sent', 'delivered']));
        expect(rows.slice(1).some(r => r[2] === 'buyer@example.com')).toBe(true);
        // Another spelling of an id is not an email of the log: 404, never an email's detail under a cacheable extension.
        const row = await logs.findOne({ where: { status: 'sent' }, order: { id: 'ASC' } });
        expect((await adminClient.fetch(`${BASE}/email-track/log/${row!.id}`)).status).toBe(200);
        for (const p of [`log/${row!.id}.csv`, `log/${row!.id}.pdf`, `log/${row!.id}%2Fx.css`, 'log/export.csv.css', 'log/0']) {
            const r = await adminClient.fetch(`${BASE}/email-track/${p}`);
            expect([p, r.status, r.headers.get('cache-control')]).toEqual([p, 404, 'private, no-store']);
        }
        // Every admin REST answer carries it, refusals included.
        expect((await adminClient.fetch(`${BASE}/email-track/log?take=1`)).headers.get('cache-control')).toBe('private, no-store');
        expect((await fetch(`${BASE}/email-track/log/export.csv`)).headers.get('cache-control')).toBe('private, no-store'); // 401
        // Premium: 402 unlicensed.
        setLicenceStatus({ valid: false, message: 'e2e: unlicensed for a moment' } as any);
        try {
            expect((await adminClient.fetch(`${BASE}/email-track/log/export.csv`)).status).toBe(402);
        } finally {
            setLicenceStatus({ valid: true, message: 'e2e licence' } as any);
        }
    });

    it('channel scope and permissions: ReadCustomer alone is 403; another channel\'s order is 404', async () => {
        await adminClient.asUserWithCredentials('ch2@test.local', 'ch2-pass'); // ReadCustomer only, channel "second"
        adminClient.setChannelToken('second-token');
        try {
            expect((await adminClient.fetch(`${BASE}/email-track/orders/${order.id}/activity`)).status).toBe(403);
        } finally {
            adminClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
            await adminClient.asSuperAdmin();
        }
        const chans: any = await adminClient.query(gql`{ channels { items { id code } } }`);
        const second = chans.channels.items.find((c: any) => c.code === 'second');
        const role: any = await adminClient.query(gql`mutation($input: CreateRoleInput!) { createRole(input: $input) { id } }`, {
            input: { code: 'ch2-orders', description: 'ch2 orders', permissions: ['ReadOrder', 'ReadCustomer'], channelIds: [second.id] },
        });
        await adminClient.query(gql`mutation($input: CreateAdministratorInput!) { createAdministrator(input: $input) { id } }`, {
            input: { firstName: 'C', lastName: 'Orders', emailAddress: 'ch2orders@test.local', password: 'ch2o-pass', roleIds: [role.createRole.id] },
        });
        await adminClient.asUserWithCredentials('ch2orders@test.local', 'ch2o-pass');
        adminClient.setChannelToken('second-token');
        try {
            expect((await adminClient.fetch(`${BASE}/email-track/orders/${order.id}/activity`)).status).toBe(404);
            expect((await adminClient.fetch(`${BASE}/email-track/orders/${order.id}/evidence-link`, { method: 'POST' })).status).toBe(404);
        } finally {
            adminClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
            await adminClient.asSuperAdmin();
        }
    });

    it('/email-track/bounce: the HMAC is checked over the exact bytes; the compact form senders used before still verifies', async () => {
        const repo = conn().rawConnection.getRepository(EmailLog);
        const row = await repo.save(repo.create({
            type: 'test', recipient: 'soft@example.com', subject: 's', fromAddress: 'f@test.local', status: 'delivered', tracked: true,
            channelId: 1, openCount: 0, clickCount: 0, smtpMessageId: 'bounce-e2e@shop',
        } as Partial<EmailLog>));
        const payload = { messageId: '<bounce-e2e@shop>', status: 'bounced', bounceType: 'soft', reason: 'Mailbox full' };
        const pretty = JSON.stringify(payload, null, 2);
        const sig = (b: string) => createHmac('sha256', 'e2e-signing-secret').update(b).digest('hex');
        const post = (b: string, s: string) => fetch(`${BASE}/email-track/bounce`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': s }, body: b });
        expect((await post(pretty, sig(pretty))).status).toBe(201);
        expect((await post(pretty, sig(JSON.stringify(payload)))).status).toBe(201);
        expect((await post(pretty, sig('{}'))).status).toBe(401);
        // Soft bounce on a delivered email: recorded, but the status never moves back.
        expect((await repo.findOne({ where: { id: row.id } }))!.status).toBe('delivered');
        const soft = await conn().rawConnection.getRepository(EmailEvent).find({ where: { emailLogId: Number(row.id), type: 'soft-bounce' } });
        expect(soft).toHaveLength(1); // the second, identical call was a retry of the same facts
        expect(await conn().rawConnection.getRepository(EmailSuppression).findOne({ where: { recipient: 'soft@example.com' } })).toBeNull();
    });

    // ── 0.17.0 parity wave ────────────────────────────────────────────────

    describe('0.17.0: free suppression, strict bounces, settings, privacy, premium reports', () => {
        const sendgridTransport = () => nodemailer.createTransport({ streamTransport: true, buffer: true });
        const sig = (b: string) => createHmac('sha256', 'e2e-signing-secret').update(b).digest('hex');
        const bounce = (payload: any) => {
            const b = JSON.stringify(payload);
            return fetch(`${BASE}/email-track/bounce`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': sig(b) }, body: b });
        };
        const supRepo = () => conn().rawConnection.getRepository(EmailSuppression);
        const logRepo = () => conn().rawConnection.getRepository(EmailLog);

        beforeAll(async () => {
            setLicenceStatus({ valid: false, message: 'e2e: free tier' } as any);
            adminClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
            await adminClient.asSuperAdmin();
        });
        afterAll(() => setLicenceStatus({ valid: false, message: 'e2e done' } as any));

        it('B1: the bounce webhook refuses deliveries, opens and untyped bounces (400, nothing changes)', async () => {
            const row = await logRepo().save(logRepo().create({
                type: 't', recipient: 'strict@example.com', subject: 's', fromAddress: 'f@x', status: 'sent', tracked: true, channelId: 1, smtpMessageId: 'strict-1@shop',
            } as Partial<EmailLog>));
            for (const status of ['delivered', 'opened', 'sent', '']) {
                expect((await bounce({ messageId: 'strict-1@shop', status })).status).toBe(400);
            }
            const untyped = await bounce({ messageId: 'strict-1@shop', status: 'bounced' });
            expect(untyped.status).toBe(400);
            expect((await untyped.json()).error).toContain('bounceType');
            expect((await logRepo().findOne({ where: { id: row.id } }))!.status).toBe('sent');
            expect(await supRepo().findOne({ where: { recipient: 'strict@example.com' } })).toBeNull();
            // A hard bounce on a single-recipient email suppresses that address.
            const ok = await bounce({ messageId: '<strict-1@shop>', status: 'bounced', bounceType: 'hard', reason: '550 no such user' });
            expect(await ok.json()).toEqual({ ok: true, matched: true, suppressed: 1 });
            expect((await logRepo().findOne({ where: { id: row.id } }))!.status).toBe('bounced');
            expect(await supRepo().findOne({ where: { recipient: 'strict@example.com' } })).toMatchObject({ reason: 'hard-bounce' });
        });

        it('B1: per recipient — a comma-joined To list is never suppressed whole; a named recipient is', async () => {
            await logRepo().save(logRepo().create({
                type: 't', recipient: 'one@example.com, Two <two@example.com>', subject: 's', fromAddress: 'f@x', status: 'sent', tracked: true, channelId: 1, smtpMessageId: 'multi-1@shop',
            } as Partial<EmailLog>));
            expect(await (await bounce({ messageId: 'multi-1@shop', status: 'complained' })).json()).toMatchObject({ matched: true, suppressed: 0 });
            expect(await supRepo().count()).toBeGreaterThan(0);
            expect(await supRepo().findOne({ where: { recipient: 'one@example.com, two <two@example.com>' } })).toBeNull();
            expect(await supRepo().findOne({ where: { recipient: 'one@example.com' } })).toBeNull();
            // Not one of the email's recipients: not matched, nothing changes.
            expect(await (await bounce({ messageId: 'multi-1@shop', status: 'bounced', bounceType: 'hard', recipient: 'stranger@example.com' })).json()).toMatchObject({ matched: false, suppressed: 0 });
            expect(await (await bounce({ messageId: 'multi-1@shop', status: 'bounced', bounceType: 'hard', recipient: 'TWO@example.com' })).json()).toMatchObject({ matched: true, suppressed: 1 });
            expect(await supRepo().findOne({ where: { recipient: 'two@example.com' } })).toBeTruthy();
            expect(await supRepo().findOne({ where: { recipient: 'one@example.com' } })).toBeNull();
            // A soft bounce never suppresses.
            await logRepo().save(logRepo().create({
                type: 't', recipient: 'full@example.com', subject: 's', fromAddress: 'f@x', status: 'sent', tracked: true, channelId: 1, smtpMessageId: 'soft-2@shop',
            } as Partial<EmailLog>));
            expect(await (await bounce({ messageId: 'soft-2@shop', status: 'bounced', bounceType: 'soft' })).json()).toMatchObject({ matched: true, suppressed: 0 });
            expect(await supRepo().findOne({ where: { recipient: 'full@example.com' } })).toBeNull();
        });

        it('B7: the suppression list is enforced at send in the free tier; a password reset is exempt', async () => {
            const tracking: EmailTrackingService = (server as any).app.get(EmailTrackingService);
            await tracking.addSuppression('blocked@example.com', 'manual');
            const blocked = await tracking.sendTracked(sendgridTransport(), { from: 'shop@example.com', to: 'Blocked <BLOCKED@example.com>', subject: 'Offer', html: '<p>x</p>' }, { type: 'marketing' });
            expect(blocked.status).toBe('suppressed');
            const reset = await tracking.sendTracked(sendgridTransport(), { from: 'shop@example.com', to: 'blocked@example.com', subject: 'Reset', html: '<p>x</p>' }, { type: 'password-reset' });
            expect(reset.status).toBe('sent');
            const partial = await tracking.sendTracked(sendgridTransport(), { from: 'shop@example.com', to: ['blocked@example.com', 'ok@example.com'], subject: 'Hi', html: '<p>x</p>' }, { type: 'note' });
            expect(partial.status).toBe('sent');
            expect(partial.errorMessage).toContain('blocked@example.com');
            expect(await tracking.isSuppressed('blocked@example.com')).toBe(true);
        });

        it('suppression admin: validation, search with a total, remove', async () => {
            const post = (body: any) => adminClient.fetch(`${BASE}/email-track/suppression`, { method: 'POST', body: JSON.stringify(body) });
            expect((await post({ recipient: 'a@x.com, b@x.com' })).status).toBe(400);
            expect((await post({ recipient: 'Jane <jane@x.com>' })).status).toBe(400);
            expect((await post({ recipient: 'Jane@Example.com', reason: 'unsubscribe', note: 'asked by phone' })).status).toBe(201);
            const list = await (await adminClient.fetch(`${BASE}/email-track/suppression?q=JANE&take=10`)).json();
            expect(list.total).toBe(1);
            expect(list.items[0]).toMatchObject({ recipient: 'jane@example.com', reason: 'unsubscribe', note: 'asked by phone' });
            expect(await (await adminClient.fetch(`${BASE}/email-track/suppression/${encodeURIComponent('jane@example.com')}`, { method: 'DELETE' })).json()).toEqual({ ok: true });
            expect((await (await adminClient.fetch(`${BASE}/email-track/suppression?q=jane`)).json()).total).toBe(0);
        });

        it('tracking switches: opens off → the pixel is served but nothing is recorded, new mail has no pixel; settings validated, SuperAdmin only', async () => {
            const save = (body: any) => adminClient.fetch(`${BASE}/email-track/settings`, { method: 'POST', body: JSON.stringify(body) });
            expect((await save({ trustedProxies: '10.0.0.0/8, not-an-ip' })).status).toBe(400);
            expect((await save({ trackOpens: 'no' })).status).toBe(400);
            expect(await (await adminClient.fetch(`${BASE}/email-track/settings`)).json()).toMatchObject({ trackOpens: true, trackClicks: true, configuredProxies: [] });
            // sql.js cannot write the SDK's prefs table (MySQL / PostgreSQL SQL): the save says so instead of
            // pretending (persistence is covered by mariadb.e2e-spec.ts). The switch itself, in-process:
            expect((await save({ trackOpens: false })).status).toBe(500);
            applyStoredPrefs({ 'tracking.opens': 'off' });
            try {
                const row = await logRepo().save(logRepo().create({ type: 't', recipient: 'sw@example.com', subject: 's', fromAddress: 'f@x', status: 'sent', tracked: true, channelId: 1 } as Partial<EmailLog>));
                const token = signValue(String(row.id), getOptions().signingSecret!);
                const px = await fetch(`${BASE}/email-track/open/${token}.gif`, { headers: { 'user-agent': 'Mozilla/5.0 (X11) AppleWebKit/537.36 Chrome/120 Safari/537.36' } });
                expect(px.status).toBe(200);
                await sleep(200);
                expect((await logRepo().findOne({ where: { id: row.id } }))!.openCount).toBe(0);
                const tracking: EmailTrackingService = (server as any).app.get(EmailTrackingService);
                let wire = '';
                const t = nodemailer.createTransport({ streamTransport: true, buffer: true });
                const capture = { sendMail: async (m: any) => { wire = m.html; return t.sendMail(m); } } as any;
                await tracking.sendTracked(capture, { from: 'shop@example.com', to: 'sw@example.com', subject: 's', html: '<a href="https://x.example/">x</a>' }, { type: 't' });
                expect(wire).not.toContain('/email-track/open/');
                expect(wire).toContain('/email-track/click/');
            } finally {
                resetStoredPrefs();
            }
            await adminClient.asUserWithCredentials('ch2@test.local', 'ch2-pass');
            adminClient.setChannelToken('second-token');
            try {
                expect((await save({ trackOpens: false })).status).toBe(403);
            } finally {
                adminClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
                await adminClient.asSuperAdmin();
            }
        });

        it('privacy: export everything held about an address; erase it (suppression entry kept), DeleteCustomer only', async () => {
            const tracking: EmailTrackingService = (server as any).app.get(EmailTrackingService);
            const a = await tracking.sendTracked(sendgridTransport(), { from: 'shop@example.com', to: 'Privy <privy@example.com>', subject: 'Order 1', html: '<p>x</p>' }, { type: 'order-confirmation' });
            const b = await tracking.sendTracked(sendgridTransport(), { from: 'shop@example.com', to: 'privy@example.com.au', subject: 'Other', html: '<p>x</p>' }, { type: 'order-confirmation' });
            await tracking.addSuppression('privy@example.com', 'manual');
            expect((await fetch(`${BASE}/email-track/privacy/export?email=privy@example.com`)).status).toBe(401);
            expect((await adminClient.fetch(`${BASE}/email-track/privacy/export?email=not-an-address`)).status).toBe(400);
            const exp = await adminClient.fetch(`${BASE}/email-track/privacy/export?email=PRIVY@example.com`);
            expect(exp.status).toBe(200);
            expect(exp.headers.get('cache-control')).toContain('no-store');
            const data = await exp.json();
            expect(data.emails.map((e: any) => e.id)).toEqual([Number(a.id)]);
            expect(data.events.length).toBeGreaterThan(0);
            expect(data.suppression).toMatchObject({ recipient: 'privy@example.com' });

            const erase = (body: any) => adminClient.fetch(`${BASE}/email-track/privacy/erase`, { method: 'POST', body: JSON.stringify(body) });
            expect((await erase({ email: 'privy@example.com' })).status).toBe(400); // confirm required
            await adminClient.asUserWithCredentials('ch2@test.local', 'ch2-pass');
            adminClient.setChannelToken('second-token');
            try {
                expect((await erase({ email: 'privy@example.com', confirm: true })).status).toBe(403);
            } finally {
                adminClient.setChannelToken(E2E_DEFAULT_CHANNEL_TOKEN);
                await adminClient.asSuperAdmin();
            }
            const r = await (await erase({ email: 'privy@example.com', confirm: true })).json();
            expect(r).toMatchObject({ email: 'privy@example.com', emails: 1, suppressionRetained: true });
            expect(r.events).toBeGreaterThan(0);
            expect(await logRepo().findOne({ where: { id: a.id } })).toBeNull();
            expect(await logRepo().findOne({ where: { id: b.id } })).toBeTruthy();
            expect(await conn().rawConnection.getRepository(EmailEvent).count({ where: { emailLogId: Number(a.id) } })).toBe(0);
            expect(await supRepo().findOne({ where: { recipient: 'privy@example.com' } })).toBeTruthy();
        });

        it('weekly report and set-up checklist are premium; the per-order email list and the widget are free', async () => {
            expect((await adminClient.fetch(`${BASE}/email-track/setup`)).status).toBe(402);
            expect(await (await adminClient.fetch(`${BASE}/email-track/digest/settings`)).json()).toMatchObject({ locked: true });
            expect((await adminClient.fetch(`${BASE}/email-track/digest/send-test`, { method: 'POST', body: '{}' })).status).toBe(402);
            expect((await adminClient.fetch(`${BASE}/email-track/digest/preview`)).status).toBe(402);
            expect((await adminClient.fetch(`${BASE}/email-track/digest/settings`, { method: 'POST', body: '{"enabled":false}' })).status).toBe(402);
            const tracking: EmailTrackingService = (server as any).app.get(EmailTrackingService);
            expect(await tracking.digest.tick(new Date(Date.now() + 30 * 86_400_000))).toBe(false);
            const list = await adminClient.fetch(`${BASE}/email-track/log?orderId=${order.id}&fromDays=all`);
            expect(list.status).toBe(200);
            expect((await list.json()).total).toBeGreaterThan(0);
            const widget = await (await adminClient.fetch(`${BASE}/email-track/widget`)).json();
            expect(widget.stats.map((x: any) => x.label)).toEqual(['Emails tracked', 'Opens', 'Clicks', 'Failed or bounced']);
            expect(widget.failedOrBounced).toBeGreaterThanOrEqual(1);
            const status = await (await adminClient.fetch(`${BASE}/email-track/licence/status`)).json();
            expect(status.premiumFeatures).toContain('Weekly email report');
            expect(status.premiumFeatures.join(' ')).not.toMatch(/suppression/i);
            setLicenceStatus({ valid: true, message: 'e2e licence' } as any);
            try {
                expect((await adminClient.fetch(`${BASE}/email-track/setup`)).status).toBe(200);
                expect(await (await adminClient.fetch(`${BASE}/email-track/digest/settings`)).json()).toMatchObject({ locked: false });
            } finally {
                setLicenceStatus({ valid: false, message: 'e2e: free tier' } as any);
            }
        });
    });
});

