import { describe, expect, it } from 'vitest';
import * as nodemailer from 'nodemailer';
import { anchorText, findLink, hasSensitiveQuery, isSensitiveParamName, isSensitiveUrl, redactSensitiveUrl, urlFingerprint } from './link-meta';
import { correlationHeaders, correlationIdFrom, correlationToken, mergeHeaders, preparedJson, providerMessageIdFromSmtpReply, sendPayload, wrapTrackedHtml } from './outgoing-mail';
import { setOptions } from './options';
import { verifyClickSignature } from './click-signature';

describe('sensitive query redaction', () => {
    it('recognises token-like parameter names', () => {
        for (const n of ['token', 'access_token', 'resetToken', 'code', 'auth_code', 'key', 'api-key', 'sig', 'signature', 'auth', 'password', 'reset', 'otp', 'client_secret'])
            expect(isSensitiveParamName(n), n).toBe(true);
        for (const n of ['utm_source', 'page', 'keyword', 'signup', 'author', 'id'])
            expect(isSensitiveParamName(n), n).toBe(false);
    });

    it('redacts the whole query when any parameter is sensitive, else leaves the URL alone', () => {
        expect(redactSensitiveUrl('https://shop.example.com/password-reset?token=abc&utm_source=x')).toBe('https://shop.example.com/password-reset?[redacted]');
        expect(redactSensitiveUrl('https://shop.example.com/verify?code=1#frag')).toBe('https://shop.example.com/verify?[redacted]');
        expect(redactSensitiveUrl('https://shop.example.com/p?id=3&utm_source=mail')).toBe('https://shop.example.com/p?id=3&utm_source=mail');
        expect(redactSensitiveUrl('[sensitive: shop.example.com]')).toBe('[sensitive: shop.example.com]');
        const once = redactSensitiveUrl('https://h.example/x?otp=1');
        expect(redactSensitiveUrl(once)).toBe(once);
        expect(hasSensitiveQuery('not a url')).toBe(false);
    });

    it('covers the other common secret carriers', () => {
        for (const n of ['session', 'sessionid', 'PHPSESSID', 'sid', 'jwt', 'id_token', 'apikey', 'api_key', 'magic', 'pin', 'nonce', 'hash', 'ticket', 'pwd', 'passcode'])
            expect(isSensitiveParamName(n), n).toBe(true);
        const cases: Array<[string, string]> = [
            ['https://s.example/x?session=abc', 'https://s.example/x?[redacted]'],
            ['https://s.example/x?jwt=eyJ', 'https://s.example/x?[redacted]'],
            ['https://s.example/x?apikey=1', 'https://s.example/x?[redacted]'],
            ['https://s.example/x?pin=1234', 'https://s.example/x?[redacted]'],
            // OAuth-style fragments
            ['https://s.example/login#access_token=abc&token_type=bearer', 'https://s.example/login?[redacted]'],
            ['https://s.example/cb#state=x&id_token=y', 'https://s.example/cb?[redacted]'],
            // a secret inside a redirect target, plain or encoded once / twice
            ['https://s.example/login?next=/reset?token=abc', 'https://s.example/login?[redacted]'],
            ['https://s.example/go?u=' + encodeURIComponent('https://shop.example/account/reset?token=SECRET'), 'https://s.example/go?[redacted]'],
            ['https://s.example/go?r=' + encodeURIComponent(encodeURIComponent('https://shop.example/verify?code=1')), 'https://s.example/go?[redacted]'],
            // account-action paths: no query recorded, token-like segments replaced
            ['https://s.example/account/reset?t=abc', 'https://s.example/account/reset?[redacted]'],
            ['https://s.example/verify?c=9', 'https://s.example/verify?[redacted]'],
            ['https://s.example/password/reset/9f8e7d6c5b4a3f2e1d0c', 'https://s.example/password/reset/[redacted]'],
            ['https://s.example/magic-link/ab12cd34', 'https://s.example/magic-link/[redacted]'],
            // user info
            ['https://user:pw@s.example/p', 'https://s.example/p'],
        ];
        for (const [url, want] of cases) expect(redactSensitiveUrl(url), url).toBe(want);
        for (const [url] of cases) { const r = redactSensitiveUrl(url); expect(redactSensitiveUrl(r), r).toBe(r); }
        // Ordinary links stay as they are.
        for (const url of ['https://s.example/products/shoes?colour=red&utm_campaign=autumn', 'https://s.example/blog#section-2', 'https://s.example/account/orders/ABC'])
            expect(redactSensitiveUrl(url), url).toBe(url);
        expect(isSensitiveUrl('https://s.example/login')).toBe(false);
    });
});

