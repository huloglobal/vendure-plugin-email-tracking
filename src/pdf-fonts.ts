/**
 * Standard-14 font metrics for the PDF writer: advance widths in 1/1000 em
 * for WinAnsiEncoding codes 32..255, taken from Adobe's Helvetica and
 * Helvetica-Bold AFM files (undefined WinAnsi codes are 0 and never emitted).
 */
/** Helvetica advance widths (1/1000 em), WinAnsiEncoding codes 32..255. */
export const HELVETICA_WIDTHS: readonly number[] = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 0,
    556, 0, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0,
    0, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 0, 500, 667,
    278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333,
    400, 584, 333, 333, 333, 578, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611,
    667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
    722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
    556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500,
];
/** Helvetica-Bold advance widths (1/1000 em), WinAnsiEncoding codes 32..255. */
export const HELVETICA_BOLD_WIDTHS: readonly number[] = [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
    333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
    611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584, 0,
    556, 0, 278, 556, 500, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0,
    0, 278, 278, 500, 500, 350, 556, 1000, 333, 1000, 556, 333, 944, 0, 500, 667,
    278, 333, 556, 556, 556, 556, 280, 556, 333, 737, 370, 556, 584, 333, 737, 333,
    400, 584, 333, 333, 333, 611, 556, 278, 333, 333, 365, 556, 834, 834, 834, 611,
    722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278,
    722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
    556, 556, 556, 556, 556, 556, 889, 556, 556, 556, 556, 556, 278, 278, 278, 278,
    611, 611, 611, 611, 611, 611, 611, 584, 611, 611, 611, 611, 611, 556, 611, 556,
];

/** Unicode code points WinAnsiEncoding places in 0x80..0x9F. */
const CP1252_HIGH: Record<number, number> = {
    0x20ac: 128, 0x201a: 130, 0x0192: 131, 0x201e: 132, 0x2026: 133, 0x2020: 134, 0x2021: 135, 0x02c6: 136,
    0x2030: 137, 0x0160: 138, 0x2039: 139, 0x0152: 140, 0x017d: 142, 0x2018: 145, 0x2019: 146, 0x201c: 147,
    0x201d: 148, 0x2022: 149, 0x2013: 150, 0x2014: 151, 0x02dc: 152, 0x2122: 153, 0x0161: 154, 0x203a: 155,
    0x0153: 156, 0x017e: 158, 0x0178: 159,
};

/** Characters outside WinAnsi with a readable ASCII / WinAnsi stand-in. */
const TRANSLITERATE: Record<string, string> = {
    '\u2192': '->', '\u2190': '<-', '\u2194': '<->', '\u21d2': '=>', '\u21d0': '<=', '\u2264': '<=', '\u2265': '>=',
    '\u2260': '!=', '\u2248': '~', '\u2212': '-', '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2015': '-',
    '\u2032': "'", '\u2033': '"', '\u2713': 'OK', '\u2714': 'OK', '\u2717': 'x', '\u2718': 'x',
    '\u2009': ' ', '\u200a': ' ', '\u202f': ' ', '\u2002': ' ', '\u2003': ' ', '\u2007': ' ', '\u2008': ' ',
    '\u0141': 'L', '\u0142': 'l', '\u0110': 'D', '\u0111': 'd', '\u0131': 'i', '\u0126': 'H', '\u0127': 'h',
    '\u0166': 'T', '\u0167': 't', '\u014a': 'N', '\u014b': 'n', '\u0138': 'k', '\u013f': 'L', '\u0140': 'l',
    '\u0149': "'n", '\u017f': 's', '\u0132': 'IJ', '\u0133': 'ij', '\u1e9e': 'SS',
};

/** One character as WinAnsi codes: itself, a stand-in, or its base letter (accents dropped); `?` as the last resort. */
function winAnsiOf(ch: string, out: number[]): void {
    const cp = ch.codePointAt(0) as number;
    if (cp === 9 || cp === 10 || cp === 13) { out.push(32); return; }
    if (cp < 32 || cp === 127) return;
    if (cp < 127 || (cp >= 160 && cp <= 255)) { out.push(cp); return; }
    const high = CP1252_HIGH[cp];
    if (high !== undefined) { out.push(high); return; }
    const sub = TRANSLITERATE[ch];
    if (sub !== undefined) { for (const c of sub) out.push(c.charCodeAt(0)); return; }
    // Latin letters with diacritics outside Latin-1 (ă, ő, ś, ž without a CP1252 slot …): the base letter.
    const base = ch.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    if (base && base !== ch && [...base].every(c => { const b = c.codePointAt(0) as number; return (b >= 32 && b < 127) || (b >= 160 && b <= 255); })) {
        for (const c of base) out.push(c.codePointAt(0) as number);
        return;
    }
    out.push(63);
}

/**
 * A string as WinAnsiEncoding byte codes. Tabs and line breaks become
 * spaces, other control characters are dropped. A character outside WinAnsi
 * becomes a readable stand-in (→ as `->`, ≥ as `>=`, Ł as `L`, ő as `o` —
 * the base letter of any accented Latin letter); anything else (Cyrillic,
 * Greek, CJK, emoji) becomes `?`.
 */
export function toWinAnsiCodes(text: string): number[] {
    const out: number[] = [];
    for (const ch of String(text ?? '')) winAnsiOf(ch, out);
    return out;
}

/** Advance width of one WinAnsi code in 1/1000 em. */
export function glyphWidth(code: number, bold: boolean): number {
    const w = (bold ? HELVETICA_BOLD_WIDTHS : HELVETICA_WIDTHS)[code - 32];
    return w || 556;
}
