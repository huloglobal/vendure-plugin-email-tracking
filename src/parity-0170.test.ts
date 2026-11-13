import { describe, expect, it, vi, beforeEach } from 'vitest';

// TypeORM entities need emitted decorator metadata, which the test transform does not produce.
vi.mock('./email-log.entity', () => ({ EmailLog: class EmailLog {} }));
vi.mock('./email-suppression.entity', () => ({ EmailSuppression: class EmailSuppression {} }));
vi.mock('./email-event.entity', () => ({ EmailEvent: class EmailEvent {} }));
import { isAddress, normaliseAddress, parseBounceBody, splitRecipients, suppressionTargets, isSuppressionExempt } from './recipients';
import {
    applyStoredPrefs, currentSettings, inRanges, parseProxies, resetStoredPrefs, settingsPatch, trackingSwitches, trustedProxyRanges, validRange,
} from './tracking-settings';
import { getRealIp } from './proxy-headers';
import { classifyEngagement, engagementCounts } from './engagement-class';
import { contextFromEmailJob, currentEmailContext, installEmailProcessorHook, withEmailContext } from './email-context';
import { wrapTrackedHtml } from './outgoing-mail';
import { findSuppressed, suppressionDecision } from './suppression-store';
import { setOptions, setLicenceStatus } from './options';
import { PremiumWeeklyDigest } from './email-tracking.service';
import { TrackingEmailSender } from './tracking-email-sender';

const GMAIL_PROXY = 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

describe('recipients (0.17.0)', () => {
    it('splits a To header into bare, lower-cased, distinct addresses', () => {
        expect(splitRecipients('A@Example.com, "Doe, Jane" <jane@x.co.uk>,a@example.com')).toEqual(['a@example.com', 'jane@x.co.uk']);
        expect(splitRecipients([{ name: 'B', address: 'B@x.com' }, 'c@y.org'])).toEqual(['b@x.com', 'c@y.org']);
        expect(splitRecipients('')).toEqual([]);
        expect(normaliseAddress('Jane <JANE@X.com>')).toBe('jane@x.com');
        expect(isAddress('a@b.co')).toBe(true);
        expect(isAddress('a@b.co, c@d.co')).toBe(false);
        expect(isAddress('Jane <a@b.co>')).toBe(false);
    });

    it('B1: the bounce webhook accepts only bounces (hard / soft named) and complaints', () => {
        expect(parseBounceBody({ status: 'delivered' })).toMatchObject({ ok: false });
        expect(parseBounceBody({ status: 'opened' })).toMatchObject({ ok: false });
        expect(parseBounceBody({})).toMatchObject({ ok: false });
        expect(parseBounceBody({ status: 'bounced' })).toMatchObject({ ok: false, error: expect.stringContaining('bounceType') });
        expect(parseBounceBody({ status: 'bounced', bounceType: 'weird' })).toMatchObject({ ok: false });
        expect(parseBounceBody({ status: 'Bounce', bounceType: 'Hard_Bounce' })).toEqual({ ok: true, status: 'bounced', soft: false, recipient: null });
        expect(parseBounceBody({ status: 'bounced', bounceType: 'Transient' })).toMatchObject({ ok: true, soft: true });
        expect(parseBounceBody({ status: 'complaint' })).toEqual({ ok: true, status: 'complained', soft: false, recipient: null });
        expect(parseBounceBody({ status: 'complained', recipient: 'X@Y.com' })).toMatchObject({ recipient: 'x@y.com' });
        expect(parseBounceBody({ status: 'complained', recipient: 'a@b.com, c@d.com' })).toMatchObject({ ok: false });
    });

    it('B1: suppresses per recipient — the named one, else the only one, never a whole list', () => {
        expect(suppressionTargets('a@x.com', null)).toEqual({ matched: true, targets: ['a@x.com'] });
        expect(suppressionTargets('a@x.com, b@x.com', null)).toEqual({ matched: true, targets: [] });
        expect(suppressionTargets('a@x.com, b@x.com', 'B@x.com')).toEqual({ matched: true, targets: ['b@x.com'] });
        expect(suppressionTargets('a@x.com', 'other@x.com')).toEqual({ matched: false, targets: [] });
    });

    it('B7: only a password reset (by default) is exempt, and only by the type the sender gave', () => {
        expect(isSuppressionExempt('password-reset')).toBe(true);
        expect(isSuppressionExempt('order-confirmation')).toBe(false);
        expect(isSuppressionExempt(null)).toBe(false);
        expect(isSuppressionExempt('email-verification', ['password-reset', 'email-verification'])).toBe(true);
    });
});

