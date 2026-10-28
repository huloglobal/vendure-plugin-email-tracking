import { Component, OnDestroy, OnInit, ChangeDetectorRef } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { NotificationService } from '@vendure/admin-ui/core';

interface EmailRow {
    id: number;
    createdAt: string;
    type: string;
    recipient: string;
    subject: string;
    status: string;
    customerId: number | null;
    orderId: number | null;
    orderCode: string | null;
    invoiceId: number | null;
    applicationId: number | null;
    channelId: number;
    openCount: number;
    firstOpenedAt: string | null;
    lastOpenedAt: string | null;
    clickCount: number;
    firstClickedAt: string | null;
    smtpResponse: string | null;
    errorMessage: string | null;
}

interface EmailDetail extends EmailRow {
    fromAddress: string | null;
    bcc: string | null;
    replyTo: string | null;
    context: string | null;
    smtpMessageId: string | null;
    firstOpenIp: string | null;
    firstOpenUserAgent: string | null;
    clicks: Array<{ url: string; ts: string; ip: string | null; ua: string | null; country?: string | null; region?: string | null; city?: string | null }>;
    opens: Array<{ ts: string; ip: string | null; ua: string | null; client?: string | null; platform?: string | null; isBot?: boolean; country?: string | null; region?: string | null; city?: string | null }>;
}

