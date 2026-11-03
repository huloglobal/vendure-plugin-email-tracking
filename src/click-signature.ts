import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Binds a tracked click link to its destination: `s` on
 * `/email-track/click/<id>.<hmac>?u=<url>&s=<sig>` is an HMAC over the
 * token AND the URL, so a recipient cannot swap `u` for another site and
 * use the shop's domain as an open redirector.
 */
export function clickSignature(token: string, url: string, secret: string): string {
    return createHmac('sha256', secret).update(`click|${token}|${url}`).digest('hex').slice(0, 32);
}

export function verifyClickSignature(token: string, url: string, sig: unknown, secret: string | undefined): boolean {
    if (!secret || typeof sig !== 'string' || !/^[0-9a-f]{32}$/i.test(sig)) return false;
    const a = Buffer.from(clickSignature(token, url, secret), 'utf8');
    const b = Buffer.from(sig.toLowerCase(), 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
}

/** The `href` the rewriters embed for one link. */
export function trackedClickHref(base: string, token: string, target: string, secret: string | undefined): string {
    const sig = secret && token.includes('.') ? `&s=${clickSignature(token, target, secret)}` : '';
    return `${base}/email-track/click/${token}?u=${encodeURIComponent(target)}${sig}`;
}
