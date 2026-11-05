import { Injectable } from '@angular/core';
import { HttpBackend, HttpClient, HttpHeaders } from '@angular/common/http';
import { getAppConfig, LocalStorageService } from '@vendure/admin-ui/core';
import { Observable, of } from 'rxjs';
import { catchError, map, shareReplay } from 'rxjs/operators';

/**
 * HttpClient for the plugin's own REST endpoints (`/email-track/…`).
 *
 * - Sends what Vendure's Apollo link adds to GraphQL calls only: the admin's
 *   active channel token (`vendure-token`, or the configured channel token
 *   key) and, when the admin UI uses bearer-token auth, `Authorization:
 *   Bearer …`. Without them a channel-scoped admin is resolved to the
 *   default channel and a bearer-only host answers 401.
 * - Goes straight to the HttpBackend, past Vendure's DefaultInterceptor,
 *   which shows a red notification for every error response — the expected
 *   402 (unlicensed) and 403 (role) included. Callers show their own
 *   message instead.
 */
@Injectable({ providedIn: 'root' })
export class EmailTrackingHttp {
    private readonly http: HttpClient;

    constructor(backend: HttpBackend, private storage: LocalStorageService) {
        this.http = new HttpClient(backend);
    }

    private headers(extra?: HttpHeaders | Record<string, string>): HttpHeaders {
        let h = extra instanceof HttpHeaders ? extra : new HttpHeaders(extra || {});
        let cfg: any = {};
        try { cfg = getAppConfig() || {}; } catch { cfg = {}; }
        const store: any = this.storage;
        const channelToken = store.get('activeChannelToken');
        if (channelToken) h = h.set(cfg.channelTokenKey || 'vendure-token', String(channelToken));
        if (cfg.tokenMethod === 'bearer') {
            const token = store.get('authToken');
            if (token) h = h.set('Authorization', `Bearer ${token}`);
        }
        return h;
    }

    get<T = any>(url: string, options: { responseType?: 'json' | 'blob' | 'text'; headers?: Record<string, string> } = {}): Observable<T> {
        return (this.http as any).get(url, { ...options, headers: this.headers(options.headers), withCredentials: true }) as Observable<T>;
    }

    post<T = any>(url: string, body: unknown, options: { responseType?: 'json' | 'blob' | 'text'; headers?: Record<string, string> } = {}): Observable<T> {
        return (this.http as any).post(url, body, { ...options, headers: this.headers(options.headers), withCredentials: true }) as Observable<T>;
    }

    delete<T = any>(url: string, options: { headers?: Record<string, string> } = {}): Observable<T> {
        return (this.http as any).delete(url, { ...options, headers: this.headers(options.headers), withCredentials: true }) as Observable<T>;
    }
}

/**
 * Whether this install has premium access (licence or evaluation), from
 * `GET /email-track/licence/status`, read once and shared for a minute. The
 * premium screens ask it first and show their notice without calling a
 * premium endpoint (no 402 in the console); `null` when it cannot be told —
 * they then call the endpoint and handle its 402 as before.
 */
@Injectable({ providedIn: 'root' })
export class EmailTrackingTier {
    private cached: { at: number; value$: Observable<boolean | null> } | null = null;

    constructor(private http: EmailTrackingHttp) {}

    premium$(): Observable<boolean | null> {
        if (!this.cached || Date.now() - this.cached.at > 60_000) {
            const value$ = this.http.get<{ tier?: string }>('/email-track/licence/status').pipe(
                map(r => (r && typeof r.tier === 'string' ? r.tier !== 'free' : null)),
                catchError(() => of(null)),
                shareReplay(1),
            );
            this.cached = { at: Date.now(), value$ };
        }
        return this.cached.value$;
    }

    /** Forget the cached answer (after a licence is activated or removed). */
    reset(): void { this.cached = null; }
}