@Component({
    selector: 'ees-email-log',
    standalone: false,
    template: `
        <!-- ── HULO brand hero — shared pattern across every HULO plugin. -->
        <vdr-page-block>
            <div class="hulo-hero">
                <div class="hulo-hero-logo" aria-hidden="true">
                    <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
                        <rect width="64" height="64" rx="14" fill="#0f1419"/>
                        <rect x="12" y="20" width="40" height="26" rx="3" fill="none" stroke="#ffffff" stroke-width="2.5"/>
                        <path d="M12 22 L32 36 L52 22" fill="none" stroke="#ffffff" stroke-width="2.5" stroke-linejoin="round"/>
                        <path d="M43 12 A6 6 0 0 1 49 18" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round"/>
                        <path d="M40 10 A9 9 0 0 1 49 19" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round"/>
                        <circle cx="47" cy="19" r="1.8" fill="#f59e0b"/>
                    </svg>
                </div>
                <div class="hulo-hero-text">
                    <h2 class="hulo-hero-title">Email log</h2>
                    <p class="hulo-hero-sub">Every transactional email your storefront sent — order confirmations, invoices, password resets. Filter by status to spot deliverability issues fast.</p>
                </div>
                <div class="hulo-hero-actions">
                    <button class="btn btn-link hulo-help-btn" (click)="helpOpen = !helpOpen" [attr.aria-expanded]="helpOpen">
                        <clr-icon shape="help"></clr-icon><span>Help</span>
                    </button>
                    <button class="btn btn-link" (click)="load()" [disabled]="loading">
                        <clr-icon shape="refresh"></clr-icon> Refresh
                    </button>
                </div>
            </div>
        </vdr-page-block>

        <vdr-page-block *ngIf="licMeta?.update?.updateAvailable && !updateDismissed">
            <div class="lic-banner">
                <div>
                    <strong>⬆️ Update available</strong> —
                    <!--email_off-->v{{ licMeta.update.current }} → <strong>v{{ licMeta.update.latest }}</strong><!--/email_off-->.
                    Run <code class="upd-cmd">npm install &#64;huloglobal/vendure-plugin-email-tracking&#64;{{ licMeta.update.latest }}</code> and restart, or see the changelog.
                </div>
                <div class="lic-actions">
                    <button class="gbtn gbtn-primary gbtn-sm" *ngIf="licMeta?.selfUpdate?.allowed" (click)="runSelfUpdate()" [disabled]="updating">{{ updating ? updateProgress : 'Update now' }}</button>
                    <button class="gbtn gbtn-outline gbtn-sm" (click)="copyUpdateCmd()">{{ cmdCopied ? 'Copied ✓' : 'Copy command' }}</button>
                    <a href="https://huloglobal.com/vendure-plugins/email-tracking/changelog/" target="_blank" class="gbtn gbtn-outline gbtn-sm">What&rsquo;s new ↗</a>
                    <button class="gbtn gbtn-outline gbtn-sm" (click)="dismissUpdate()">Dismiss</button>
                </div>
            </div>
        </vdr-page-block>

        <vdr-page-block *ngIf="licMeta && licMeta.licensed">
            <div class="lic-banner">
                <div><strong>✅ Licensed</strong> — {{ licenceLabel() }}</div>
                <div class="lic-actions">
                    <ng-container *ngIf="licMeta.licence && !licMeta.licence.master && licMeta.licence.plan !== 'lifetime'">
                        <button class="gbtn gbtn-outline gbtn-sm" (click)="openPortal()" [disabled]="portalOpening">{{ portalOpening ? 'Opening…' : 'Manage billing ↗' }}</button>
                        <button class="gbtn gbtn-primary gbtn-sm" (click)="buyLifetime()" [disabled]="buying">{{ buying ? 'Opening checkout…' : 'Upgrade to lifetime →' }}</button>
                    </ng-container>
                    <span *ngIf="claim?.state === 'pending'" style="font-size:12.5px;font-weight:600">⏳ Waiting for checkout to finish — the licence installs itself. <a (click)="checkClaim(true)" style="cursor:pointer;text-decoration:underline">Check now</a></span>
                    <a href="https://huloglobal.com/vendure-plugins/email-tracking/" target="_blank" class="gbtn gbtn-outline gbtn-sm">Details ↗</a>
                </div>
                <div class="lic-notice" *ngIf="licMeta.notice?.message">{{ licMeta.notice.message }}</div>
            </div>
        </vdr-page-block>
        <vdr-page-block *ngIf="licMeta && !licMeta.licensed">
            <div class="lic-banner">
                <div *ngIf="licMeta.tier === 'trial'">
                    <strong>⏳ Full-featured evaluation</strong> —
                    <ng-container *ngIf="licMeta.eval?.daysRemaining != null">
                        <strong>{{ licMeta.eval.daysRemaining }} day{{ licMeta.eval.daysRemaining === 1 ? '' : 's' }} left</strong> with everything enabled.
                    </ng-container>
                    <ng-container *ngIf="licMeta.eval?.daysRemaining == null">everything is enabled.</ng-container>
                    Afterwards the plugin drops to the free tier.
                    <div class="lic-sub" *ngIf="licMeta.premiumFeatures?.length">Included now: {{ licMeta.premiumFeatures.join(' · ') }}</div>
                    <div class="lic-sub" *ngIf="licMeta.recentStats?.length"><strong>So far:</strong> {{ statsLine() }}</div>
                </div>
                <div *ngIf="licMeta.tier !== 'trial'">
                    <strong>🔓 Free tier</strong> — premium features need a licence. Subscribe below (monthly or annual, cancel any time) or buy a lifetime licence. Premium features are paused; your configuration is kept and reactivates instantly with a key.
                    <div class="lic-sub" *ngIf="licMeta.premiumFeatures?.length">Switch on with a licence: {{ licMeta.premiumFeatures.join(' · ') }}</div>
                    <div class="lic-sub" *ngIf="licMeta.recentStats?.length"><strong>{{ licMeta.eval?.source === 'server' ? 'During your evaluation:' : 'So far:' }}</strong> {{ statsLine() }}</div>
                </div>
                <div class="lic-actions">
                    <ng-container *ngIf="licMeta.tier === 'trial' && !remindMeSent">
                        <input class="lic-key" style="min-width:200px" type="email" placeholder="you@company.com" [(ngModel)]="remindEmail" [disabled]="remindMeSending">
                        <button class="gbtn gbtn-outline gbtn-sm" (click)="sendRemindMe()" [disabled]="remindMeSending || !remindEmail">{{ remindMeSending ? 'Saving…' : 'Email me before it ends' }}</button>
                    </ng-container>
                    <span *ngIf="licMeta.tier === 'trial' && remindMeSent" style="font-size:12.5px;font-weight:600">✓ We'll email you before it ends</span>
                    <input class="lic-key" type="text" placeholder="Paste licence key (eyJhbGciOi…)" [(ngModel)]="licKeyInput" [disabled]="licActivating">
                    <button class="gbtn gbtn-primary gbtn-sm" (click)="activateLicence()" [disabled]="licActivating || !licKeyInput">{{ licActivating ? 'Verifying…' : 'Activate' }}</button>
                    <select [(ngModel)]="buyPlan" [disabled]="buying" style="padding:5px 9px;border:1px solid #d1d5db;border-radius:7px;font-size:12.5px;background:#fff;color:inherit"><option value="monthly">Monthly</option><option value="annual">Annual · 2 months free</option><option value="lifetime">Lifetime · one-off</option></select>
                    <button class="gbtn gbtn-primary gbtn-sm" (click)="buyLicence()" [disabled]="buying">{{ buying ? 'Opening checkout…' : (buyPlan === 'lifetime' ? 'Buy lifetime →' : (licMeta?.tier === 'trial' ? 'Subscribe — first charge when the evaluation ends →' : 'Subscribe →')) }}</button>
                    <span *ngIf="claim?.state === 'pending'" style="font-size:12.5px;font-weight:600">⏳ Waiting for checkout to finish — the licence installs itself. <a (click)="checkClaim(true)" style="cursor:pointer;text-decoration:underline">Check now</a></span>
                    <a href="https://huloglobal.com/vendure-plugins/email-tracking/" target="_blank" class="gbtn gbtn-outline gbtn-sm">Details ↗</a>
                </div>
                <div class="lic-notice" *ngIf="licMeta.notice?.message">{{ licMeta.notice.message }}</div>
            </div>
        </vdr-page-block>

        <vdr-page-block *ngIf="helpOpen">
            <div class="hulo-help-drawer">
                <div class="hulo-help-grid">
                    <div class="hulo-help-card">
                        <div class="hulo-help-num">1</div>
                        <h4>Every email captured automatically</h4>
                        <p>The plugin hooks Vendure's outgoing mail — no code changes required in your storefront.</p>
                    </div>
                    <div class="hulo-help-card">
                        <div class="hulo-help-num">2</div>
                        <h4>Click a status card to filter</h4>
                        <p>Sent, Failed, Pending — the counters above are clickable and filter the table below.</p>
                    </div>
                    <div class="hulo-help-card">
                        <div class="hulo-help-num">3</div>
                        <h4>Open any message for its history</h4>
                        <p>Click a row to see the SMTP reply, every open with client and location, and every link clicked.</p>
                    </div>
                </div>
                <div class="hulo-help-links">
                    <a href="https://huloglobal.com/vendure-plugins/email-tracking/docs/" target="_blank">Full docs ↗</a>
                    <a href="https://huloglobal.com/vendure-plugins/email-tracking/" target="_blank">Plugin page ↗</a>
                    <a href="mailto:support@huloglobal.com">Email support</a>
                </div>
            </div>
        </vdr-page-block>

        <vdr-page-block *ngIf="showSetup() || digest">
            <div class="hulo-setup-grid" [class.single]="!showSetup()">
                <div class="hulo-card" *ngIf="showSetup()">
                    <div class="hulo-card-head">
                        <h4>Set-up checklist</h4>
                        <a class="hulo-link" (click)="hideSetup()" *ngIf="setup?.complete">Hide</a>
                    </div>
                    <div class="setup-row" *ngFor="let it of setup?.items">
                        <span class="setup-dot" [class.done]="it.done" aria-hidden="true"></span>
                        <div class="setup-body">
                            <div class="setup-label">{{ it.label }}</div>
                            <div class="setup-hint">{{ it.hint }}</div>
                        </div>
                        <a *ngIf="it.url && !it.done" [href]="it.url" target="_blank" rel="noopener" class="hulo-link">How ↗</a>
                    </div>
                </div>
                <div class="hulo-card" *ngIf="digest">
                    <div class="hulo-card-head">
                        <h4>Weekly report</h4>
                        <label class="hulo-toggle"><input type="checkbox" [checked]="digest.enabled" (change)="toggleDigest()" [disabled]="digestSaving"> {{ digest.enabled ? 'On' : 'Off' }}</label>
                    </div>
                    <p class="setup-hint" style="margin:0 0 8px">Every Monday at 08:00 (server time): emails tracked, opens, clicks, bounces and open rate for the week, with next steps.</p>
                    <div class="digest-row">
                        <input class="form-input" type="email" [(ngModel)]="digestRecipient" [placeholder]="digest.defaultRecipient ? 'Defaults to ' + digest.defaultRecipient : 'Recipient email'" [disabled]="digestSaving">
                        <button class="btn btn-sm btn-secondary" (click)="saveDigestRecipient()" [disabled]="digestSaving">Save</button>
                    </div>
                    <div class="setup-hint" *ngIf="!digest.recipient && !digest.defaultRecipient">No recipient yet — enter one above, or activate a licence or set a trial reminder email so one is known.</div>
                    <div class="setup-hint">Last sent {{ digest.lastSentAt ? (digest.lastSentAt | date:'mediumDate') : 'never' }} · next {{ digest.nextDueAt ? (digest.nextDueAt | date:'medium') : '—' }}</div>
                    <div class="digest-row" style="margin-top:8px">
                        <button class="btn btn-sm btn-secondary" (click)="sendDigestTest()" [disabled]="digestTesting">{{ digestTesting ? 'Sending…' : 'Send me a test' }}</button>
                        <button class="btn btn-sm btn-link" (click)="previewDigest()">Preview</button>
                    </div>
                </div>
            </div>
        </vdr-page-block>

        <vdr-page-block>
            <div class="summary-row">
                <div class="summary-card" [class.active]="filterStatus===''" (click)="setStatus('')">
                    <div class="num" style="color:#1d4ed8">{{ totalAll() }}</div>
                    <div class="lbl">Last {{ summary.fromDays }} days</div>
                </div>
                <div class="summary-card" [class.active]="filterStatus==='sent'" (click)="setStatus('sent')">
                    <div class="num" style="color:#10b981">{{ summary.sent || 0 }}</div>
                    <div class="lbl">Sent</div>
                </div>
                <div class="summary-card" [class.active]="filterStatus==='failed'" (click)="setStatus('failed')">
                    <div class="num" style="color:#ef4444">{{ summary.failed || 0 }}</div>
                    <div class="lbl">Failed</div>
                </div>
                <div class="summary-card" [class.active]="filterStatus==='deferred'" (click)="setStatus('deferred')">
                    <div class="num" style="color:#f59e0b">{{ summary.deferred || 0 }}</div>
                    <div class="lbl">Deferred</div>
                </div>
                <div class="summary-card" [class.active]="filterStatus==='bounced'" (click)="setStatus('bounced')">
                    <div class="num" style="color:#9333ea">{{ summary.bounced || 0 }}</div>
                    <div class="lbl">Bounced</div>
                </div>
                <div class="summary-card">
                    <div class="num" style="color:#0369a1">{{ summary.opens || 0 }}</div>
                    <div class="lbl">Opens</div>
                    <div class="sub">{{ summary.clicks || 0 }} clicks</div>
                </div>
            </div>
            <div class="hulo-card" style="margin-bottom:16px">
                <div class="hulo-card-head">
                    <h4>By template <span class="setup-hint">last 30 days</span></h4>
                    <div class="digest-row">
                        <span class="unlock-chip" *ngIf="exportLocked">🔒 Premium — <a class="hulo-link" (click)="scrollToLicence()">start the free trial or activate a key</a></span>
                        <button class="btn btn-sm btn-secondary" (click)="exportCsv()" [disabled]="exporting">{{ exporting ? 'Exporting…' : 'Export CSV' }}</button>
                    </div>
                </div>
                <div *ngIf="byTemplateLocked" class="unlock-chip">🔒 Per-template open and click rates are a premium feature — <a class="hulo-link" (click)="scrollToLicence()">start the free trial or activate a key</a> at the top of this page.</div>
                <div *ngIf="!byTemplateLocked && byTemplateLoading" class="setup-hint">Loading…</div>
                <div *ngIf="!byTemplateLocked && !byTemplateLoading && byTemplate.length === 0" class="setup-hint">No emails in the last 30 days.</div>
                <table class="table table-compact" *ngIf="!byTemplateLocked && byTemplate.length > 0" style="margin-top:0">
                    <thead><tr><th>Template</th><th>Sent</th><th>Opened</th><th>Open rate</th><th>Clicked</th><th>Click rate</th><th>Bounced</th><th>Failed</th></tr></thead>
                    <tbody>
                        <tr *ngFor="let t of byTemplate">
                            <td><span class="pill type-pill">{{ t.type }}</span></td>
                            <td>{{ t.sent }}</td>
                            <td>{{ t.opened }}</td>
                            <td>{{ pct(t.openRate) }}</td>
                            <td>{{ t.clicked }}</td>
                            <td>{{ pct(t.clickRate) }}</td>
                            <td>{{ t.bounced }}</td>
                            <td>{{ t.failed }}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </vdr-page-block>

        <vdr-page-block>
            <div class="card">
                <div class="card-block">
                    <div class="filters">
                        <input class="form-input" placeholder="Filter recipient…" [(ngModel)]="filterRecipient" (keyup.enter)="load()">
                        <input class="form-input" placeholder="Filter type…" [(ngModel)]="filterType" (keyup.enter)="load()">
                        <input class="form-input" placeholder="Customer ID" [(ngModel)]="filterCustomerId" (keyup.enter)="load()">
                        <input class="form-input" placeholder="Order code" [(ngModel)]="filterOrderCode" (keyup.enter)="load()">
                        <button class="btn btn-secondary" (click)="load()">Apply</button>
                        <button class="btn btn-link" (click)="clearFilters()">Clear</button>
                    </div>

                    <div *ngIf="loading" style="padding:30px;text-align:center;color:var(--color-component-color-300)">Loading…</div>
                    <div *ngIf="!loading && rows.length === 0" style="padding:30px;text-align:center;color:var(--color-component-color-300)">
                        No emails match this view.
                    </div>

                    <table class="table table-compact" *ngIf="rows.length > 0">
                        <thead>
                            <tr>
                                <th>#</th>
                                <th>Sent</th>
                                <th>Type</th>
                                <th>Recipient</th>
                                <th>Subject</th>
                                <th>Status</th>
                                <th>Opens</th>
                                <th>Clicks</th>
                                <th>Linked to</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody>
                            <ng-container *ngFor="let r of rows">
                                <tr>
                                    <td><strong>#{{ r.id }}</strong></td>
                                    <td>{{ r.createdAt | date:'short' }}</td>
                                    <td><span class="pill type-pill">{{ r.type }}</span></td>
                                    <td>
                                        <a [href]="'mailto:' + r.recipient">{{ r.recipient }}</a>
                                    </td>
                                    <td style="max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" [title]="r.subject">{{ r.subject }}</td>
                                    <td>
                                        <span class="pill" [ngClass]="'status-' + r.status">{{ r.status }}</span>
                                    </td>
                                    <td>
                                        <span [class.muted]="r.openCount === 0" [style.color]="r.openCount > 0 ? '#10b981' : null">{{ r.openCount }}</span>
                                        <div class="help-text" *ngIf="r.firstOpenedAt">{{ r.firstOpenedAt | date:'short' }}</div>
                                    </td>
                                    <td>
                                        <span [class.muted]="r.clickCount === 0" [style.color]="r.clickCount > 0 ? '#0369a1' : null">{{ r.clickCount }}</span>
                                    </td>
                                    <td>
                                        <a *ngIf="r.orderId" [routerLink]="['/orders', r.orderId]">{{ r.orderCode || r.orderId }}</a>
                                        <a *ngIf="r.customerId && !r.orderId" [routerLink]="['/customers', r.customerId]">cust #{{ r.customerId }}</a>
                                        <span *ngIf="!r.orderId && !r.customerId" class="help-text">—</span>
                                    </td>
                                    <td>
                                        <button class="btn btn-sm btn-link" (click)="open(r.id)">
                                            <clr-icon shape="eye"></clr-icon> Details
                                        </button>
                                    </td>
                                </tr>
                                <tr *ngIf="expandedId === r.id && detail" class="detail-row">
                                    <td colspan="10">
                                        <div class="detail-grid">
                                            <div>
                                                <div class="lbl">From</div><div>{{ detail.fromAddress }}</div>
                                                <div class="lbl">To</div><div>{{ detail.recipient }}</div>
                                                <div class="lbl" *ngIf="detail.bcc">BCC</div><div *ngIf="detail.bcc">{{ detail.bcc }}</div>
                                                <div class="lbl">Subject</div><div>{{ detail.subject }}</div>
                                                <div class="lbl">Context</div><div>{{ detail.context || '—' }}</div>
                                            </div>
                                            <div>
                                                <div class="lbl">SMTP message id</div>
                                                <div style="font-family:monospace;font-size:11px;word-break:break-all">{{ detail.smtpMessageId || '—' }}</div>
                                                <div class="lbl">SMTP response</div>
                                                <div style="font-family:monospace;font-size:11px;word-break:break-all">{{ detail.smtpResponse || '—' }}</div>
                                                <div class="lbl" *ngIf="detail.errorMessage">Error</div>
                                                <div *ngIf="detail.errorMessage" style="color:#ef4444">{{ detail.errorMessage }}</div>
                                            </div>
                                            <div>
                                                <div class="lbl">Opens</div>
                                                <div>{{ detail.openCount }} ({{ detail.firstOpenedAt | date:'short' }} → {{ detail.lastOpenedAt | date:'short' }})</div>
                                                <div class="lbl" *ngIf="detail.firstOpenIp">First open IP</div>
                                                <div *ngIf="detail.firstOpenIp" style="font-family:monospace;font-size:11px">{{ detail.firstOpenIp }}</div>
                                                <div class="lbl" *ngIf="detail.firstOpenUserAgent">First open UA</div>
                                                <div *ngIf="detail.firstOpenUserAgent" style="font-size:11px;color:var(--color-component-color-300)">{{ detail.firstOpenUserAgent }}</div>
                                            </div>
                                        </div>
                                        <h5 style="margin-top:18px" *ngIf="detail.opens && detail.opens.length > 0">Open history ({{ detail.openCount }})</h5>
                                        <table class="table table-compact" *ngIf="detail.opens && detail.opens.length > 0">
                                            <thead><tr><th style="width:160px">Time</th><th style="width:140px">Location</th><th style="width:160px">Client</th><th>User-Agent</th></tr></thead>
                                            <tbody>
                                                <tr *ngFor="let o of detail.opens">
                                                    <td>{{ o.ts | date:'medium' }}</td>
                                                    <td>
                                                        <span *ngIf="o.country || o.city">
                                                            {{ o.city || '' }}{{ o.city && o.region ? ', ' : '' }}{{ o.region || '' }}{{ (o.city || o.region) && o.country ? ' · ' : '' }}{{ o.country || '' }}
                                                        </span>
                                                        <span *ngIf="!o.country && !o.city" style="color:var(--color-component-color-300)">—</span>
                                                    </td>
                                                    <td style="font-size:11px">
                                                        <span *ngIf="o.client">{{ o.client }}<span *ngIf="o.platform"> · {{ o.platform }}</span></span>
                                                        <span *ngIf="o.isBot" style="display:inline-block;margin-left:4px;padding:1px 5px;border-radius:6px;background:#fef3c7;color:#92400e;font-size:10px;font-weight:600;text-transform:uppercase">bot</span>
                                                    </td>
                                                    <td style="font-size:11px;color:var(--color-component-color-300)">{{ o.ua || '—' }}</td>
                                                </tr>
                                            </tbody>
                                        </table>
                                        <p *ngIf="detail.openCount > 50 && detail.opens && detail.opens.length === 50" class="help-text" style="margin:6px 0 0">
                                            Showing the most recent 50 opens. Older opens contribute to the open count above.
                                        </p>

                                        <h5 style="margin-top:18px" *ngIf="detail.clicks.length > 0">Click history ({{ detail.clickCount }})</h5>
                                        <table class="table table-compact" *ngIf="detail.clicks.length > 0">
                                            <thead><tr><th style="width:160px">Time</th><th>URL</th><th style="width:140px">Location</th><th>User-Agent</th></tr></thead>
                                            <tbody>
                                                <tr *ngFor="let c of detail.clicks">
                                                    <td>{{ c.ts | date:'medium' }}</td>
                                                    <td style="font-family:monospace;font-size:11px;word-break:break-all"><a [href]="c.url" target="_blank" rel="noopener">{{ c.url }}</a></td>
                                                    <td>
                                                        <span *ngIf="c.country || c.city">
                                                            {{ c.city || '' }}{{ c.city && c.region ? ', ' : '' }}{{ c.region || '' }}{{ (c.city || c.region) && c.country ? ' · ' : '' }}{{ c.country || '' }}
                                                        </span>
                                                        <span *ngIf="!c.country && !c.city" style="color:var(--color-component-color-300)">—</span>
                                                    </td>
                                                    <td style="font-size:11px;color:var(--color-component-color-300)">{{ c.ua || '—' }}</td>
                                                </tr>
                                            </tbody>
                                        </table>
                                        <p *ngIf="detail.clickCount > 50 && detail.clicks.length === 50" class="help-text" style="margin:6px 0 0">
                                            Showing the most recent 50 clicks. Older clicks contribute to the click count above.
                                        </p>
                                    </td>
                                </tr>
                            </ng-container>
                        </tbody>
                    </table>

                    <div class="pager" *ngIf="total > take">
                        <button class="btn btn-sm" (click)="prevPage()" [disabled]="skip === 0">‹ Prev</button>
                        <span style="margin:0 12px;font-size:12px">Showing {{ skip + 1 }}–{{ skip + rows.length }} of {{ total }}</span>
                        <button class="btn btn-sm" (click)="nextPage()" [disabled]="skip + take >= total">Next ›</button>
                    </div>
                </div>
            </div>
        </vdr-page-block>
    `,
    styles: [`
        .lic-banner { display:flex; gap:12px; align-items:center; justify-content:space-between; flex-wrap:wrap; padding:12px 16px; border-radius:10px; font-size:13px; background:var(--gb-tint-warn, #fef3c7); border:1px solid var(--gb-line-warn, #fcd34d); }
        .lic-actions { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
        .upd-cmd { font-family: monospace; font-size: 12px; background: rgba(0,0,0,.06); padding: 2px 6px; border-radius: 5px; }
        [data-theme='dark'] .upd-cmd, :host-context([data-theme='dark']) .upd-cmd { background: rgba(255,255,255,.1); }
        .lic-key { padding:5px 9px; border:1px solid var(--gb-ui-border, #d1d5db); border-radius:7px; font-size:12.5px; min-width:280px; background:#fff; color:#0f172a; }
        .lic-sub { font-size:12px; margin-top:4px; color:#78350f; }
        .lic-notice { flex-basis:100%; padding:8px 12px; border-radius:8px; background:#fde68a; border:1px solid #f59e0b; color:#78350f; font-size:12.5px; font-weight:600; }

        /* ── Set-up checklist + weekly report cards ─────────────────── */
        .hulo-setup-grid { display:grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap:12px; }
        .hulo-setup-grid.single { grid-template-columns: 1fr; }
        .hulo-card { padding:14px 18px; border:1px solid var(--color-component-border-200); border-radius:8px; background:var(--color-component-bg-100); color:var(--color-text-100, inherit); }
        .hulo-card-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:10px; }
        .hulo-card-head h4 { margin:0; font-size:14px; }
        .hulo-link { color:#b45309; cursor:pointer; text-decoration:underline; font-size:12px; font-weight:600; }
        .setup-row { display:flex; align-items:flex-start; gap:10px; padding:6px 0; border-top:1px solid var(--color-component-border-200); }
        .setup-row:first-of-type { border-top:0; }
        .setup-dot { flex:0 0 auto; width:10px; height:10px; border-radius:999px; background:#cbd5e1; margin-top:5px; }
        .setup-dot.done { background:#10b981; }
        .setup-body { flex:1 1 auto; min-width:0; }
        .setup-label { font-size:13px; font-weight:600; }
        .setup-hint { font-size:11.5px; color:var(--color-component-color-300); }
        .hulo-toggle { display:flex; align-items:center; gap:6px; font-size:12px; cursor:pointer; }
        .digest-row { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
        .digest-row .form-input { flex:1 1 180px; padding:4px 8px; height:30px; border:1px solid var(--color-component-border-200); background:var(--color-component-bg-100); color:var(--color-text-100, inherit); border-radius:4px; }
        .unlock-chip { display:inline-block; padding:4px 10px; border-radius:999px; background:#fef3c7; border:1px solid #fcd34d; color:#92400e; font-size:12px; }
        @media (max-width: 900px) { .hulo-setup-grid { grid-template-columns: 1fr; } }

        :host { color: var(--color-text-100, inherit); }

        /* ── HULO shared hero + help pattern ─────────────────────── */
        .hulo-hero {
            display: flex; align-items: center; gap: 18px;
            padding: 20px 22px; border-radius: 14px;
            background: linear-gradient(135deg, #0f1419 0%, #1e293b 100%);
            color: #fff;
            box-shadow: 0 1px 3px rgba(15,23,42,.15), 0 8px 24px rgba(15,23,42,.08);
        }
        .hulo-hero-logo { flex: 0 0 auto; width: 56px; height: 56px; }
        .hulo-hero-logo svg { width: 100%; height: 100%; display: block; }
        .hulo-hero-text { flex: 1 1 auto; min-width: 0; }
        .hulo-hero-title { color: #fff; font-size: 22px; font-weight: 700; margin: 0; letter-spacing: -0.01em; }
        .hulo-hero-sub { color: #cbd5e1; font-size: 13px; line-height: 1.5; margin: 4px 0 0; max-width: 640px; }
        .hulo-hero-actions { display: flex; gap: 6px; align-items: center; flex: 0 0 auto; }
        .hulo-hero-actions .btn { color: #f8fafc; }
        .hulo-hero-actions .btn:hover { color: #f59e0b; }
        .hulo-help-btn clr-icon { margin-right: 4px; }
        .hulo-help-drawer {
            background: #fffbeb; border: 1px solid #fde68a; border-radius: 12px;
            padding: 20px 22px; color: #451a03;
        }
        .hulo-help-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
        .hulo-help-card { background: #ffffff; border-radius: 10px; padding: 16px; }
        .hulo-help-num { width: 24px; height: 24px; border-radius: 999px;
            background: #f59e0b; color: #fff; font-weight: 700; font-size: 13px;
            display: grid; place-items: center; margin-bottom: 8px; }
        .hulo-help-card h4 { margin: 0 0 4px; font-size: 14px; color: #0f172a; }
        .hulo-help-card p { margin: 0; font-size: 13px; line-height: 1.5; color: #475569; }
        .hulo-help-links { margin-top: 16px; padding-top: 14px; border-top: 1px solid #fde68a; display: flex; gap: 18px; flex-wrap: wrap; font-size: 13px; }
        .hulo-help-links a { color: #b45309; text-decoration: none; font-weight: 600; }
        .hulo-help-links a:hover { text-decoration: underline; }
        @media (max-width: 640px) {
            .hulo-hero { flex-wrap: wrap; }
            .hulo-hero-actions { width: 100%; justify-content: flex-end; }
        }

        .summary-row { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
        .summary-card {
            flex: 1; min-width: 130px; padding: 14px 18px;
            border: 1px solid var(--color-component-border-200);
            border-radius: 6px;
            background: var(--color-component-bg-100);
            color: var(--color-text-100, inherit);
            cursor: pointer; transition: border-color .15s, box-shadow .15s;
        }
        .summary-card:hover { border-color: var(--color-primary-500, #1d4ed8); }
        .summary-card.active {
            border-color: var(--color-primary-500, #1d4ed8);
            box-shadow: 0 0 0 2px rgba(29,78,216,.18);
        }
        .summary-card .num { font-size: 24px; font-weight: 700; line-height: 1.2; }
        .summary-card .lbl { font-size: 11px; color: var(--color-component-color-300); margin-top: 2px; }
        .summary-card .sub { font-size: 10px; color: var(--color-component-color-300); margin-top: 2px; }

        .filters { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
        .filters .form-input {
            padding: 4px 8px; height: 32px;
            border: 1px solid var(--color-component-border-200);
            background: var(--color-component-bg-100);
            color: var(--color-text-100, inherit);
            border-radius: 4px; min-width: 160px;
        }

        .pill {
            display: inline-block; padding: 2px 8px; border-radius: 10px;
            font-size: 11px; font-weight: 600; text-transform: uppercase;
            color: #fff;
        }
        .type-pill {
            background: var(--color-component-bg-200);
            color: var(--color-text-100, inherit);
            border: 1px solid var(--color-component-border-200);
        }
        .status-sent { background: #10b981; }
        .status-failed { background: #ef4444; }
        .status-deferred { background: #f59e0b; }
        .status-bounced { background: #9333ea; }
        .status-complained { background: #db2777; }

        .detail-row > td {
            background: var(--color-component-bg-200);
            color: var(--color-text-100, inherit);
            padding: 18px;
            border-top: 1px solid var(--color-component-border-200);
        }
        .detail-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; }
        .detail-grid .lbl {
            font-size: 11px;
            color: var(--color-component-color-300);
            text-transform: uppercase; margin-top: 6px;
        }
        .pager {
            display: flex; align-items: center; justify-content: flex-end;
            padding: 10px 0;
            color: var(--color-text-100, inherit);
        }
        .help-text { color: var(--color-component-color-300); font-size: 11px; }
        .muted { color: var(--color-component-color-300); }

        /* Mobile under 768px */
        @media (max-width: 767px) {
            /* Interactive elements in our component meet the 44px tap target */
            :host button, :host .btn { min-height: 40px; }
            :host vdr-action-bar button { min-height: 40px; padding: 6px 12px; }
            :host vdr-action-bar { flex-wrap: wrap; gap: 6px; }
            .pager .btn { min-height: 44px; padding: 8px 14px; }
            .pager span { display: block; width: 100%; text-align: center; padding: 4px 0; }
            .summary-row { gap: 8px; }
            .summary-card { min-width: 0; flex-basis: calc(50% - 4px); padding: 10px 12px; }
            .summary-card .num { font-size: 20px; }
            .filters { flex-direction: column; gap: 6px; }
            .filters .form-input { width: 100%; min-width: 0; }
            .filters .btn { width: 100%; min-height: 44px; }

            /* Card-block scrolls horizontally; table keeps natural layout */
            .card-block { padding: 12px; overflow-x: auto; -webkit-overflow-scrolling: touch; }
            .card-block > table { white-space: nowrap; }
            .card-block > table th, .card-block > table td { padding: 8px 10px; }
            .detail-row > td { padding: 12px; display: block; }
            .detail-grid { grid-template-columns: 1fr; gap: 10px; }
            .pager { justify-content: center; }
        }
    `],
})
export class EmailLogComponent implements OnInit, OnDestroy {
    private restartTimer: any = null;
    rows: EmailRow[] = [];
    total = 0;
    take = 100;
    skip = 0;
    loading = false;