describe('link metadata', () => {
    it('anchor text: tags stripped, entities decoded, 120 characters, image alt fallback', () => {
        expect(anchorText('  <b>View&nbsp;your</b>\n <span>order</span> &amp; invoice ')).toBe('View your order & invoice');
        expect(anchorText('<img src="x.png" alt="Shop logo">')).toBe('[image: Shop logo]');
        expect(anchorText('x'.repeat(300))).toHaveLength(120);
    });

    it('wrapTrackedHtml: unchanged URLs + signatures, one entry per tracked link, skipped links not listed', () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com', signingSecret: 'test-secret' });
        const html = '<html><body>'
            + '<a href="https://shop.example.com/orders/ABC">View <b>order</b></a>'
            + '<a href="mailto:help@shop.example.com">Mail us</a>'
            + '<a href="https://shop.example.com/reset?token=t1&amp;u=2">Reset password</a>'
            + '<a href="https://shop.example.com/unsubscribe">Unsubscribe</a>'
            + '<a class="btn" href=\'https://partner.example/x\' target="_blank"><img alt="Partner"></a>'
            + '</body></html>';
        const { html: out, links, signed } = wrapTrackedHtml(html, 7);
        expect(signed).toBe(true);
        expect(links).toEqual([
            { i: 0, t: 'View order', s: false, h: urlFingerprint('https://shop.example.com/orders/ABC', 'test-secret') },
            { i: 1, t: 'Reset password', s: true, h: urlFingerprint('https://shop.example.com/reset?token=t1&u=2', 'test-secret') },
            { i: 2, t: '[image: Partner]', s: false, h: urlFingerprint('https://partner.example/x', 'test-secret') },
        ]);
        const hrefs = [...out.matchAll(/href=["']([^"']+)["']/g)].map(m => m[1]);
        expect(hrefs[1]).toBe('mailto:help@shop.example.com');
        expect(hrefs[3]).toBe('https://shop.example.com/unsubscribe');
        const reset = new URL(hrefs[2]);
        expect(reset.searchParams.get('u')).toBe('https://shop.example.com/reset?token=t1&u=2');
        const token = reset.pathname.split('/').pop()!;
        expect(token).toMatch(/^7\.[0-9a-f]{16}$/);
        expect(verifyClickSignature(token, reset.searchParams.get('u')!, reset.searchParams.get('s'), 'test-secret')).toBe(true);
        expect(out).toContain('/email-track/open/7.');
        expect(findLink(links, 'https://shop.example.com/reset?token=t1&u=2', 'test-secret')).toMatchObject({ i: 1, s: true });
        expect(findLink(links, 'https://elsewhere.example/', 'test-secret')).toBeNull();
        expect(findLink(null, 'x')).toBeNull();
        expect(sendPayload(links, signed)).toEqual({ signed: true, links });
        expect(sendPayload([], false)).toEqual({ signed: false });
    });

    it('the fingerprint is keyed and, for a sensitive link, taken over the redacted URL — a low-entropy code cannot be recovered', () => {
        const url = (n: number) => `https://x.example/p?id=1&code=OTP-${String(n).padStart(3, '0')}`;
        const h = urlFingerprint(url(999), 'install-secret');
        // Every candidate code gives the same fingerprint (the code is not in it) …
        expect(urlFingerprint(url(0), 'install-secret')).toBe(h);
        // … and without the install's secret nothing matches at all.
        expect(urlFingerprint(url(999))).not.toBe(h);
        expect(urlFingerprint('https://x.example/a', 'install-secret')).not.toBe(urlFingerprint('https://x.example/a', 'other-install'));
        expect(urlFingerprint('https://x.example/a', 'k')).toMatch(/^[0-9a-f]{16}$/);
    });
});

