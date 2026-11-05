import { describe, expect, it } from 'vitest';
import { createHmac, createSign, generateKeyPairSync, sign } from 'crypto';
import {
    CERT_FAILURE_TTL_MS, CERT_FETCHES_PER_CLIENT_PER_MINUTE, CERT_FETCHES_PER_MINUTE, CertCache, confirmSnsSubscription, isValidSnsCertUrl, isValidSnsSubscribeUrl, parseSendgridKey, readCapped, ReplayCache,
    safeEqualStrings, SENDGRID_MAX_SKEW_SEC, snsHostForTopic, snsStringToSign, snsTopicRegion, verifyMailgunSignature, verifyPostmarkAuth,
    verifySendgridSignature, verifySnsMessage,
} from './webhook-verify';

// Self-signed test fixture (CN=sns.amazonaws.com), valid 2026-11-04 → 2126; never a real AWS key.
const SNS_TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDUzCCAjugAwIBAgIUE07BEwzmwrco6NmKpaclv/0vToUwDQYJKoZIhvcNAQEL
BQAwODEaMBgGA1UEAwwRc25zLmFtYXpvbmF3cy5jb20xGjAYBgNVBAoMEUhVTE8g
dGVzdCBmaXh0dXJlMCAXDTI2MTEwNDE4MTMzNloYDzIxMjYxMDExMTgxMzM2WjA4
MRowGAYDVQQDDBFzbnMuYW1hem9uYXdzLmNvbTEaMBgGA1UECgwRSFVMTyB0ZXN0
IGZpeHR1cmUwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCM0YHZNB29
ye4uMYjBeqngEX9nlxB5K1MBf1BZPHLQ4e8s037TPRyyL4m3Ml3zWshwQLITqi7v
IDNg+zuhrMg564GJpV2dPLxdu7KX9xyV02bc3LzZg3ZWgMJkrO6xNMeLPpV46bp6
4cf2/kqiTKFWU5jo7eonlywuZ+KoBpYCYCs/AjxqH25o49CRnZeLmB6sQSCEVDB6
5nMk5iHl+WG+so1G0XOXf1dSBqZf4hqvO7BmGAaLiy3Rr/D6wbdCYoebrFMScCfV
aaplVJT04GmuH/saLR8UYbrqoFueZNjJnY/5B5PubPsNNn2HrBkhKA2sfKYe4p74
reGv7XRuumXFAgMBAAGjUzBRMB0GA1UdDgQWBBRmfiavxLiXFM73bzEGvw8rkdK2
xDAfBgNVHSMEGDAWgBRmfiavxLiXFM73bzEGvw8rkdK2xDAPBgNVHRMBAf8EBTAD
AQH/MA0GCSqGSIb3DQEBCwUAA4IBAQBoiuT3J1zZevTok3xOhZRQcgM/JFI0Dp4o
i1lMVNioCSH+t+Hs2niAjxZHHMV+m98XV2NSJuTjmTL+EWAzP/Ze2VnY4soKfYG5
OvOwRcv4hOdP7d4qbAAP6Ukiv4aJrGs8VEd2biqxEl36g8bDHGG2iY3ADMICzjHu
h6nC7r2TZY59Hl61mCxuzfuncoWwauY+sW33HrYQ7Ij0odWeudXuhPvw269ralQl
xn/kr5A3JKkOHlQeJ+Yuy3PhJ0lizKbbn+M2I/QGbMbgdmmkf67UBxyJi1OzSYYx
KvQMnp6V9BPk5hVpVnXD79g4ASGO16WKPLAwIDRGli6PKqD8ec+y
-----END CERTIFICATE-----`;
const SNS_TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCM0YHZNB29ye4u
MYjBeqngEX9nlxB5K1MBf1BZPHLQ4e8s037TPRyyL4m3Ml3zWshwQLITqi7vIDNg
+zuhrMg564GJpV2dPLxdu7KX9xyV02bc3LzZg3ZWgMJkrO6xNMeLPpV46bp64cf2
/kqiTKFWU5jo7eonlywuZ+KoBpYCYCs/AjxqH25o49CRnZeLmB6sQSCEVDB65nMk
5iHl+WG+so1G0XOXf1dSBqZf4hqvO7BmGAaLiy3Rr/D6wbdCYoebrFMScCfVaapl
VJT04GmuH/saLR8UYbrqoFueZNjJnY/5B5PubPsNNn2HrBkhKA2sfKYe4p74reGv
7XRuumXFAgMBAAECggEAF18KOv9gVEh4ZGhKNzphiVO+HnY/AK1FGIGF11mmAK8O
4BS1/t8srRIgvCv61dHiZGcIZyUepwdkH5ty2TFxBdPlau/sKpWS+ceWK4ySzPcK
ImvsV/luoYq7OLRO5VBKMf0QF8JK9ewVIRQxVOB9AnPbdAVQkIORjJ4nSxXUvc3z
OALHm7tMQaf3Dgq1J4FTCr+eMJq7lByqda9ViV0DcxHgYvNZC93XkYpSEo9ELTzB
xE75jJ/pdvdcAxBlA4CgAZocKULdCwbWMcIcTfiosQDIVOeuSA+q6NE8GjTJSbCC
JAboFEZD6v81afEB9UjbIiW5meo63IikalmEOigEfQKBgQDAPJvps6+HBHZ3UBmH
WlbD7eDxH7ONVzljQx+3OHagOQ1id6IPdfl8CzANqC4/tHl6y8Geg5Fbs6dVE7dS
UD/WjYJAHff5Q139CnZL483loeKTXi7qyvTLt7Rpz9z0TQWNUAR7pHcSTER2FBbQ
HYYAano+7QWKX45nxEM/f835gwKBgQC7htAOKgAn27OuRHakpuBfqTOQALIkx1zK
iXMeMXavuhlabTAY57ipCsb6UuPsAfZRWaS2spOmOcleWJ2D8e6kSySkkBaYS91I
XzcbwhYyAnYYZvUdcIUVOLVFxcEq0wW9H19+jFLfGQmOKt7ucPAoWPvXrmtoRhmX
7dTvNEEpFwKBgAkiWB4wpYR6184vhicCSeEhanDKmtN6c4Wd6OHh0vEmBNbK7G5j
oqkcNvpPJXNtdeA50kdf5QZAcRD/0NQecAoXyzqUsfWsF8kwOBK/Dkd8+7EY5o3N
evg7EF1+vPb2ue7PAIeHdwjtiss5hSP6YyWd6ZUX2g2LIM8ZakCYKAdVAoGBAJdx
zY7SzqNh5B9l/ScF+ghnflParAPV2ZNcI9MLgV1zfswvh/tlEBW8tWsuDBHql8Gl
EsfVOjaxTnXaPQN1HBQk92fLUeQWyJONCdVqDkC/Ch6071miKGg2DvdVOKZcG7Nb
peRucPLppnThHH8WSG1dR64sl2Nz0XGISkIQQltrAoGAfYhaqydZBBIWWNy6KJ8f
gpKiAscxWjZD4vt/LmQEYKH4gfipYVADZQACpYIe8fYm4sa5GneSCVd3Ti01bqL2
ITehV0antBy1cxk/nazX5Toih9cc6dUDarPVsk+eEDfI8AGd/38MfQvAcbt0KvO+
saZHeJahbeTbUKsvh0s91Es=
-----END PRIVATE KEY-----`;