    filterStatus = '';
    filterRecipient = '';
    filterType = '';
    filterCustomerId = '';
    filterOrderCode = '';
    /** When the page is mounted with a ?customerId= query param, lock to that
     *  customer (used by the per-customer Emails tab). */
    lockedCustomerId: string | null = null;

    summary: any = { sent: 0, failed: 0, deferred: 0, bounced: 0, opens: 0, clicks: 0, fromDays: 30 };

    expandedId: number | null = null;
    detail: EmailDetail | null = null;

    /** Toggles the shared HULO help drawer under the hero. */
    helpOpen = false;
    private dismissKey = 'huloglobal-email-tracking-update-dismissed';
    private setupHiddenKey = 'hulo-vendure-plugin-email-tracking-setup-hidden';

    setup: { items: Array<{ key: string; label: string; done: boolean; hint: string; tab?: string; url?: string }>; complete: boolean } | null = null;
    setupHidden = false;
    digest: any = null;
    digestRecipient = '';
    digestSaving = false;
    digestTesting = false;
    byTemplate: any[] = [];
    byTemplateLoading = false;
    byTemplateLocked = false;
    exporting = false;
    exportLocked = false;
    remindEmail = '';
    remindMeSending = false;
    remindMeSent = false;

    /** One message for every "needs a licence" failure (402 or a licence error code). */
    errMsg(e: any, what: string): string {
        const code = e?.error?.error;
        if (e?.status === 402 || code === 'licence-required' || code === 'licence_required' || code === 'premium-feature') {
            return `${what} needs a licence — start the free trial or activate a key at the top of this page.`;
        }
        const m = e?.error?.message || (typeof e?.error?.error === 'string' ? e.error.error : '') || e?.message;
        return m ? `${what} failed: ${m}` : `${what} failed`;
    }