/** One timeline item as `GET /email-track/orders/:orderId/activity` returns it (redacted). */
export interface ActivityItem {
    id: string;
    at: string;
    kind: 'event' | 'legacy' | 'history';
    type: string;
    source: string;
    label: string;
    detail: string | null;
    emailLogId: number | null;
    emailType: string | null;
    classification: 'human_likely' | 'machine_likely' | 'unknown' | 'unverified' | null;
    reasons: string[];
    location: { country: string | null; region: string | null; city: string | null; timezone: string | null } | null;
    network: { asn: string | null; org: string | null; isProxy: boolean | null; isVpn: boolean | null; isTor: boolean | null; isHosting: boolean | null; isMobile: boolean | null; enrichedBy: string | null } | null;
    client: string | null;
    platform: string | null;
    isBot: boolean | null;
    ip: string | null;
    url: string | null;
    linkIndex: number | null;
    linkText: string | null;
    actor: string | null;
    legacy: boolean;
    visibility?: 'public' | 'private';
}

export interface ActivitySummary {
    order: { id: number; code: string; state: string; placedAt: string | null; totalFormatted: string; paymentState: string; customerEmail: string | null; customerName: string | null };
    emails: { total: number; sent: number; delivered: number; opened: number; firstOpenAt: string | null; clicked: number; bounced: number };
    opens: { recorded: number; human: number; machine: number; unknown: number; unsigned?: number };
    clicks: { recorded: number; human: number; machine: number; unknown: number; unsigned?: number };
    historyUnavailable?: boolean;
}

export interface ActivityPage {
    orderId: number;
    filter: string;
    items: ActivityItem[];
    nextCursor: string | null;
    hasMore: boolean;
    total: number;
    summary?: ActivitySummary;
    /** Vendure's order history could not be read: the timeline has email rows only. */
    historyUnavailable?: boolean;
    warning: string;
}

export const FILTERS: Array<{ id: string; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'emails', label: 'Emails' },
    { id: 'opens', label: 'Opens' },
    { id: 'clicks', label: 'Clicks' },
    { id: 'delivery', label: 'Delivery' },
    { id: 'order', label: 'Order & payment' },
    { id: 'notes', label: 'Notes' },
];

export function classLabel(c: string | null | undefined): string {
    if (c === 'human_likely') return 'Human-likely';
    if (c === 'machine_likely') return 'Machine-likely';
    if (c === 'unknown') return 'Unknown';
    if (c === 'unverified') return 'Unverified';
    return '';
}

/** `Link #2: Reset your password` (`linkIndex` is 0-based; shown from 1), the text alone, or ''. */
export function linkLabel(i: Pick<ActivityItem, 'linkIndex' | 'linkText'>): string {
    const text = i.linkText || '';
    if (i.linkIndex !== null && i.linkIndex !== undefined && i.linkIndex >= 0) return `Link #${i.linkIndex + 1}${text ? `: ${text}` : ''}`;
    return text;
}

/** The export file name the server would send: `order-<code>-activity[-<filter>][-full]-<UTC date>.<ext>`. */
export function exportFileName(code: string, filter: string, full: boolean, ext: 'csv' | 'json'): string {
    const safe = String(code).replace(/[^A-Za-z0-9_-]/g, '');
    return `order-${safe}-activity${filter && filter !== 'all' ? `-${filter}` : ''}${full ? '-full' : ''}-${new Date().toISOString().slice(0, 10)}.${ext}`;
}

export function locationLabel(i: ActivityItem): string {
    if (!i.location) return '';
    return [i.location.city, i.location.region, i.location.country].filter(Boolean).join(', ');
}

export function networkLabel(i: ActivityItem): string {
    if (!i.network) return '';
    const flags: string[] = [];
    if (i.network.isProxy) flags.push('proxy');
    if (i.network.isVpn) flags.push('VPN');
    if (i.network.isTor) flags.push('Tor');
    if (i.network.isHosting) flags.push('datacentre');
    if (i.network.isMobile) flags.push('mobile');
    return [i.network.org, i.network.asn, flags.length ? flags.join(', ') : ''].filter(Boolean).join(' · ');
}

export function clientLabel(i: ActivityItem): string {
    if (!i.client || i.client === 'unknown') return '';
    return i.client + (i.platform && i.platform !== 'unknown' ? ` · ${i.platform}` : '');
}