describe('Postmark Basic auth', () => {
    const cfg = { username: 'hooks', password: 's3cret:with:colons' };
    const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
    it('accepts the configured pair only', () => {
        expect(verifyPostmarkAuth(basic('hooks', 's3cret:with:colons'), cfg)).toBe(true);
        expect(verifyPostmarkAuth(basic('hooks', 'wrong'), cfg)).toBe(false);
        expect(verifyPostmarkAuth(basic('other', 's3cret:with:colons'), cfg)).toBe(false);
        expect(verifyPostmarkAuth(undefined, cfg)).toBe(false);
        expect(verifyPostmarkAuth('Bearer abc', cfg)).toBe(false);
        expect(verifyPostmarkAuth(`Basic ${Buffer.from('nocolon').toString('base64')}`, cfg)).toBe(false);
    });
    it('is never satisfied when not configured', () => {
        expect(verifyPostmarkAuth(basic('', ''), undefined)).toBe(false);
        expect(verifyPostmarkAuth(basic('', ''), { username: '', password: '' })).toBe(false);
    });
    it('compares in constant time whatever the lengths', () => {
        expect(safeEqualStrings('a', 'a')).toBe(true);
        expect(safeEqualStrings('a', 'ab')).toBe(false);
    });
});

describe('SendGrid ECDSA P-256 signature', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const der = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    const pem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
    const raw = Buffer.from('[{"email":"a@example.com","event":"bounce","sg_event_id":"x1"}]\r\n');
    const ts = '1762250000';
    const sig = sign('sha256', Buffer.concat([Buffer.from(ts), raw]), { key: privateKey, dsaEncoding: 'der' }).toString('base64');

    const now = Number(ts) * 1000 + 60_000;

    it('accepts the key as base64 DER (SendGrid UI) and as PEM', () => {
        expect(verifySendgridSignature(parseSendgridKey(der), sig, ts, raw, now)).toBe(true);
        expect(verifySendgridSignature(parseSendgridKey(pem), sig, ts, raw, now)).toBe(true);
    });
    it('rejects a changed body (even whitespace), timestamp or signature', () => {
        const key = parseSendgridKey(der);
        expect(verifySendgridSignature(key, sig, ts, Buffer.from(raw.toString().trim()), now)).toBe(false);
        expect(verifySendgridSignature(key, sig, '1762250001', raw, now)).toBe(false);
        expect(verifySendgridSignature(key, sig.replace(/^./, c => (c === 'A' ? 'B' : 'A')), ts, raw, now)).toBe(false);
        expect(verifySendgridSignature(key, undefined, ts, raw, now)).toBe(false);
        expect(verifySendgridSignature(key, sig, ts, undefined, now)).toBe(false);
    });
    it('refuses a validly signed request whose timestamp is more than 72 hours from now (replay)', () => {
        const key = parseSendgridKey(der);
        const t = Number(ts) * 1000;
        expect(verifySendgridSignature(key, sig, ts, raw, t + (SENDGRID_MAX_SKEW_SEC - 60) * 1000)).toBe(true);   // a late retry
        expect(verifySendgridSignature(key, sig, ts, raw, t + (SENDGRID_MAX_SKEW_SEC + 60) * 1000)).toBe(false);  // captured, replayed later
        expect(verifySendgridSignature(key, sig, ts, raw, t - (SENDGRID_MAX_SKEW_SEC + 60) * 1000)).toBe(false);  // from the future
        const old = '1420070400'; // 2015-01-01
        const oldSig = sign('sha256', Buffer.concat([Buffer.from(old), raw]), { key: privateKey, dsaEncoding: 'der' }).toString('base64');
        expect(verifySendgridSignature(key, oldSig, old, raw, Date.parse('2026-11-04T12:00:00Z'))).toBe(false);
    });
    it('refuses a key that is not EC P-256, and a missing key', () => {
        const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ format: 'pem', type: 'spki' }).toString();
        expect(parseSendgridKey(rsa)).toBeNull();
        const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ format: 'pem', type: 'spki' }).toString();
        expect(parseSendgridKey(p384)).toBeNull();
        expect(parseSendgridKey('not a key')).toBeNull();
        expect(verifySendgridSignature(null, sig, ts, raw, now)).toBe(false);
    });
});