    statsLine(): string {
        return (this.licMeta?.recentStats || []).map((s: any) => `${s.value} ${s.label}`).join(' · ');
    }

    pct(v: any): string { const n = Number(v); return Number.isFinite(n) ? `${Math.round(n * 1000) / 10}%` : '—'; }

    scrollToLicence() { try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch { window.scrollTo(0, 0); } }

    // ── Set-up checklist ──────────────────────────────────────────────
    loadSetup() {
        this.http.get<any>('/email-track/setup').subscribe({
            next: r => {
                this.setup = r;
                try { this.setupHidden = localStorage.getItem(this.setupHiddenKey) === '1'; } catch { this.setupHidden = false; }
                this.cdr.markForCheck();
            },
            error: () => undefined,
        });
    }
    /** Shown while anything is undone; once complete it stays until hidden. */
    showSetup(): boolean {
        if (!this.setup) return false;
        if (!this.setup.complete) return true;
        return !this.setupHidden;
    }
    hideSetup() {
        try { localStorage.setItem(this.setupHiddenKey, '1'); } catch {}
        this.setupHidden = true;
    }

    // ── Weekly report ─────────────────────────────────────────────────
    loadDigest() {
        this.http.get<any>('/email-track/digest/settings').subscribe({
            next: d => { this.digest = d; this.digestRecipient = d?.recipient || ''; this.cdr.markForCheck(); },
            error: () => undefined,
        });
    }
    toggleDigest() {
        if (!this.digest) return;
        this.digestSaving = true;
        this.http.post<any>('/email-track/digest/settings', { enabled: !this.digest.enabled }).subscribe({
            next: d => { this.digest = d; this.digestSaving = false; this.notify.success(d.enabled ? 'Weekly report on' : 'Weekly report off'); this.cdr.markForCheck(); },
            error: e => { this.digestSaving = false; this.notify.error(this.errMsg(e, 'Saving the weekly report setting')); this.cdr.markForCheck(); },
        });
    }
    saveDigestRecipient() {
        this.digestSaving = true;
        this.http.post<any>('/email-track/digest/settings', { recipient: (this.digestRecipient || '').trim() || null }).subscribe({
            next: d => { this.digest = d; this.digestRecipient = d?.recipient || ''; this.digestSaving = false; this.notify.success(d.recipient ? `Weekly report goes to ${d.recipient}` : 'Recipient cleared — the default is used'); this.cdr.markForCheck(); },
            error: e => { this.digestSaving = false; this.notify.error(e?.error?.message || this.errMsg(e, 'Saving the recipient')); this.cdr.markForCheck(); },
        });
    }
    sendDigestTest() {
        this.digestTesting = true;
        this.http.post<any>('/email-track/digest/send-test', {}).subscribe({
            next: r => {
                this.digestTesting = false;
                if (r?.sent) this.notify.success(`Test report sent to ${r.to}`);
                else this.notify.error(r?.reason === 'no-recipient' ? 'No recipient — enter one above first' : `Not sent: ${r?.reason || 'unknown error'}`);
                this.cdr.markForCheck();
            },
            error: e => { this.digestTesting = false; this.notify.error(this.errMsg(e, 'Sending the test report')); this.cdr.markForCheck(); },
        });
    }
    /** Fetched with the admin session (works for cookie and bearer auth) and opened as a Blob URL. */
    previewDigest() {
        this.http.get('/email-track/digest/preview', { responseType: 'text' }).subscribe({
            next: html => {
                const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
                window.open(url, '_blank', 'noopener');
                setTimeout(() => URL.revokeObjectURL(url), 60_000);
            },
            error: e => this.notify.error(this.errMsg(e, 'Preview')),
        });
    }

