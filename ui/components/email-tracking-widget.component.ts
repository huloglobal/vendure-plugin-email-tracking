import { ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { SharedModule } from '@vendure/admin-ui/core';
import { EmailTrackingHttp } from './activity-shared';

interface WidgetData {
    tier: 'paid' | 'trial' | 'free';
    notice: { kind: string; message: string; daysLeft: number } | null;
    stats: Array<{ label: string; value: string }>;
    route: string;
}

/**
 * Dashboard widget: the last 7 days of Email Tracking at a glance
 * (Dashboard → Add widget → Email Tracking). Reads `GET /email-track/widget`
 * with the admin session (and the bearer token on bearer-auth hosts), same as the Email Log page.
 */
@Component({
    selector: 'hulo-email-tracking-widget',
    standalone: true,
    imports: [SharedModule],
    template: `
        <div class="et-widget">
            <div class="et-stats" *ngIf="data; else loadingTpl">
                <div class="et-stat" *ngFor="let s of data.stats">
                    <div class="et-num">{{ s.value }}</div>
                    <div class="et-lbl">{{ s.label }}</div>
                </div>
            </div>
            <ng-template #loadingTpl>
                <div class="et-muted">{{ error || 'Loading…' }}</div>
            </ng-template>
            <div class="et-notice" *ngIf="data?.notice as n">{{ n.message }}</div>
            <div class="et-foot">
                <span class="et-muted">Last 7 days<ng-container *ngIf="data?.tier === 'trial'"> · evaluation</ng-container><ng-container *ngIf="data?.tier === 'free'"> · free tier</ng-container></span>
                <a [routerLink]="data?.route || '/extensions/email-log'" class="btn btn-sm btn-link">Open Email Tracking</a>
            </div>
        </div>
    `,
    styles: [`
        .et-widget { display: flex; flex-direction: column; gap: 10px; min-height: 120px; }
        .et-stats { display: flex; gap: 12px; flex-wrap: wrap; }
        .et-stat { flex: 1 1 90px; padding: 10px 12px; border-radius: 8px; background: var(--color-component-bg-200); }
        .et-num { font-size: 26px; font-weight: 700; line-height: 1.1; color: var(--color-text-100, inherit); }
        .et-lbl { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--color-component-color-300); margin-top: 2px; }
        .et-notice { padding: 8px 12px; border-radius: 8px; background: #fffbeb; border: 1px solid #fcd34d; color: #92400e; font-size: 12.5px; }
        .et-foot { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
        .et-muted { font-size: 12px; color: var(--color-component-color-300); }
    `],
})
export class EmailTrackingWidgetComponent implements OnInit {
    data: WidgetData | null = null;
    error = '';

    constructor(private http: EmailTrackingHttp, private cdr: ChangeDetectorRef) {}

    ngOnInit() {
        this.http.get<WidgetData>('/email-track/widget').subscribe({
            next: d => { this.data = d; this.cdr.markForCheck(); },
            error: () => { this.error = 'Could not load Email Tracking figures'; this.cdr.markForCheck(); },
        });
    }
}