describe('Mailgun HMAC + replay window', () => {
    const key = 'key-mailgun-test';
    const mk = (timestamp: number, token: string) => ({
        timestamp: String(timestamp), token,
        signature: createHmac('sha256', key).update(String(timestamp) + token).digest('hex'),
    });
    it('accepts a fresh, correctly signed token once', () => {
        const now = 1_762_250_000_000;
        const cache = new ReplayCache();
        const s = mk(now / 1000, 'tok-1');
        expect(verifyMailgunSignature(s, key, cache, now)).toBe('ok');
        cache.add('tok-1', now);
        expect(verifyMailgunSignature(s, key, cache, now + 1000)).toBe('replay');
    });
    it('rejects timestamps more than 15 minutes off, either way', () => {
        const now = 1_762_250_000_000;
        const cache = new ReplayCache();
        expect(verifyMailgunSignature(mk(now / 1000 - 16 * 60, 'old'), key, cache, now)).toBe('stale');
        expect(verifyMailgunSignature(mk(now / 1000 + 16 * 60, 'future'), key, cache, now)).toBe('stale');
        expect(verifyMailgunSignature(mk(now / 1000 - 14 * 60, 'recent'), key, cache, now)).toBe('ok');
    });
    it('rejects a wrong key, a tampered token and malformed blocks', () => {
        const now = 1_762_250_000_000;
        const cache = new ReplayCache();
        const s = mk(now / 1000, 'tok-2');
        expect(verifyMailgunSignature(s, 'other-key', cache, now)).toBe('bad-signature');
        expect(verifyMailgunSignature({ ...s, token: 'tok-3' }, key, cache, now)).toBe('bad-signature');
        expect(verifyMailgunSignature({ ...s, signature: 'zz' }, key, cache, now)).toBe('bad-signature');
        expect(verifyMailgunSignature(undefined, key, cache, now)).toBe('bad-signature');
        expect(verifyMailgunSignature(s, undefined, cache, now)).toBe('bad-signature');
    });
    it('a reserved token refuses concurrent duplicates; releasing it lets the provider retry', () => {
        const now = 1_762_250_000_000;
        const cache = new ReplayCache();
        const s = mk(now / 1000, 'tok-race');
        // The controller reserves right after "ok", before any await: a second in-flight request is a replay.
        expect(verifyMailgunSignature(s, key, cache, now)).toBe('ok');
        cache.add('tok-race', now);
        expect(verifyMailgunSignature(s, key, cache, now)).toBe('replay');
        // Processing failed (500): released, so Mailgun's retry of the same signature is accepted.
        cache.delete('tok-race');
        expect(verifyMailgunSignature(s, key, cache, now + 5000)).toBe('ok');
    });
    it('the replay cache is bounded and forgets expired tokens', () => {
        const cache = new ReplayCache(100, 1000);
        for (let i = 0; i < 250; i++) cache.add(`t${i}`, 0);
        expect(cache.size).toBeLessThanOrEqual(100);
        expect(cache.has('t249', 10)).toBe(true);
        expect(cache.has('t249', 5000)).toBe(false);
    });
});

