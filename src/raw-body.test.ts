import { describe, expect, it } from 'vitest';
import { PassThrough } from 'stream';
import { gzipSync } from 'zlib';
import {
    bounceBodyMiddleware, captureBody, jsonShapeWithin, parseJsonBody, providerWebhookBodyMiddleware, WEBHOOK_BODY_LIMITS, WEBHOOK_MAX_JSON_CONTAINERS,
    WEBHOOK_MAX_JSON_DEPTH,
} from './raw-body';
import { setOptions } from './options';

function mockRes() {
    const headers: Record<string, string> = {};
    return {
        statusCode: 200, ended: false, body: '' as string, headers, headersSent: false,
        setHeader(k: string, v: string) { headers[k.toLowerCase()] = v; },
        end(b?: string) { this.ended = true; this.headersSent = true; if (b) this.body = b; },
    };
}

/** Run a middleware over a streamed body; resolves when next() is called or the response ends. */
function run(mw: (req: any, res: any, next: () => void) => void, body: Buffer | string | null, headers: Record<string, string>,
    opts: { url?: string; ip?: string; endBody?: boolean; wait?: number } = {}) {
    const req: any = new PassThrough();
    req.method = 'POST';
    req.url = opts.url ?? '/';
    req.headers = headers;
    req.ip = opts.ip ?? '203.0.113.7';
    const res = mockRes();
    let bytesRead = 0;
    req.on('data', (c: Buffer) => { bytesRead += c.length; });
    return new Promise<{ req: any; res: ReturnType<typeof mockRes>; nextCalled: boolean; bytesRead: () => number; mwListeners: number }>(resolve => {
        // Listeners the middleware attached to the request (the harness's own counter excluded).
        const done = (nextCalled: boolean) => resolve({ req, res, nextCalled, bytesRead: () => bytesRead, mwListeners: req.listenerCount('data') - 1 });
        const origEnd = res.end.bind(res);
        res.end = (b?: string) => { origEnd(b); done(false); };
        mw(req, res, () => done(true));
        if (body !== null) {
            if (opts.endBody === false) req.write(body);
            else req.end(body);
        }
        if (opts.wait) setTimeout(() => done(false), opts.wait);
    });
}

const capture = (limit = 1000, inflate = false, timeoutMs?: number) => (req: any, res: any, next: () => void) => captureBody(req, res, next, { limit, inflate, timeoutMs });

