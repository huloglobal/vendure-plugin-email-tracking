import { describe, expect, it } from 'vitest';
import { inflateSync } from 'zlib';
import { measureText, pdfDate, pdfString, PdfWriter, wrapText } from './pdf-writer';
import { glyphWidth, toWinAnsiCodes } from './pdf-fonts';
import { buildEvidenceReport, charsAfterLines, fitLines, MAX_CELL_LINES, rowCells } from './evidence-report';
import { historyItem, TimelineItem } from './timeline';
import { csvRow } from './csv';

/** Parse the xref table and check every offset lands on its "n 0 obj" line. */
function checkStructure(buf: Buffer) {
    const s = buf.toString('latin1');
    expect(s.startsWith('%PDF-1.4\n')).toBe(true);
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true);
    const m = /startxref\n(\d+)\n%%EOF\n$/.exec(s);
    expect(m).not.toBeNull();
    const xrefAt = Number(m![1]);
    expect(s.slice(xrefAt, xrefAt + 5)).toBe('xref\n');
    const head = /^xref\n0 (\d+)\n/.exec(s.slice(xrefAt))!;
    const count = Number(head[1]);
    const entriesStart = xrefAt + head[0].length;
    for (let n = 0; n < count; n++) {
        const entry = s.slice(entriesStart + n * 20, entriesStart + (n + 1) * 20);
        expect(entry.length).toBe(20);
        if (n === 0) { expect(entry).toBe('0000000000 65535 f \n'); continue; }
        expect(entry).toMatch(/^\d{10} 00000 n \n$/);
        const off = Number(entry.slice(0, 10));
        expect(s.slice(off, off + `${n} 0 obj`.length)).toBe(`${n} 0 obj`);
    }
    expect(s).toContain(`trailer\n<< /Size ${count} /Root 1 0 R /Info 5 0 R >>`);
    return { s, count };
}

function pageCount(s: string): number {
    return Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(s)![1]);
}

/** Every content stream, inflated. */
function streams(buf: Buffer): string[] {
    const out: string[] = [];
    const s = buf.toString('latin1');
    const re = /<< \/Length (\d+)( \/Filter \/FlateDecode)? >>\nstream\n/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
        const start = m.index + m[0].length;
        const data = buf.subarray(start, start + Number(m[1]));
        out.push(m[2] ? inflateSync(data).toString('latin1') : data.toString('latin1'));
    }
    return out;
}

describe('PdfWriter', () => {
    it('writes a valid PDF 1.4 skeleton with a byte-exact xref and startxref', () => {
        const pdf = new PdfWriter();
        pdf.addPage();
        pdf.text(0, 40, 800, 'Hello (world) \\ back', 'bold', 12);
        pdf.addPage();
        pdf.line(1, 40, 40, 200, 40);
        pdf.rect(1, 40, 60, 100, 20, [0.9, 0.9, 0.9]);
        const buf = pdf.toBuffer({ title: 'Test', creationDate: new Date('2026-11-04T10:00:00Z') });
        const { s, count } = checkStructure(buf);
        expect(count).toBe(6 + 2 * 2);
        expect(pageCount(s)).toBe(2);
        expect(s).toContain('/BaseFont /Helvetica /Encoding /WinAnsiEncoding');
        expect(s).toContain('/BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding');
        expect(s).toContain('/MediaBox [0 0 595.28 841.89]');
        expect(s).toContain('/CreationDate (D:20261104100000Z)');
        expect(streams(buf)[0]).toContain('(Hello \\(world\\) \\\\ back) Tj');
    });

    it('offsets stay exact with uncompressed streams and non-ASCII text', () => {
        const pdf = new PdfWriter(undefined, undefined, false);
        pdf.addPage();
        pdf.text(0, 10, 10, 'Café £12 — “quoted” • ✓ 日本');
        const buf = pdf.toBuffer();
        checkStructure(buf);
        // WinAnsi bytes as octal escapes; ✓ has a stand-in, characters with none become '?'.
        expect(streams(buf)[0]).toContain('(Caf\\351 \\24312 \\227 \\223quoted\\224 \\225 OK ??) Tj');
    });

    it('an empty document still has one page', () => {
        const buf = new PdfWriter().toBuffer();
        const { s } = checkStructure(buf);
        expect(pageCount(s)).toBe(1);
    });
});

