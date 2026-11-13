import { normaliseAddress } from './recipients';

type Query = (sql: string, params?: any[]) => Promise<any>;

/** Addresses looked up per statement. */
const IN_CHUNK = 200;

/**
 * Which of `addresses` are on the suppression list (lower-cased, bare).
 * One `IN (…)` query per 200 addresses, through the SDK dialect adapter.
 */
export async function findSuppressed(query: Query, addresses: string[]): Promise<string[]> {
    const list = Array.from(new Set(addresses.map(normaliseAddress).filter(Boolean)));
    const out: string[] = [];
    for (let i = 0; i < list.length; i += IN_CHUNK) {
        const chunk = list.slice(i, i + IN_CHUNK);
        const marks = chunk.map(() => '?').join(', ');
        const rows = await query(`SELECT recipient FROM email_suppression WHERE recipient IN (${marks})`, chunk);
        for (const r of Array.isArray(rows) ? rows : []) {
            const a = String(r?.recipient || '').toLowerCase();
            if (a && !out.includes(a)) out.push(a);
        }
    }
    return out;
}

/** The note a partly suppressed email carries (the addresses it was not sent to). */
export function partialSuppressionNote(dropped: string[]): string {
    return dropped.length === 1
        ? `Not sent to this address on the suppression list: ${dropped[0]}`
        : `Not sent to these addresses on the suppression list: ${dropped.join(', ')}`;
}

export const SUPPRESSED_NOTE = 'Not sent: the recipient is on the suppression list';

/**
 * The send decision for one email: `skip` when it is exempt (or has no
 * address), otherwise the addresses kept and dropped.
 */
export async function suppressionDecision(query: Query, recipients: string[], exempt: boolean):
    Promise<{ kept: string[]; dropped: string[] }> {
    if (exempt || !recipients.length) return { kept: recipients, dropped: [] };
    const suppressed = await findSuppressed(query, recipients);
    if (!suppressed.length) return { kept: recipients, dropped: [] };
    return {
        kept: recipients.filter(a => !suppressed.includes(a)),
        dropped: recipients.filter(a => suppressed.includes(a)),
    };
}
