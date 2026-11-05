/**
 * Minutes by which the database's naive "now" (what column defaults such as
 * CURRENT_TIMESTAMP write: Vendure's history, `email_log.createdAt`), read
 * back through the driver, is off from this process's clock; null when it
 * cannot be told (sqlite, a failed query). Non-zero means the Node process
 * and the database session use different time zones (or clocks): the
 * timestamps this process writes (`email_event.occurredAt`) and those the
 * database writes then disagree by that much on the timeline and the PDF.
 */
export async function databaseClockSkewMinutes(query: (sql: string) => Promise<any>, type: string, nowMs = Date.now()): Promise<number | null> {
    if (!/^(mysql|mariadb|postgres)$/.test(type)) return null;
    try {
        const rows = await query('SELECT LOCALTIMESTAMP AS `dbNow`');
        const v = Array.isArray(rows) ? rows[0]?.dbNow : undefined;
        const t = v instanceof Date ? v.getTime() : typeof v === 'string' ? new Date(v.replace(' ', 'T')).getTime() : NaN;
        return Number.isFinite(t) ? Math.round((t - nowMs) / 60_000) : null;
    } catch {
        return null;
    }
}
