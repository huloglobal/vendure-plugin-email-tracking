import { A4, measureText, PdfFont, PdfWriter, wrapText } from './pdf-writer';
import type { ActivitySummary } from './order-activity.service';
import { isUnsignedItem, linkLabel, TimelineItem } from './timeline';

/**
 * "Order activity and delivery evidence report" — an A4 PDF of the full
 * timeline for one order, laid out with the built-in PDF writer.
 */
export interface EvidenceReportInput {
    shop: string;
    summary: ActivitySummary;
    items: TimelineItem[];
    truncated: boolean;
    generatedAt: Date;
    generatedBy: string;
    timelineSha256: string;
    producer: string;
    /** Private (internal) order notes are printed (marked internal); else left out. */
    internalNotes?: boolean;
    /** How many private notes were left out (when `internalNotes` is false). */
    internalNotesLeftOut?: number;
}

export const REPORT_TITLE = 'Order activity and delivery evidence report';

export const HOW_TO_READ = [
    'Times are server time in UTC.',
    'IP geolocation is approximate: it may show a mail provider\'s image proxy, a VPN, a corporate gateway or a security scanner rather than the recipient.',
    'Opens and clicks marked machine-likely usually come from privacy proxies (Gmail image proxy, Apple Mail Privacy Protection) or link scanners (Microsoft Safe Links and similar), not from a person. The classification is advisory.',
    'Raw events are not deduplicated: each pixel fetch and each click is its own row, up to 100 opens and 100 clicks per email per day; beyond that one "not stored" row marks the day and the opened / clicked counts keep counting. Rows marked "legacy" were reconstructed from the email log for emails sent before version 0.16.0.',
    'Rows marked "unverified" came through a tracking link without a signature. Anyone who knows the email\'s number can produce such a row, so they prove nothing: they are not counted in the opened, clicked or human / machine figures.',
    'Delivery, bounce and complaint rows come from the plugin\'s own send path, the bounce webhook or the mail provider\'s signed webhooks.',
    '"Accepted by the mail server" means the SMTP server took the email; delivery to the inbox is known only when a provider webhook reports it. '
        + '"Sending…" means no reply from the mail server has been recorded yet, and "No reply recorded" that none ever was (the send was cut off, '
        + 'for example by a restart). Rows marked "from email log" were read from the email log because the email has no send event.',
    'A temporary refusal (an SMTP 4xx reply, a connection error or a timeout) reads "Deferred, retrying" while the email can still be sent again. '
        + 'Once it is, the attempts are linked: "Deferred, retried" ("Send failed, retried" after a permanent refusal, "No reply recorded, retried" '
        + 'after a cut-off send), then "Sent after 1 retry". "Send failed" means a permanent refusal (an SMTP 5xx reply or any other error) with no '
        + 'later attempt, or that the retries are over: none came within 15 minutes, or the sixth attempt failed.',
    'Private (internal) order notes are left out unless the report was requested with them; they are then marked "internal". Order-history entries of a kind this report does not know show their type only.',
    'A table cell longer than a page (about 85 lines) is cut, and says how many characters are missing: the activity.json export has every value in full.',
];

const M = 40;                       // side margin
const TOP = A4.height - 42;
const BOTTOM = 48;                  // keep clear of the footer
const CONTENT_W = A4.width - 2 * M;
const COLS: Array<{ title: string; width: number }> = [
    { title: 'Time (UTC)', width: 78 },
    { title: 'Event', width: 92 },
    { title: 'Detail', width: 168 },
    { title: 'Location (approximate)', width: 92 },
    { title: 'Client / classification', width: CONTENT_W - 78 - 92 - 168 - 92 },
];
const TABLE_SIZE = 7;
const TABLE_LEADING = 8.6;
const CELL_PAD = 3;
/** The table header row's height. */
const HEADER_ROW_H = TABLE_LEADING + 2 * CELL_PAD;
/** Lines of the tallest row that fits on a fresh page under the repeated table header (85). */
export const MAX_CELL_LINES = Math.floor((TOP - BOTTOM - HEADER_ROW_H - 2 * CELL_PAD) / TABLE_LEADING);
const INK: [number, number, number] = [0.07, 0.09, 0.13];
const MUTED: [number, number, number] = [0.38, 0.42, 0.48];

const utc = (iso: string | null | undefined): string => (iso ? iso.replace('T', ' ').replace(/\.\d{3}Z$/, '').replace(/Z$/, '') : '—');

function classLabel(c: string | null): string {
    if (c === 'human_likely') return 'human-likely';
    if (c === 'machine_likely') return 'machine-likely';
    if (c === 'unknown') return 'unknown';
    if (c === 'unverified') return 'unverified';
    return '';
}