describe('text helpers', () => {
    it('escapes \\ ( ) and maps to WinAnsi', () => {
        expect(pdfString('a(b)c\\d')).toBe('(a\\(b\\)c\\\\d)');
        expect(pdfString('é')).toBe('(\\351)');
        expect(pdfString('€')).toBe('(\\200)');
        expect(pdfString('😀')).toBe('(?)');
        expect(pdfString('tab\tnew\nline')).toBe('(tab new line)');
        expect(toWinAnsiCodes('\u0001x')).toEqual([120]);
    });

    it('measures with the Helvetica AFM widths', () => {
        // Helvetica: H 722, e 556, l 222, o 556 → 2278 units.
        expect(measureText('Hello', 'regular', 10)).toBeCloseTo(22.78, 5);
        expect(glyphWidth('i'.charCodeAt(0), false)).toBe(222);
        expect(glyphWidth('i'.charCodeAt(0), true)).toBe(278);
        expect(measureText('W', 'bold', 1000)).toBe(944);
    });

    it('wraps on words, keeps explicit breaks and hard-breaks over-long words', () => {
        const lines = wrapText('The quick brown fox jumps over the lazy dog', 'regular', 10, 60);
        expect(lines.length).toBeGreaterThan(1);
        for (const l of lines) expect(measureText(l, 'regular', 10)).toBeLessThanOrEqual(60);
        expect(lines.join(' ')).toBe('The quick brown fox jumps over the lazy dog');
        expect(wrapText('a\nb', 'regular', 10, 500)).toEqual(['a', 'b']);
        const hash = 'f'.repeat(80);
        const broken = wrapText(hash, 'regular', 8, 50);
        expect(broken.join('')).toBe(hash);
        for (const l of broken) expect(measureText(l, 'regular', 8)).toBeLessThanOrEqual(50);
        expect(wrapText('', 'regular', 8, 50)).toEqual(['']);
        expect(pdfDate(new Date('2026-01-02T03:04:05Z'))).toBe('D:20260102030405Z');
    });
});

describe('characters outside WinAnsi', () => {
    const text = (s: string) => String.fromCharCode(...toWinAnsiCodes(s));
    it('arrows, comparison signs and accented Latin letters get readable stand-ins; other scripts become ?', () => {
        expect(text('Created → AddingItems')).toBe('Created -> AddingItems');
        expect(text('← ≤ ≥ ✓')).toBe('<- <= >= OK');
        expect(text('Zoë Müller-Łukasz')).toBe('Zoë Müller-Lukasz'); // ë and ü are WinAnsi; Ł has no slot
        expect(text('Őrő ă ś ı')).toBe('Oro a s i');
        expect(text('Šž€')).toBe('Šž€'.split('').map(c => String.fromCharCode(toWinAnsiCodes(c)[0])).join(''));
        expect(text('Москва')).toBe('??????');
    });

    it('a Vendure history row prints without a single ?', () => {
        const row = rowCells({
            id: 'h1', at: '2026-11-04T10:00:00.000Z', kind: 'history', type: 'ORDER_PAYMENT_TRANSITION', source: 'vendure', label: 'Payment state changed',
            detail: 'Created → Settled — USD 47.98 via review-payment', emailLogId: null, emailType: null, classification: null, reasons: [],
            location: null, network: null, client: null, platform: null, isBot: null, ip: null, url: null, linkIndex: null, linkText: null,
            actor: 'Zoë Müller-Łukasz', legacy: false,
        } as TimelineItem);
        for (const cell of row) expect(toWinAnsiCodes(cell).includes(63), cell).toBe(false);
    });
});

const item = (n: number): TimelineItem => ({
    id: `e${n}`, at: new Date(Date.UTC(2026, 10, 4, 10, 0, n)).toISOString(), kind: 'event', type: n % 2 ? 'open' : 'click', source: 'pixel',
    label: n % 2 ? 'Opened' : 'Link clicked', detail: n % 2 ? null : `link text number ${n} with a long description that wraps across lines`,
    emailLogId: 7, emailType: 'order-confirmation', classification: n % 3 ? 'machine_likely' : 'human_likely', reasons: n % 3 ? ['gmail-proxy'] : [],
    location: { country: 'GB', region: 'England', city: 'London', timezone: 'Europe/London' },
    network: { asn: 'AS5089', org: 'Virgin Media', isProxy: false, isVpn: false, isTor: false, isHosting: n % 5 === 0, isMobile: false, enrichedBy: 'ip-api.com' },
    client: 'Gmail (prefetch)', platform: 'web', isBot: true, ip: 'a1b2c3', url: n % 2 ? null : 'https://shop.example.com/p?[redacted]',
    linkIndex: n % 2 ? null : 0, linkText: n % 2 ? null : 'View order', actor: null, legacy: n === 3,
});

