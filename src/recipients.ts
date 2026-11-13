/**
 * Recipient lists, suppression exemptions and the bounce webhook's strict
 * vocabulary (0.17.0). Pure functions: no database, no options.
 */

/** One address inside a To / Cc header (display names, quotes and angle brackets around it are ignored). */
const ADDRESS_IN_LIST = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/g;

/** A single bare address, as the suppression list stores it (lower-cased, at most 320 characters). */
export function normaliseAddress(raw: unknown): string {
    const s = String(raw ?? '').trim();
    const m = s.match(ADDRESS_IN_LIST);
    return m ? m[0].toLowerCase().slice(0, 320) : '';
}

/**
 * Every distinct address of a recipient value: a comma-joined header
 * (`a@x.com, "Doe, Jane" <j@x.com>`), an array of them, or nodemailer's
 * `{ name, address }` objects. Lower-cased, in order, without duplicates.
 */
export function splitRecipients(to: unknown): string[] {
    const parts: string[] = [];
    const add = (v: unknown) => {
        if (!v) return;
        if (Array.isArray(v)) { v.forEach(add); return; }
        if (typeof v === 'object' && (v as any).address) { parts.push(String((v as any).address)); return; }
        parts.push(String(v));
    };
    add(to);
    const out: string[] = [];
    for (const p of parts) {
        for (const m of p.match(ADDRESS_IN_LIST) || []) {
            const a = m.toLowerCase().slice(0, 320);
            if (!out.includes(a)) out.push(a);
        }
    }
    return out;
}

/** True when `raw` is exactly one valid-looking e-mail address (after normalising). */
export function isAddress(raw: unknown): boolean {
    const s = String(raw ?? '').trim();
    return /^[^\s@<>,"]{1,64}@[^\s@<>,"]{1,255}$/.test(s) && normaliseAddress(s) === s.toLowerCase();
}

/**
 * E-mail types that are always sent, even to a suppressed address: a
 * password reset is how someone gets back into their account. Only a type
 * the sender gave counts (Vendure's EmailPlugin event type, or `meta.type`
 * of `sendTracked`), never one guessed from the subject. Same default as the
 * WordPress plugin.
 */
export const DEFAULT_SUPPRESSION_EXEMPT_TYPES: readonly string[] = ['password-reset'];

export function isSuppressionExempt(type: string | null | undefined, exempt: readonly string[] = DEFAULT_SUPPRESSION_EXEMPT_TYPES): boolean {
    return !!type && exempt.includes(String(type));
}

// ── Bounce webhook (POST /email-track/bounce) ─────────────────────────────

/** `status` values (any case) the bounce webhook accepts. Nothing else is recorded. */
export const BOUNCE_STATUSES: Readonly<Record<string, 'bounced' | 'complained'>> = {
    bounced: 'bounced', bounce: 'bounced', complained: 'complained', complaint: 'complained',
};

/**
 * `bounceType` values (any case; spaces, `-` and `_` ignored) → soft?
 * Required for a bounce: a report that does not say which kind it is never
 * suppresses anyone.
 */
export const BOUNCE_TYPES: Readonly<Record<string, boolean>> = {
    hard: false, hardbounce: false, permanent: false,
    soft: true, softbounce: true, transient: true, temporary: true,
};

export type ParsedBounce =
    | { ok: true; status: 'bounced' | 'complained'; soft: boolean; recipient: string | null }
    | { ok: false; error: string };

/**
 * The strict reading of a bounce webhook body (as the WordPress plugin
 * 0.1.1): `status` must be a bounce or a complaint, a bounce must say
 * whether it is hard or soft, and an optional `recipient` (or `email`) must
 * be one address. Anything else (a relay forwarding deliveries or opens, a
 * provider's own status words) is refused and changes nothing.
 */
export function parseBounceBody(body: any): ParsedBounce {
    const str = (k: string) => (body && (typeof body[k] === 'string' || typeof body[k] === 'number') ? String(body[k]) : '');
    const status = BOUNCE_STATUSES[str('status').trim().toLowerCase()];
    if (!status) return { ok: false, error: 'status must be "bounced" or "complained"; other events are not recorded' };
    let soft = false;
    if (status === 'bounced') {
        const kind = str('bounceType').toLowerCase().replace(/[\s_-]+/g, '');
        if (!(kind in BOUNCE_TYPES)) return { ok: false, error: 'bounceType must be "hard" or "soft" for a bounce' };
        soft = BOUNCE_TYPES[kind];
    }
    const named = str('recipient') || str('email');
    if (named && !isAddress(named)) return { ok: false, error: 'recipient must be one email address' };
    return { ok: true, status, soft, recipient: named ? normaliseAddress(named) : null };
}

/**
 * The addresses a hard bounce or complaint puts on the suppression list:
 * the one the report names (it must be one of the e-mail's recipients),
 * else the e-mail's only recipient. An e-mail to several people with no
 * address named suppresses nobody, so one dead mailbox never stops mail to
 * the others. `matched` is false when a named address is not a recipient.
 */
export function suppressionTargets(emailRecipients: unknown, named: string | null): { matched: boolean; targets: string[] } {
    const to = splitRecipients(emailRecipients);
    if (named) {
        const n = normaliseAddress(named);
        return to.includes(n) ? { matched: true, targets: [n] } : { matched: false, targets: [] };
    }
    return { matched: true, targets: to.length === 1 ? to : [] };
}
