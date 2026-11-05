/** UTF-8 byte-order mark: written before the header row so Excel reads the file as UTF-8 (→, —, Zoë). */
export const CSV_BOM = '\uFEFF';

/** Whitespace and invisible characters a spreadsheet may skip before deciding a cell is a formula. */
const LEADING_INVISIBLE = /^[\s\u00a0\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u2064\u3000\ufeff]*/;

/**
 * One CSV cell, always wrapped in double quotes (inner quotes doubled), so
 * no separator inside it splits the field in any locale — not the comma,
 * and not the semicolon that de / fr / nl spreadsheets use. A value whose
 * first visible character is = + - @ (or that starts with a tab or CR) is
 * prefixed with `'`, which Excel, LibreOffice and Google Sheets would
 * otherwise run as a formula (CSV injection). Null and undefined are empty.
 */
export function csvCell(v: unknown): string {
    if (v === null || v === undefined) return '';
    let s = v instanceof Date ? v.toISOString() : String(v);
    const lead = (LEADING_INVISIBLE.exec(s) || [''])[0];
    if (/^[\t\r]/.test(s) || /^[=+\-@]/.test(s.slice(lead.length))) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
}

/** One CSV line (no trailing newline). */
export function csvRow(cells: unknown[]): string {
    return cells.map(csvCell).join(',');
}