describe('evidence report', () => {
    const summary = {
        order: { id: 12, code: 'ABC123DEF456', state: 'PaymentSettled', placedAt: '2026-11-04T09:59:00.000Z', total: 1200, currencyCode: 'GBP', totalFormatted: 'GBP 12.00', paymentState: 'Settled (GBP 12.00 via test)', customerEmail: 'jane@example.com', customerName: 'Jane Doe' },
        emails: { total: 2, sent: 2, delivered: 1, opened: 1, firstOpenAt: '2026-11-04T10:00:01.000Z', clicked: 1, bounced: 0 },
        opens: { recorded: 60, human: 20, machine: 40, unknown: 0, unsigned: 0 },
        clicks: { recorded: 60, human: 20, machine: 40, unknown: 0, unsigned: 0 },
        historyUnavailable: false,
    };

    it('paginates a long timeline with the table header repeated and "Page n of m" footers', () => {
        const items = Array.from({ length: 120 }, (_v, i) => item(i + 1));
        const buf = buildEvidenceReport({
            shop: 'shop.example.com', summary, items, truncated: false, generatedAt: new Date('2026-11-04T11:00:00Z'),
            generatedBy: 'admin@example.com (user #1)', timelineSha256: 'a'.repeat(64), producer: '@huloglobal/vendure-plugin-email-tracking 0.16.0',
        });
        const { s } = checkStructure(buf);
        const pages = pageCount(s);
        expect(pages).toBeGreaterThan(2);
        const content = streams(buf);
        expect(content).toHaveLength(pages);
        expect(content[0]).toContain('(Order activity and delivery evidence report) Tj');
        expect(content[0]).toContain('(How to read this report) Tj');
        for (let p = 0; p < pages; p++) {
            expect(content[p]).toContain(`(Page ${p + 1} of ${pages}) Tj`);
            expect(content[p]).toContain('(Time \\(UTC\\)) Tj'); // header repeated on every page
        }
        expect(content[pages - 1]).toContain(`(Timeline SHA-256: ${'a'.repeat(64)}) Tj`);
    });

    it('renders an empty timeline', () => {
        const buf = buildEvidenceReport({
            shop: 'shop.example.com', summary, items: [], truncated: false, generatedAt: new Date(), generatedBy: 'x', timelineSha256: 'b'.repeat(64), producer: 'p',
        });
        checkStructure(buf);
        expect(streams(buf)[0]).toContain('(No activity recorded for this order.) Tj');
    });

    it('row cells: time, event + email, detail + link, location + network flags, client + classification', () => {
        const [time, event, detail, location, client] = rowCells(item(10));
        expect(time).toBe('2026-11-04 10:00:10');
        expect(event).toContain('Link clicked');
        expect(event).toContain('order-confirmation #7');
        expect(detail).toContain('https://shop.example.com/p?[redacted]');
        expect(location).toContain('London, England, GB');
        expect(location).toContain('flags: datacentre');
        expect(client).toContain('machine-likely');
        expect(client).toContain('gmail-proxy');
        expect(rowCells(item(3))[0]).toContain('legacy');
        expect(rowCells({ ...item(1), reasons: ['unsigned-token', 'gmail-proxy'] })[4]).toContain('unsigned link');
    });
});