describe('Amazon SNS signature (SES)', () => {
    const TOPIC = 'arn:aws:sns:eu-west-1:123456789012:ses-events';
    const CERT_URL = 'https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem';
    // The test certificate is valid from 2026-11-04T18:13:36Z.
    const NOW = Date.parse('2026-11-05T12:05:00Z');
    const signMsg = (m: any, version: '1' | '2', certUrl = CERT_URL) => {
        const out = { ...m, SignatureVersion: version, SigningCertURL: certUrl };
        const s = createSign(version === '1' ? 'RSA-SHA1' : 'RSA-SHA256');
        s.update(snsStringToSign(out)!);
        out.Signature = s.sign(SNS_TEST_KEY, 'base64');
        return out;
    };
    const notification = {
        Type: 'Notification', MessageId: '22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324', TopicArn: TOPIC, Subject: 'Amazon SES Email Event Notification',
        Message: JSON.stringify({ notificationType: 'Bounce', bounce: { bounceType: 'Permanent' } }), Timestamp: '2026-11-05T12:00:00.000Z',
    };
    const fetcher = () => {
        const calls: string[] = [];
        return { calls, fetchCert: async (url: string) => { calls.push(url); return SNS_TEST_CERT; } };
    };

    it('builds the canonical string per Type (Subject only when present)', () => {
        expect(snsStringToSign(notification)).toBe(
            `Message\n${notification.Message}\nMessageId\n${notification.MessageId}\nSubject\n${notification.Subject}\nTimestamp\n${notification.Timestamp}\nTopicArn\n${TOPIC}\nType\nNotification\n`);
        const { Subject, ...noSubject } = notification;
        expect(snsStringToSign(noSubject)).not.toContain('Subject');
        const conf = { Type: 'SubscriptionConfirmation', Message: 'm', MessageId: 'id', SubscribeURL: 'https://x', Timestamp: 't', Token: 'tok', TopicArn: TOPIC };
        expect(snsStringToSign(conf)).toBe(`Message\nm\nMessageId\nid\nSubscribeURL\nhttps://x\nTimestamp\nt\nToken\ntok\nTopicArn\n${TOPIC}\nType\nSubscriptionConfirmation\n`);
        expect(snsStringToSign({ ...conf, Token: undefined })).toBeNull();
        expect(snsStringToSign({ Type: 'Other' })).toBeNull();
    });

    it('verifies SignatureVersion 1 (SHA1withRSA) and 2 (SHA256withRSA) through the injected fetcher, caching the certificate', async () => {
        const f = fetcher();
        const cache = new CertCache();
        expect(await verifySnsMessage(signMsg(notification, '1'), [TOPIC], { fetchCert: f.fetchCert, cache, now: NOW })).toBe('ok');
        expect(await verifySnsMessage(signMsg(notification, '2'), [TOPIC], { fetchCert: f.fetchCert, cache, now: NOW })).toBe('ok');
        expect(f.calls).toEqual([CERT_URL]); // second message used the cache
    });

    it('rejects a tampered message, an unknown version and a bad signature', async () => {
        const f = fetcher();
        const good = signMsg(notification, '2');
        const deps = { fetchCert: f.fetchCert, cache: new CertCache(), now: NOW };
        expect(await verifySnsMessage({ ...good, Message: good.Message.replace('Permanent', 'Transient') }, [TOPIC], deps)).toBe('bad-signature');
        expect(await verifySnsMessage({ ...good, SignatureVersion: '3' }, [TOPIC], deps)).toBe('bad-signature');
        expect(await verifySnsMessage({ ...good, Signature: Buffer.from('nope').toString('base64') }, [TOPIC], deps)).toBe('bad-signature');
    });

    it('checks the body TopicArn against the allowlist before fetching anything', async () => {
        const f = fetcher();
        const msg = signMsg({ ...notification, TopicArn: 'arn:aws:sns:eu-west-1:999999999999:other' }, '2');
        expect(await verifySnsMessage(msg, [TOPIC], { fetchCert: f.fetchCert, cache: new CertCache(), now: NOW })).toBe('topic-not-allowed');
        expect(await verifySnsMessage(signMsg(notification, '2'), [], { fetchCert: f.fetchCert, cache: new CertCache(), now: NOW })).toBe('bad-signature');
        expect(f.calls).toEqual([]);
    });

    it('refuses messages older than 24 hours or from the future, before fetching anything (replay)', async () => {
        const f = fetcher();
        const deps = { fetchCert: f.fetchCert, cache: new CertCache(), now: NOW };
        expect(await verifySnsMessage(signMsg({ ...notification, Timestamp: '2019-01-01T00:00:00.000Z' }, '2'), [TOPIC], deps)).toBe('stale');
        expect(await verifySnsMessage(signMsg({ ...notification, Timestamp: '2026-11-04T11:00:00.000Z' }, '2'), [TOPIC], deps)).toBe('stale');
        expect(await verifySnsMessage(signMsg({ ...notification, Timestamp: '2026-11-05T13:00:00.000Z' }, '2'), [TOPIC], deps)).toBe('stale');
        expect(await verifySnsMessage(signMsg({ ...notification, Timestamp: 'yesterday' }, '2'), [TOPIC], deps)).toBe('bad-signature');
        expect(f.calls).toEqual([]);
    });

    it('takes the certificate only from https://sns.<the topic\'s region>.amazonaws.com(.cn)/SimpleNotificationService-<hex>.pem', async () => {
        expect(snsTopicRegion(TOPIC)).toEqual({ partition: 'aws', region: 'eu-west-1' });
        expect(snsHostForTopic('arn:aws-cn:sns:cn-north-1:123456789012:t')).toBe('sns.cn-north-1.amazonaws.com.cn');
        expect(snsHostForTopic('arn:aws-us-gov:sns:us-gov-west-1:123456789012:t')).toBe('sns.us-gov-west-1.amazonaws.com');
        expect(snsHostForTopic('arn:aws:sns:s3:123456789012:t')).toBeNull();
        expect(isValidSnsCertUrl(CERT_URL, TOPIC)).toBe(true);
        expect(isValidSnsCertUrl('https://sns.cn-north-1.amazonaws.com.cn/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem', 'arn:aws-cn:sns:cn-north-1:123456789012:t')).toBe(true);
        for (const bad of [
            'http://sns.eu-west-1.amazonaws.com/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem',
            'https://sns.eu-west-1.amazonaws.com.evil.com/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem',
            'https://evil.com/sns.eu-west-1.amazonaws.com/x.pem', 'https://sns.eu-west-1.amazonaws.com/x.txt',
            'https://sns.eu-west-1.amazonaws.com/attacker.pem',
            'https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem?x=1',
            'https://user:pw@sns.eu-west-1.amazonaws.com/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem',
            'https://sns.eu-west-1.amazonaws.com:8443/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem',
            // Another region than the topic's, and the S3 hosts of a bucket literally named "sns".
            'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem',
            'https://sns.s3.amazonaws.com/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem',
            'https://sns.s3-us-west-2.amazonaws.com/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem',
            'https://sns.s3-external-1.amazonaws.com/x.pem', 'https://sns.x.amazonaws.com/x.pem',
            'https://s3.amazonaws.com/x.pem', 'https://169.254.169.254/latest/meta-data.pem', 42 as any,
        ]) expect(isValidSnsCertUrl(bad, TOPIC), String(bad)).toBe(false);
        const f = fetcher();
        for (const url of ['https://evil.example/cert.pem', 'https://sns.s3.amazonaws.com/attacker-bucket-object.pem']) {
            const msg = signMsg(notification, '2', url);
            expect(await verifySnsMessage(msg, [TOPIC], { fetchCert: f.fetchCert, cache: new CertCache(), now: NOW })).toBe('bad-signature');
        }
        expect(f.calls).toEqual([]);
    });

    it('rejects a certificate outside its validity dates, and a fetch failure (remembered briefly)', async () => {
        const f = fetcher();
        const later = Date.parse('2200-01-01T00:00:00Z');
        const earlier = Date.parse('2000-01-01T00:00:00Z');
        expect(await verifySnsMessage(signMsg({ ...notification, Timestamp: '2199-12-31T23:00:00.000Z' }, '2'), [TOPIC], { ...f, cache: new CertCache(), now: later })).toBe('bad-signature');
        expect(await verifySnsMessage(signMsg({ ...notification, Timestamp: '1999-12-31T23:00:00.000Z' }, '2'), [TOPIC], { ...f, cache: new CertCache(), now: earlier })).toBe('bad-signature');
        let attempts = 0;
        const failing = async () => { attempts++; throw new Error('timeout'); };
        const cache = new CertCache();
        const msg = signMsg(notification, '2');
        expect(await verifySnsMessage(msg, [TOPIC], { fetchCert: failing, cache, now: NOW })).toBe('bad-signature');
        expect(await verifySnsMessage(msg, [TOPIC], { fetchCert: failing, cache, now: NOW + 1000 })).toBe('bad-signature');
        expect(attempts).toBe(1); // the failure is cached …
        expect(await verifySnsMessage(msg, [TOPIC], { fetchCert: f.fetchCert, cache, now: NOW + CERT_FAILURE_TTL_MS + 1 })).toBe('ok'); // … for a short time only
    });

    it('concurrent messages naming the same certificate share one fetch', async () => {
        let calls = 0;
        const slow = async () => { calls++; await new Promise(r => setTimeout(r, 20)); return SNS_TEST_CERT; };
        const cache = new CertCache();
        const msg = signMsg(notification, '2');
        const verdicts = await Promise.all([1, 2, 3, 4].map(() => verifySnsMessage(msg, [TOPIC], { fetchCert: slow, cache, now: NOW })));
        expect(verdicts).toEqual(['ok', 'ok', 'ok', 'ok']);
        expect(calls).toBe(1);
    });

    it('stops reading a certificate body as soon as it passes the cap', async () => {
        let served = 0;
        const chunk = new Uint8Array(16 * 1024);
        const body = { getReader: () => ({ read: async () => { served += chunk.length; return served > 20 * 1024 * 1024 ? { done: true } : { done: false, value: chunk }; }, cancel: async () => undefined }) };
        await expect(readCapped({ headers: { get: () => null }, body }, 64 * 1024)).rejects.toThrow('too large');
        expect(served).toBeLessThanOrEqual(96 * 1024);
        await expect(readCapped({ headers: { get: () => String(20 * 1024 * 1024) }, body }, 64 * 1024)).rejects.toThrow('too large');
        const small = { getReader: () => { let n = 0; return { read: async () => (n++ ? { done: true } : { done: false, value: Buffer.from('-----BEGIN CERTIFICATE-----') }), cancel: async () => undefined }; } };
        expect(await readCapped({ headers: { get: () => null }, body: small }, 64 * 1024)).toBe('-----BEGIN CERTIFICATE-----');
    });

    it('the certificate cache is bounded', () => {
        const c = new CertCache(2, 1000);
        c.set('a', 'A', 0); c.set('b', 'B', 0); c.set('c', 'C', 0);
        expect(c.size).toBe(2);
        expect(c.get('a', 1)).toBeNull();
        expect(c.get('c', 1)).toBe('C');
        expect(c.get('c', 2000)).toBeNull();
    });

    it('confirms a subscription only via the topic\'s own SNS endpoint for the same topic, or leaves it for manual confirmation', async () => {
        const urls: string[] = [];
        const okFetch = async (u: string) => { urls.push(u); return { ok: true, status: 200 }; };
        const sub = `https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(TOPIC)}&Token=abc`;
        expect(await confirmSnsSubscription({ SubscribeURL: sub, TopicArn: TOPIC }, undefined, okFetch)).toBe('confirmed');
        expect(await confirmSnsSubscription({ SubscribeURL: sub, TopicArn: TOPIC }, false, okFetch)).toBe('manual');
        expect(await confirmSnsSubscription({ SubscribeURL: 'http://169.254.169.254/latest', TopicArn: TOPIC }, true, okFetch)).toBe('rejected-url');
        expect(await confirmSnsSubscription({ SubscribeURL: sub.replace('ses-events', 'other'), TopicArn: TOPIC }, true, okFetch)).toBe('rejected-url');
        expect(await confirmSnsSubscription({ SubscribeURL: sub.replace('sns.eu-west-1', 'sns.us-east-1'), TopicArn: TOPIC }, true, okFetch)).toBe('rejected-url');
        expect(isValidSnsSubscribeUrl(sub, TOPIC)).toBe(true);
        expect(urls).toEqual([sub]);
    });
});