/** The detail cell without the actor line (kept apart, so a long note never loses its author). */
function detailBody(i: TimelineItem): string {
    const link = linkLabel(i.linkIndex, i.linkText);
    return [
        i.detail,
        link && link !== i.detail ? link : null,
        i.url ? i.url : null,
    ].filter(Boolean).join('\n');
}

/** The time cell's marker for a row read from the email log after the event timeline began (kind `log`). */
const FROM_LOG = 'from email log';

/** The five cells of one timeline row. */
export function rowCells(i: TimelineItem): string[] {
    const time = utc(i.at) + (i.legacy ? '\nlegacy' : i.kind === 'log' ? `\n${FROM_LOG}` : '');
    const event = [i.label, i.emailType ? `${i.emailType}${i.emailLogId ? ` #${i.emailLogId}` : ''}` : null, i.kind === 'event' ? `via ${i.source}` : null]
        .filter(Boolean).join('\n');
    const detail = [detailBody(i), i.actor ? `by ${i.actor}` : null].filter(Boolean).join('\n') || '—';
    const place = i.location ? [i.location.city, i.location.region, i.location.country].filter(Boolean).join(', ') : '';
    const net = i.network ? [i.network.org, i.network.asn].filter(Boolean).join(' · ') : '';
    const flags = i.network ? (['isProxy', 'isVpn', 'isTor', 'isHosting', 'isMobile'] as const)
        .filter(k => i.network && i.network[k] === true)
        .map(k => ({ isProxy: 'proxy', isVpn: 'VPN', isTor: 'Tor', isHosting: 'datacentre', isMobile: 'mobile' } as const)[k]).join(', ') : '';
    const location = [place, net, flags ? `flags: ${flags}` : ''].filter(Boolean).join('\n') || (i.kind === 'history' ? '' : '—');
    // Classification first (the line in dark ink), then the client and the reasons.
    const client = [
        isUnsignedItem(i) ? 'unverified (unsigned link)' : classLabel(i.classification) || null,
        i.client && i.client !== 'unknown' ? `${i.client}${i.platform && i.platform !== 'unknown' ? ` · ${i.platform}` : ''}${i.isBot ? ' (bot)' : ''}` : null,
        i.reasons.length ? i.reasons.join(', ') : null,
    ].filter(Boolean).join('\n');
    return [time, event, detail, location, client];
}

/** The characters `wrapText` splits on (and drops): spaces, tabs and line breaks. */
const isBreak = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

/**
 * How many characters of `text` come after what `shownLines` — the first
 * lines of `wrapText(text, …)` — print, every character counted (spaces and
 * line breaks too) except the break right after the last shown line.
 */
export function charsAfterLines(text: string, shownLines: string[]): number {
    // wrapText keeps every other character, in order: count them off the front of the text.
    let shown = 0;
    for (const line of shownLines) for (let i = 0; i < line.length; i++) if (!isBreak(line[i])) shown++;
    let pos = 0;
    for (; pos < text.length && shown > 0; pos++) if (!isBreak(text[pos])) shown--;
    while (pos < text.length && isBreak(text[pos])) pos++;
    return text.length - pos;
}

/**
 * `lines` (from `wrapText(text, …, width)`) cut to `max`: the kept lines are
 * followed by a notice saying how many characters are missing ("… (truncated,
 * 812 more characters: see activity.json)"), counted from the lines actually
 * kept — the notice may take two lines — so nothing is dropped without notice.
 */
export function fitLines(text: string, lines: string[], max: number, width: number): string[] {
    if (lines.length <= max) return lines;
    let noteLines = 1;
    for (;;) {
        const keep = Math.max(0, max - noteLines);
        const missing = Math.max(1, charsAfterLines(text, lines.slice(0, keep)));
        const note = wrapText(`… (truncated, ${missing} more character${missing === 1 ? '' : 's'}: see activity.json)`, 'regular', TABLE_SIZE, width);
        if (note.length <= noteLines || keep === 0) return [...lines.slice(0, keep), ...note];
        noteLines = note.length; // the notice is taller than reserved: keep fewer lines and count again
    }
}

/** The detail cell's lines: the body (cut with notice if need be), then the actor line, always shown. */
function detailLines(item: TimelineItem, width: number): string[] {
    const actor = item.actor ? wrapText(`by ${item.actor}`, 'regular', TABLE_SIZE, width) : [];
    const body = detailBody(item);
    if (!body) return actor.length ? actor : ['—'];
    return [...fitLines(body, wrapText(body, 'regular', TABLE_SIZE, width), MAX_CELL_LINES - actor.length, width), ...actor];
}

export function buildEvidenceReport(input: EvidenceReportInput): Buffer {
    const pdf = new PdfWriter();
    let page = pdf.addPage();
    let y = TOP;
    let inTable = false;

    const text = (x: number, s: string, font: PdfFont, size: number, color = INK) => pdf.text(page, x, y, s, font, size, color);

    const tableHeader = () => {
        const h = TABLE_LEADING + 2 * CELL_PAD;
        pdf.rect(page, M, y - h, CONTENT_W, h, [0.92, 0.93, 0.95]);
        let x = M;
        for (const col of COLS) {
            pdf.text(page, x + CELL_PAD, y - CELL_PAD - TABLE_SIZE, col.title, 'bold', TABLE_SIZE, INK);
            x += col.width;
        }
        y -= h;
        pdf.line(page, M, y, M + CONTENT_W, y, 0.6, 0.55);
    };
    const newPage = () => {
        page = pdf.addPage();
        y = TOP;
        if (inTable) tableHeader();
    };
    const ensure = (h: number) => { if (y - h < BOTTOM) newPage(); };

    /** Wrapped paragraph across the content width. */
    const paragraph = (s: string, font: PdfFont, size: number, leading: number, indent = 0, color = INK) => {
        for (const line of wrapText(s, font, size, CONTENT_W - indent)) {
            ensure(leading);
            y -= leading;
            text(M + indent, line, font, size, color);
        }
    };

    // ── Title + header block ───────────────────────────────────────────
    const s = input.summary;
    y -= 16;
    text(M, REPORT_TITLE, 'bold', 15);
    y -= 6;
    const meta: Array<[string, string]> = [
        ['Shop', input.shop],
        ['Order', `${s.order.code} (#${s.order.id}) — ${s.order.state}`],
        ['Customer', [s.order.customerName, s.order.customerEmail ? `<${s.order.customerEmail}>` : null].filter(Boolean).join(' ') || '—'],
        ['Placed at (UTC)', utc(s.order.placedAt)],
        ['Total', s.order.totalFormatted || '—'],
        ['Payment', s.order.paymentState],
        ['Generated at (UTC)', utc(input.generatedAt.toISOString())],
        ['Generated by', input.generatedBy],
        ['Internal notes', input.internalNotes
            ? 'included, marked "internal"'
            : `not included${input.internalNotesLeftOut ? ` (${input.internalNotesLeftOut} private note${input.internalNotesLeftOut === 1 ? '' : 's'} left out)` : ''}`],
    ];
    for (const [k, v] of meta) {
        const lines = wrapText(v, 'regular', 9, CONTENT_W - 110);
        lines.forEach((line, idx) => {
            ensure(12);
            y -= 12;
            if (idx === 0) text(M, k, 'bold', 9);
            text(M + 110, line, 'regular', 9);
        });
    }

    // ── Summary ────────────────────────────────────────────────────────
    y -= 10;
    ensure(30);
    y -= 13;
    text(M, 'Summary', 'bold', 11);
    const e = s.emails;
    // Emails count once each (a retried email is one email, its attempts apart); delivery only when a provider can report it.
    const attempts = Number(e.attempts) || 0;
    const delivery = s.deliveryEvents === false ? 'delivery not reported (no provider webhook is configured)' : `${e.delivered} delivered (provider-reported)`;
    const pending = [
        e.sending ? `${e.sending} sending` : null, e.retrying ? `${e.retrying} retrying` : null, e.deferred ? `${e.deferred} deferred` : null,
        e.unknown ? `${e.unknown} no reply recorded` : null, e.failed ? `${e.failed} failed` : null, e.suppressed ? `${e.suppressed} suppressed` : null,
    ].filter(Boolean);
    paragraph(`Emails: ${e.total}${attempts > e.total ? ` (${attempts} attempts)` : ''} · ${e.sent} accepted by the mail server · ${delivery}`
        + `${pending.length ? ` · ${pending.join(' · ')}` : ''} · ${e.opened} opened`
        + `${e.firstOpenAt ? ` (first open ${utc(e.firstOpenAt)} UTC)` : ''} · ${e.clicked} clicked · ${e.bounced} bounced or complained`, 'regular', 9, 12);
    paragraph(`Opens recorded: ${s.opens.recorded} — classified events: human-likely ${s.opens.human} · machine-likely ${s.opens.machine} · unknown ${s.opens.unknown}`, 'regular', 9, 12);
    paragraph(`Clicks recorded: ${s.clicks.recorded} — classified events: human-likely ${s.clicks.human} · machine-likely ${s.clicks.machine} · unknown ${s.clicks.unknown}`, 'regular', 9, 12);
    if (s.opens.unsigned || s.clicks.unsigned) {
        paragraph(`Through unsigned links (unverified, not counted in any figure above): ${s.opens.unsigned} open${s.opens.unsigned === 1 ? '' : 's'} · `
            + `${s.clicks.unsigned} click${s.clicks.unsigned === 1 ? '' : 's'}`, 'regular', 9, 12);
    }
    if (s.historyUnavailable) {
        paragraph('The order\'s own history (state, payment, fulfilment, refund and note entries) could not be read when this report was generated: the timeline below has its email rows only.',
            'bold', 8.5, 11, 0, [0.6, 0.1, 0.1]);
    }

    // ── How to read ────────────────────────────────────────────────────
    y -= 8;
    const noteLines = HOW_TO_READ.flatMap(p => wrapText(`• ${p}`, 'regular', 8, CONTENT_W - 16));
    const noteH = 16 + noteLines.length * 10.5 + 8;
    ensure(noteH);
    pdf.rect(page, M, y - noteH, CONTENT_W, noteH, [1, 0.97, 0.88]);
    y -= 14;
    text(M + 8, 'How to read this report', 'bold', 9, [0.47, 0.21, 0.06]);
    y -= 2;
    for (const line of noteLines) { y -= 10.5; text(M + 8, line, 'regular', 8, [0.35, 0.2, 0.05]); }
    y -= 14;

    // ── Timeline table ─────────────────────────────────────────────────
    ensure(40);
    y -= 13;
    text(M, `Timeline (${input.items.length} item${input.items.length === 1 ? '' : 's'}${input.truncated ? ', truncated' : ''})`, 'bold', 11);
    y -= 6;
    inTable = true;
    tableHeader();
    if (!input.items.length) {
        ensure(16);
        y -= 13;
        text(M + CELL_PAD, 'No activity recorded for this order.', 'regular', 8, MUTED);
    }
    for (const item of input.items) {
        const cells = rowCells(item).map((c, idx) => {
            const width = COLS[idx].width - 2 * CELL_PAD;
            if (idx === 2) return detailLines(item, width);
            return fitLines(c, wrapText(c, idx === 1 ? 'bold' : 'regular', TABLE_SIZE, width), MAX_CELL_LINES, width);
        });
        const rowH = 2 * CELL_PAD + Math.max(...cells.map(c => c.length)) * TABLE_LEADING;
        ensure(rowH);
        let x = M;
        cells.forEach((lines, idx) => {
            lines.forEach((line, li) => {
                const color = idx === 0 && (line === 'legacy' || line === FROM_LOG) ? MUTED : (li > 0 && idx !== 2 ? MUTED : INK);
                pdf.text(page, x + CELL_PAD, y - CELL_PAD - TABLE_SIZE - li * TABLE_LEADING + 1, line, idx === 1 && li === 0 ? 'bold' : 'regular', TABLE_SIZE, color);
            });
            x += COLS[idx].width;
        });
        y -= rowH;
        pdf.line(page, M, y, M + CONTENT_W, y, 0.3, 0.82);
    }
    inTable = false;

    // ── Integrity line ─────────────────────────────────────────────────
    // The hash and the paragraph that explains it stay together: the block moves to a new page as a unit.
    y -= 10;
    const hashLine = `Timeline SHA-256: ${input.timelineSha256}`;
    const hashNote = `The SHA-256 of the canonical JSON (object keys sorted, no whitespace) of the items printed above, as the "items" array of `
        + `GET /email-track/orders/${s.order.id}/activity.json?evidence=1${input.internalNotes ? '&internalNotes=1' : ''} returns them. `
        + 'A later export of an unchanged timeline gives the same value.'
        + (input.truncated ? ' This report was truncated at the export limit.' : '');
    ensure(wrapText(hashLine, 'bold', 8, CONTENT_W).length * 11 + wrapText(hashNote, 'regular', 7.5, CONTENT_W).length * 10);
    paragraph(hashLine, 'bold', 8, 11);
    paragraph(hashNote, 'regular', 7.5, 10, 0, MUTED);

    // ── Footers (page count known only now) ─────────────────────────────
    const total = pdf.pageCount;
    for (let p = 0; p < total; p++) {
        pdf.line(p, M, 36, M + CONTENT_W, 36, 0.3, 0.75);
        pdf.text(p, M, 24, `Order ${s.order.code} — ${REPORT_TITLE}`, 'regular', 7, MUTED);
        const label = `Page ${p + 1} of ${total}`;
        pdf.text(p, A4.width - M - measureText(label, 'regular', 7), 24, label, 'regular', 7, MUTED);
    }
    return pdf.toBuffer({
        title: `${REPORT_TITLE} — order ${s.order.code}`,
        subject: `Order ${s.order.code}`,
        author: input.shop,
        producer: input.producer,
        creationDate: input.generatedAt,
    });
}