describe('outgoing correlation headers', () => {
    it('adds a header only for each configured provider; JSON ones are prepared (sent as raw JSON)', () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com' });
        expect(correlationHeaders(5)).toEqual({});
        setOptions({ publicBaseUrl: 'https://shop.example.com', providerWebhooks: { sendgrid: { verificationKey: 'k' } } });
        expect(correlationHeaders(5)).toEqual({ 'X-SMTPAPI': { prepared: true, value: '{"unique_args":{"hulo-log-id":"5"}}' } });
        setOptions({
            publicBaseUrl: 'https://shop.example.com',
            providerWebhooks: { mailgun: { signingKey: 'k' }, postmark: { username: 'u', password: 'p' }, ses: { topicArns: ['arn:aws:sns:eu-west-1:123456789012:t'] } },
        });
        expect(correlationHeaders(5)).toEqual({
            'X-Mailgun-Variables': { prepared: true, value: '{"hulo-log-id":"5"}' },
            'X-PM-Metadata-hulo-log-id': '5',
            'X-SES-MESSAGE-TAGS': 'hulo-log-id=5',
        });
        setOptions({ publicBaseUrl: 'https://shop.example.com', providerWebhooks: { postmark: { username: 'u', password: '' }, ses: { topicArns: [] } } });
        expect(correlationHeaders(5)).toEqual({});
    });

    it('serialises through nodemailer as raw JSON the providers can parse (no RFC 2047 encoded-words)', async () => {
        setOptions({
            publicBaseUrl: 'https://shop.example.com', signingSecret: 'install-a',
            providerWebhooks: { sendgrid: { verificationKey: 'k' }, mailgun: { signingKey: 'k' }, postmark: { username: 'u', password: 'p' }, ses: { topicArns: ['arn:aws:sns:eu-west-1:123456789012:t'] } },
        });
        const id = correlationToken(5, 'install-a');
        const headers = mergeHeaders({ 'X-SMTPAPI': '{"category":["orders"]}' }, correlationHeaders(5));
        const info: any = await nodemailer.createTransport({ streamTransport: true, buffer: true }).sendMail({
            from: 'shop@example.com', to: 'a@example.com', subject: 'Hi', text: 'Hi', headers,
        });
        const raw = info.message.toString('utf8');
        const header = (name: string) => {
            const m = new RegExp(`^${name}: (.*(?:\\r\\n[ \\t].*)*)`, 'mi').exec(raw);
            return m ? m[1].replace(/\r\n[ \t]+/g, ' ') : null;
        };
        expect(raw).not.toContain('=?UTF-8?');
        expect(JSON.parse(header('X-SMTPAPI')!)).toEqual({ category: ['orders'], unique_args: { 'hulo-log-id': id } });
        expect(JSON.parse(header('X-Mailgun-Variables')!)).toEqual({ 'hulo-log-id': id });
        expect(header('X-SES-MESSAGE-TAGS')).toBe(`hulo-log-id=${id}`);
        // nodemailer re-cases this one (the Postmark mapper reads metadata keys case-insensitively).
        expect(header('X-PM-Metadata-hulo-log-id')).toBe(id);
    });

    it('a long JSON header is folded between tokens and still parses after unfolding; non-ASCII is escaped', () => {
        const big = preparedJson({ unique_args: { 'hulo-log-id': '5' }, category: Array.from({ length: 80 }, (_v, i) => `category-${i}`), note: 'Zoë → ok' });
        expect(big.prepared).toBe(true);
        expect(big.value).not.toMatch(/[^\x00-\x7f]/);
        for (const line of big.value.split('\r\n')) expect(line.length).toBeLessThan(990);
        expect(JSON.parse(big.value.replace(/\r\n[ \t]+/g, ' ')).note).toBe('Zoë → ok');
    });

    it('signs the correlation value per install, so another shop\'s ids never match', () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com' });
        const t = correlationToken(5, 'install-a');
        expect(t).toMatch(/^5-[0-9a-f]{16}$/);
        expect(correlationIdFrom(t, 'install-a')).toBe(5);
        expect(correlationIdFrom(t, 'install-b')).toBeNull();
        expect(correlationIdFrom('5', 'install-a')).toBeNull();               // unsigned
        expect(correlationIdFrom(t.replace(/^5/, '6'), 'install-a')).toBeNull(); // re-pointed
        expect(correlationIdFrom('0-0123456789abcdef', 'install-a')).toBeNull();
        expect(correlationToken(5, undefined)).toBe('5');
        expect(correlationIdFrom('5', undefined)).toBe(5);
        setOptions({ publicBaseUrl: 'https://shop.example.com', signingSecret: 'install-a', providerWebhooks: { ses: { topicArns: ['arn:aws:sns:eu-west-1:123456789012:t'] } } });
        expect(correlationHeaders(5)).toEqual({ 'X-SES-MESSAGE-TAGS': `hulo-log-id=${t}` });
    });

    it('merges into object or list headers; JSON headers the sender set are merged (and sent prepared), others win', () => {
        const extra = { 'X-SMTPAPI': preparedJson({ unique_args: { 'hulo-log-id': '5' } }), 'X-PM-Metadata-hulo-log-id': '5' };
        expect(mergeHeaders(undefined, extra)).toEqual(extra);
        expect(mergeHeaders({ 'x-smtpapi': '{"category":["a"]}', 'X-PM-Metadata-hulo-log-id': 'keep' }, extra)).toEqual({
            'x-smtpapi': { prepared: true, value: '{"category":["a"],"unique_args":{"hulo-log-id":"5"}}' }, 'X-PM-Metadata-hulo-log-id': 'keep',
        });
        // A prepared value the sender set is merged too.
        expect(mergeHeaders({ 'X-SMTPAPI': { prepared: true, value: '{"unique_args":{"a":"1"}}' } }, extra)).toEqual({
            'X-SMTPAPI': { prepared: true, value: '{"unique_args":{"a":"1","hulo-log-id":"5"}}' }, 'X-PM-Metadata-hulo-log-id': '5',
        });
        expect(mergeHeaders([{ key: 'X-Other', value: '1' }], { 'X-Mailgun-Variables': preparedJson({ 'hulo-log-id': '5' }) }))
            .toEqual([{ key: 'X-Other', value: '1' }, { key: 'X-Mailgun-Variables', value: { prepared: true, value: '{"hulo-log-id":"5"}' } }]);
        // Not JSON: the sender's header is left alone.
        expect(mergeHeaders({ 'X-SMTPAPI': 'garbage' }, extra)['X-SMTPAPI']).toBe('garbage');
        expect(mergeHeaders({ a: 1 }, {})).toEqual({ a: 1 });
    });

    it('parses the provider message id out of SMTP replies', () => {
        expect(providerMessageIdFromSmtpReply('250 2.0.0 Ok: queued as 4ZxB2k0Qy1z3')).toBe('4ZxB2k0Qy1z3');
        expect(providerMessageIdFromSmtpReply('250 Ok: queued as lQ7cKc5ARWuvFlG1jGs-Lg')).toBe('lQ7cKc5ARWuvFlG1jGs-Lg');
        expect(providerMessageIdFromSmtpReply('250 Ok 0100018b5e6f7a8b-1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d-000000')).toBe('0100018b5e6f7a8b-1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d-000000');
        expect(providerMessageIdFromSmtpReply('0102018b5e6f7a8b-1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d-000000')).toBe('0102018b5e6f7a8b-1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d-000000');
        expect(providerMessageIdFromSmtpReply('250 2.0.0 OK  1699999999 x1-20020a17090a5c0b00b0027d0b1e8f1asi1234567pjm.12 - gsmtp')).toBeNull();
        expect(providerMessageIdFromSmtpReply(undefined)).toBeNull();
    });
});