describe('captureBody', () => {
    it('keeps the exact bytes and parses JSON', async () => {
        const raw = '{ "a": 1,\n  "b": [1, 2] }\n';
        const { req, nextCalled } = await run(capture(), raw, { 'content-type': 'application/json; charset=utf-8' });
        expect(nextCalled).toBe(true);
        expect(req.rawBody.toString('utf8')).toBe(raw);
        expect(req.body).toEqual({ a: 1, b: [1, 2] });
        expect(req._body).toBe(true);
    });

    it('flags invalid JSON instead of throwing', async () => {
        const bad = await run(capture(), '{not json', { 'content-type': 'application/json' });
        expect(bad.req.body).toEqual({});
        expect(bad.req.huloBodyInvalid).toBe(true);
        expect(bad.req.rawBody.toString()).toBe('{not json');
    });

    it('answers 413 over the limit (streamed or declared) and closes the connection', async () => {
        const big = await run(capture(1000), 'x'.repeat(2000), { 'content-type': 'application/json' });
        expect(big.nextCalled).toBe(false);
        expect(big.res.statusCode).toBe(413);
        expect(big.res.headers.connection).toBe('close');
        const declared = await run(capture(1000), '{}', { 'content-type': 'application/json', 'content-length': '999999999' });
        expect(declared.res.statusCode).toBe(413);
    });

    it('inflates gzip only where allowed, and caps the inflated size', async () => {
        const gz = gzipSync(Buffer.from('[{"event":"delivered"}]'));
        expect((await run(capture(1000, true), gz, { 'content-type': 'application/json', 'content-encoding': 'gzip' })).req.body).toEqual([{ event: 'delivered' }]);
        expect((await run(capture(1000, false), gz, { 'content-type': 'application/json', 'content-encoding': 'gzip' })).res.statusCode).toBe(415);
        expect((await run(capture(1000, true), '{}', { 'content-type': 'application/json', 'content-encoding': 'br' })).res.statusCode).toBe(415);
        // 5 KB of gzip inflating to 200 KB: refused as soon as the inflated bytes pass the cap.
        const bomb = gzipSync(Buffer.alloc(200_000, 0x20));
        expect(bomb.length).toBeLessThan(1000);
        const r = await run(capture(10_000, true), bomb, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        expect(r.res.statusCode).toBe(413);
    });

    it('gives up on a body that does not arrive in time (408) and drops what it read', async () => {
        const r = await run(capture(1000, false, 30), '{"a":', { 'content-type': 'application/json' }, { endBody: false });
        expect(r.nextCalled).toBe(false);
        expect(r.res.statusCode).toBe(408);
        expect(r.req.rawBody).toBeUndefined();
    });
});

describe('provider webhook middleware (before reading the body)', () => {
    const mw = providerWebhookBodyMiddleware(1000);
    const cfg = () => setOptions({
        publicBaseUrl: 'https://shop.example.com', rateLimit: { capacity: 1000, windowMs: 60_000 },
        providerWebhooks: { sendgrid: { verificationKey: 'k' }, ses: { topicArns: ['arn:aws:sns:eu-west-1:123456789012:t'] } },
    });

    it('unknown slug 404 without reading a byte', async () => {
        cfg();
        const unknown = await run(mw, null, { 'content-type': 'application/json', 'content-encoding': 'gzip' }, { url: '/unknownprov', wait: 30 });
        expect(unknown.res.statusCode).toBe(404);
        expect(unknown.res.body).toBe('');
        expect(unknown.res.headers.connection).toBe('close');
        const nested = await run(mw, null, { 'content-type': 'application/json' }, { url: '/sendgrid/extra', wait: 30 });
        expect(nested.res.statusCode).toBe(404);
        for (const r of [unknown, nested]) expect(r.mwListeners).toBe(0); // the body was never read
    });

    it('a provider that is not configured gets exactly the gates and the body read of a configured one (its 401 comes later, from the controller)', async () => {
        cfg(); // sendgrid configured, postmark and mailgun not
        const outcome = async (slug: string, body: string | Buffer, headers: Record<string, string>) => {
            const r = await run(mw, body, headers, { url: `/${slug}`, wait: 50, ip: `192.0.2.${slug.length}` });
            return { status: r.nextCalled ? 'next' : r.res.statusCode, conn: r.res.headers.connection ?? null, body: r.res.body, read: r.nextCalled ? r.req.rawBody?.length : null };
        };
        const cases: Array<[string | Buffer, Record<string, string>]> = [
            ['{"a":1}', { 'content-type': 'application/json' }],
            ['{"a":1}', { 'content-type': 'text/plain' }],
            [gzipSync(Buffer.from('[]')), { 'content-type': 'application/json', 'content-encoding': 'gzip' }],
            ['{}', { 'content-type': 'application/json', 'content-length': '2000000' }],
        ];
        for (const [body, headers] of cases) {
            const configured = await outcome('sendgrid', body, headers);
            for (const off of ['postmark', 'mailgun']) expect(await outcome(off, body, headers), `${off} ${JSON.stringify(headers)}`).toEqual(configured);
        }
        expect((await outcome('postmark', '{"a":1}', { 'content-type': 'application/json' })).status).toBe('next');
    });

    it('only rejected requests spend the failure allowance; once it is used up the address gets 429 before a byte is read', async () => {
        setOptions({
            publicBaseUrl: 'https://shop.example.com', providerWebhooks: { sendgrid: { verificationKey: 'k' }, rateLimit: { failed: { capacity: 3, windowMs: 60_000 } } },
        });
        const ip = '198.51.100.99';
        // Requests that pass the body checks are not charged here (the controller charges a failed verification).
        for (let i = 0; i < 20; i++) expect((await run(mw, '[]', { 'content-type': 'application/json' }, { url: '/sendgrid', ip })).nextCalled).toBe(true);
        for (let i = 0; i < 3; i++) expect((await run(mw, '[]', { 'content-type': 'text/plain' }, { url: '/sendgrid', ip, wait: 30 })).res.statusCode).toBe(415);
        const blocked = await run(mw, null, { 'content-type': 'application/json' }, { url: '/sendgrid', ip, wait: 30 });
        expect(blocked.res.statusCode).toBe(429);
        expect(blocked.res.headers['retry-after']).toBe('60');
        expect(blocked.mwListeners).toBe(0);
        // Another address is unaffected.
        expect((await run(mw, '[]', { 'content-type': 'application/json' }, { url: '/sendgrid', ip: '198.51.100.100' })).nextCalled).toBe(true);
    });

    it('JSON for every provider, text/plain for SES only, identity encoding only', async () => {
        cfg();
        const sg = await run(mw, '[{"event":"delivered"}]', { 'content-type': 'application/json' }, { url: '/sendgrid' });
        expect(sg.nextCalled).toBe(true);
        expect(sg.req.huloRateChecked).toBe(true);
        // SendGrid signs outside the body: kept as bytes, parsed by the controller once the signature verified.
        expect(sg.req.huloBodyDeferred).toBe(true);
        expect(sg.req.body).toEqual({});
        expect(parseJsonBody(sg.req.rawBody)).toEqual({ body: [{ event: 'delivered' }], invalid: false });
        const ses = await run(mw, '{"Type":"Notification"}', { 'content-type': 'text/plain; charset=UTF-8' }, { url: '/ses' });
        expect(ses.req.body).toEqual({ Type: 'Notification' });
        expect(ses.req.huloBodyDeferred).toBeUndefined();
        const sgText = await run(mw, '[]', { 'content-type': 'text/plain' }, { url: '/sendgrid', wait: 30 });
        expect(sgText.res.statusCode).toBe(415);
        const gz = await run(mw, gzipSync(Buffer.from('[]')), { 'content-type': 'application/json', 'content-encoding': 'gzip' }, { url: '/sendgrid', wait: 30 });
        expect(gz.res.statusCode).toBe(415);
        const upper = await run(mw, '[]', { 'content-type': 'application/json' }, { url: '/SendGrid?x=1' });
        expect(upper.nextCalled).toBe(true);
    });
});

describe('provider webhook bodies: parse cost before verification', () => {
    const mw = providerWebhookBodyMiddleware();
    const deep = (n: number) => '['.repeat(n) + ']'.repeat(n);

    it('SendGrid and Postmark bodies are never parsed before their check; Mailgun and SES ones are, after a nesting check', async () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com', rateLimit: { capacity: 1000, windowMs: 60_000 } }); // nothing configured
        for (const slug of ['sendgrid', 'postmark']) {
            const r = await run(mw, deep(5000), { 'content-type': 'application/json' }, { url: `/${slug}`, ip: '192.0.2.40' });
            expect([slug, r.nextCalled, r.req.huloBodyDeferred, r.req.body, r.req.rawBody.length]).toEqual([slug, true, true, {}, 10_000]);
        }
        for (const slug of ['mailgun', 'ses']) {
            const tooDeep = await run(mw, deep(WEBHOOK_MAX_JSON_DEPTH + 1), { 'content-type': 'application/json' }, { url: `/${slug}`, ip: '192.0.2.41', wait: 50 });
            expect([slug, tooDeep.nextCalled, tooDeep.res.statusCode, tooDeep.res.body, tooDeep.res.headers.connection]).toEqual([slug, false, 400, '', 'close']);
            expect(tooDeep.req.rawBody).toBeUndefined();
            const ok = await run(mw, deep(WEBHOOK_MAX_JSON_DEPTH), { 'content-type': 'application/json' }, { url: `/${slug}`, ip: '192.0.2.41' });
            expect([slug, ok.nextCalled, ok.req.huloBodyDeferred]).toEqual([slug, true, undefined]);
            // Many small arrays (flat) cost parse time too: at most WEBHOOK_MAX_JSON_CONTAINERS arrays + objects.
            const many = (n: number) => `[${Array(n - 1).fill('[]').join(',')}]`;
            const wide = await run(mw, many(WEBHOOK_MAX_JSON_CONTAINERS + 1), { 'content-type': 'application/json' }, { url: `/${slug}`, ip: '192.0.2.41', wait: 50 });
            expect([slug, wide.res.statusCode]).toEqual([slug, 400]);
            expect((await run(mw, many(WEBHOOK_MAX_JSON_CONTAINERS), { 'content-type': 'application/json' }, { url: `/${slug}`, ip: '192.0.2.41' })).nextCalled).toBe(true);
        }
    });

    it('a refused deep body spends the failure allowance like any other rejected request', async () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com', providerWebhooks: { rateLimit: { failed: { capacity: 2, windowMs: 60_000 } } } });
        const ip = '192.0.2.42';
        for (let i = 0; i < 2; i++) expect((await run(mw, deep(1000), { 'content-type': 'application/json' }, { url: '/mailgun', ip, wait: 50 })).res.statusCode).toBe(400);
        expect((await run(mw, null, { 'content-type': 'application/json' }, { url: '/mailgun', ip, wait: 30 })).res.statusCode).toBe(429);
    });

    it('caps by slug, never by configuration: 1 MB SendGrid and Postmark, 320 KB SES, 256 KB Mailgun', async () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com', rateLimit: { capacity: 1000, windowMs: 60_000 }, providerWebhooks: { mailgun: { signingKey: 'k' } } });
        expect(WEBHOOK_BODY_LIMITS).toEqual({ sendgrid: 1024 * 1024, postmark: 1024 * 1024, ses: 320 * 1024, mailgun: 256 * 1024 });
        const body = (n: number) => `{"x":"${'a'.repeat(n - 8)}"}`;
        const status = async (slug: string, n: number) => {
            const r = await run(mw, body(n), { 'content-type': 'application/json' }, { url: `/${slug}`, ip: '192.0.2.43', wait: 200 });
            return r.nextCalled ? 'next' : r.res.statusCode;
        };
        expect(await status('mailgun', 256 * 1024)).toBe('next'); // configured
        expect(await status('mailgun', 256 * 1024 + 1)).toBe(413);
        expect(await status('ses', 320 * 1024)).toBe('next'); // not configured: the same caps
        expect(await status('ses', 320 * 1024 + 1)).toBe(413);
        expect(await status('postmark', 1024 * 1024)).toBe('next');
        expect(await status('sendgrid', 1024 * 1024 + 1)).toBe(413);
    });

    it('jsonShapeWithin counts arrays and objects outside strings only; parseJsonBody never throws', () => {
        expect(jsonShapeWithin(Buffer.from('{"a":[{"b":[1]}]}'), 4)).toBe(true);
        expect(jsonShapeWithin(Buffer.from('{"a":[{"b":[1]}]}'), 3)).toBe(false);
        expect(jsonShapeWithin(Buffer.from('{"a":[{"b":[1]}]}'), 4, 4)).toBe(true);
        expect(jsonShapeWithin(Buffer.from('{"a":[{"b":[1]}]}'), 4, 3)).toBe(false);
        expect(jsonShapeWithin(Buffer.from(`{"s":"${'['.repeat(100)}\\\"${'{'.repeat(100)}"}`), 1, 1)).toBe(true);
        expect(jsonShapeWithin(Buffer.from(deep(1_000_000)), 32)).toBe(false);
        expect(parseJsonBody(Buffer.from('\uFEFF{"a":1}'))).toEqual({ body: { a: 1 }, invalid: false });
        expect(parseJsonBody(Buffer.from('  '))).toEqual({ body: {}, invalid: false });
        expect(parseJsonBody(Buffer.from('{nope'))).toEqual({ body: {}, invalid: true });
        expect(parseJsonBody(undefined)).toEqual({ body: {}, invalid: false });
    });
});

