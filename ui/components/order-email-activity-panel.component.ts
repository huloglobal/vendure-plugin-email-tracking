import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { UntypedFormGroup } from '@angular/forms';
import { CustomDetailComponent, NotificationService, PermissionsService, SharedModule } from '@vendure/admin-ui/core';
import { Observable, Subscription } from 'rxjs';
import {
    ActivityItem, ActivityPage, classLabel, clientLabel, collapseRuns, EmailTrackingHttp, EmailTrackingTier, emailsInProgress, errorMessage, iconFor,
    isUnsigned, locationLabel, openEvidenceReport, PanelRow, stateLabel, toneFor,
} from './activity-shared';

/**
 * "Email activity" on the order detail page: the email summary and the
 * latest ten rows (emails, deliveries, opens, clicks and the order's own
 * history — consecutive identical machine-likely opens folded into one row,
 * reading up to four pages of 100 to fill the ten rows),
 * a link to the full activity page and the PDF evidence report (private
 * order notes left out; the full page offers to include them). Hidden for
 * admins without ReadOrder and ReadCustomer. The free tier (0.17.0) gets the
 * order's email list instead (sent, to, status, opens, clicks) with a note
 * that the timeline and the evidence report are premium; no premium request
 * is made for it.
 *
 * Emails are counted once each (a retried email is one email): accepted by
 * the mail server, and delivered only where a provider webhook can report
 * it; sending, retrying, deferred, no reply recorded, failed and suppressed
 * when there are any. Refresh reads the card again; while an email is
 * sending or waiting for its retry the card refreshes itself every 10
 * seconds, for up to 3 minutes.
 */
