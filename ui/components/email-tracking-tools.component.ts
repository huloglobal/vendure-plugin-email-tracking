import { ChangeDetectionStrategy, ChangeDetectorRef, Component, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NotificationService, SharedModule } from '@vendure/admin-ui/core';
import { EmailTrackingHttp, errorMessage } from './activity-shared';

interface SuppressionRow { id: number; createdAt: string; recipient: string; reason: string; note: string | null; channelId: number | null; }
interface TrackingSettingsView {
    trackOpens: boolean; trackClicks: boolean; trustedProxies: string[]; configuredProxies: string[]; trustedIpHeaders: string[];
}

/**
 * The free tools under the Email Log (0.17.0): the suppression list (search,
 * add, remove), the tracking settings (open / click switches, trusted
 * proxies) and the privacy tools (export / erase everything held about one
 * address). Each card answers its own errors; saving settings needs
 * SuperAdmin, erasing needs DeleteCustomer.
 */
@Component({
    selector: 'hulo-email-tracking-tools',
    standalone: true,
    imports: [SharedModule, FormsModule],
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <div class="et-tools">
            <section class="hulo-card" aria-labelledby="et-sup-h">
                <h4 id="et-sup-h">Suppression list <span class="et-muted">{{ supTotal }} address{{ supTotal === 1 ? '' : 'es' }}</span></h4>
                <p class="et-muted et-small">Emails are never sent to these addresses (a password reset still is). Hard bounces and spam complaints add an address automatically.</p>
                <div class="et-row">
                    <input class="form-input" type="search" [(ngModel)]="supQuery" (keyup.enter)="loadSuppression(0)" placeholder="Search addresses" aria-label="Search the suppression list">
                    <button class="btn btn-sm btn-secondary" (click)="loadSuppression(0)">Search</button>
                </div>
                <table class="table et-table" *ngIf="supRows.length; else supEmpty">
                    <thead><tr><th>Address</th><th>Reason</th><th>Note</th><th>Added</th><th></th></tr></thead>
                    <tbody>
                        <tr *ngFor="let r of supRows">
                            <td class="et-addr">{{ r.recipient }}</td>
                            <td>{{ reasonLabel(r.reason) }}</td>
                            <td class="et-note" [title]="r.note || ''">{{ r.note || '' }}</td>
                            <td>{{ r.createdAt | localeDate:'short' }}</td>
                            <td><button class="btn btn-sm btn-link" (click)="removeSuppression(r)" [disabled]="busy">Remove</button></td>
                        </tr>
                    </tbody>
                </table>
                <ng-template #supEmpty><p class="et-muted">{{ supLoading ? 'Loading…' : 'No addresses on the list.' }}</p></ng-template>
                <div class="et-row" *ngIf="supTotal > supTake">
                    <button class="btn btn-sm btn-secondary" (click)="loadSuppression(supSkip - supTake)" [disabled]="supSkip === 0">Previous</button>
                    <span class="et-muted et-small">{{ supSkip + 1 }}–{{ supSkip + supRows.length }} of {{ supTotal }}</span>
                    <button class="btn btn-sm btn-secondary" (click)="loadSuppression(supSkip + supTake)" [disabled]="supSkip + supTake >= supTotal">Next</button>
                </div>
                <div class="et-row et-add">
                    <input class="form-input" type="email" [(ngModel)]="newAddress" placeholder="name@example.com" aria-label="Address to suppress">
                    <select class="form-input" [(ngModel)]="newReason" aria-label="Reason">
                        <option value="manual">Manual</option>
                        <option value="unsubscribe">Asked not to be emailed</option>
                        <option value="hard-bounce">Hard bounce</option>
                        <option value="complaint">Spam complaint</option>
                    </select>
                    <input class="form-input" type="text" [(ngModel)]="newNote" placeholder="Note (optional)" aria-label="Note">
                    <button class="btn btn-sm btn-primary" (click)="addSuppression()" [disabled]="busy || !newAddress">Add</button>
                </div>
            </section>

            <section class="hulo-card" aria-labelledby="et-set-h">
                <h4 id="et-set-h">Tracking settings</h4>
                <ng-container *ngIf="settings; else setLoading">
                    <label class="et-check"><input type="checkbox" [(ngModel)]="settings.trackOpens"> Track opens <span class="et-muted et-small">(adds a 1×1 image to HTML emails)</span></label>
                    <label class="et-check"><input type="checkbox" [(ngModel)]="settings.trackClicks"> Track link clicks <span class="et-muted et-small">(links pass through this server; unsubscribe links never do)</span></label>
                    <p class="et-muted et-small">Switching one off stops it at once for new emails and new hits; what was recorded stays until retention removes it.</p>
                    <label for="et-proxies" class="et-label">Trusted proxies</label>
                    <textarea id="et-proxies" class="form-input et-proxies" rows="3" [(ngModel)]="proxiesText" placeholder="10.0.0.0/8&#10;2400:cb00::/32"></textarea>
                    <p class="et-muted et-small">
                        IPs or CIDR ranges of your reverse proxies, one per line. Proxy headers
                        <ng-container *ngIf="settings.trustedIpHeaders.length; else noHeaders">({{ settings.trustedIpHeaders.join(', ') }})</ng-container>
                        <ng-template #noHeaders>(none set in <code>trustedIpHeaders</code>, so the connection address is used)</ng-template>
                        are then believed only from these addresses.
                        <ng-container *ngIf="settings.configuredProxies.length"> Also trusted from the plugin configuration: {{ settings.configuredProxies.join(', ') }}.</ng-container>
                    </p>
                    <button class="btn btn-sm btn-primary" (click)="saveSettings()" [disabled]="busy">Save settings</button>
                </ng-container>
                <ng-template #setLoading><p class="et-muted">{{ settingsError || 'Loading…' }}</p></ng-template>
            </section>

            <section class="hulo-card" aria-labelledby="et-priv-h">
                <h4 id="et-priv-h">Privacy</h4>
                <p class="et-muted et-small">Export or erase everything this plugin holds about one address: its emails, their opens, clicks and delivery events. Erasing keeps the address on the suppression list (the record that it must not be emailed); remove it there too if it should go.</p>
                <div class="et-row">
                    <input class="form-input" type="email" [(ngModel)]="privacyEmail" placeholder="name@example.com" aria-label="Address">
                    <button class="btn btn-sm btn-secondary" (click)="exportPrivacy()" [disabled]="busy || !privacyEmail">Export (JSON)</button>
                    <button class="btn btn-sm btn-warning" (click)="erasePrivacy()" [disabled]="busy || !privacyEmail">Erase…</button>
                </div>
                <p class="et-small" *ngIf="privacyResult" role="status">{{ privacyResult }}</p>
            </section>
        </div>
    `,
    styles: [`
        .et-tools { display: grid; gap: 12px; }
        .hulo-card { padding: 14px 16px; border-radius: 8px; border: 1px solid var(--color-component-border-200); background: var(--color-component-bg-100); }
        .hulo-card h4 { margin: 0 0 6px; font-size: 14px; }
        .et-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 6px 0; }
        .et-row .form-input { flex: 1 1 180px; min-width: 0; height: 30px; padding: 4px 8px; }
        .et-add select.form-input { flex: 0 1 190px; }
        .et-table { width: 100%; font-size: 12.5px; margin: 6px 0; }
        .et-addr { word-break: break-all; }
        .et-note { max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .et-check { display: block; margin: 4px 0; font-size: 13px; }
        .et-label { display: block; margin-top: 8px; font-weight: 600; font-size: 12.5px; }
        .et-proxies { width: 100%; font-family: monospace; min-height: 60px; }
        .et-muted { color: var(--color-component-color-300); font-weight: normal; }
        .et-small { font-size: 11.5px; }
        @media (max-width: 767px) { :host button, :host .btn { min-height: 40px; } .et-note { max-width: 120px; } }
    `],
})
export class EmailTrackingToolsComponent implements OnInit {
    supRows: SuppressionRow[] = [];
    supTotal = 0;
    supSkip = 0;
    readonly supTake = 50;
    supQuery = '';
    supLoading = false;
    newAddress = '';
    newReason = 'manual';
    newNote = '';
    settings: TrackingSettingsView | null = null;
    settingsError = '';
    proxiesText = '';
    privacyEmail = '';
    privacyResult = '';
    busy = false;

    constructor(private http: EmailTrackingHttp, private notify: NotificationService, private cdr: ChangeDetectorRef) {}

    ngOnInit() {
        this.loadSuppression(0);
        this.loadSettings();
    }

    reasonLabel(r: string): string {
        return ({ 'hard-bounce': 'Hard bounce', complaint: 'Spam complaint', manual: 'Manual', unsubscribe: 'Asked not to be emailed' } as Record<string, string>)[r] || r;
    }

    loadSuppression(skip: number) {
        this.supSkip = Math.max(0, skip);
        this.supLoading = true;
        const q = this.supQuery.trim() ? `&q=${encodeURIComponent(this.supQuery.trim())}` : '';
        this.http.get<{ items: SuppressionRow[]; total: number }>(`/email-track/suppression?take=${this.supTake}&skip=${this.supSkip}${q}`).subscribe({
            next: r => { this.supRows = r.items || []; this.supTotal = r.total || 0; this.supLoading = false; this.cdr.markForCheck(); },
            error: e => { this.supLoading = false; this.notify.error(errorMessage(e, 'Loading the suppression list')); this.cdr.markForCheck(); },
        });
    }

    addSuppression() {
        this.busy = true;
        this.http.post('/email-track/suppression', { recipient: this.newAddress.trim(), reason: this.newReason, note: this.newNote.trim() || undefined }).subscribe({
            next: () => {
                this.busy = false;
                this.notify.success(`${this.newAddress.trim()} added to the suppression list`);
                this.newAddress = ''; this.newNote = '';
                this.loadSuppression(0);
            },
            error: e => { this.busy = false; this.notify.error(errorMessage(e, 'Adding the address')); this.cdr.markForCheck(); },
        });
    }

    removeSuppression(r: SuppressionRow) {
        if (!window.confirm(`Remove ${r.recipient} from the suppression list? Emails to it are sent again.`)) return;
        this.busy = true;
        this.http.delete(`/email-track/suppression/${encodeURIComponent(r.recipient)}`).subscribe({
            next: () => { this.busy = false; this.notify.success(`${r.recipient} removed`); this.loadSuppression(this.supSkip); },
            error: e => { this.busy = false; this.notify.error(errorMessage(e, 'Removing the address')); this.cdr.markForCheck(); },
        });
    }

    loadSettings() {
        this.http.get<TrackingSettingsView>('/email-track/settings').subscribe({
            next: s => { this.settings = s; this.proxiesText = (s.trustedProxies || []).join('\n'); this.cdr.markForCheck(); },
            error: e => { this.settingsError = errorMessage(e, 'Loading the settings'); this.cdr.markForCheck(); },
        });
    }

    saveSettings() {
        if (!this.settings) return;
        this.busy = true;
        const body = { trackOpens: this.settings.trackOpens, trackClicks: this.settings.trackClicks, trustedProxies: this.proxiesText };
        this.http.post<TrackingSettingsView>('/email-track/settings', body).subscribe({
            next: s => { this.busy = false; this.settings = s; this.proxiesText = s.trustedProxies.join('\n'); this.notify.success('Tracking settings saved'); this.cdr.markForCheck(); },
            error: e => {
                this.busy = false;
                this.notify.error(e?.status === 403 ? 'Saving the tracking settings needs a SuperAdmin.' : (e?.error?.error || errorMessage(e, 'Saving the settings')));
                this.cdr.markForCheck();
            },
        });
    }

    exportPrivacy() {
        const email = this.privacyEmail.trim();
        this.busy = true;
        this.http.get<Blob>(`/email-track/privacy/export?email=${encodeURIComponent(email)}`, { responseType: 'blob' }).subscribe({
            next: blob => {
                this.busy = false;
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `email-tracking-${email.replace(/[^a-z0-9._-]+/gi, '_')}.json`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 10_000);
                this.privacyResult = `Exported what is held about ${email}.`;
                this.cdr.markForCheck();
            },
            error: e => { this.busy = false; this.notify.error(errorMessage(e, 'Exporting')); this.cdr.markForCheck(); },
        });
    }

    erasePrivacy() {
        const email = this.privacyEmail.trim();
        if (!window.confirm(`Erase every email sent to ${email}, with its opens, clicks and delivery events? This cannot be undone.`)) return;
        this.busy = true;
        this.http.post<any>('/email-track/privacy/erase', { email, confirm: true }).subscribe({
            next: r => {
                this.busy = false;
                this.privacyResult = `Erased ${r.emails} email${r.emails === 1 ? '' : 's'} and ${r.events} event${r.events === 1 ? '' : 's'} for ${r.email}.${r.suppressionRetained ? ' The address stays on the suppression list.' : ''}`;
                this.cdr.markForCheck();
            },
            error: e => {
                this.busy = false;
                this.notify.error(e?.status === 403 ? 'Erasing needs the DeleteCustomer permission.' : errorMessage(e, 'Erasing'));
                this.cdr.markForCheck();
            },
        });
    }
}