describe('bounce middleware', () => {
    const mw = bounceBodyMiddleware(1000);

    it('reads nothing while the endpoint is disabled (the controller answers 503)', async () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com' });
        const r = await run(mw, null, { 'content-type': 'application/json' }, { wait: 30 });
        expect(r.nextCalled).toBe(true);
        expect(r.req._body).toBe(true);
        expect(r.req.rawBody).toBeUndefined();
        expect(r.mwListeners).toBe(0);
    });

    it('application/json only: a text/plain or form post (a cross-site "simple" request) is refused', async () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com', allowUnauthenticatedBounceWebhook: true, rateLimit: { capacity: 1000, windowMs: 60_000 } });
        const text = await run(mw, '{"messageId":"m","status":"complained"}', { 'content-type': 'text/plain;charset=UTF-8' }, { wait: 30 });
        expect(text.res.statusCode).toBe(415);
        const form = await run(mw, 'messageId=m&status=complained', { 'content-type': 'application/x-www-form-urlencoded' }, { wait: 30 });
        expect(form.res.statusCode).toBe(415);
        const ok = await run(mw, '{"messageId":"m"}', { 'content-type': 'application/json' });
        expect(ok.nextCalled).toBe(true);
        expect(ok.req.rawBody.toString()).toBe('{"messageId":"m"}');
        // gzip is inflated here, as the global parser did before 0.16.0.
        const gz = await run(mw, gzipSync(Buffer.from('{"messageId":"z"}')), { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        expect(gz.req.body).toEqual({ messageId: 'z' });
        const big = await run(mw, `{"x":"${'a'.repeat(2000)}"}`, { 'content-type': 'application/json' });
        expect(big.res.statusCode).toBe(413);
    });

    it('leaves sub-paths and already-parsed requests alone', async () => {
        setOptions({ publicBaseUrl: 'https://shop.example.com', allowUnauthenticatedBounceWebhook: true });
        const sub = await run(mw, '{}', { 'content-type': 'text/plain' }, { url: '/x' });
        expect(sub.nextCalled).toBe(true);
        const req: any = { method: 'POST', url: '/', headers: { 'content-type': 'application/json' }, _body: true };
        let called = false;
        mw(req, mockRes(), () => { called = true; });
        expect(called).toBe(true);
    });
});