describe('SNS certificate URL: canonical form only, and a fetch budget', () => {
    const TOPIC = 'arn:aws:sns:eu-west-1:123456789012:ses-events';
    const CERT_URL = 'https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem';
    const NOW = Date.parse('2026-11-05T12:05:00Z');
    const notification = {
        Type: 'Notification', MessageId: '22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324', TopicArn: TOPIC,
        Message: JSON.stringify({ notificationType: 'Delivery' }), Timestamp: '2026-11-05T12:00:00.000Z',
    };
    const signMsg = (m: any, certUrl = CERT_URL) => {
        const out = { ...m, SignatureVersion: '2', SigningCertURL: certUrl };
        const s = createSign('RSA-SHA256');
        s.update(snsStringToSign(out)!);
        out.Signature = s.sign(SNS_TEST_KEY, 'base64');
        return out;
    };

    it('refuses every non-canonical spelling of the real certificate URL, before fetching anything', async () => {
        const variants = [
            'https://sns.eu-west-1.amazonaws.com:443/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem',
            'https://sns.eu-west-1.amazonaws.com/x/../SimpleNotificationService-0123456789abcdef0123456789abcdef.pem',
            'https://sns.eu-west-1.amazonaws.com/x/%2e%2e/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem',
            'https://sns.eu-west-1.amazonaws.com/Simple\tNotificationService-0123456789abcdef0123456789abcdef.pem',
            'https://SNS.eu-west-1.amazonaws.com/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem',
            'HTTPS://sns.eu-west-1.amazonaws.com/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem',
            'https://sns.eu-west-1.amazonaws.com./SimpleNotificationService-0123456789abcdef0123456789abcdef.pem',
        ];
        const calls: string[] = [];
        const fetchCert = async (u: string) => { calls.push(u); return SNS_TEST_CERT; };
        for (const v of variants) {
            expect(isValidSnsCertUrl(v, TOPIC), JSON.stringify(v)).toBe(false);
            expect(await verifySnsMessage(signMsg(notification, v), [TOPIC], { fetchCert, cache: new CertCache(), now: NOW })).toBe('bad-signature');
        }
        expect(calls).toEqual([]);
        expect(isValidSnsCertUrl(CERT_URL, TOPIC)).toBe(true);
    });

    it('one client address gets at most 2 new certificate fetches a minute, so made-up certificate URLs cannot starve the real ones', async () => {
        const cache = new CertCache(16, 1000);
        const calls: string[] = [];
        const junkFetch = async (u: string) => { calls.push(u); throw new Error('404'); };
        const junk = (i: number) => `https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-${String(i).padStart(32, 'a')}.pem`;
        // Unsigned messages naming made-up certificates on the topic's real SNS host, all from one address.
        for (let i = 0; i < 10; i++) {
            expect(await verifySnsMessage(signMsg(notification, junk(i)), [TOPIC], { fetchCert: junkFetch, cache, now: NOW + i, client: '203.0.113.200' })).toBe('bad-signature');
        }
        expect(calls).toHaveLength(CERT_FETCHES_PER_CLIENT_PER_MINUTE);
        // A genuine message from SNS (another address) in this fresh process: its certificate is still fetched.
        const good = async (u: string) => { calls.push(u); return SNS_TEST_CERT; };
        expect(await verifySnsMessage(signMsg(notification), [TOPIC], { fetchCert: good, cache, now: NOW + 20, client: '54.240.197.1' })).toBe('ok');
        expect(calls[calls.length - 1]).toBe(CERT_URL);
        // The address's own allowance comes back a minute later.
        expect(cache.tryStartFetch(NOW + 30, '203.0.113.200')).toBe(false);
        expect(cache.tryStartFetch(NOW + 61_000, '203.0.113.200')).toBe(true);
    });

    it('at most 60 new certificate fetches a minute in all; an expired copy of the same certificate still serves meanwhile', async () => {
        const cache = new CertCache(16, 1000);
        const calls: string[] = [];
        const fetchCert = async (u: string) => { calls.push(u); throw new Error('404'); };
        for (let i = 0; i < CERT_FETCHES_PER_MINUTE + 5; i++) {
            const url = `https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-${String(i).padStart(32, 'a')}.pem`;
            expect(await verifySnsMessage(signMsg(notification, url), [TOPIC], { fetchCert, cache, now: NOW + i, client: `198.51.100.${i}` })).toBe('bad-signature');
        }
        expect(calls).toHaveLength(CERT_FETCHES_PER_MINUTE);
        // The real certificate, cached earlier and past its cache lifetime: served stale while the budget is used up.
        cache.set(CERT_URL, SNS_TEST_CERT, NOW - 5000);
        const good = async (u: string) => { calls.push(u); return SNS_TEST_CERT; };
        expect(await verifySnsMessage(signMsg(notification), [TOPIC], { fetchCert: good, cache, now: NOW + 100, client: '54.240.197.1' })).toBe('ok');
        expect(calls).toHaveLength(CERT_FETCHES_PER_MINUTE);
        // A minute later the budget is back.
        expect(await verifySnsMessage(signMsg(notification), [TOPIC], { fetchCert: good, cache, now: NOW + 61_000, client: '54.240.197.1' })).toBe('ok');
        expect(calls[calls.length - 1]).toBe(CERT_URL);
    });
});
