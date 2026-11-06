import { Body, Controller, Delete, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import { Ctx, Logger, RequestContext, TransactionalConnection } from '@vendure/core';
import {
    applySecurityHeaders,
    isUrlOnAllowlist,
    premiumFeatureError,
    verifyHmacSha256,
    verifySignedValue, LicenceStore, performSelfUpdate, selfUpdateEnv, adapterFor, PurchaseClaimClient, evalInstanceId, describeLicence } from '@huloglobal/vendure-licence-sdk';
import { Request, Response } from 'express';
import { EmailLog } from './email-log.entity';
import { EmailSuppression } from './email-suppression.entity';
import { EmailTrackingService, PREMIUM_FEATURES, effectiveTier, recentStatLines } from './email-tracking.service';
import { EmailLinkService } from './email-link.service';
import { EmailTrackingPlugin } from './plugin';
import { getOptions, getLicenceStatus, hasPremiumAccess, getEvalState, getEvalInstanceId, configuredSigningSecret } from './options';
import { dateParam, deliveryEventsUnavailable, getLimiter, intParam, realIp, requireAdmin, scopedChannel } from './http-helpers';
import { verifyClickSignature } from './click-signature';
import { csvCell, CSV_BOM } from './csv';
import { redactSensitiveUrl } from './link-meta';
import {
    ATTEMPT_COLUMNS, ATTEMPT_STATES, AttemptInfo, attemptInfosFor, AttemptState, mayHaveRetry, SendClock, sendClock, SENDING_SQL, sendingSince,
    sqlTime, stateFields, STORED_STATES, TimelineStart, UNKNOWN_SQL, unknownParams, UNSETTLED_SQL, unsettledSince,
} from './send-attempts';

const loggerCtx = 'EmailTrackingController';

const DAY_MS = 86_400_000;

/** Rows a `state` filter reads that needs each email's other attempts (failed, retrying, retried, deferred, unknown), newest first. */
const STATE_CANDIDATES = 5000;
const EXPORT_ROWS = 50_000;

/** The Email Log list's columns (`updatedAt`: when a refused attempt's failure was recorded). */
const LIST_COLUMNS = `id, \`createdAt\`, \`updatedAt\`, type, recipient, subject, status,
                    \`customerId\`, \`orderId\`, \`orderCode\`, \`invoiceId\`, \`applicationId\`,
                    \`channelId\`, \`openCount\`, \`firstOpenedAt\`, \`lastOpenedAt\`,
                    \`clickCount\`, \`firstClickedAt\`, \`smtpResponse\`, \`errorMessage\``;

/** The CSV export's columns, plus what reading the attempt needs. */
const EXPORT_COLUMNS = `id, \`createdAt\`, \`updatedAt\`, type, recipient, subject, status,
                    \`openCount\`, \`clickCount\`, \`customerId\`, \`orderId\`, \`orderCode\`, \`invoiceId\`, \`channelId\`,
                    \`smtpMessageId\`, \`smtpResponse\`, \`errorMessage\``;

/** A validated Email Log filter: WHERE parts and their parameters, the period, and the `state` filter. */
interface LogFilter {
    where: string[];
    params: any[];
    /** Days back (null: no limit). */
    fromDays: number | null;
    /** `state=`: how the send went (send-attempts.ts). */
    states: AttemptState[] | null;
    /** A state needs each email's other attempts, so the rows are read and picked here (not in SQL). */
    classified: boolean;
    /** The database's "now" and the timeline start the filter was built for: the SQL bounds and the rows' states use the same. */
    clock: SendClock;
}

/** SQL and parameter of a `state` that the row alone decides (STORED_STATES). */
function storedStateSql(state: AttemptState, clock: SendClock, dbType: string | undefined): { sql: string; params: any[] } {
    if (state === 'sending') return { sql: SENDING_SQL, params: [sendingSince(clock.now, dbType)] };
    // Neither in flight nor without any reply recorded (`unknown`).
    if (state === 'sent') return { sql: `(status = 'sent' AND NOT ${UNSETTLED_SQL})`, params: [unsettledSince(clock.now, clock.timelineFrom, dbType)] };
    return { sql: 'status = ?', params: [state] };
}

/** Hosts a legacy (unsigned) click token may redirect to: the shop itself plus any tracked hosts. */
function ownHosts(): string[] {
    const opts = getOptions();
    const out = new Set<string>();
    try { out.add(new URL(opts.publicBaseUrl || '').hostname.toLowerCase()); } catch { /* unset */ }
    for (const h of opts.trackedHosts || []) { const v = String(h).toLowerCase().replace(/^https?:\/\//, '').split('/')[0]; if (v) out.add(v); }
    for (const h of opts.clickRedirectAllowedDomains || []) { const v = String(h).toLowerCase().replace(/^\*\./, ''); if (v) out.add(v); }
    return [...out].filter(Boolean);
}

// 1×1 transparent GIF (43 bytes) returned by the open-tracking endpoint.
const ONE_PX_GIF = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    'base64',
);

const PLUGIN_ID_FOR_STORE = 'vendure-plugin-email-tracking';

@Controller('email-track')
export class EmailTrackingController {
    constructor(
        private connection: TransactionalConnection,
        private tracking: EmailTrackingService,
        private links: EmailLinkService,
    ) {}

    /**
     * Admin: plugin health + update availability. Read by the admin UI
     * banner so the operator sees when a new version is on npm.
     *
     * GET /email-track/status
     */

    // Pass `opts` through: on PostgreSQL LicenceStore.save needs its conflict columns for the upsert.
    private licenceStore = new LicenceStore((sql: string, params?: any[], opts?: any) => adapterFor(this.connection.rawConnection).query(sql, params, opts));

    /** Licence/evaluation state for the admin banner, plus the lifecycle
     *  notice, what the free tier loses and the top 30-day figures. */
    @Get('licence/status')
    async licenceState(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (!requireAdmin(ctx, res, false)) return;
        const licence = getLicenceStatus();
        const ev = getEvalState();
        const updater = EmailTrackingPlugin.getUpdateChecker();
        const summary = describeLicence(licence);
        let recentStats: Array<{ label: string; value: string }> = [];
        try { recentStats = recentStatLines(await this.tracking.evalStats()); } catch { recentStats = []; }
        return res.json({
            licensed: !!licence?.valid,
            licence: summary,
            licenceMessage: licence?.valid ? '' : (licence?.message || 'No licence key configured'),
            tier: effectiveTier(),
            eval: ev,
            pkg: PLUGIN_ID_FOR_STORE,
            update: updater ? updater.getStatus() : null,
            selfUpdate: selfUpdateEnv(),
            notice: this.tracking.licenceNotice(),
            premiumFeatures: PREMIUM_FEATURES,
            recentStats,
        });
    }

    /** Trial reminder opt-in: the admin's address goes to the licence server
     *  (`/licence/eval/lead`) so they hear before the evaluation ends.
     *  Explicit consent only; the address is also kept as the default
     *  recipient of the weekly report. */
    @Post('eval/remind-me')
    async evalRemindMe(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: any) {
        if (!requireAdmin(ctx, res, true)) return;
        const email = String(body?.email || '').trim().slice(0, 320);
        const instanceId = getEvalInstanceId() || evalInstanceId();
        if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email) || !instanceId) return res.status(400).json({ error: 'bad-request', message: 'Enter a valid email address' });
        try {
            const base = (process.env.HULO_LICENCE_EVAL_URL || 'https://elite.charity/licence/eval/register').replace(/\/register$/, '');
            const resp = await fetch(`${base}/lead`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ plugin: EmailTrackingPlugin.getPackageName(), instanceId, email }),
                signal: AbortSignal.timeout(8_000),
            });
            if (!resp.ok) return res.status(502).json({ error: 'upstream', status: resp.status });
            await this.tracking.prefs.set('eval.leadEmail', email.toLowerCase());
            return res.json({ ok: true });
        } catch {
            return res.status(502).json({ error: 'unreachable' });
        }
    }

    /** Set-up checklist for the first screen (real checks, read-only). */
    @Get('setup')
    async setup(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (!requireAdmin(ctx, res, false)) return;
        return res.json(await this.tracking.setupChecklist());
    }

    /** Dashboard widget: three 7-day figures + lifecycle notice. */
    @Get('widget')
    async widget(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (!requireAdmin(ctx, res, false)) return;
        return res.json(await this.tracking.widgetData());
    }

    // ── Weekly report ──────────────────────────────────────────────────

    @Get('digest/settings')
    async digestSettings(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (!requireAdmin(ctx, res, false)) return;
        return res.json(await this.tracking.digestSettings());
    }

    @Post('digest/settings')
    async digestUpdateSettings(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: any) {
        if (!requireAdmin(ctx, res, true)) return;
        const patch: { enabled?: boolean; recipient?: string | null } = {};
        if (typeof body?.enabled === 'boolean') patch.enabled = body.enabled;
        if (body && 'recipient' in body) patch.recipient = body.recipient === null ? null : String(body.recipient ?? '');
        try {
            return res.json(await this.tracking.digest.updateSettings(patch));
        } catch (e: any) {
            return res.status(400).json({ error: 'bad-request', message: e?.message || 'Invalid settings' });
        }
    }

    @Post('digest/send-test')
    async digestSendTest(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: any) {
        if (!requireAdmin(ctx, res, true)) return;
        const to = body?.to ? String(body.to).trim().slice(0, 320) : undefined;
        if (to && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: 'bad-request', message: 'Enter a valid email address' });
        const r = await this.tracking.digest.sendNow(to);
        return res.json({ sent: r.sent, to: r.to, reason: r.reason, subject: r.preview.subject });
    }

    /** This week's report as HTML, for the admin "Preview" button. */
    @Get('digest/preview')
    async digestPreview(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (!requireAdmin(ctx, res, false)) return;
        const mail = await this.tracking.digestPreview();
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(mail.html);
    }

    /** One-click in-app update (owner-approved feature): installs a
     *  registry-verified version of THIS plugin via the host's package
     *  manager and restarts under the process supervisor. Admin-only;
     *  package name is hard-coded; HULO_SELF_UPDATE=off disables. */
    @Post('update/run')
    async updateRun(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: any) {
        if (!requireAdmin(ctx, res, 'ops')) return;
        const updater = EmailTrackingPlugin.getUpdateChecker();
        const target = String(body?.version || updater?.getStatus()?.latest || '').trim();
        if (!target) return res.status(400).json({ ok: false, message: 'No target version known yet — the registry check runs daily; try again shortly.' });
        const result = await performSelfUpdate({ packageName: '@huloglobal/vendure-plugin-email-tracking', targetVersion: target });
        return res.status(result.ok ? 200 : 400).json(result);
    }

    /** Admin-UI licence activation: paste-a-key, verified with the exact
     *  boot-time checks, applied immediately and persisted. */
    @Post('licence/activate')
    async licenceActivate(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: any) {
        if (!requireAdmin(ctx, res, 'ops')) return;
        const key = String(body?.key || '').trim();
        if (!key) return res.status(400).json({ licensed: false, message: 'Paste your licence key first.' });
        const status = EmailTrackingPlugin.activateRuntimeLicence(key);
        if (!status.valid) return res.status(400).json({ licensed: false, message: status.message || 'Invalid licence key.' });
        await this.licenceStore.ensureTable();
        await this.licenceStore.save(PLUGIN_ID_FOR_STORE, key);
        return res.json({ licensed: true, message: status.message });
    }

    /** Remove an admin-activated key (env-configured keys unaffected). */
    @Post('licence/deactivate')
    async licenceDeactivate(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (!requireAdmin(ctx, res, 'ops')) return;
        await this.licenceStore.clear(PLUGIN_ID_FOR_STORE);
        EmailTrackingPlugin.deactivateRuntimeLicence();
        return res.json({ licensed: false });
    }

    /** Buy-from-admin: mint a claim token and return the HULO buy-page
     *  URL. Once checkout completes the licence server binds the claim to
     *  the minted key and `licence/claim-status` installs it — no email
     *  round-trip, no .env edit, no restart. */
    @Post('licence/purchase-link')
    async licencePurchaseLink(@Ctx() ctx: RequestContext, @Res() res: Response, @Body() body: any) {
        if (!requireAdmin(ctx, res, 'ops')) return;
        const plan = (['monthly', 'annual', 'lifetime'].includes(String(body?.plan)) ? String(body.plan) : 'annual') as 'monthly' | 'annual' | 'lifetime';
        try {
            const r = await this.purchaseClaimClient().createPurchaseLink(plan, String(body?.email || '').trim() || undefined);
            return res.json({ url: r.url, state: 'pending' });
        } catch (e: any) {
            return res.status(500).json({ message: e?.message || 'Could not start the purchase — try again shortly.' });
        }
    }

    /** Poll target for the admin page while a purchase is pending; with
     *  `?check=1` it asks the licence server right now and installs the
     *  key if it is ready. Installed claims are re-checked daily so a
     *  renewed subscription key lands automatically too. */
    @Get('licence/claim-status')
    async licenceClaimStatus(@Ctx() ctx: RequestContext, @Res() res: Response, @Query('check') check?: string) {
        if (!requireAdmin(ctx, res, false)) return;
        const client = this.purchaseClaimClient();
        const st = check ? await client.checkNow() : await client.status();
        return res.json({ ...st, licensed: !!getLicenceStatus()?.valid });
    }

    /** Stripe billing portal (update card, cancel, switch plan) for the
     *  subscription behind this install's licence. Ownership is proven by
     *  the buy-from-admin claim or by the stored licence key itself. */
    @Post('licence/portal-link')
    async licencePortalLink(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (!requireAdmin(ctx, res, 'ops')) return;
        let storedKey: string | null = null;
        try { storedKey = await this.licenceStore.load(PLUGIN_ID_FOR_STORE); } catch { storedKey = null; }
        const url = await this.purchaseClaimClient().billingPortalUrl(storedKey);
        if (!url) return res.status(404).json({ message: 'No billing portal is available for this licence (lifetime and master licences have nothing to manage; for a key set via the environment, reply to your receipt email for a portal link).' });
        return res.json({ url });
    }

    /** Buy-from-admin auto-install client. */
    private purchaseClaim: PurchaseClaimClient | null = null;
    private purchaseClaimClient(): PurchaseClaimClient {
        if (!this.purchaseClaim) {
            this.purchaseClaim = new PurchaseClaimClient({
                packageName: EmailTrackingPlugin.getPackageName(),
                instanceId: () => evalInstanceId(),
                query: (sql, params, opts) => adapterFor(this.connection.rawConnection).query(sql, params, opts),
                onLicence: async (key: string) => {
                    const status = EmailTrackingPlugin.activateRuntimeLicence(key);
                    if (!status.valid) return false;
                    await this.licenceStore.ensureTable(); await this.licenceStore.save(PLUGIN_ID_FOR_STORE, key);
                    return true;
                },
            });
        }
        return this.purchaseClaim;
    }

    async onApplicationBootstrap() {
        await this.purchaseClaimClient().resume().catch(() => undefined);
    }

    @Get('status')
    async status(@Ctx() ctx: RequestContext, @Res() res: Response) {
        if (!requireAdmin(ctx, res, false)) return;
        const updater = EmailTrackingPlugin.getUpdateChecker();
        const update = updater ? updater.getStatus() : null;
        const licence = getLicenceStatus();
        return res.json({
            packageName: EmailTrackingPlugin.getPackageName(),
            version: EmailTrackingPlugin.getPackageVersion(),
            licence: licence ? { valid: licence.valid, reason: licence.reason, plan: licence.payload?.plan, expiresAt: licence.payload?.exp } : null,
            update,
            uptimeSec: Math.round(process.uptime()),
        });
    }

    /**
     * Open-tracking pixel. Returns a 1×1 transparent GIF and logs the
     * open against the event. No-cache so privacy-protecting prefetchers
     * still get caught per fetch (and we count opens accurately).
     *
     * GET /email-track/open/:id.gif
     */
    @Get('open/:token.gif')
    async open(@Param('token') token: string, @Req() req: Request, @Res() res: Response) {
        const ip = realIp(req);
        // Rate limit per IP so an attacker can't inflate open counts at
        // scale by hammering the pixel.
        if (ip && !getLimiter().allow(`open|${ip}`)) {
            res.status(429).setHeader('Retry-After', '60');
            return res.end();
        }

        const resolved = this.resolveSignedId(token);
        const id = resolved?.id ?? null;
        if (id !== null && hasPremiumAccess()) {
            // Open tracking is a paid feature. Unlicensed installs still
            // serve the pixel (so emails don't show a broken image) but
            // do not record the open. A bare id is recorded as unsigned (or
            // not at all when the email's own links were signed).
            this.tracking.recordOpen(id, ip, req.headers['user-agent'] as string || null, { signed: !!resolved?.signed })
                .catch((e: any) => Logger.warn(`open log fail #${id}: ${e?.message}`, loggerCtx));
        }
        // Always return the pixel — never leak whether the id was real
        // or the signature was valid. Privacy-protecting clients and bots
        // get the same response as real opens.
        res.setHeader('Content-Type', 'image/gif');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        // Not applySecurityHeaders(): its CORP `same-origin` makes mail clients drop a cross-origin image.
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        return res.end(ONE_PX_GIF);
    }

    /**
     * Click redirect. Logs the click then 302-redirects to the original
     * URL. Returns 400 if the URL is missing or malformed (we never
     * redirect to an empty / javascript: target).
     *
     * GET /email-track/click/:id?u=<encoded>
     *
     * Three token shapes: `<id>.<hmac>` (signed log id), a bare legacy id
     * (own hosts only), or a 64-hex `EmailLinkService` token whose `s`
     * signature and stored hash bind the destination to the row.
     */
    @Get('click/:token')
    async click(@Param('token') token: string, @Query('u') u: string, @Query('s') sig: string, @Req() req: Request, @Res() res: Response) {
        const ip = realIp(req);
        if (ip && !getLimiter().allow(`click|${ip}`)) {
            res.setHeader('Retry-After', '60');
            return res.status(429).send('Too many requests');
        }

        const url = (typeof u === 'string' ? u : '').trim();
        const opts = getOptions();
        // Defence in depth: reject non-http(s) and any host that isn't on
        // the allowlist when one is configured. Stops the redirector
        // being abused as an open redirector.
        if (!isUrlOnAllowlist(url, opts.clickRedirectAllowedDomains || [])) {
            applySecurityHeaders(res);
            return res.status(400).send('Invalid redirect target');
        }
        if (/^[0-9a-f]{64}$/.test(token)) return this.clickLinkToken(token, url, String(sig || ''), ip, req, res);
        const resolved = this.resolveSignedId(token);
        const id = resolved?.id ?? null;
        // Never redirect for a token we cannot tie to an email we sent: with a
        // signing secret that closes the open redirector completely. Legacy
        // unsigned ids (emails sent before a secret existed) may only redirect
        // to the shop's own hosts.
        if (id === null) {
            applySecurityHeaders(res);
            return res.status(404).send('Unknown link');
        }
        // The `<id>.<hmac>` token only proves which email this is; `s` binds
        // the destination. Without a valid `s` (bare legacy ids, and signed
        // links rewritten before 0.15.3) only the shop's own hosts are reachable.
        const destinationSigned = !!opts.signingSecret && token.includes('.')
            && verifyClickSignature(token, url, sig, opts.signingSecret);
        if (!destinationSigned) {
            const own = ownHosts();
            let host = '';
            try { host = new URL(url).hostname.toLowerCase(); } catch { /* rejected above */ }
            if (!own.some(h => host === h || host.endsWith(`.${h}`))) {
                applySecurityHeaders(res);
                return res.status(400).send('Invalid redirect target');
            }
        }
        if (id !== null && hasPremiumAccess()) {
            // Click tracking is paid. Unlicensed mode still redirects
            // (we don't break the customer's email) but doesn't log.
            // Recorded after the redirect is on its way: a slow lookup or
            // database never holds the customer up.
            this.tracking.recordClick(id, url, ip, req.headers['user-agent'] as string || null, undefined, { signed: !!resolved?.signed })
                .catch((e: any) => Logger.warn(`click log fail #${id}: ${e?.message}`, loggerCtx));
        }
        res.setHeader('Cache-Control', 'no-store');
        applySecurityHeaders(res);
        return res.redirect(302, url);
    }

    /** Per-link token minted by `EmailLinkService.issueLinkToken`: the row
     *  must exist, be unexpired, and both the `s` HMAC and the stored
     *  destination hash must match `u` — so the token cannot be pointed at
     *  another URL. Sensitive links are recorded by their redacted form. */
    private async clickLinkToken(token: string, url: string, sig: string, ip: string | null, req: Request, res: Response) {
        applySecurityHeaders(res);
        const link = await this.links.findLinkByToken(token);
        if (!link) return res.status(404).send('Unknown link');
        if (link.expiresAt && new Date(link.expiresAt).getTime() < Date.now()) return res.status(410).send('Link expired');
        if (!this.links.verifyClickDestination(token, url, sig) || !this.links.destinationMatches(link, url)) {
            return res.status(400).send('Invalid redirect target');
        }
        if (link.emailLogId && link.isTrackingEnabled !== false && hasPremiumAccess()) {
            const recorded = link.isSensitive ? (link.destinationUrlRedacted || `[sensitive: ${link.destinationUrlHost || 'unknown'}]`) : url;
            // Fire-and-forget, as for the pixel: the redirect never waits on the recording.
            this.tracking.recordClick(Number(link.emailLogId), recorded, ip, req.headers['user-agent'] as string || null,
                { linkIndex: link.linkIndex ?? null, linkText: link.linkText || link.linkLabel || null })
                .catch((e: any) => Logger.warn(`click log fail (link ${link.id}): ${e?.message}`, loggerCtx));
        }
        res.setHeader('Cache-Control', 'no-store');
        return res.redirect(302, url);
    }

    /**
     * Resolve a path parameter back to a numeric email-log id, and whether
     * the token carried a valid signature.
     *
     * With a signing secret, `<id>.<hmac>` tokens are verified (`signed`).
     * A bare numeric id — links in emails sent before any secret existed —
     * is still accepted but `signed: false`: anyone can type one, so while
     * a secret exists its opens and clicks are recorded as `unverified`
     * events only (reason `unsigned-token`, never enriched, never counted in
     * `email_log`), and not recorded at all when that email's own links were
     * signed. Parsed strictly so nothing like a path traversal slips in.
     */
    private resolveSignedId(raw: string): { id: number; signed: boolean } | null {
        if (!raw) return null;
        const secret = getOptions().signingSecret;
        if (secret && raw.includes('.')) {
            const value = verifySignedValue(raw, secret);
            if (!value || !/^\d{1,12}$/.test(value)) return null;
            const id = parseInt(value, 10);
            return id > 0 ? { id, signed: true } : null;
        }
        // Bare id: only the exact decimal form ("12abc" and 64-hex link tokens are not ids).
        if (!/^\d{1,12}$/.test(raw)) return null;
        const id = parseInt(raw, 10);
        return id > 0 ? { id, signed: false } : null;
    }

    /**
     * Bounce webhook. Wire up a postmaster / mail-server hook (or have a
     * scheduled DSN-parser POST here) to mark messages as bounced or
     * complained. Both fields are required; the messageId is the
     * `<...@domain>` value Gmail returned at submit time.
     *
     * POST /email-track/bounce
     * Body: { messageId, status: 'bounced'|'complained', reason? }
     *
     * Currently unauthenticated to keep the integration simple — gate
     * behind a shared secret header if you expose the endpoint to the
     * public internet (it's fine on a private network).
     */
    @Post('bounce')
    async bounce(@Body() body: any, @Req() req: Request, @Res() res: Response) {
        applySecurityHeaders(res, { strict: true });

        // Webhook authentication: when a secret is configured, every
        // request MUST carry a valid X-Signature header. Without a
        // secret the endpoint accepts unauthenticated POSTs (legacy
        // behaviour — strongly recommend setting bounceWebhookSecret in
        // production).
        // A secret generated at boot is unknown to the sender, so only a
        // configured one authenticates the webhook.
        const opts = getOptions();
        const secret = opts.bounceWebhookSecret || configuredSigningSecret();
        if (!secret && !opts.allowUnauthenticatedBounceWebhook) {
            // Anyone who knows a Message-ID could otherwise mark mail bounced and suppress the customer.
            return res.status(503).json({ error: 'bounce webhook disabled: set bounceWebhookSecret (or allowUnauthenticatedBounceWebhook: true on a private network)' });
        }
        const bounceIp = realIp(req);
        // The body middleware already took this request's token from the limiter.
        if (!(req as any).huloRateChecked && bounceIp && !getLimiter().allow(`bounce|${bounceIp}`)) {
            res.setHeader('Retry-After', '60');
            return res.status(429).json({ error: 'Too many requests' });
        }
        if (secret) {
            const sig = (req.headers['x-signature'] as string)
                || (req.headers['x-hub-signature-256'] as string)
                || '';
            // Since 0.16.0 the plugin captures the exact request bytes on this
            // route (raw-body.ts), so the HMAC is checked over what was sent.
            // Senders that signed the compact JSON form (what 0.15.x verified,
            // with no raw body available) keep working through the fallback.
            const raw: Buffer | undefined = (req as any).rawBody;
            const ok = (raw && verifyHmacSha256(raw, sig, secret))
                || verifyHmacSha256(Buffer.from(JSON.stringify(body || {})), sig, secret);
            if (!ok) {
                return res.status(401).json({ error: 'Invalid signature' });
            }
        }

        const messageId = String(body?.messageId || '').trim().replace(/^<|>$/g, '');
        if (!messageId || messageId.length > 500) {
            return res.status(400).json({ error: 'messageId required' });
        }
        const status = body?.status === 'complained' ? 'complained' : 'bounced';
        // A soft/transient bounce (mailbox full, greylisting) is recorded but never suppresses the address.
        const bounceType = String(body?.bounceType || 'hard').toLowerCase();
        const soft = status === 'bounced' && (bounceType === 'soft' || bounceType === 'transient');
        const reason = body?.reason ? String(body.reason).slice(0, 2000) : undefined;
        const ok = await this.tracking.recordBounce(messageId, status, reason, { soft });
        return res.json({ ok, matched: ok });
    }

    /**
     * Admin: list email events, with filtering for the "Email Log" page
     * and the per-customer Emails tab. Filterable by customerId, orderId,
     * orderCode, status (as stored), state (how the send went), type,
     * recipient, a date range and a period in days.
     *
     * GET /email-track/log?customerId=&orderId=&status=&state=&fromDays=&take=
     */
    /**
     * Validated WHERE for the log list, its summary and the export (400 on a
     * bad value); non-default channels only see their own rows. `fromDays`:
     * the last n days (`all` or 0: no limit). `state`: comma-separated
     * states (send-attempts.ts) — those the row alone decides become SQL,
     * the others (failed, retrying, retried, deferred, unknown) are picked
     * after reading each email's attempts (`selectLog`). `clock`: the
     * database's "now" (`sendClock`), which the period counts back from.
     */
    private buildLogFilter(ctx: RequestContext, q: any, clock: SendClock): LogFilter | { error: string } {
        const now = clock.now;
        const where: string[] = [];
        const params: any[] = [];
        const dbType = this.dbType();
        const int = (name: string, col: string) => {
            if (q[name] === undefined || q[name] === '') return true;
            const n = intParam(q[name], 1, 2147483647);
            if (n === null) return false;
            where.push(`\`${col}\` = ?`); params.push(n); return true;
        };
        if (!int('customerId', 'customerId') || !int('orderId', 'orderId') || !int('invoiceId', 'invoiceId')) return { error: 'ids must be positive integers' };
        if (q.orderCode) { where.push('\`orderCode\` = ?'); params.push(String(q.orderCode).slice(0, 64)); }
        if (q.status) {
            // One status, or several comma-separated (`sent,delivered`: everything accepted).
            const list = Array.from(new Set(String(q.status).split(',').map(x => x.trim()).filter(Boolean))).slice(0, 8);
            if (!list.length || list.some(x => x.length > 32)) return { error: 'status must be one or more comma-separated statuses' };
            where.push(list.length === 1 ? 'status = ?' : `status IN (${list.map(() => '?').join(', ')})`);
            params.push(...list);
        }
        if (q.type) { where.push('type = ?'); params.push(String(q.type).slice(0, 64)); }
        if (q.recipient) { where.push('recipient LIKE ?'); params.push(`%${String(q.recipient).slice(0, 190).replace(/[\\%_]/g, m => '\\' + m)}%`); }
        if (q.from) { const d = dateParam(q.from); if (!d) return { error: 'from is not a date' }; where.push('\`createdAt\` >= ?'); params.push(d); }
        if (q.to) { const d = dateParam(q.to); if (!d) return { error: 'to is not a date' }; where.push('\`createdAt\` <= ?'); params.push(d); }
        let fromDays: number | null = null;
        if (q.fromDays !== undefined && q.fromDays !== '' && q.fromDays !== 'all' && String(q.fromDays) !== '0') {
            fromDays = intParam(q.fromDays, 1, 3650);
            if (fromDays === null) return { error: 'fromDays must be a number of days (1 to 3650) or all' };
            where.push('\`createdAt\` >= ?'); params.push(sqlTime(new Date(now - fromDays * DAY_MS), dbType));
        }
        let states: AttemptState[] | null = null;
        let classified = false;
        if (q.state) {
            const list = Array.from(new Set(String(q.state).split(',').map(x => x.trim()).filter(Boolean))) as AttemptState[];
            if (!list.length || list.some(x => !ATTEMPT_STATES.includes(x))) return { error: `state must be one or more of ${ATTEMPT_STATES.join(', ')}` };
            states = list;
            classified = list.some(x => !STORED_STATES.includes(x));
            if (!classified) {
                const parts = list.map(x => storedStateSql(x, clock, dbType));
                where.push(`(${parts.map(x => x.sql).join(' OR ')})`);
                for (const x of parts) params.push(...x.params);
            }
        }
        const scope = scopedChannel(ctx);
        if (scope) { where.push('\`channelId\` = ?'); params.push(scope); }
        return { where, params, fromDays, states, classified, clock };
    }

    /** The TypeORM driver type (`mysql`, `postgres`, `sqljs` …). */
    private dbType(): string {
        return String((this.connection.rawConnection.options as any)?.type || '');
    }

    private readonly timeline = new TimelineStart();

    /** What the send states are read against: the database's "now" and when the event timeline began. */
    private clock(): Promise<SendClock> {
        const db = adapterFor(this.connection.rawConnection);
        return sendClock((sql, params) => db.query(sql, params), this.dbType(), this.timeline);
    }

    /**
     * The filtered log, newest first: one page of rows, the total, and how
     * each row's send went (send-attempts.ts). A `state` filter the row alone
     * cannot decide reads the refused attempts and those without any reply
     * recorded (and the rows of any other state asked for, at most `cap`) and
     * keeps the matching ones. `relatedFor`: `all` reads the attempts around
     * every row (the list shows each row's retry links), `refused` only
     * around those whose state a later attempt can change (enough for their
     * state; the export).
     */
    private async selectLog(f: LogFilter, columns: string, take: number, skip: number, cap: number, relatedFor: 'all' | 'refused'):
        Promise<{ rows: any[]; total: number; infos: Map<number, AttemptInfo> }> {
        const db = adapterFor(this.connection.rawConnection);
        const query = (sql: string, params?: any[]) => db.query(sql, params);
        const dbType = this.dbType();
        const seedsOf = (rows: any[]) => (relatedFor === 'all' ? rows : rows.filter(mayHaveRetry));
        const readAt = { now: f.clock.now, timelineFrom: f.clock.timelineFrom, dbType };
        if (!f.classified) {
            const whereClause = f.where.length ? ` WHERE ${f.where.join(' AND ')}` : '';
            // Backticks: email_log is a TypeORM entity table, so its camelCase columns are quoted on Postgres.
            const rows: any[] = await db.query(
                `SELECT ${columns}
                 FROM email_log${whereClause}
                 ORDER BY id DESC
                 LIMIT ? OFFSET ?`,
                [...f.params, take, skip],
            );
            const counted = await db.query(`SELECT COUNT(*) AS total FROM email_log${whereClause}`, f.params);
            const infos = await attemptInfosFor(query, rows || [], { ...readAt, seeds: seedsOf(rows || []) });
            return { rows: rows || [], total: Number(counted?.[0]?.total) || 0, infos };
        }
        const either = ["status IN ('failed', 'deferred')", UNKNOWN_SQL];
        const eitherParams: any[] = [...unknownParams(f.clock.now, f.clock.timelineFrom, dbType)];
        for (const s of f.states || []) {
            if (!STORED_STATES.includes(s)) continue;
            const x = storedStateSql(s, f.clock, dbType);
            either.push(x.sql);
            eitherParams.push(...x.params);
        }
        const candidateClause = ` WHERE ${[...f.where, `(${either.join(' OR ')})`].join(' AND ')}`;
        const candidates: any[] = (await db.query(
            `SELECT ${columns} FROM email_log${candidateClause} ORDER BY id DESC LIMIT ?`,
            [...f.params, ...eitherParams, cap],
        )) || [];
        const infos = await attemptInfosFor(query, candidates, { ...readAt, seeds: seedsOf(candidates) });
        const picked = candidates.filter(r => (f.states || []).includes(infos.get(Number(r.id))?.state as AttemptState));
        return { rows: picked.slice(skip, skip + take), total: picked.length, infos };
    }

    @Get('log')
    async listLog(@Ctx() ctx: RequestContext, @Req() req: Request, @Res() res: Response) {
        if (!requireAdmin(ctx, res, false)) return;
        const q = req.query as any;
        const take = intParam(q.take, 1, 500) ?? 100;
        const skip = intParam(q.skip, 0, 10_000_000) ?? 0;
        const built = this.buildLogFilter(ctx, q, await this.clock());
        if ('error' in built) return res.status(400).json({ error: built.error });
        const { rows, total, infos } = await this.selectLog(built, LIST_COLUMNS, take, skip, STATE_CANDIDATES, 'all');
        // Each row with how its send went: `state`, and the attempt it retried or that retried it.
        const items = rows.map(r => ({ ...r, ...stateFields(infos.get(Number(r.id))) }));
        return res.json({ items, total, take, skip, fromDays: built.fromDays });
    }

    /**
     * Admin: the Email Log cards — counts per state over the same filters
     * and period as the list (default the last 30 days; `fromDays=all`: every
     * email), so a card and the list it opens agree. `total` is every row;
     * `sent` leaves out sends still in flight (`sending`) and those that never
     * recorded a reply (`unknown`); a refused attempt is `failed` only when no
     * retry is due and none was made (`retrying`, `retried` otherwise);
     * `deferred` keeps deferrals that were not retried. `deliveryEvents`:
     * deliveries can be reported (`deliveryEventsReason` says why not).
     */
    @Get('log/summary')
    async logSummary(@Ctx() ctx: RequestContext, @Req() req: Request, @Res() res: Response) {
        if (!requireAdmin(ctx, res, false)) return;
        const q: any = { ...(req.query as any) };
        if (q.fromDays === undefined || q.fromDays === '') q.fromDays = 30;
        delete q.status;
        delete q.state;
        const built = this.buildLogFilter(ctx, q, await this.clock());
        if ('error' in built) return res.status(400).json({ error: built.error });
        const db = adapterFor(this.connection.rawConnection);
        const dbType = this.dbType();
        const { now, timelineFrom } = built.clock;
        const whereClause = built.where.length ? ` WHERE ${built.where.join(' AND ')}` : '';
        const rows = await db.query(
            `SELECT status, COUNT(*) AS n, SUM(\`openCount\`) AS opens, SUM(\`clickCount\`) AS clicks
             FROM email_log${whereClause}
             GROUP BY status`,
            built.params,
        );
        // Every status, `total` over all of them (delivered and suppressed included).
        const deliveryOff = deliveryEventsUnavailable();
        const summary: any = {
            total: 0, sent: 0, delivered: 0, failed: 0, deferred: 0, bounced: 0, complained: 0, suppressed: 0,
            sending: 0, retrying: 0, retried: 0, unknown: 0, opens: 0, clicks: 0, fromDays: built.fromDays,
            deliveryEvents: deliveryOff === null, deliveryEventsReason: deliveryOff,
        };
        for (const r of rows || []) {
            summary[r.status] = Number(r.n);
            summary.total += Number(r.n) || 0;
            summary.opens += Number(r.opens) || 0;
            summary.clicks += Number(r.clicks) || 0;
        }
        // Stored as sent but not sent: still in flight, or no reply ever recorded (only rows since the event timeline began can be).
        const unsettledClause = ` WHERE ${[...built.where, UNSETTLED_SQL].join(' AND ')}`;
        const unsettled = await db.query(
            `SELECT SUM(CASE WHEN ${SENDING_SQL} THEN 1 ELSE 0 END) AS sending, SUM(CASE WHEN ${UNKNOWN_SQL} THEN 1 ELSE 0 END) AS \`noReply\`
             FROM email_log${unsettledClause}`,
            [sendingSince(now, dbType), ...unknownParams(now, timelineFrom, dbType), ...built.params, unsettledSince(now, timelineFrom, dbType)],
        );
        const noReply = Number(unsettled?.[0]?.noReply) || 0;
        summary.sending = Number(unsettled?.[0]?.sending) || 0;
        summary.sent = Math.max(0, summary.sent - summary.sending - noReply);
        // Refused attempts and those without a reply: failed for good, retrying, unknown or retried — read with each email's other attempts.
        const candidateClause = ` WHERE ${[...built.where, `(status IN ('failed', 'deferred') OR ${UNKNOWN_SQL})`].join(' AND ')}`;
        const candidates: any[] = (await db.query(
            `SELECT ${ATTEMPT_COLUMNS} FROM email_log${candidateClause} ORDER BY id DESC LIMIT ?`,
            [...built.params, ...unknownParams(now, timelineFrom, dbType), STATE_CANDIDATES],
        )) || [];
        const infos = await attemptInfosFor((sql, params) => db.query(sql, params), candidates, { now, timelineFrom, dbType });
        const read = { failed: 0, deferred: 0, sent: 0 };
        const states = { failed: 0, deferred: 0, retrying: 0, retried: 0, unknown: 0 };
        for (const r of candidates) {
            if (r.status === 'failed' || r.status === 'deferred' || r.status === 'sent') read[r.status as 'failed' | 'deferred' | 'sent']++;
            const state = infos.get(Number(r.id))?.state;
            if (state === 'failed' || state === 'deferred' || state === 'retrying' || state === 'retried' || state === 'unknown') states[state]++;
        }
        // Beyond the rows read (the newest STATE_CANDIDATES), the stored status stands, and a row without a reply stays unknown.
        summary.failed = states.failed + Math.max(0, summary.failed - read.failed);
        summary.deferred = states.deferred + Math.max(0, summary.deferred - read.deferred);
        summary.unknown = states.unknown + Math.max(0, noReply - read.sent);
        summary.retrying = states.retrying;
        summary.retried = states.retried;
        return res.json(summary);
    }

    /** Admin: per-template aggregates — open rate + CTR by `type`.
     * Drives the "By template" tab in the admin UI. */
    @Get('log/stats/by-template')
    async byTemplate(@Ctx() ctx: RequestContext, @Req() req: Request, @Res() res: Response) {
        if (!requireAdmin(ctx, res, false)) return;
        if (!hasPremiumAccess()) {
            return res.status(402).json(premiumFeatureError('vendure-plugin-email-tracking'));
        }
        const days = intParam((req.query as any).fromDays, 1, 365) ?? 30;
        // `sent`: accepted by the mail server (never a refused attempt); `failed`: failed for good, as the Failed card.
        return res.json({ days, types: await this.tracking.statsByTemplate(days, scopedChannel(ctx)) });
    }

    /** Admin: CSV export of the log with the same filters as the list view. */
    @Get('log/export.csv')
    async exportCsv(@Ctx() ctx: RequestContext, @Req() req: Request, @Res() res: Response) {
        if (!requireAdmin(ctx, res, false)) return;
        if (!hasPremiumAccess()) {
            return res.status(402).json(premiumFeatureError('vendure-plugin-email-tracking'));
        }
        const q = req.query as any;
        const built = this.buildLogFilter(ctx, q, await this.clock());
        if ('error' in built) return res.status(400).json({ error: built.error });
        // The list's rows (same filters, `state` included), with each one's state as the last column.
        const { rows, infos } = await this.selectLog(built, EXPORT_COLUMNS, EXPORT_ROWS, 0, EXPORT_ROWS, 'refused');
        // Cache-Control: private, no-store (requireAdmin): a CDN that caches .csv must never keep an export.
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="email-log-${new Date().toISOString().slice(0, 10)}.csv"`);
        // Formula-injection guard + quoting (csv.ts, shared with the order activity export).
        const esc = csvCell;
        const header = 'createdAt,type,recipient,subject,status,openCount,clickCount,customerId,orderCode,invoiceId,smtpMessageId,errorMessage,state\n';
        res.write(CSV_BOM + header);
        for (const r of rows) {
            res.write([
                esc(r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt),
                esc(r.type), esc(r.recipient), esc(r.subject), esc(r.status),
                esc(r.openCount), esc(r.clickCount), esc(r.customerId),
                esc(r.orderCode), esc(r.invoiceId),
                esc(r.smtpMessageId), esc(r.errorMessage),
                esc(infos.get(Number(r.id))?.state ?? r.status),
            ].join(',') + '\n');
        }
        return res.end();
    }

    /** Admin: full detail for one email including the opens and clicks JSON. Declared after the fixed
     *  `log/…` routes: Nest matches routes in declaration order, and `log/:id` would take `log/export.csv`. */
    @Get('log/:id')
    async logDetail(@Ctx() ctx: RequestContext, @Param('id') idParam: string, @Res() res: Response) {
        if (!requireAdmin(ctx, res, false)) return;
        // Digits only: `1.csv`, `1.pdf` or `1%2Fx.css` are not an email of the log (and must never answer
        // with one: a CDN that caches by extension would keep it).
        const id = /^\d{1,10}$/.test(String(idParam)) ? intParam(idParam, 1, 2147483647) : null;
        if (id === null) return res.status(404).json({ error: 'Not found' });
        const row = await this.connection.rawConnection.getRepository(EmailLog).findOne({ where: { id } });
        // Same channel scope as the list: a channel admin never reads another channel's email.
        const scope = scopedChannel(ctx);
        if (!row || (scope && Number(row.channelId) !== scope)) return res.status(404).json({ error: 'Not found' });
        let clicks: any[] = [];
        let opens: any[] = [];
        try { clicks = JSON.parse(row.clicksJson || '[]'); } catch {}
        try { opens = JSON.parse(row.opensJson || '[]'); } catch {}
        // Click history written before 0.16.0 kept raw URLs: never show a live reset or magic-link token.
        if (Array.isArray(clicks)) clicks = clicks.map(c => (c && typeof c.url === 'string' ? { ...c, url: redactSensitiveUrl(c.url) } : c));
        return res.json({ ...row, clicks, opens, clicksJson: undefined, opensJson: undefined });
    }

    /** Admin: list suppression entries. */
    @Get('suppression')
    async listSuppression(@Ctx() ctx: RequestContext, @Req() req: Request, @Res() res: Response) {
        if (!requireAdmin(ctx, res, false)) return;
        const take = Math.min(parseInt(String((req.query as any).take), 10) || 200, 1000);
        const recipient = (req.query as any).recipient;
        const rows = recipient
            ? await this.connection.rawConnection.getRepository(EmailSuppression).find({
                where: { recipient: String(recipient).toLowerCase() }, take,
            })
            : await this.connection.rawConnection.getRepository(EmailSuppression).find({
                order: { id: 'DESC' }, take,
            });
        return res.json({ items: rows, total: rows.length });
    }

    /** Admin: manually suppress a recipient (e.g. when the customer asks
     * to be removed). */
    @Post('suppression')
    async addSuppression(@Ctx() ctx: RequestContext, @Body() body: any, @Res() res: Response) {
        if (!requireAdmin(ctx, res, true)) return;
        const recipient = String(body?.recipient || '').trim().slice(0, 320);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) return res.status(400).json({ error: 'Valid recipient required' });
        const reason = String(body?.reason || 'manual');
        if (!['hard-bounce', 'complaint', 'manual', 'unsubscribe'].includes(reason)) return res.status(400).json({ error: 'reason must be hard-bounce, complaint, manual or unsubscribe' });
        const channelId = body?.channelId === undefined || body?.channelId === null || body?.channelId === '' ? undefined : intParam(body.channelId, 1, 2147483647);
        if (body?.channelId && channelId === null) return res.status(400).json({ error: 'channelId must be a positive integer' });
        const row = await this.tracking.addSuppression(
            recipient,
            reason,
            body?.note ? String(body.note).slice(0, 2000) : undefined,
            channelId ?? undefined,
        );
        // On the timeline too (unlinked; the address is only kept as a salted hash there).
        await this.tracking.recordAdminSuppression(recipient, reason, ctx.activeUserId != null ? String(ctx.activeUserId) : null, channelId ?? null);
        return res.json({ ok: true, row });
    }

    /** Admin: lift a suppression (recipient asked to be re-subscribed,
     * or it was a transient hard bounce). */
    @Delete('suppression/:recipient')
    async deleteSuppression(@Ctx() ctx: RequestContext, @Param('recipient') recipient: string, @Res() res: Response) {
        if (!requireAdmin(ctx, res, true)) return;
        const removed = await this.tracking.removeSuppression(recipient);
        return res.json({ ok: removed });
    }
}