/** Clarity icon for an item. */
export function iconFor(i: ActivityItem): string {
    if (i.kind === 'history') {
        if (i.type === 'ORDER_NOTE') return 'note';
        if (i.type === 'ORDER_PAYMENT_TRANSITION' || i.type === 'ORDER_REFUND_TRANSITION') return 'dollar';
        if (i.type.startsWith('ORDER_FULFILLMENT')) return 'truck';
        return 'shopping-cart';
    }
    switch (i.type) {
        case 'open': return 'eye';
        case 'click': return 'cursor-hand-click';
        case 'delivered': return 'check-circle';
        case 'bounced':
        case 'complained':
        case 'dropped':
        case 'failed': return 'exclamation-triangle';
        case 'deferred':
        case 'soft-bounce': return 'clock';
        default: return 'envelope';
    }
}

/** Severity class for the event label. */
export function toneFor(i: ActivityItem): string {
    if (['bounced', 'complained', 'dropped', 'failed', 'suppressed'].includes(i.type)) return 'et-tone-bad';
    if (['deferred', 'soft-bounce', 'unsubscribed'].includes(i.type)) return 'et-tone-warn';
    if (i.type === 'delivered') return 'et-tone-good';
    return '';
}

/** True for an open / click that came through a link without a signature (classification `unverified`). */
export function isUnsigned(i: ActivityItem): boolean {
    return i.classification === 'unverified' || (Array.isArray(i.reasons) && i.reasons.includes('unsigned-token'));
}

/** One message for every failure, the licence case included. */
export function errorMessage(e: any, what: string): string {
    const code = e?.error?.error;
    if (e?.status === 402 || code === 'premium-feature') return `${what} needs a licence — subscribe or activate a key on the Email Log page.`;
    if (e?.status === 401) return `${what}: your session has ended — sign in again.`;
    if (e?.status === 403) return `${what}: your role does not allow this.`;
    if (e?.status === 404) return `${what}: order not found on this channel.`;
    const m = e?.error?.message || (typeof code === 'string' ? code : '') || e?.message;
    return m ? `${what} failed: ${m}` : `${what} failed`;
}

/**
 * Open the PDF evidence report in a new tab. A blank tab is opened inside
 * the click (so pop-up blockers allow it), then pointed at the short-lived
 * signed URL the server mints — the admin UI's bearer token cannot travel
 * on a plain link, the signature can.
 */
export function openEvidenceReport(http: EmailTrackingHttp, orderId: number | string, onError: (msg: string) => void, opts: { internalNotes?: boolean } = {}): void {
    const tab = window.open('about:blank', '_blank');
    http.post<{ url: string }>(`/email-track/orders/${orderId}/evidence-link`, opts.internalNotes ? { internalNotes: true } : {}).subscribe({
        next: r => {
            if (tab) {
                tab.opener = null;
                tab.location.href = r.url;
            } else {
                window.location.assign(r.url);
            }
        },
        error: e => {
            if (tab) tab.close();
            onError(errorMessage(e, 'The evidence report'));
        },
    });
}

/** One row of the compact order panel: an item, or a run of identical machine-likely opens / clicks. */
export interface PanelRow {
    item: ActivityItem;
    count: number;
}

function sameMachineRun(a: ActivityItem, b: ActivityItem): boolean {
    return a.kind !== 'history' && b.kind !== 'history' && a.type === b.type && (a.type === 'open' || a.type === 'click')
        && a.classification === 'machine_likely' && b.classification === 'machine_likely'
        && a.emailLogId === b.emailLogId && a.client === b.client && a.source === b.source
        && a.reasons.join(',') === b.reasons.join(',') && a.legacy === b.legacy;
}

/**
 * The latest rows for the order panel: consecutive machine-likely opens or
 * clicks of the same email, client and reasons (a Gmail proxy fetching the
 * pixel again and again) become one row with a count, so deliveries and
 * bounces are not pushed out of view. At most `max` rows.
 */
export function collapseRuns(items: ActivityItem[], max = 10): PanelRow[] {
    const out: PanelRow[] = [];
    for (const i of items) {
        const prev = out[out.length - 1];
        if (prev && sameMachineRun(prev.item, i)) { prev.count++; continue; }
        if (out.length >= max) break;
        out.push({ item: i, count: 1 });
    }
    return out;
}

export function saveBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