describe('evidence report: 0.16.0 review fixes', () => {
    const summary = {
        order: { id: 3, code: 'NOTE0001TEST', state: 'PaymentSettled', placedAt: '2026-11-04T09:59:00.000Z', total: 1200, currencyCode: 'GBP', totalFormatted: 'GBP 12.00', paymentState: 'Settled', customerEmail: 'zoe@example.com', customerName: 'Zoe L' },
        emails: { total: 1, sent: 1, delivered: 0, opened: 0, firstOpenAt: null, clicked: 0, bounced: 0 },
        opens: { recorded: 0, human: 0, machine: 0, unknown: 0, unsigned: 3 },
        clicks: { recorded: 0, human: 0, machine: 0, unknown: 0, unsigned: 0 },
        historyUnavailable: false,
    };
    const base = (over: Partial<TimelineItem>): TimelineItem => ({
        id: 'h1', at: '2026-11-04T10:00:00.000Z', kind: 'history', type: 'ORDER_NOTE', source: 'vendure', label: 'Note (public)', detail: null,
        emailLogId: null, emailType: null, classification: null, reasons: [], location: null, network: null, client: null, platform: null,
        isBot: null, ip: null, url: null, linkIndex: null, linkText: null, actor: 'Super Admin', legacy: false, ...over,
    });
    const text = (buf: Buffer) => streams(buf).join('\n');
    const build = (items: TimelineItem[], { summary: over, ...extra }: any = {}) => buildEvidenceReport({
        shop: 'shop.example.com', summary: { ...summary, ...(over || {}) }, items, truncated: false, generatedAt: new Date('2026-11-04T11:00:00Z'),
        generatedBy: 'admin (user #1)', timelineSha256: 'c'.repeat(64), producer: 'p', ...extra,
    });

    it('prints a 2 000-character note in full, with its author', () => {
        const words = Array.from({ length: 330 }, (_v, i) => `w${i}`).join(' ');
        const note = `START ${words} END`.slice(0, 2000);
        const buf = build([base({ detail: note })]);
        checkStructure(buf);
        const t = text(buf);
        expect(t).toContain('START');
        expect(t).toContain('END) Tj');
        expect(t).toContain('(by Super Admin) Tj');
        expect(t).not.toContain('truncated,');
        expect(MAX_CELL_LINES).toBeGreaterThanOrEqual(80);
    });

    it('a cell longer than a page says how much is missing, keeps the author line, and the row still fits a page', () => {
        const huge = Array.from({ length: 2500 }, (_v, i) => `word${i}`).join(' ');
        const buf = build([base({ detail: huge })]);
        const { s } = checkStructure(buf);
        const t = text(buf);
        // The notice wraps over two lines of the narrow column: "… (truncated, N more" / "characters: see activity.json)".
        expect(t).toMatch(/\(truncated, \d+ more/);
        expect(t).toContain('activity.json\\)) Tj');
        expect(t).toContain('(by Super Admin) Tj');
        expect(pageCount(s)).toBeGreaterThanOrEqual(2);
        const lines = wrapText(huge, 'regular', 7, 162);
        expect(fitLines(huge, lines, 10, 162)).toHaveLength(10);
        expect(fitLines('short', ['short'], 10, 162)).toEqual(['short']);
    });

    it('a 3 500-character note is kept whole: in the timeline item, the CSV and the PDF (which only cuts a cell taller than a page)', () => {
        const words = Array.from({ length: 700 }, (_v, i) => `n${String(i).padStart(3, '0')}`).join(' ');
        const note = `NOTE-START\n${words}\nNOTE-END`.slice(0, 3500);
        expect(note.length).toBe(3500);
        const item = historyItem({ id: 9, createdAt: new Date('2026-11-04T10:00:00Z'), type: 'ORDER_NOTE', data: { note }, isPublic: true,
            administrator: { firstName: 'Ágnes', lastName: 'Kovács' } } as any, [], 'GBP', false);
        expect(item.detail).toBe(note); // no 2 000-character cap any more
        expect(csvRow([item.detail])).toBe(`"${note}"`);
        const lines = wrapText(note, 'regular', 7, 162);
        const t = text(build([base({ detail: item.detail, actor: item.actor })]));
        if (lines.length + 1 <= MAX_CELL_LINES) {
            expect(t).toContain('(NOTE-START) Tj');
            expect(t).toContain(`${note.slice(note.lastIndexOf(' ') + 1).replace(/\n.*/s, '')}`);
            expect(t).not.toContain('truncated,');
        } else {
            expect(t).toMatch(/\(truncated, \d+ more/);
        }
        expect(t).toContain('(by \\301gnes Kov\\341cs) Tj'); // Latin-1 letters print as themselves (octal escapes)
    });

    it('the truncation notice counts every character after the lines it keeps, also when it wraps to two lines', () => {
        // Fixed-width words: from the last word kept, the missing characters can be counted by hand.
        const words = Array.from({ length: 3000 }, (_v, i) => `w${String(i).padStart(4, '0')}`);
        const huge = words.join(' ');
        for (const width of [162, 80]) {
            const lines = wrapText(huge, 'regular', 7, width);
            const out = fitLines(huge, lines, 12, width);
            expect(out).toHaveLength(12);
            const noticeAt = out.findIndex(l => l.startsWith('… (truncated'));
            expect(noticeAt).toBeGreaterThan(0);
            const kept = out.slice(0, noticeAt);
            expect(kept).toEqual(lines.slice(0, noticeAt)); // the kept lines are the text's first lines
            const lastWord = kept[kept.length - 1].split(' ').pop()!;
            const end = huge.indexOf(lastWord) + lastWord.length;
            const expected = huge.length - end - 1; // the space after the last shown word is not "missing"
            const notice = out.slice(noticeAt).join(' ');
            expect(notice).toBe(`… (truncated, ${expected} more characters: see activity.json)`);
            if (width === 80) expect(out.length - noticeAt).toBeGreaterThanOrEqual(2); // the notice wrapped
        }
        // Spaces and line breaks inside the missing part count too.
        expect(charsAfterLines('aaa bbb\nccc  ddd', ['aaa'])).toBe('bbb\nccc  ddd'.length);
        expect(charsAfterLines('aaa bbb', ['aaa bbb'])).toBe(0);
    });

    it('the SHA-256 line and its explanation are never split across pages', () => {
        // One-line rows plus a last row of 1 … 12 lines move the table's end over every position near the page bottom
        // (before the fix, 16 of these 72 reports printed the hash on one page and its explanation on the next).
        let checked = 0;
        for (let n = 14; n <= 19; n++) {
            for (let extra = 1; extra <= 12; extra++) {
                const items = [...Array.from({ length: n }, (_v, i) => base({ id: `h${i}`, detail: 'one line', actor: null })),
                    base({ id: 'last', detail: Array.from({ length: extra }, (_v, i) => `line ${i}`).join('\n'), actor: null })];
                const content = streams(build(items, { timelineSha256: 'd'.repeat(64) }));
                const pages = [`(Timeline SHA-256: ${'d'.repeat(64)}) Tj`, '(The SHA-256 of the canonical JSON', 'returns them. A later export']
                    .map(marker => content.findIndex(c => c.includes(marker)));
                expect([n, extra, ...pages]).toEqual([n, extra, pages[0], pages[0], pages[0]]);
                expect(pages[0]).toBeGreaterThanOrEqual(0);
                checked++;
            }
        }
        expect(checked).toBe(72);
    });

    it('says whether internal notes are included, counts the unverified hits apart, and flags missing order history', () => {
        const left = text(build([], { internalNotes: false, internalNotesLeftOut: 2 }));
        expect(left).toContain('(not included \\(2 private notes left out\\)) Tj');
        expect(left).toContain('not counted in any figure above\\): 3 opens');
        const incl = text(build([], { internalNotes: true }));
        expect(incl).toContain('(included, marked "internal") Tj');
        expect(incl).toContain('activity.json?evidence=1&internalNotes=1');
        const noHistory = text(build([], { summary: { historyUnavailable: true } }));
        expect(noHistory).toContain('could not be read');
    });

    it('row cells: unverified hits are never human or machine; clicks name their link', () => {
        const bare = rowCells({ ...base({ kind: 'event', type: 'open', label: 'Opened', actor: null }), classification: 'unverified', reasons: ['unsigned-token', 'gmail-proxy'] });
        expect(bare[4]).toContain('unverified (unsigned link)');
        expect(bare[4]).not.toMatch(/human|machine/);
        const click = rowCells(base({ kind: 'event', type: 'click', label: 'Link clicked', detail: 'Link #2: Reset your password', linkIndex: 1, linkText: 'Reset your password', actor: null }));
        expect(click[2]).toBe('Link #2: Reset your password');
        const providerClick = rowCells(base({ kind: 'event', type: 'click', label: 'Link clicked', detail: null, linkIndex: 0, linkText: 'Shop now', url: 'https://s.example/p', actor: null }));
        expect(providerClick[2]).toBe('Link #1: Shop now\nhttps://s.example/p');
    });
});
