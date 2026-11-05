import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { UntypedFormGroup } from '@angular/forms';
import { CustomDetailComponent, NotificationService, PermissionsService, SharedModule } from '@vendure/admin-ui/core';
import { Observable, Subscription } from 'rxjs';
import {
    ActivityItem, ActivityPage, classLabel, clientLabel, collapseRuns, EmailTrackingHttp, EmailTrackingTier, errorMessage, iconFor, isUnsigned,
    locationLabel, openEvidenceReport, PanelRow, toneFor,
} from './activity-shared';

/**
 * "Email activity" on the order detail page: the email summary and the
 * latest ten rows (emails, deliveries, opens, clicks and the order's own
 * history — consecutive identical machine-likely opens folded into one row,
 * reading up to four pages of 100 to fill the ten rows),
 * a link to the full activity page and the PDF evidence report (private
 * order notes left out; the full page offers to include them). Hidden for
 * admins without ReadOrder and ReadCustomer; unlicensed installs see the
 * premium notice, never an error, and no premium request is made for them.
 */
@Component({
    selector: 'hulo-order-email-activity-panel',
    standalone: true,
    imports: [SharedModule],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <vdr-card title="Email activity" *ngIf="allowed">
            <div *ngIf="state === 'loading'" class="et-muted" role="status">Loading email activity…</div>
            <div *ngIf="state === 'locked'" class="et-locked">
                Order email activity is a premium feature —
                <a [routerLink]="['/extensions', 'email-log']">subscribe or activate a key</a> on the Email Log page.
            </div>
            <div *ngIf="state === 'error'" class="et-muted" role="alert">{{ error }}</div>
            <ng-container *ngIf="state === 'ready' && page">
                <div class="et-stats" *ngIf="page.summary as s">
                    <span class="et-stat"><strong>{{ s.emails.total }}</strong> emails</span>
                    <span class="et-stat"><strong>{{ s.emails.delivered }}</strong> delivered</span>
                    <span class="et-stat" [title]="s.emails.firstOpenAt ? 'First open ' + (s.emails.firstOpenAt | localeDate:'medium') : ''">
                        <strong>{{ s.emails.opened }}</strong> opened<ng-container *ngIf="s.emails.firstOpenAt"> · first {{ s.emails.firstOpenAt | localeDate:'short' }}</ng-container>
                    </span>
                    <span class="et-stat"><strong>{{ s.emails.clicked }}</strong> clicked</span>
                    <span class="et-stat" [class.et-tone-bad]="s.emails.bounced > 0"><strong>{{ s.emails.bounced }}</strong> bounced / complained</span>
                    <span class="et-stat" title="Advisory classification of every recorded open">
                        opens: <strong>{{ s.opens.human }}</strong> human-likely · <strong>{{ s.opens.machine }}</strong> machine-likely
                    </span>
                </div>
                <ol class="et-list" *ngIf="rows.length; else emptyTpl" aria-label="Latest email and order activity">
                    <li *ngFor="let r of rows" class="et-row">
                        <clr-icon [attr.shape]="icon(r.item)" size="14" aria-hidden="true"></clr-icon>
                        <time class="et-time" [attr.datetime]="r.item.at">{{ r.item.at | localeDate:'short' }}</time>
                        <span class="et-label" [ngClass]="tone(r.item)">{{ r.item.label }}<ng-container *ngIf="r.count > 1"> × {{ r.count }}{{ r === openEnded ? '+' : '' }}</ng-container></span>
                        <span class="et-detail" [title]="r.item.detail || ''">{{ r.item.detail || r.item.emailType || '' }}</span>
                        <span class="et-unsigned" *ngIf="unsigned(r.item); else classified" title="From a tracking link without a signature: anyone could produce it, so it is not counted">Unverified</span>
                        <ng-template #classified><span class="et-badge" *ngIf="r.item.classification" [ngClass]="'et-cls-' + r.item.classification">{{ cls(r.item.classification) }}</span></ng-template>
                        <span class="et-muted et-small" *ngIf="where(r.item) || client(r.item)">{{ where(r.item) }}{{ where(r.item) && client(r.item) ? ' · ' : '' }}{{ client(r.item) }}</span>
                        <span class="et-legacy" *ngIf="r.item.legacy" title="Reconstructed from the email log (sent before 0.16.0)">legacy</span>
                    </li>
                </ol>
                <ng-template #emptyTpl><p class="et-muted">No email activity for this order yet.</p></ng-template>
                <p class="et-muted et-small" *ngIf="rows.length">Locations are IP-derived and approximate (mail proxies, VPNs, scanners).</p>
                <div class="et-actions">
                    <a class="btn btn-sm btn-secondary" [routerLink]="['/extensions', 'email-log', 'orders', orderId]">Open full activity</a>
                    <button type="button" class="btn btn-sm btn-secondary" (click)="evidence()" title="Private order notes are left out; Open full activity offers to include them">
                        <clr-icon shape="file" aria-hidden="true"></clr-icon> Evidence report (PDF)
                    </button>
                </div>
            </ng-container>
        </vdr-card>
    `,
    styles: [`
        .et-stats { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12.5px; margin-bottom: 10px; }
        .et-stat strong { font-weight: 700; }
        .et-list { list-style: none; margin: 0; padding: 0; }
        .et-row { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; padding: 5px 0; border-top: 1px solid var(--color-component-border-200); font-size: 12.5px; }
        .et-row:first-child { border-top: 0; }
        .et-row clr-icon { color: var(--color-component-color-300); align-self: center; }
        .et-time { min-width: 84px; color: var(--color-component-color-300); font-variant-numeric: tabular-nums; }
        .et-label { font-weight: 600; }
        .et-detail { flex: 1 1 160px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .et-badge { padding: 1px 7px; border-radius: 999px; font-size: 10.5px; font-weight: 600; }
        .et-cls-human_likely { background: #dcfce7; color: #166534; }
        .et-cls-machine_likely { background: #fef3c7; color: #92400e; }
        .et-cls-unknown { background: var(--color-component-bg-200); color: var(--color-component-color-200, inherit); }
        .et-unsigned { padding: 1px 7px; border-radius: 999px; font-size: 10.5px; font-weight: 600; background: #fee2e2; color: #991b1b; }
        .et-legacy { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: var(--color-component-color-300); border: 1px solid var(--color-component-border-200); border-radius: 4px; padding: 0 4px; }
        .et-tone-bad { color: #b91c1c; }
        .et-tone-warn { color: #b45309; }
        .et-tone-good { color: #15803d; }
        :host-context([data-theme='dark']) .et-tone-bad { color: #f87171; }
        :host-context([data-theme='dark']) .et-tone-warn { color: #fbbf24; }
        :host-context([data-theme='dark']) .et-tone-good { color: #4ade80; }
        .et-muted { color: var(--color-component-color-300); }
        .et-small { font-size: 11.5px; }
        .et-locked { padding: 8px 12px; border-radius: 8px; background: #fffbeb; border: 1px solid #fcd34d; color: #92400e; font-size: 12.5px; }
        .et-locked a { color: #92400e; text-decoration: underline; }
        :host-context([data-theme='dark']) .et-locked { background: #451a03; border-color: #b45309; color: #fde68a; }
        :host-context([data-theme='dark']) .et-locked a { color: #fde68a; }
        .et-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
    `],
})
export class OrderEmailActivityPanelComponent implements CustomDetailComponent, OnInit, OnDestroy {
    entity$!: Observable<any>;
    detailForm!: UntypedFormGroup;

    orderId: string | null = null;
    page: ActivityPage | null = null;
    rows: PanelRow[] = [];
    /** The last row, when its run of identical opens may go on past what was fetched ("× 400+"). */
    openEnded: PanelRow | null = null;
    private fetched: ActivityItem[] = [];
    /** Pages of 100 the panel reads at most to fill its ten rows. */
    private static readonly MAX_PAGES = 4;
    state: 'loading' | 'ready' | 'locked' | 'error' = 'loading';
    error = '';
    /** The endpoints need ReadOrder AND ReadCustomer; without both the panel is not shown at all. */
    allowed = false;
    private sub?: Subscription;
    private permSub?: Subscription;

    readonly cls = classLabel;
    readonly where = locationLabel;
    readonly client = clientLabel;
    readonly icon = iconFor;
    readonly unsigned = isUnsigned;
    readonly tone = (i: ActivityItem) => toneFor(i);

    constructor(
        private http: EmailTrackingHttp,
        private tier: EmailTrackingTier,
        private notify: NotificationService,
        private permissions: PermissionsService,
        private cdr: ChangeDetectorRef,
    ) {}

    ngOnInit() {
        this.permSub = this.permissions.currentUserPermissions$.subscribe(() => {
            const was = this.allowed;
            this.allowed = this.permissions.userHasPermissions(['ReadOrder']) && this.permissions.userHasPermissions(['ReadCustomer']);
            if (this.allowed && !was && this.orderId) this.load();
            this.cdr.markForCheck();
        });
        this.sub = this.entity$?.subscribe(order => {
            if (!order?.id || String(order.id) === this.orderId) return;
            this.orderId = String(order.id);
            if (this.allowed) this.load();
        });
    }

    ngOnDestroy() { this.sub?.unsubscribe(); this.permSub?.unsubscribe(); }

    load() {
        if (!this.orderId) return;
        this.state = 'loading';
        this.fetched = [];
        this.cdr.markForCheck();
        // Unlicensed: the notice, without a premium request (and its 402) being made.
        this.tier.premium$().subscribe(premium => {
            if (premium === false) {
                this.state = 'locked';
                this.cdr.markForCheck();
                return;
            }
            this.fetchPage(null, 1);
        });
    }

    /**
     * The latest items, newest first, folded to ten rows (identical proxy opens become one).
     * When a long run of opens fills a page, the next page is read too — at most MAX_PAGES.
     */
    private fetchPage(cursor: string | null, n: number) {
        const id = encodeURIComponent(this.orderId || '');
        const url = `/email-track/orders/${id}/activity?take=100&order=desc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        this.http.get<ActivityPage>(url).subscribe({
            next: p => {
                if (!cursor) this.page = p; // the summary comes with the first page
                this.fetched.push(...(p.items || []));
                // An eleventh row proves the tenth is complete.
                const rows = collapseRuns(this.fetched, 11);
                if (rows.length <= 10 && p.hasMore && p.nextCursor && n < OrderEmailActivityPanelComponent.MAX_PAGES) {
                    this.fetchPage(p.nextCursor, n + 1);
                    return;
                }
                this.rows = rows.slice(0, 10);
                const last = this.rows[this.rows.length - 1] || null;
                this.openEnded = rows.length <= 10 && p.hasMore && last && last.count > 1 ? last : null;
                this.state = 'ready';
                this.cdr.markForCheck();
            },
            error: e => {
                if (e?.status === 402) this.state = 'locked';
                else { this.state = 'error'; this.error = errorMessage(e, 'Loading email activity'); }
                this.cdr.markForCheck();
            },
        });
    }

    evidence() {
        if (this.orderId) openEvidenceReport(this.http, this.orderId, m => this.notify.error(m));
    }
}