    // ── Trial reminder ────────────────────────────────────────────────
    sendRemindMe() {
        const email = (this.remindEmail || '').trim();
        if (!email) return;
        this.remindMeSending = true;
        this.http.post<any>('/email-track/eval/remind-me', { email }).subscribe({
            next: () => { this.remindMeSending = false; this.remindMeSent = true; this.notify.success('Reminder set — check your inbox for a confirmation'); this.loadDigest(); this.cdr.markForCheck(); },
            error: e => { this.remindMeSending = false; this.notify.error(e?.error?.message || 'Could not save the reminder — try again shortly'); this.cdr.markForCheck(); },
        });
    }

    // ── By template + CSV export (premium) ────────────────────────────
    loadByTemplate() {
        this.byTemplateLoading = true;
        this.http.get<any>('/email-track/log/stats/by-template?fromDays=30').subscribe({
            next: r => { this.byTemplate = r?.types || []; this.byTemplateLocked = false; this.byTemplateLoading = false; this.cdr.markForCheck(); },
            error: e => {
                this.byTemplateLoading = false;
                if (e?.status === 402) this.byTemplateLocked = true;
                else this.notify.error(this.errMsg(e, 'Loading per-template stats'));
                this.cdr.markForCheck();
            },
        });
    }
    exportCsv() {
        this.exporting = true;
        this.http.get(`/email-track/log/export.csv?${this.buildParams()}`, { responseType: 'blob' }).subscribe({
            next: blob => {
                this.exporting = false;
                this.exportLocked = false;
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = `email-log-${new Date().toISOString().slice(0, 10)}.csv`;
                document.body.appendChild(a); a.click(); a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 10_000);
                this.cdr.markForCheck();
            },
            error: e => {
                this.exporting = false;
                if (e?.status === 402) this.exportLocked = true;
                this.notify.error(this.errMsg(e, 'CSV export'));
                this.cdr.markForCheck();
            },
        });
    }

    constructor(
        private http: HttpClient,
        private notify: NotificationService,
        private route: ActivatedRoute,
        private cdr: ChangeDetectorRef,
    ) {}

    licMeta: any = null;
    updating = false;
    updateProgress = 'Updating…';

    runSelfUpdate() {
        const target = this.licMeta?.update?.latest;
        if (!target || this.updating) return;
        this.updating = true;
        this.updateProgress = 'Installing…';
        this.cdr.markForCheck();
        this.http.post<any>('/email-track/update/run', { version: target }).subscribe({
            next: r => {
                if (r?.restartScheduled) {
                    this.updateProgress = 'Restarting…';
                    this.notify.success(r.message || 'Updated — server restarting');
                    this.pollAfterRestart(target);
                } else {
                    this.updating = false;
                    this.notify.success(r?.message || 'Installed — restart the server to load it');
                }
                this.cdr.markForCheck();
            },
            error: e => {
                this.updating = false;
                this.notify.error(e?.error?.message || this.errMsg(e, 'Update'));
                this.cdr.markForCheck();
            },
        });
    }

    private pollAfterRestart(target: string, attempt = 0) {
        if (attempt > 40) {
            this.updating = false;
            this.notify.error('The server has not come back yet — check your process manager');
            this.cdr.markForCheck();
            return;
        }
        this.restartTimer = setTimeout(() => {
            this.http.get<any>('/email-track/licence/status').subscribe({
                next: m => {
                    const v = m?.version || m?.update?.current;
                    if (v === target) {
                        this.updating = false;
                        this.licMeta = m;
                        this.notify.success(`Now running v${target}`);
                        this.cdr.markForCheck();
                    } else {
                        this.pollAfterRestart(target, attempt + 1);
                    }
                },
                error: () => this.pollAfterRestart(target, attempt + 1),
            });
        }, 3000);
    }
    licKeyInput = '';
    licActivating = false;
    updateDismissed = false;
    cmdCopied = false;

    copyUpdateCmd() {
        const cmd = `npm install @huloglobal/vendure-plugin-email-tracking@${this.licMeta?.update?.latest || 'latest'}`;
        navigator.clipboard?.writeText(cmd).then(() => {
            this.cmdCopied = true;
            this.cdr.markForCheck();
            setTimeout(() => { this.cmdCopied = false; this.cdr.markForCheck(); }, 2500);
        });
    }

    loadLicMeta() {
        this.http.get<any>('/email-track/licence/status').subscribe({
            next: m => {
                this.licMeta = m;
                let dismissed = '';
                try { dismissed = localStorage.getItem(this.dismissKey) || ''; } catch {}
                this.updateDismissed = !!m?.update?.latest && dismissed === m.update.latest;
                this.cdr.markForCheck();
            },
            error: () => undefined,
        });
    }

    // Buy-from-admin: opens HULO checkout in a new tab; the licence server
    // binds the purchase to this install and the key installs itself.
    buyPlan: 'monthly' | 'annual' | 'lifetime' = 'monthly';
    buying = false;
    claim: any = null;
    private claimTimer: any = null;
    buyLicence() {
        this.buying = true;
        this.http.post<any>('/email-track/licence/purchase-link', { plan: this.buyPlan }).subscribe({
            next: r => {
                this.buying = false;
                if (r?.url) {
                    window.open(r.url, '_blank', 'noopener');
                    this.claim = { state: 'pending' };
                    this.startClaimPoll();
                }
                this.cdr.markForCheck();
            },
            error: e => { this.buying = false; this.notify.error(e?.error?.message || this.errMsg(e, 'Starting checkout')); this.cdr.markForCheck(); },
        });
    }
    checkClaim(force = false) {
        this.http.get<any>('/email-track/licence/claim-status' + (force ? '?check=1' : '')).subscribe({
            next: r => {
                const wasPending = this.claim?.state === 'pending';
                this.claim = r;
                if (r?.state === 'pending') { if (!this.claimTimer) this.startClaimPoll(); }
                else this.stopClaimPoll();
                if (r?.licensed && (wasPending || r?.state === 'installed') && !this.licMeta?.licensed) {
                    this.notify.success('Licence installed — all features enabled');
                    this.http.get<any>('/email-track/licence/status').subscribe({ next: m => { this.licMeta = m; this.cdr.markForCheck(); }, error: () => undefined });
                }
                this.cdr.markForCheck();
            },
            error: () => undefined,
        });
    }
    private startClaimPoll() { this.stopClaimPoll(); this.claimTimer = setInterval(() => this.checkClaim(false), 15000); }
    private stopClaimPoll() { if (this.claimTimer) { clearInterval(this.claimTimer); this.claimTimer = null; } }
    ngOnDestroy() { this.stopClaimPoll(); clearTimeout(this.restartTimer); }

    portalOpening = false;
    licenceLabel(): string {
        const l: any = this.licMeta?.licence;
        if (!l) return 'active licence';
        const d = (s: string) => new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
        if (l.master) return 'master licence — covers every HULO plugin on this server';
        if (l.plan === 'lifetime') return 'lifetime licence — never expires, every update included';
        if (l.trialEndsAt && new Date(l.trialEndsAt).getTime() > Date.now()) {
            return `free trial on the ${l.plan} plan — first charge on ${d(l.trialEndsAt)}; cancel any time before then via Manage billing`;
        }
        return `${l.plan} subscription — renews automatically${l.expiresAt ? ' — current key valid until ' + d(l.expiresAt) : ''}`;
    }
    openPortal() {
        this.portalOpening = true;
        this.http.post<any>('/email-track/licence/portal-link', {}).subscribe({
            next: r => { this.portalOpening = false; if (r?.url) window.open(r.url, '_blank', 'noopener'); this.cdr.markForCheck(); },
            error: e => { this.portalOpening = false; this.notify.error(e?.error?.message || this.errMsg(e, 'Opening the billing portal')); this.cdr.markForCheck(); },
        });
    }
    buyLifetime() { this.buyPlan = 'lifetime'; this.buyLicence(); }

    activateLicence() {
        const key = (this.licKeyInput || '').trim();
        if (!key) return;
        this.licActivating = true;
        this.http.post<any>('/email-track/licence/activate', { key }).subscribe({
            next: r => {
                this.licActivating = false;
                this.licKeyInput = '';
                this.notify.success(r?.message || 'Licence activated — all features enabled');
                this.loadLicMeta();
                this.cdr.markForCheck();
            },
            error: e => {
                this.licActivating = false;
                this.notify.error(e?.error?.message || 'That key did not validate — check it was copied completely');
                this.cdr.markForCheck();
            },
        });
    }

    ngOnInit() {
        this.checkClaim(false);
        this.loadLicMeta();
        const cId = this.route.snapshot.queryParamMap.get('customerId');
        if (cId) {
            this.lockedCustomerId = cId;
            this.filterCustomerId = cId;
        }
        const oCode = this.route.snapshot.queryParamMap.get('orderCode');
        if (oCode) this.filterOrderCode = oCode;
        this.loadSetup();
        this.loadDigest();
        this.loadByTemplate();
        this.load();
    }

    dismissUpdate() {
        const latest = this.licMeta?.update?.latest;
        if (latest) { try { localStorage.setItem(this.dismissKey, latest); } catch {} }
        this.updateDismissed = true;
    }

    totalAll(): number {
        return (this.summary.sent || 0) + (this.summary.failed || 0) + (this.summary.deferred || 0)
            + (this.summary.bounced || 0) + (this.summary.complained || 0);
    }

    setStatus(s: string) {
        this.filterStatus = s;
        this.skip = 0;
        this.load();
    }

    clearFilters() {
        this.filterStatus = '';
        this.filterRecipient = '';
        this.filterType = '';
        this.filterCustomerId = this.lockedCustomerId || '';
        this.filterOrderCode = '';
        this.skip = 0;
        this.load();
    }

    private buildParams(): string {
        const p: string[] = [`take=${this.take}`, `skip=${this.skip}`];
        if (this.filterStatus) p.push(`status=${encodeURIComponent(this.filterStatus)}`);
        if (this.filterRecipient) p.push(`recipient=${encodeURIComponent(this.filterRecipient)}`);
        if (this.filterType) p.push(`type=${encodeURIComponent(this.filterType)}`);
        if (this.filterCustomerId) p.push(`customerId=${encodeURIComponent(this.filterCustomerId)}`);
        if (this.filterOrderCode) p.push(`orderCode=${encodeURIComponent(this.filterOrderCode)}`);
        return p.join('&');
    }

    load() {
        this.loading = true;
        Promise.all([
            this.http.get<any>(`/email-track/log?${this.buildParams()}`).toPromise(),
            this.http.get<any>('/email-track/log/summary?fromDays=30').toPromise(),
        ]).then(([list, summary]) => {
            this.rows = list?.items || [];
            this.total = list?.total || 0;
            this.summary = summary || this.summary;
            this.loading = false;
            this.expandedId = null;
            this.detail = null;
            this.cdr.markForCheck();
        }).catch((e: any) => {
            this.loading = false;
            this.notify.error(this.errMsg(e, 'Loading the email log'));
            this.cdr.markForCheck();
        });
    }

    open(id: number) {
        if (this.expandedId === id) {
            this.expandedId = null;
            this.detail = null;
            return;
        }
        this.expandedId = id;
        this.detail = null;
        this.http.get<EmailDetail>(`/email-track/log/${id}`).subscribe({
            next: (d) => { this.detail = d; this.cdr.markForCheck(); },
            error: e => this.notify.error(this.errMsg(e, 'Loading the email detail')),
        });
    }

    nextPage() { this.skip += this.take; this.load(); }
    prevPage() { this.skip = Math.max(0, this.skip - this.take); this.load(); }
}