describe('suppression store', () => {
    it('looks addresses up with one IN query and answers the suppressed ones', async () => {
        const seen: Array<{ sql: string; params: any[] }> = [];
        const query = async (sql: string, params: any[] = []) => { seen.push({ sql, params }); return params.filter(p => p.startsWith('dead')).map(recipient => ({ recipient })); };
        expect(await findSuppressed(query, ['Dead@x.com', 'live@x.com', 'dead@x.com'])).toEqual(['dead@x.com']);
        expect(seen).toEqual([{ sql: 'SELECT recipient FROM email_suppression WHERE recipient IN (?, ?)', params: ['dead@x.com', 'live@x.com'] }]);
        expect(await suppressionDecision(query, ['dead@x.com', 'live@x.com'], false)).toEqual({ kept: ['live@x.com'], dropped: ['dead@x.com'] });
        expect(await suppressionDecision(query, ['dead@x.com'], true)).toEqual({ kept: ['dead@x.com'], dropped: [] });
    });
});

describe('tracking settings + trusted proxies (0.17.0)', () => {
    beforeEach(() => { resetStoredPrefs(); setOptions({ publicBaseUrl: 'https://shop.example.com' }); });

    it('validates IPs and CIDR ranges, v4 and v6', () => {
        expect(validRange('10.0.0.0/8')).toBe(true);
        expect(validRange('2400:cb00::/32')).toBe(true);
        expect(validRange('192.168.1.5')).toBe(true);
        expect(validRange('10.0.0.0/33')).toBe(false);
        expect(validRange('example.com')).toBe(false);
        expect(parseProxies('10.0.0.0/8, bad, 10.0.0.0/8\n::1')).toEqual(['10.0.0.0/8', '::1']);
        expect(inRanges('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
        expect(inRanges('::ffff:10.1.2.3', ['10.0.0.0/8'])).toBe(true);
        expect(inRanges('2400:cb00:1::1', ['2400:cb00::/32'])).toBe(true);
        expect(inRanges('2400:cb01::1', ['2400:cb00::/32'])).toBe(false);
        expect(inRanges('11.0.0.1', ['10.0.0.0/8'])).toBe(false);
    });

    it('switches default to the init options, stored prefs override them', () => {
        expect(trackingSwitches()).toEqual({ opens: true, clicks: true });
        setOptions({ publicBaseUrl: 'https://shop.example.com', trackClicks: false, trustedProxies: ['10.0.0.0/8'] });
        expect(trackingSwitches()).toEqual({ opens: true, clicks: false });
        applyStoredPrefs({ 'tracking.opens': 'off', 'tracking.clicks': 'on', 'tracking.trustedProxies': '192.168.0.0/16' });
        expect(trackingSwitches()).toEqual({ opens: false, clicks: true });
        expect(trustedProxyRanges()).toEqual(['10.0.0.0/8', '192.168.0.0/16']);
        expect(currentSettings()).toMatchObject({ trackOpens: false, trackClicks: true, trustedProxies: ['192.168.0.0/16'], configuredProxies: ['10.0.0.0/8'] });
    });

    it('a settings patch is validated', () => {
        expect(settingsPatch({ trackOpens: 'yes' })).toEqual({ error: 'trackOpens must be true or false' });
        expect(settingsPatch({ trustedProxies: '10.0.0.0/8, nope' })).toMatchObject({ error: expect.stringContaining('nope') });
        expect(settingsPatch({ trackOpens: false, trustedProxies: ['10.0.0.0/8'] })).toEqual({ prefs: { 'tracking.opens': 'off', 'tracking.trustedProxies': '10.0.0.0/8' } });
        expect(settingsPatch({ trustedProxies: '' })).toEqual({ prefs: { 'tracking.trustedProxies': null } });
    });

    it('with trusted proxies, headers are believed only from them, and X-Forwarded-For skips them', () => {
        const req = (peer: string, headers: Record<string, string>) => ({ socket: { remoteAddress: peer }, ip: peer, headers }) as any;
        const proxies = ['10.0.0.0/8'];
        // A client that is not a proxy cannot pick its address.
        expect(getRealIp(req('203.0.113.9', { 'x-forwarded-for': '1.1.1.1' }), ['x-forwarded-for'], proxies)).toBe('203.0.113.9');
        // From the proxy: the right-most hop that is not a trusted proxy.
        expect(getRealIp(req('10.0.0.2', { 'x-forwarded-for': '6.6.6.6, 198.51.100.7, 10.0.0.9' }), ['x-forwarded-for'], proxies)).toBe('198.51.100.7');
        // A malformed hop stops the walk.
        expect(getRealIp(req('10.0.0.2', { 'x-forwarded-for': 'garbage, 10.0.0.9' }), ['x-forwarded-for'], proxies)).toBe('10.0.0.2');
        expect(getRealIp(req('::ffff:10.0.0.2', { 'cf-connecting-ip': '198.51.100.8' }), ['cf-connecting-ip'], proxies)).toBe('198.51.100.8');
        // No proxies configured: the 0.16 behaviour (right-most public hop).
        expect(getRealIp(req('203.0.113.9', { 'x-forwarded-for': '1.1.1.1, 198.51.100.7' }), ['x-forwarded-for'], [])).toBe('198.51.100.7');
    });
});

describe('bot-aware engagement counting (0.17.0)', () => {
    it('machine opens and clicks are not counted; image-proxy opens are', () => {
        expect(engagementCounts('open', classifyEngagement('open', CHROME, '198.51.100.1'))).toBe(true);
        const gmail = classifyEngagement('open', GMAIL_PROXY, '66.249.84.1');
        expect(gmail.classification).toBe('machine_likely');
        expect(engagementCounts('open', gmail)).toBe(true);
        expect(engagementCounts('open', classifyEngagement('open', 'python-requests/2.31', '198.51.100.1'))).toBe(false);
        expect(engagementCounts('click', classifyEngagement('click', 'Mozilla/5.0 (compatible; Barracuda Sentinel)', '198.51.100.1'))).toBe(false);
        expect(engagementCounts('click', classifyEngagement('click', CHROME, '198.51.100.1'))).toBe(true);
    });

    it("Apple's network is Mail Privacy Protection for opens", () => {
        const c = classifyEngagement('open', CHROME, '17.58.100.4');
        expect(c.classification).toBe('machine_likely');
        expect(c.reasons).toEqual(expect.arrayContaining(['apple-network', 'ampp']));
        expect(engagementCounts('open', c)).toBe(false);
        // A click from Apple's network is a person following the link.
        expect(classifyEngagement('click', CHROME, '17.58.100.4').classification).toBe('human_likely');
    });
});

describe('sender context (0.17.0)', () => {
    it('reads the EmailPlugin job: event type, order, channel', () => {
        const ctx = contextFromEmailJob({
            type: 'order-confirmation', ctx: { _channel: { id: 2 } },
            templateVars: { order: { id: 41, code: 'ABC123DEF456', customer: { id: 7 } } },
        });
        expect(ctx).toEqual({ type: 'order-confirmation', orderId: 41, orderCode: 'ABC123DEF456', customerId: 7, channelId: 2 });
        expect(contextFromEmailJob({ type: 'bad type!', templateVars: {} }).type).toBeNull();
    });

    it('the processor hook runs each job inside its context, once per prototype', async () => {
        class EmailProcessor { async process(data: any) { await Promise.resolve(); return currentEmailContext(); } }
        const mod = { EmailProcessor };
        expect(installEmailProcessorHook(() => mod)).toBe(true);
        expect(installEmailProcessorHook(() => mod)).toBe(true);
        const seen = await new EmailProcessor().process({ type: 'password-reset', templateVars: {} });
        expect(seen).toMatchObject({ type: 'password-reset' });
        expect(currentEmailContext()).toBeNull();
        expect(installEmailProcessorHook(() => ({}))).toBe(false);
        expect(await withEmailContext({ type: 'quote-sent', orderId: 3 }, async () => currentEmailContext())).toMatchObject({ type: 'quote-sent', orderId: 3 });
    });
});

describe('wrapping honours the tracking switches', () => {
    it('clicks off: links untouched; opens off: no pixel', () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com', signingSecret: 's' });
        const html = '<html><body><a href="https://shop.example.com/x">x</a></body></html>';
        const noClicks = wrapTrackedHtml(html, 5, { clicks: false });
        expect(noClicks.html).toContain('href="https://shop.example.com/x"');
        expect(noClicks.html).toContain('/email-track/open/5.');
        const noOpens = wrapTrackedHtml(html, 5, { opens: false });
        expect(noOpens.html).not.toContain('/email-track/open/');
        expect(noOpens.html).toContain('/email-track/click/5.');
    });
});

describe('weekly report is premium (0.17.0)', () => {
    it('the scheduler does nothing without premium, and runs with it', async () => {
        const prefsAll = vi.fn(async () => ({}));
        const prefs: any = { all: prefsAll, get: async () => null, cas: async () => false, casDelete: async () => false, set: async () => undefined };
        let premium = false;
        const d = new PremiumWeeklyDigest({
            pluginId: 'x', pluginName: 'X', prefs,
            collect: async () => ({}) as any, send: async () => true, defaultRecipient: () => 'a@b.co',
        }, () => premium);
        expect(await d.tick(new Date())).toBe(false);
        expect(prefsAll).not.toHaveBeenCalled();
        premium = true;
        await d.tick(new Date());
        expect(prefsAll).toHaveBeenCalled();
    });
});

describe('B7: TrackingEmailSender enforces the suppression list (free)', () => {
    function harness(suppressed: string[]) {
        setOptions({ publicBaseUrl: 'https://shop.example.com', signingSecret: 'test-secret' });
        setLicenceStatus({ valid: false, message: 'free' } as any);
        resetStoredPrefs();
        const saved: any[] = [];
        const recorded: any[] = [];
        const sent: any[] = [];
        const repo = { create: (p: any) => ({ ...p }), save: async (row: any) => { const r = { ...row, id: 21 }; saved.push(r); return r; }, update: async () => ({ affected: 1 }) };
        const sender = new TrackingEmailSender();
        (sender as any).connection = {
            rawConnection: {
                options: { type: 'mysql' }, getRepository: () => repo,
                query: async (sql: string, params: any[] = []) => (/email_suppression/.test(sql) ? params.filter(p => suppressed.includes(p)).map(recipient => ({ recipient })) : []),
            },
        };
        (sender as any).events = { record: async (e: any) => { recorded.push(e); return { id: 1, duplicate: false, failed: false }; } };
        (sender as any).inner.getSmtpTransport = () => ({ sendMail: async (m: any) => { sent.push(m); return { messageId: '<x@shop>', response: '250 Ok' }; } });
        return { sender, saved, recorded, sent };
    }

    it('a suppressed recipient is not sent to, in the free tier, and the attempt is logged', async () => {
        const h = harness(['dead@example.com']);
        await h.sender.send({ recipient: 'Dead@Example.com', subject: 'Your order', body: '<p>x</p>', from: 'f@x' } as any, { type: 'smtp' } as any);
        expect(h.sent).toHaveLength(0);
        expect(h.saved[0]).toMatchObject({ status: 'suppressed', tracked: false });
        expect(h.recorded[0]).toMatchObject({ type: 'suppressed', source: 'smtp' });
    });

    it('drops only the suppressed addresses of a list', async () => {
        const h = harness(['dead@example.com']);
        await h.sender.send({ recipient: 'dead@example.com, live@example.com', subject: 'Hi', body: '<p>x</p>', from: 'f@x' } as any, { type: 'smtp' } as any);
        expect(h.sent).toHaveLength(1);
        expect(h.sent[0].to).toBe('live@example.com');
        expect(h.saved[0]).toMatchObject({ status: 'sent', recipient: 'live@example.com', errorMessage: expect.stringContaining('dead@example.com') });
    });

    it('a password reset (the sender says so) is always sent; a subject that merely says "password" is not exempt', async () => {
        const h = harness(['dead@example.com']);
        await withEmailContext({ type: 'password-reset' }, () =>
            h.sender.send({ recipient: 'dead@example.com', subject: 'Reset', body: '<p>x</p>', from: 'f@x' } as any, { type: 'smtp' } as any));
        expect(h.sent).toHaveLength(1);
        expect(h.saved[0]).toMatchObject({ type: 'password-reset', status: 'sent' });
        const h2 = harness(['dead@example.com']);
        await h2.sender.send({ recipient: 'dead@example.com', subject: 'Reset your password', body: '<p>x</p>', from: 'f@x' } as any, { type: 'smtp' } as any);
        expect(h2.sent).toHaveLength(0);
        expect(h2.saved[0]).toMatchObject({ type: 'password-reset', status: 'suppressed' });
    });

    it('the e-mail type comes from the sender context, not the subject', async () => {
        const h = harness([]);
        await withEmailContext({ type: 'email-verification' }, () =>
            h.sender.send({ recipient: 'a@example.com', subject: 'Your invoice is ready', body: '<p>x</p>', from: 'f@x' } as any, { type: 'smtp' } as any));
        expect(h.saved[0].type).toBe('email-verification');
    });

    it('with both tracking switches off the body is sent untouched and the row is not tracked', async () => {
        const h = harness([]);
        applyStoredPrefs({ 'tracking.opens': 'off', 'tracking.clicks': 'off' });
        await h.sender.send({ recipient: 'a@example.com', subject: 's', body: '<a href="https://x.example/">x</a>', from: 'f@x' } as any, { type: 'smtp' } as any);
        expect(h.sent[0].html).toBe('<a href="https://x.example/">x</a>');
        expect(h.saved[0].tracked).toBe(false);
        resetStoredPrefs();
    });
});

describe('sender context through the real Vendure EmailProcessor', () => {
    it("the EmailPlugin job's type and order reach TrackingEmailSender", async () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { EmailProcessor } = require('@vendure/email-plugin/lib/src/email-processor');
        expect(installEmailProcessorHook()).toBe(true);
        let seen: any = null;
        const self = Object.create(EmailProcessor.prototype);
        Object.assign(self, {
            moduleRef: {},
            options: { templateLoader: { loadTemplate: async () => '<p>{{ x }}</p>' }, transport: { type: 'none' } },
            generator: { generate: async (from: string, subject: string, body: string) => ({ from, subject, body }) },
            emailSender: { send: async () => { seen = currentEmailContext(); } },
            eventBus: { publish: async () => undefined },
            getTransportSettings: async () => ({ type: 'none' }),
        });
        await self.process({
            ctx: { _channel: { id: 3 } }, type: 'order-confirmation', from: 'f@x', recipient: 'c@x.com', subject: 's', templateFile: 'body.hbs',
            templateVars: { order: { id: 9, code: 'XYZ1234567AB', customerId: 4 } }, attachments: [],
        });
        expect(seen).toEqual({ type: 'order-confirmation', orderId: 9, orderCode: 'XYZ1234567AB', customerId: 4, channelId: 3 });
    });
});