@Component({
    selector: 'hulo-order-email-activity-panel',
    standalone: true,
    imports: [SharedModule],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <vdr-card title="Email activity" *ngIf="allowed">
            <div *ngIf="state === 'loading'" class="et-muted" role="status">Loading email activity…</div>
            <ng-container *ngIf="state === 'list'">
                <table class="table et-emails" *ngIf="emails.length; else noEmailsTpl" aria-label="Emails sent for this order">
                    <thead><tr><th>Sent</th><th>Email</th><th>To</th><th>Status</th><th>Opens</th><th>Clicks</th></tr></thead>
                    <tbody>
                        <tr *ngFor="let e of emails">
                            <td><time [attr.datetime]="e.createdAt">{{ e.createdAt | localeDate:'short' }}</time></td>
                            <td [title]="e.subject || ''">{{ e.type }}</td>
                            <td class="et-to">{{ e.recipient }}</td>
                            <td [ngClass]="listTone(e.state || e.status)">{{ stateText(e.state || e.status) }}</td>
                            <td>{{ e.openCount || 0 }}</td>
                            <td>{{ e.clickCount || 0 }}</td>
                        </tr>
                    </tbody>
                </table>
                <ng-template #noEmailsTpl><p class="et-muted">No emails for this order yet.</p></ng-template>
                <p class="et-muted et-small" *ngIf="emailsTotal > emails.length">Showing the latest {{ emails.length }} of {{ emailsTotal }}.</p>
                <div class="et-locked et-small">
                    The full activity timeline (deliveries, each open and click, the order's own history) and the PDF evidence report are premium —
                    <a [routerLink]="['/extensions', 'email-log']">subscribe or activate a key</a> on the Email Log page.
                </div>
                <div class="et-actions">
                    <button type="button" class="btn btn-sm btn-secondary" (click)="refresh()">
                        <clr-icon shape="refresh" aria-hidden="true"></clr-icon> Refresh
                    </button>
                    <a class="btn btn-sm btn-secondary" [routerLink]="['/extensions', 'email-log']" [queryParams]="{ orderCode: orderCode }" *ngIf="orderCode">Open in Email Log</a>
                </div>
            </ng-container>
            <div *ngIf="state === 'error'" class="et-muted" role="alert">
                {{ error }}
                <button type="button" class="btn btn-sm btn-link" (click)="refresh()">Try again</button>
            </div>
            <ng-container *ngIf="state === 'ready' && page">
                <div class="et-stats" *ngIf="page.summary as s">
                    <span class="et-stat"><strong>{{ s.emails.total }}</strong> email{{ s.emails.total === 1 ? '' : 's' }}<ng-container *ngIf="s.emails.attempts > s.emails.total"> ({{ s.emails.attempts }} attempts)</ng-container></span>
                    <span class="et-stat" [title]="s.deliveryEvents ? 'The mail server took the email (SMTP 250)' : 'The mail server took the email (SMTP 250). Delivery to the inbox is not reported: no provider webhook is configured.'">
                        <strong>{{ s.emails.sent }}</strong> accepted by the mail server
                    </span>
                    <span class="et-stat" *ngIf="s.deliveryEvents" title="Delivery reported by your mail provider's webhook"><strong>{{ s.emails.delivered }}</strong> delivered</span>
                    <span class="et-stat et-tone-warn" *ngIf="s.emails.sending" title="No reply from the mail server yet"><strong>{{ s.emails.sending }}</strong> sending</span>
                    <span class="et-stat et-tone-warn" *ngIf="s.emails.retrying" title="Refused for the time being: it is sent again automatically"><strong>{{ s.emails.retrying }}</strong> retrying</span>
                    <span class="et-stat et-tone-warn" *ngIf="s.emails.deferred" title="Put off for now: by the mail server (an SMTP 4xx reply) or, after it accepted the email, by the receiving server"><strong>{{ s.emails.deferred }}</strong> deferred</span>
                    <span class="et-stat et-tone-warn" *ngIf="s.emails.unknown" title="No reply from the mail server was ever recorded: the send was cut off, for example by a restart"><strong>{{ s.emails.unknown }}</strong> no reply recorded</span>
                    <span class="et-stat et-tone-bad" *ngIf="s.emails.failed" title="Refused for good, or every retry failed"><strong>{{ s.emails.failed }}</strong> failed</span>
                    <span class="et-stat" *ngIf="s.emails.suppressed" title="Not sent: the recipient is on the suppression list"><strong>{{ s.emails.suppressed }}</strong> suppressed</span>
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
                        <span class="et-legacy" *ngIf="r.item.legacy" title="Read from the email log: sent before the event timeline began (0.16.0)">legacy</span>
                    </li>
                </ol>
                <ng-template #emptyTpl><p class="et-muted">No email activity for this order yet.</p></ng-template>
                <p class="et-muted et-small" *ngIf="rows.length">Locations are IP-derived and approximate (mail proxies, VPNs, scanners).</p>
                <p class="et-muted et-small" *ngIf="polling" role="status">Updating every 10 seconds while an email is being sent or retried.</p>
                <div class="et-actions">
                    <button type="button" class="btn btn-sm btn-secondary" (click)="refresh()" [disabled]="refreshing" title="Read the email activity again">
                        <clr-icon shape="refresh" aria-hidden="true"></clr-icon> {{ refreshing ? 'Refreshing…' : 'Refresh' }}
                    </button>
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
        .et-emails { width: 100%; font-size: 12.5px; margin: 0 0 8px; }
        .et-to { word-break: break-all; }
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
    /** Pages of 100 the panel reads at most to fill its ten rows. */
    private static readonly MAX_PAGES = 4;
    /** While an email is sending or retrying: refresh every 10 s, for up to 3 minutes from the load or the last Refresh. */
    private static readonly POLL_EVERY_MS = 10_000;
    private static readonly POLL_FOR_MS = 3 * 60_000;
    private pollTimer: ReturnType<typeof setTimeout> | null = null;
    private pollUntil = 0;
    /** The card refreshes itself (the note under the rows); it stays on while a poll's request is out. */
    polling = false;
    /** A refresh is reading the card again (what is shown stays until it answers). */
    refreshing = false;
    /** The refresh in flight was the poll's: its failure stops the polling without a message. */
    private quietRefresh = false;
    /** `list`: the free tier's per-order email list (0.17.0); the timeline is premium. */
    state: 'loading' | 'ready' | 'list' | 'error' = 'loading';
    emails: any[] = [];
    emailsTotal = 0;
    orderCode: string | null = null;
    readonly stateText = stateLabel;
    listTone(s: string): string {
        if (s === 'failed' || s === 'bounced' || s === 'complained') return 'et-tone-bad';
        if (s === 'deferred' || s === 'retrying' || s === 'sending' || s === 'unknown') return 'et-tone-warn';
        if (s === 'sent' || s === 'delivered') return 'et-tone-good';
        return '';
    }
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
            this.orderCode = order.code ? String(order.code) : null;
            if (this.allowed) this.load();
        });
    }

    ngOnDestroy() { this.sub?.unsubscribe(); this.permSub?.unsubscribe(); this.stopPolling(); }

    load() {
        if (!this.orderId) return;
        this.stopPolling();
        this.pollUntil = 0;
        this.refreshing = false;
        this.state = 'loading';
        this.cdr.markForCheck();
        // Free tier: the order's emails (free since 0.17.0), without a premium request (and its 402) being made.
        this.tier.premium$().subscribe(premium => {
            if (premium === false) {
                this.fetchList();
                return;
            }
            this.fetchPage(null, 1, [], null);
        });
    }

    /** The free per-order email list: `GET /email-track/log?orderId=` (every state, all time, latest 20). */
    private fetchList() {
        const forOrder = this.orderId;
        this.http.get<{ items: any[]; total: number }>(`/email-track/log?orderId=${encodeURIComponent(this.orderId || '')}&fromDays=all&take=20`).subscribe({
            next: r => {
                if (this.orderId !== forOrder) return;
                this.emails = r?.items || [];
                this.emailsTotal = r?.total || 0;
                this.state = 'list';
                this.refreshing = false;
                this.cdr.markForCheck();
            },
            error: e => {
                if (this.orderId !== forOrder) return;
                this.state = 'error';
                this.error = errorMessage(e, 'Loading the order emails');
                this.cdr.markForCheck();
            },
        });
    }

    /**
     * Read the card again, keeping what is shown until the answer comes (the
     * Refresh button: also a new 3-minute polling window; `manual` false: the
     * poll). From an error or the premium notice it loads the card afresh.
     */
    refresh(manual = true) {
        if (!this.orderId) return;
        if (manual) this.pollUntil = 0;
        if (this.state !== 'ready') { this.load(); return; }
        if (this.refreshing) return;
        this.clearPollTimer();
        this.refreshing = true;
        this.quietRefresh = !manual;
        this.cdr.markForCheck();
        this.fetchPage(null, 1, [], null);
    }

    /** While an email is sending or retrying, the next refresh in 10 s — until 3 minutes have passed. */
    private schedulePoll() {
        this.clearPollTimer();
        if (!emailsInProgress(this.page?.summary)) { this.pollUntil = 0; this.polling = false; return; }
        const now = Date.now();
        if (!this.pollUntil) this.pollUntil = now + OrderEmailActivityPanelComponent.POLL_FOR_MS;
        this.polling = now < this.pollUntil;
        if (!this.polling) return;
        this.pollTimer = setTimeout(() => {
            this.pollTimer = null;
            this.refresh(false);
        }, OrderEmailActivityPanelComponent.POLL_EVERY_MS);
    }

    /** Cancel the next poll (the note stays: a refresh is about to answer). */
    private clearPollTimer() {
        if (this.pollTimer !== null) clearTimeout(this.pollTimer);
        this.pollTimer = null;
    }

    /** No more polling: a failed refresh, the premium notice, a reload, the card gone. */
    private stopPolling() {
        this.clearPollTimer();
        this.polling = false;
    }

    /**
     * The latest items, newest first, folded to ten rows (identical proxy opens become one).
     * When a long run of opens fills a page, the next page is read too — at most MAX_PAGES.
     * `acc`: the items read so far; `first`: the first page (it carries the summary).
     */
    private fetchPage(cursor: string | null, n: number, acc: ActivityItem[], first: ActivityPage | null) {
        const forOrder = this.orderId;
        const id = encodeURIComponent(this.orderId || '');
        const url = `/email-track/orders/${id}/activity?take=100&order=desc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        this.http.get<ActivityPage>(url).subscribe({
            next: p => {
                if (this.orderId !== forOrder) return; // another order is shown now
                const head = first || p; // the summary comes with the first page
                const fetched = [...acc, ...(p.items || [])];
                // An eleventh row proves the tenth is complete.
                const rows = collapseRuns(fetched, 11);
                if (rows.length <= 10 && p.hasMore && p.nextCursor && n < OrderEmailActivityPanelComponent.MAX_PAGES) {
                    this.fetchPage(p.nextCursor, n + 1, fetched, head);
                    return;
                }
                this.page = head;
                this.rows = rows.slice(0, 10);
                const last = this.rows[this.rows.length - 1] || null;
                this.openEnded = rows.length <= 10 && p.hasMore && last && last.count > 1 ? last : null;
                this.state = 'ready';
                this.refreshing = false;
                this.schedulePoll();
                this.cdr.markForCheck();
            },
            error: e => {
                if (this.orderId !== forOrder) return;
                const wasRefresh = this.refreshing;
                this.refreshing = false;
                if (wasRefresh && e?.status !== 402) {
                    // A failed refresh keeps the card as it was; only a Refresh click says so.
                    this.stopPolling();
                    if (!this.quietRefresh) this.notify.error(errorMessage(e, 'Refreshing email activity'));
                } else if (e?.status === 402) {
                    // The licence lapsed since the tier was read: the free list instead.
                    this.stopPolling();
                    this.fetchList();
                    return;
                } else {
                    this.state = 'error';
                    this.error = errorMessage(e, 'Loading email activity');
                }
                this.cdr.markForCheck();
            },
        });
    }

    evidence() {
        if (this.orderId) openEvidenceReport(this.http, this.orderId, m => this.notify.error(m));
    }
}
