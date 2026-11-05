import { describe, expect, it } from 'vitest';
import { evidenceScopeFromParam, EVIDENCE_LINK_TTL_SEC, signEvidenceLink, verifyEvidenceLink } from './signed-link';
import { CSV_BOM, csvCell, csvRow } from './csv';

describe('evidence report signed link', () => {
    const secret = 'install-secret';
    const now = Date.UTC(2026, 10, 4, 12, 0, 0);

    it('verifies within the 5-minute lifetime', () => {
        const { exp, sig } = signEvidenceLink(42, 7, secret, now);
        expect(exp).toBe(now / 1000 + EVIDENCE_LINK_TTL_SEC);
        expect(EVIDENCE_LINK_TTL_SEC).toBe(300);
        expect(verifyEvidenceLink(42, String(exp), '7', sig, secret, now)).toBe('ok');
        expect(verifyEvidenceLink(42, String(exp), '7', sig, secret, now + 299_000)).toBe('ok');
    });

    it('expires', () => {
        const { exp, sig } = signEvidenceLink(42, 7, secret, now);
        expect(verifyEvidenceLink(42, String(exp), '7', sig, secret, now + 301_000)).toBe('expired');
    });

    it('rejects a tampered order id, expiry, user id, signature or secret', () => {
        const { exp, sig } = signEvidenceLink(42, 7, secret, now);
        expect(verifyEvidenceLink(43, String(exp), '7', sig, secret, now)).toBe('invalid');
        expect(verifyEvidenceLink(42, String(exp + 600), '7', sig, secret, now)).toBe('invalid');
        expect(verifyEvidenceLink(42, String(exp), '8', sig, secret, now)).toBe('invalid');
        expect(verifyEvidenceLink(42, String(exp), '7', sig.replace(/.$/, c => (c === '0' ? '1' : '0')), secret, now)).toBe('invalid');
        expect(verifyEvidenceLink(42, String(exp), '7', sig, 'other', now)).toBe('invalid');
        expect(verifyEvidenceLink(42, String(exp), '7', sig, undefined, now)).toBe('invalid');
        expect(verifyEvidenceLink(42, 'abc', '7', sig, secret, now)).toBe('invalid');
        expect(verifyEvidenceLink(42, String(exp), '7', 'short', secret, now)).toBe('invalid');
    });

    it('refuses a correctly signed link claiming a lifetime longer than any we mint', () => {
        const { exp, sig } = signEvidenceLink(42, 7, secret, now, 3600);
        expect(verifyEvidenceLink(42, String(exp), '7', sig, secret, now)).toBe('expired');
    });

    it('binds the internal-notes choice: a standard link cannot be widened, nor an internal one narrowed', () => {
        const std = signEvidenceLink(42, 7, secret, now);
        const internal = signEvidenceLink(42, 7, secret, now, EVIDENCE_LINK_TTL_SEC, 'internal-notes');
        expect(internal.sig).not.toBe(std.sig);
        expect(verifyEvidenceLink(42, String(internal.exp), '7', internal.sig, secret, now, EVIDENCE_LINK_TTL_SEC, 'internal-notes')).toBe('ok');
        expect(verifyEvidenceLink(42, String(std.exp), '7', std.sig, secret, now, EVIDENCE_LINK_TTL_SEC, 'internal-notes')).toBe('invalid');
        expect(verifyEvidenceLink(42, String(internal.exp), '7', internal.sig, secret, now)).toBe('invalid');
        expect(evidenceScopeFromParam('internal')).toBe('internal-notes');
        for (const v of [undefined, '', 'INTERNAL', 'all', ['internal']]) expect(evidenceScopeFromParam(v)).toBe('standard');
    });
});

describe('CSV cells', () => {
    const ch = (n: number) => String.fromCharCode(n);
    it('quotes every cell, doubles quotes and guards formulas', () => {
        expect(csvCell('plain')).toBe('"plain"');
        expect(csvCell('a,b')).toBe('"a,b"');
        expect(csvCell('say "hi"')).toBe('"say ""hi"""');
        expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
        expect(csvCell('cr\rhere')).toBe('"cr\rhere"');
        for (const f of ['=HYPERLINK("http://x")', '+1', '-2', '@SUM(A1)', '\tTAB', '\r=1']) expect(csvCell(f).startsWith(`"'`), f).toBe(true);
        expect(csvCell('=1,2')).toBe(`"'=1,2"`);
        expect(csvCell(null)).toBe('');
        expect(csvCell(undefined)).toBe('');
        expect(csvCell(0)).toBe('"0"');
        expect(csvCell(false)).toBe('"false"');
        expect(csvCell(new Date('2026-11-04T10:00:00Z'))).toBe('"2026-11-04T10:00:00.000Z"');
        expect(csvRow(['a', '=b', 3])).toBe(`"a","'=b","3"`);
    });

    it('leading whitespace or invisible characters do not hide a formula', () => {
        for (const f of [' =1+1', '   +cmd', ch(0xa0) + '=1', ch(0x200b) + '=1', ch(0xfeff) + '@SUM(A1)']) expect(csvCell(f).startsWith(`"'`), JSON.stringify(f)).toBe(true);
        expect(csvCell('a =1')).toBe('"a =1"');
    });

    it('a semicolon-locale spreadsheet cannot split a field into a formula cell', () => {
        // The SMTP reply a customer's server returns, relayed by the provider into the event detail.
        expect(csvCell("451 4.7.1 greylisted;=1+cmd|' /C calc'!A0")).toBe(`"451 4.7.1 greylisted;=1+cmd|' /C calc'!A0"`);
        // Split on ';' and ',' only outside quotes, as such a spreadsheet does: still one field each.
        const fields = (line: string) => line.match(/"(?:[^"]|"")*"|[^;,]+/g)!;
        expect(fields(csvRow(['x', 'a;=1+1', 'y']))).toEqual(['"x"', '"a;=1+1"', '"y"']);
    });

    it('the byte-order mark is a single U+FEFF', () => {
        expect(CSV_BOM).toBe(ch(0xfeff));
    });
});
