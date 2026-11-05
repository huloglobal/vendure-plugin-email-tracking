import { deflateSync } from 'zlib';
import { glyphWidth, toWinAnsiCodes } from './pdf-fonts';

/**
 * A deliberately small, dependency-free PDF 1.4 writer: A4 pages, the
 * standard Helvetica and Helvetica-Bold fonts in WinAnsiEncoding, text,
 * lines and filled rectangles, Flate-compressed content streams and a
 * byte-exact cross-reference table. Enough for a tabular report; nothing
 * is embedded and no external program runs.
 */
export type PdfFont = 'regular' | 'bold';

export const A4 = { width: 595.28, height: 841.89 } as const;

/** Width of `text` in points at `size`, from the Helvetica AFM widths. */
export function measureText(text: string, font: PdfFont, size: number): number {
    let units = 0;
    for (const c of toWinAnsiCodes(text)) units += glyphWidth(c, font === 'bold');
    return (units * size) / 1000;
}

/**
 * Greedy word wrap to `maxWidth` points. Explicit line breaks are kept;
 * a word wider than the line is broken by characters. Never returns an
 * empty array (an empty string wraps to `['']`).
 */
export function wrapText(text: string, font: PdfFont, size: number, maxWidth: number): string[] {
    const lines: string[] = [];
    for (const para of String(text ?? '').split(/\r?\n/)) {
        const words = para.split(/[ \t]+/).filter(w => w.length > 0);
        if (!words.length) { lines.push(''); continue; }
        let line = '';
        for (const word of words) {
            const candidate = line ? `${line} ${word}` : word;
            if (measureText(candidate, font, size) <= maxWidth) { line = candidate; continue; }
            if (line) lines.push(line);
            if (measureText(word, font, size) <= maxWidth) { line = word; continue; }
            // Hard-break an over-long word (URLs, hashes).
            let chunk = '';
            for (const ch of word) {
                if (chunk && measureText(chunk + ch, font, size) > maxWidth) { lines.push(chunk); chunk = ch; } else chunk += ch;
            }
            line = chunk;
        }
        lines.push(line);
    }
    return lines.length ? lines : [''];
}

/** A PDF literal string: WinAnsi bytes, `\ ( )` escaped, bytes ≥ 0x80 as octal escapes (7-bit file). */
export function pdfString(text: string): string {
    let out = '(';
    for (const c of toWinAnsiCodes(text)) {
        if (c === 0x5c) out += '\\\\';
        else if (c === 0x28) out += '\\(';
        else if (c === 0x29) out += '\\)';
        else if (c >= 32 && c < 127) out += String.fromCharCode(c);
        else out += '\\' + c.toString(8).padStart(3, '0');
    }
    return out + ')';
}

/**
 * A text string for the document Info dictionary, which PDF readers decode
 * as PDFDocEncoding or UTF-16BE (not WinAnsi): printable ASCII as a literal,
 * anything else as UTF-16BE hex with a byte-order mark.
 */
export function pdfTextString(text: string): string {
    const s = String(text ?? '');
    if (/^[\x20-\x7e]*$/.test(s)) return pdfString(s);
    let hex = 'FEFF';
    for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
    return `<${hex}>`;
}

const num = (n: number): string => {
    const r = Math.round(n * 100) / 100;
    return Number.isInteger(r) ? String(r) : r.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
};

/** `D:YYYYMMDDHHmmSSZ` (UTC). */
export function pdfDate(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

export interface PdfInfo {
    title?: string;
    author?: string;
    subject?: string;
    producer?: string;
    creationDate?: Date;
}

export class PdfWriter {
    private readonly pages: string[][] = [];

    constructor(readonly width: number = A4.width, readonly height: number = A4.height, private readonly compress = true) {}

    get pageCount(): number { return this.pages.length; }

    /** Start a page; returns its index. */
    addPage(): number {
        this.pages.push([]);
        return this.pages.length - 1;
    }

    /** One line of text with its baseline at (x, y) — PDF coordinates, origin bottom-left. */
    text(page: number, x: number, y: number, text: string, font: PdfFont = 'regular', size = 9, rgb: [number, number, number] = [0, 0, 0]): void {
        const f = font === 'bold' ? 'F2' : 'F1';
        this.pages[page].push(`BT ${rgb.map(num).join(' ')} rg /${f} ${num(size)} Tf ${num(x)} ${num(y)} Td ${pdfString(text)} Tj ET`);
    }

    line(page: number, x1: number, y1: number, x2: number, y2: number, width = 0.5, gray = 0): void {
        this.pages[page].push(`${num(gray)} G ${num(width)} w ${num(x1)} ${num(y1)} m ${num(x2)} ${num(y2)} l S`);
    }

    rect(page: number, x: number, y: number, w: number, h: number, fill: [number, number, number]): void {
        this.pages[page].push(`${fill.map(num).join(' ')} rg ${num(x)} ${num(y)} ${num(w)} ${num(h)} re f`);
    }

    /** Serialise: header, objects, cross-reference table (exact byte offsets), trailer. */
    toBuffer(info: PdfInfo = {}): Buffer {
        if (!this.pages.length) this.addPage();
        const chunks: Buffer[] = [];
        let length = 0;
        const push = (b: Buffer | string) => {
            const buf = typeof b === 'string' ? Buffer.from(b, 'latin1') : b;
            chunks.push(buf);
            length += buf.length;
        };
        const offsets: number[] = [];
        const object = (n: number, body: Buffer | string) => {
            offsets[n] = length;
            push(`${n} 0 obj\n`);
            push(body);
            push('\nendobj\n');
        };

        // Header + a binary comment so transfer tools treat the file as binary.
        push('%PDF-1.4\n');
        push(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

        const firstPage = 6;
        const kids = this.pages.map((_p, i) => `${firstPage + i * 2} 0 R`).join(' ');
        object(1, '<< /Type /Catalog /Pages 2 0 R >>');
        object(2, `<< /Type /Pages /Kids [${kids}] /Count ${this.pages.length} >>`);
        object(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
        object(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
        const infoParts = [
            info.title ? `/Title ${pdfTextString(info.title)}` : '',
            info.author ? `/Author ${pdfTextString(info.author)}` : '',
            info.subject ? `/Subject ${pdfTextString(info.subject)}` : '',
            `/Producer ${pdfTextString(info.producer || 'HULO Email Tracking')}`,
            `/CreationDate (${pdfDate(info.creationDate || new Date())})`,
        ].filter(Boolean).join(' ');
        object(5, `<< ${infoParts} >>`);

        this.pages.forEach((ops, i) => {
            const pageObj = firstPage + i * 2;
            const contentObj = pageObj + 1;
            object(pageObj, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(this.width)} ${num(this.height)}] `
                + `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObj} 0 R >>`);
            const raw = Buffer.from(ops.join('\n'), 'latin1');
            const data = this.compress ? deflateSync(raw) : raw;
            object(contentObj, Buffer.concat([
                Buffer.from(`<< /Length ${data.length}${this.compress ? ' /Filter /FlateDecode' : ''} >>\nstream\n`, 'latin1'),
                data,
                Buffer.from('\nendstream', 'latin1'),
            ]));
        });

        const count = firstPage + this.pages.length * 2; // objects 0..count-1
        const xrefAt = length;
        let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
        for (let n = 1; n < count; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
        push(xref);
        push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
        return Buffer.concat(chunks, length);
    }
}
