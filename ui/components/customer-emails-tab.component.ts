import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { SharedModule } from '@vendure/admin-ui/core';
import { EmailTrackingHttp, errorMessage } from './activity-shared';

interface EmailRow {
    id: number;
    createdAt: string;
    type: string;
    subject: string;
    status: string;
    orderId: number | null;
    orderCode: string | null;
    openCount: number;
    firstOpenedAt: string | null;
    clickCount: number;
}

/**
 * Customers → (a customer) → Emails: every email logged for that customer,
 * from the same `GET /email-track/log?customerId=` list the Email Log page
 * uses, with links to each order's activity and to the full Email Log.
 */
@Component({
    selector: 'hulo-customer-emails-tab',
    standalone: true,
    imports: [SharedModule],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <vdr-page-block>
            <vdr-card title="Emails sent to this customer">
                <div class="et-head">
                    <span class="et-muted" *ngIf="!loading">{{ total }} email{{ total === 1 ? '' : 's' }}</span>
                    <a *ngIf="customerId" class="btn btn-sm btn-link" [routerLink]="['/extensions', 'email-log']" [queryParams]="{ customerId: customerId }">Open in Email Log</a>
                </div>
                <div *ngIf="loading" class="et-muted" role="status">Loading…</div>
                <div *ngIf="error" class="et-muted" role="alert">{{ error }}</div>
                <div *ngIf="!loading && !error && !rows.length" class="et-muted">No emails have been logged for this customer.</div>
                <div class="et-scroll" *ngIf="rows.length">
                    <table class="table table-compact et-table">
                        <!-- Fixed column widths: all seven columns fit the card from about 760 px (a 1280 px screen);
                             narrower, the table scrolls inside its box. -->
                        <colgroup>
                            <col style="width: 15%" /><col style="width: 13%" /><col style="width: 19%" /><col style="width: 21%" />
                            <col style="width: 13%" /><col style="width: 9.5%" /><col style="width: 9.5%" />
                        </colgroup>
                        <thead>
                            <tr>
                                <th scope="col">Sent</th><th scope="col">Type</th><th scope="col">Order</th><th scope="col">Subject</th>
                                <th scope="col">Status</th><th scope="col">Opens</th><th scope="col">Clicks</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr *ngFor="let r of rows">
                                <td>{{ r.createdAt | localeDate:'short' }}</td>
                                <td><span class="et-pill">{{ r.type }}</span></td>
                                <td class="et-order">
                                    <ng-container *ngIf="r.orderId; else noOrder">
                                        <a [routerLink]="['/orders', r.orderId]">{{ r.orderCode || ('#' + r.orderId) }}</a>
                                        <a class="et-small et-block" [routerLink]="['/extensions', 'email-log', 'orders', r.orderId]">activity</a>
                                    </ng-container>
                                    <ng-template #noOrder><span class="et-muted">—</span></ng-template>
                                </td>
                                <td class="et-subject" [title]="r.subject">{{ r.subject }}</td>
                                <td><span class="et-status" [ngClass]="'et-status-' + r.status">{{ r.status }}</span></td>
                                <td>{{ r.openCount }}<div class="et-muted et-small" *ngIf="r.firstOpenedAt">{{ r.firstOpenedAt | localeDate:'short' }}</div></td>
                                <td>{{ r.clickCount }}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <div class="et-pager" *ngIf="total > take">
                    <button type="button" class="btn btn-sm btn-secondary" (click)="page(-1)" [disabled]="skip === 0 || loading">Previous</button>
                    <span class="et-muted">{{ skip + 1 }}–{{ skip + rows.length }} of {{ total }}</span>
                    <button type="button" class="btn btn-sm btn-secondary" (click)="page(1)" [disabled]="skip + take >= total || loading">Next</button>
                </div>
            </vdr-card>
        </vdr-page-block>
    `,
    styles: [`
        .et-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 8px; }
        .et-muted { color: var(--color-component-color-300); }
        .et-small { font-size: 11px; }
        .et-scroll { overflow-x: auto; contain: inline-size; width: 100%; }
        .et-table { table-layout: fixed; width: 100%; min-width: 760px; }
        .et-table th, .et-table td { text-align: left; overflow-wrap: anywhere; }
        .et-block { display: block; }
        .et-subject { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .et-pill { display: inline-block; max-width: 100%; padding: 1px 8px; border-radius: 10px; font-size: 11px; border: 1px solid var(--color-component-border-200); background: var(--color-component-bg-200); }
        /* White on each status colour is at least 4.5:1 (WCAG AA). */
        .et-status { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; text-transform: uppercase; color: #fff; background: #475569; }
        .et-status-sent { background: #047857; }
        .et-status-delivered { background: #15803d; }
        .et-status-failed { background: #b91c1c; }
        .et-status-deferred { background: #b45309; }
        .et-status-bounced { background: #7e22ce; }
        .et-status-complained { background: #be185d; }
        .et-pager { display: flex; justify-content: flex-end; align-items: center; gap: 10px; padding-top: 10px; }
    `],
})
export class CustomerEmailsTabComponent implements OnInit {
    customerId: string | null = null;
    rows: EmailRow[] = [];
    total = 0;
    take = 25;
    skip = 0;
    loading = false;
    error = '';

    constructor(private http: EmailTrackingHttp, private route: ActivatedRoute, private cdr: ChangeDetectorRef) {}

    ngOnInit() {
        // The tab is a child route of customers/:id — read the id from the nearest route that has it.
        for (const snap of [...this.route.snapshot.pathFromRoot].reverse()) {
            const id = snap.paramMap.get('id');
            if (id) { this.customerId = id; break; }
        }
        this.load();
    }

    page(dir: number) {
        this.skip = Math.max(0, this.skip + dir * this.take);
        this.load();
    }

    load() {
        if (!this.customerId || !/^\d+$/.test(this.customerId)) {
            this.error = 'Emails appear here once the customer has been saved.';
            this.cdr.markForCheck();
            return;
        }
        this.loading = true;
        this.error = '';
        this.cdr.markForCheck();
        this.http.get<{ items: EmailRow[]; total: number }>(`/email-track/log?customerId=${encodeURIComponent(this.customerId)}&take=${this.take}&skip=${this.skip}`).subscribe({
            next: r => { this.rows = r?.items || []; this.total = r?.total || 0; this.loading = false; this.cdr.markForCheck(); },
            error: e => { this.loading = false; this.error = errorMessage(e, 'Loading the emails'); this.cdr.markForCheck(); },
        });
    }
}
