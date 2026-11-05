import { createHmac, timingSafeEqual } from 'crypto';

/** Lifetime of an evidence-report link. */
export const EVIDENCE_LINK_TTL_SEC = 300;

/**
 * What an evidence link covers: `standard` (private order notes left out)
 * or `internal-notes` (private notes printed, marked internal). Bound into
 * the HMAC, so a standard link cannot be turned into one that prints them.
 */
export type EvidenceLinkScope = 'standard' | 'internal-notes';

/** The `notes` query value of a link with this scope (absent for `standard`). */
export const INTERNAL_NOTES_PARAM = 'internal';

export function evidenceScopeFromParam(notes: unknown): EvidenceLinkScope {
    return notes === INTERNAL_NOTES_PARAM ? 'internal-notes' : 'standard';
}

function evidenceSig(orderId: number, exp: number, uid: string, scope: EvidenceLinkScope, secret: string): string {
    return createHmac('sha256', secret).update(`order-evidence|${orderId}|${exp}|${uid}|${scope}`).digest('hex');
}

/**
 * Mint the `exp` + `sig` for `GET /email-track/orders/:orderId/evidence.pdf`.
 * The HMAC covers the order id, the expiry, the admin user id and the scope,
 * so a link cannot be re-pointed at another order, extended, re-attributed
 * or widened to print internal notes.
 */
export function signEvidenceLink(orderId: number, uid: string | number, secret: string, nowMs = Date.now(), ttlSec = EVIDENCE_LINK_TTL_SEC,
    scope: EvidenceLinkScope = 'standard'): { exp: number; sig: string } {
    const exp = Math.floor(nowMs / 1000) + ttlSec;
    return { exp, sig: evidenceSig(orderId, exp, String(uid), scope, secret) };
}

export type EvidenceLinkVerdict = 'ok' | 'invalid' | 'expired';

/** Constant-time check of an evidence link; expiry is checked after the signature. */
export function verifyEvidenceLink(
    orderId: number,
    expRaw: unknown,
    uidRaw: unknown,
    sigRaw: unknown,
    secret: string | undefined,
    nowMs = Date.now(),
    ttlSec = EVIDENCE_LINK_TTL_SEC,
    scope: EvidenceLinkScope = 'standard',
): EvidenceLinkVerdict {
    if (!secret || !Number.isInteger(orderId) || orderId <= 0) return 'invalid';
    const exp = typeof expRaw === 'string' && /^\d{1,12}$/.test(expRaw) ? Number(expRaw) : (typeof expRaw === 'number' ? expRaw : NaN);
    const uid = typeof uidRaw === 'string' || typeof uidRaw === 'number' ? String(uidRaw) : '';
    const sig = typeof sigRaw === 'string' ? sigRaw.toLowerCase() : '';
    if (!Number.isInteger(exp) || !uid || uid.length > 64 || !/^[0-9a-f]{64}$/.test(sig)) return 'invalid';
    const expected = evidenceSig(orderId, exp, uid, scope, secret);
    if (!timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(sig, 'utf8'))) return 'invalid';
    const now = Math.floor(nowMs / 1000);
    // Expired, or claiming a lifetime longer than any link we mint.
    if (exp < now || exp > now + ttlSec + 60) return 'expired';
    return 'ok';
}
