import { ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { NotificationService } from '@vendure/admin-ui/core';
import {
    ActivityItem, ActivityPage, ActivitySummary, classLabel, clientLabel, EmailTrackingHttp, EmailTrackingTier, errorMessage, exportFileName,
    FILTERS, iconFor, isUnsigned, linkLabel, locationLabel, networkLabel, openEvidenceReport, saveBlob, toneFor,
} from './activity-shared';

/**
 * Full order activity: every email event (sends, deliveries, bounces,
 * opens, clicks — never deduplicated), legacy email-log entries and the
 * order's Vendure history in one timeline, with filters, Load more (100 at
 * a time), CSV / PDF / full exports. Export CSV follows the active filter
 * (and says so in the file name); the PDF and the full export always cover
 * the whole timeline. The PDF leaves private order notes out unless
 * "Include internal notes" is ticked. An unlicensed install sees the
 * premium notice without a premium request being made.
 */
@Component({
    selector: 'hulo-order-activity-page',
    standalone: false,
    template: `
        <vdr-page-block>
            <vdr-action-bar>
                <vdr-ab-left>
                    <h1 class="et-title">Order activity<ng-container *ngIf="summary"> — {{ summary.order.code }}</ng-container></h1>
                    <div class="et-muted">Email delivery and engagement for this order, merged with its order history.</div>
                </vdr-ab-left>
                <vdr-ab-right>
                    <div class="et-actions">
                        <a class="btn btn-link" [routerLink]="['/orders', orderId]"><clr-icon shape="arrow" dir="left" aria-hidden="true"></clr-icon> Back to order</a>
                        <button type="button" class="btn btn-secondary" (click)="exportCsv()" [disabled]="busy || locked || !!loadError"
                            [title]="filter === 'all' ? 'The whole timeline as CSV' : 'The ' + filterLabel() + ' filter as CSV'">Export CSV<ng-container *ngIf="filter !== 'all'"> ({{ filterLabel() }})</ng-container></button>
                        <span class="et-pdf">
                            <button type="button" class="btn btn-secondary" (click)="evidence()" [disabled]="locked || !!loadError">Evidence report (PDF)</button>
                            <label class="et-check" title="Private order notes are left out of the report unless this is ticked; they are then marked internal">
                                <input type="checkbox" [checked]="internalNotes" (change)="internalNotes = $any($event.target).checked" [disabled]="locked || !!loadError" />
                                Include internal notes
                            </label>
                        </span>
                        <button *vdrIfPermissions="'ExportEmailEvidence'" type="button" class="btn btn-warning-outline" (click)="exportFull()" [disabled]="busy || locked || !!loadError"
                            title="The whole timeline: every stored column, provider payloads and full user agents">Full export</button>
                    </div>
                </vdr-ab-right>
            </vdr-action-bar>
        </vdr-page-block>

        <vdr-page-block *ngIf="locked">
            <div class="et-locked" role="alert">
                Order email activity is a premium feature —
                <a [routerLink]="['/extensions', 'email-log']">subscribe or activate a key</a> on the Email Log page.
            </div>
        </vdr-page-block>

        <vdr-page-block *ngIf="!locked && loadError">
            <div class="et-error" role="alert">
                <clr-icon shape="exclamation-circle" aria-hidden="true"></clr-icon> <span>{{ loadError }}</span>
                <button type="button" class="btn btn-sm btn-secondary et-retry" (click)="load()" [disabled]="loading">Try again</button>
            </div>
        </vdr-page-block>

        <ng-container *ngIf="!locked && !loadError">
            <vdr-page-block *ngIf="warning">
                <div class="et-caution" role="note"><clr-icon shape="info-circle" aria-hidden="true"></clr-icon> {{ warning }}</div>
            </vdr-page-block>

            <vdr-page-block *ngIf="historyUnavailable">
                <div class="et-error" role="alert">
                    <clr-icon shape="exclamation-circle" aria-hidden="true"></clr-icon>
                    <span>The order's own history (state, payment, fulfilment, refund and note entries) could not be loaded — the timeline shows its email rows only. The server log has the reason.</span>
                </div>
            </vdr-page-block>

            <vdr-page-block *ngIf="summary as s">
                <div class="et-cards">
                    <div class="et-card"><div class="et-k">Customer</div><div class="et-v">{{ s.order.customerName || '—' }}</div><div class="et-sub">{{ s.order.customerEmail }}</div></div>
                    <div class="et-card"><div class="et-k">Placed</div><div class="et-v">{{ s.order.placedAt ? (s.order.placedAt | localeDate:'medium') : '—' }}</div><div class="et-sub">{{ s.order.state }}</div></div>
                    <div class="et-card"><div class="et-k">Total</div><div class="et-v">{{ s.order.totalFormatted }}</div><div class="et-sub">{{ s.order.paymentState }}</div></div>
                    <div class="et-card"><div class="et-k">Emails</div><div class="et-v">{{ s.emails.total }}</div><div class="et-sub">{{ s.emails.sent }} sent · {{ s.emails.delivered }} delivered · {{ s.emails.bounced }} bounced / complained</div></div>
                    <div class="et-card"><div class="et-k">Opened</div><div class="et-v">{{ s.emails.opened }}</div><div class="et-sub">{{ s.emails.firstOpenAt ? 'first ' + (s.emails.firstOpenAt | localeDate:'short') : 'not yet' }}</div></div>
                    <div class="et-card"><div class="et-k">Opens: human / machine</div><div class="et-v">{{ s.opens.human }} / {{ s.opens.machine }}</div><div class="et-sub">{{ s.opens.recorded }} recorded · {{ s.opens.unknown }} unknown<ng-container *ngIf="s.opens.unsigned"> · {{ s.opens.unsigned }} unverified (not counted)</ng-container></div></div>
                    <div class="et-card"><div class="et-k">Clicked</div><div class="et-v">{{ s.emails.clicked }}</div><div class="et-sub">{{ s.clicks.recorded }} clicks · {{ s.clicks.human }} human-likely<ng-container *ngIf="s.clicks.unsigned"> · {{ s.clicks.unsigned }} unverified (not counted)</ng-container></div></div>
                </div>
            </vdr-page-block>

            <vdr-page-block>
                <div class="et-filters" role="group" aria-label="Filter the timeline">
                    <button type="button" *ngFor="let f of filters" class="et-chip" [class.on]="filter === f.id" [attr.aria-pressed]="filter === f.id" (click)="setFilter(f.id)">{{ f.label }}</button>
                    <span class="et-muted et-count" *ngIf="!loading">Showing {{ items.length }} of {{ total }}</span>
                </div>

                <div *ngIf="loading" class="et-empty" role="status">Loading…</div>
                <div *ngIf="!loading && !items.length" class="et-empty">No activity matches this filter.</div>

                <div class="et-scroll" *ngIf="items.length">
                    <table class="table table-compact et-table">
                        <thead>
                            <tr>
                                <th scope="col">Time</th>
                                <th scope="col">Event</th>
                                <th scope="col">Detail</th>
                                <th scope="col">Location (approx.)</th>
                                <th scope="col">Client</th>
                                <th scope="col">Classification</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr *ngFor="let i of items; trackBy: trackId">
                                <td class="et-nowrap"><time [attr.datetime]="i.at" [title]="(i.at | date:'yyyy-MM-dd HH:mm:ss':'UTC') + ' UTC'">{{ i.at | localeDate:'medium' }}</time></td>
                                <td>
                                    <div class="et-event"><clr-icon [attr.shape]="icon(i)" size="14" aria-hidden="true"></clr-icon> <span [ngClass]="tone(i)">{{ i.label }}</span></div>
                                    <div class="et-muted et-small" *ngIf="i.emailType">{{ i.emailType }}<ng-container *ngIf="i.emailLogId"> #{{ i.emailLogId }}</ng-container></div>
                                    <div class="et-muted et-small" *ngIf="i.kind === 'event'">via {{ i.source }}</div>
                                    <span class="et-legacy" *ngIf="i.legacy" title="Reconstructed from the email log (sent before 0.16.0)">legacy</span>
                                </td>
                                <td class="et-detail">
                                    <div class="et-text" *ngIf="i.detail">{{ i.detail }}</div>
                                    <div class="et-small" *ngIf="link(i) && link(i) !== i.detail">{{ link(i) }}</div>
                                    <div class="et-small et-url" *ngIf="i.url">{{ i.url }}</div>
                                    <div class="et-muted et-small" *ngIf="i.actor">by {{ i.actor }}</div>
                                </td>
                                <td>
                                    <div>{{ where(i) || '—' }}</div>
                                    <div class="et-muted et-small" *ngIf="net(i)">{{ net(i) }}</div>
                                </td>
                                <td>
                                    <div>{{ client(i) || '—' }}</div>
                                    <div class="et-muted et-small" *ngIf="i.isBot">automated client</div>
                                </td>
                                <td>
                                    <span *ngIf="unsigned(i); else classified" class="et-badge et-unsigned" title="From a tracking link without a signature: anyone who knows the email's number could produce this row, so it is not counted">Unverified</span>
                                    <ng-template #classified><span *ngIf="i.classification" class="et-badge" [ngClass]="'et-cls-' + i.classification">{{ cls(i.classification) }}</span></ng-template>
                                    <div class="et-reasons" *ngIf="i.reasons.length"><span class="et-reason" *ngFor="let r of i.reasons">{{ r }}</span></div>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                <div class="et-more" *ngIf="hasMore">
                    <button type="button" class="btn btn-secondary" (click)="loadMore()" [disabled]="loadingMore">{{ loadingMore ? 'Loading…' : 'Load more' }}</button>
                </div>
            </vdr-page-block>
        </ng-container>
    `,
    styles: [`
        .et-title { margin: 0; font-size: 1.25rem; line-height: 1.3; font-weight: 600; overflow-wrap: anywhere; }
        .et-actions { display: flex; flex-wrap: wrap; gap: 4px; justify-content: flex-end; }
        .et-retry { margin-left: auto; }
        .et-error { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 10px 14px; border-radius: 6px; background: #fee2e2; color: #991b1b; border: 1px solid #fca5a5; font-size: 13px; }
        .et-muted { color: var(--color-component-color-300); }
        .et-small { font-size: 11.5px; }
        .et-caution { display: flex; gap: 8px; align-items: flex-start; padding: 10px 14px; border-left: 4px solid #d97706; background: #fef3c7; color: #78350f; border-radius: 6px; font-size: 13px; }
        .et-locked { padding: 12px 16px; border-radius: 10px; background: #fffbeb; border: 1px solid #fcd34d; color: #92400e; font-size: 13px; }
        .et-locked a { color: #92400e; text-decoration: underline; font-weight: 600; }
        :host-context([data-theme='dark']) .et-locked { background: #451a03; border-color: #b45309; color: #fde68a; }
        :host-context([data-theme='dark']) .et-locked a { color: #fde68a; }
        .et-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
        .et-card { min-width: 0; padding: 10px 14px; border: 1px solid var(--color-component-border-200); border-radius: 8px; background: var(--color-component-bg-100); }
        .et-k { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--color-component-color-300); }
        .et-v { font-size: 18px; font-weight: 700; margin-top: 2px; overflow-wrap: anywhere; }
        .et-sub { font-size: 11.5px; color: var(--color-component-color-300); margin-top: 2px; overflow-wrap: anywhere; }
        .et-pdf { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
        .et-check { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; cursor: pointer; }
        .et-check input:focus-visible { outline: 2px solid var(--color-primary-500, #1d4ed8); outline-offset: 2px; }
        .et-filters { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }
        .et-chip { border: 1px solid var(--color-component-border-200); background: var(--color-component-bg-100); color: inherit; border-radius: 999px; padding: 4px 12px; font-size: 12.5px; cursor: pointer; }
        .et-chip.on { background: #0369a1; border-color: #0369a1; color: #fff; }
        .et-chip:focus-visible { outline: 2px solid var(--color-primary-500, #1d4ed8); outline-offset: 2px; }
        .et-count { margin-left: auto; font-size: 12px; }
        .et-empty { padding: 24px; text-align: center; color: var(--color-component-color-300); }
        /* The table scrolls inside its own box; the page never grows wider than the screen. */
        .et-scroll { overflow-x: auto; contain: inline-size; width: 100%; -webkit-overflow-scrolling: touch; }
        .et-table td { vertical-align: top; }
        .et-table th, .et-table td { text-align: left; }
        .et-table td.et-detail { min-width: 160px; }
        .et-nowrap { white-space: nowrap; }
        .et-event { display: flex; align-items: center; gap: 4px; font-weight: 600; }
        .et-detail { max-width: 420px; word-break: break-word; }
        /* A multi-line note keeps its line breaks, as in the PDF and the CSV. */
        .et-text { white-space: pre-line; }
        .et-url { font-family: monospace; }
        .et-badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
        .et-cls-human_likely { background: #dcfce7; color: #166534; }
        .et-cls-machine_likely { background: #fef3c7; color: #92400e; }
        .et-cls-unknown { background: var(--color-component-bg-200); color: var(--color-component-color-300); }
        .et-reasons { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px; }
        .et-reason { font-size: 10.5px; padding: 0 6px; border-radius: 4px; background: #fff7ed; border: 1px solid #fed7aa; color: #9a3412; }
        .et-legacy { display: inline-block; margin-top: 2px; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--color-component-color-300); border: 1px solid var(--color-component-border-200); border-radius: 4px; padding: 0 4px; }
        .et-unsigned { background: #fee2e2; color: #991b1b; margin-left: 4px; }
        .et-tone-bad { color: #b91c1c; }
        .et-tone-warn { color: #b45309; }
        .et-tone-good { color: #15803d; }
        :host-context([data-theme='dark']) .et-tone-bad { color: #f87171; }
        :host-context([data-theme='dark']) .et-tone-warn { color: #fbbf24; }
        :host-context([data-theme='dark']) .et-tone-good { color: #4ade80; }
        .et-more { display: flex; justify-content: center; padding: 12px 0; }
        @media (max-width: 767px) {
            :host ::ng-deep vdr-action-bar { display: block; }
            :host ::ng-deep vdr-ab-right { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
            .et-actions { justify-content: flex-start; }
            .et-count { margin-left: 0; flex-basis: 100%; }
        }
    `],
})
export class OrderActivityPageComponent implements OnInit {
    readonly filters = FILTERS;
    orderId = '';
    filter = 'all';
    items: ActivityItem[] = [];
    total = 0;
    hasMore = false;
    cursor: string | null = null;
    summary: ActivitySummary | null = null;
    warning = '';
    loading = false;
    loadingMore = false;
    busy = false;
    locked = false;
    /** Set when the timeline could not be loaded (403, 404, network): shown instead of an empty timeline. */
    loadError = '';
    /** The order's Vendure history could not be read: the timeline has email rows only. */
    historyUnavailable = false;
    /** Print private order notes (marked internal) in the PDF. */
    internalNotes = false;

    readonly cls = classLabel;
    readonly where = locationLabel;
    readonly net = networkLabel;
    readonly client = clientLabel;
    readonly icon = iconFor;
    readonly unsigned = isUnsigned;
    readonly link = linkLabel;
    readonly tone = (i: ActivityItem) => toneFor(i);
    readonly trackId = (_n: number, i: ActivityItem) => i.id;

    constructor(private http: EmailTrackingHttp, private tier: EmailTrackingTier, private route: ActivatedRoute, private notify: NotificationService,
        private cdr: ChangeDetectorRef) {}

    filterLabel(): string {
        return (FILTERS.find(f => f.id === this.filter)?.label || this.filter).toLowerCase();
    }

    ngOnInit() {
        this.orderId = this.route.snapshot.paramMap.get('orderId') || '';
        this.loading = true;
        // Unlicensed: the notice, without a premium request (and its 402) being made.
        this.tier.premium$().subscribe(premium => {
            if (premium === false) {
                this.loading = false;
                this.locked = true;
                this.cdr.markForCheck();
                return;
            }
            this.load();
        });
    }

    private url(path: string, params: Record<string, string>): string {
        const q = Object.entries(params).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
        return `/email-track/orders/${encodeURIComponent(this.orderId)}/${path}${q ? `?${q}` : ''}`;
    }

    setFilter(f: string) {
        if (f === this.filter) return;
        this.filter = f;
        this.load();
    }

    load() {
        this.loading = true;
        this.http.get<ActivityPage>(this.url('activity', { filter: this.filter, take: '100' })).subscribe({
            next: p => {
                this.items = p.items;
                this.total = p.total;
                this.hasMore = p.hasMore;
                this.cursor = p.nextCursor;
                this.summary = p.summary || this.summary;
                this.warning = p.warning;
                this.historyUnavailable = !!p.historyUnavailable;
                this.loading = false;
                this.loadError = '';
                this.cdr.markForCheck();
            },
            error: e => {
                this.loading = false;
                this.items = [];
                this.hasMore = false;
                if (e?.status === 402) this.locked = true;
                else this.loadError = errorMessage(e, 'Loading the order activity');
                this.cdr.markForCheck();
            },
        });
    }

    loadMore() {
        if (!this.cursor) return;
        this.loadingMore = true;
        this.http.get<ActivityPage>(this.url('activity', { filter: this.filter, take: '100', cursor: this.cursor })).subscribe({
            next: p => {
                this.items = [...this.items, ...p.items];
                this.hasMore = p.hasMore;
                this.cursor = p.nextCursor;
                this.total = p.total;
                this.loadingMore = false;
                this.cdr.markForCheck();
            },
            error: e => { this.loadingMore = false; this.notify.error(errorMessage(e, 'Loading more activity')); this.cdr.markForCheck(); },
        });
    }

    private download(path: string, params: Record<string, string>, filename: string, what: string) {
        this.busy = true;
        this.http.get(this.url(path, params), { responseType: 'blob' }).subscribe({
            next: blob => { this.busy = false; saveBlob(blob, filename); this.cdr.markForCheck(); },
            error: e => { this.busy = false; this.notify.error(errorMessage(e, what)); this.cdr.markForCheck(); },
        });
    }

    /** The name the server's Content-Disposition gives (filter and UTC date included). */
    exportCsv() {
        this.download('activity.csv', { filter: this.filter }, exportFileName(this.summary?.order.code || this.orderId, this.filter, false, 'csv'), 'CSV export');
    }

    /** Always the whole timeline. */
    exportFull() {
        this.download('activity.json', { full: '1' }, exportFileName(this.summary?.order.code || this.orderId, 'all', true, 'json'), 'Full export');
    }

    evidence() {
        openEvidenceReport(this.http, this.orderId, m => this.notify.error(m), { internalNotes: this.internalNotes });
    }
}
