import { Body, Controller, Delete, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import { Ctx, Logger, Permission, RequestContext, TransactionalConnection } from '@vendure/core';
import {
    applySecurityHeaders,
    isLicensed,
    isUrlOnAllowlist,
    premiumFeatureError,
    RateLimiter,
    verifyHmacSha256,
    verifySignedValue, LicenceStore, performSelfUpdate, selfUpdateEnv, adapterFor, PurchaseClaimClient, evalInstanceId, describeLicence } from '@huloglobal/vendure-licence-sdk';
import { Request, Response } from 'express';
import { EmailLog } from './email-log.entity';
import { EmailSuppression } from './email-suppression.entity';
import { EmailTrackingService, PREMIUM_FEATURES, effectiveTier, recentStatLines } from './email-tracking.service';
import { EmailLinkService } from './email-link.service';
import { EmailTrackingPlugin } from './plugin';
import { getOptions, getLicenceStatus, hasPremiumAccess, getEvalState, getEvalInstanceId, configuredSigningSecret } from './options';

const loggerCtx = 'EmailTrackingController';

/** Hosts a legacy (unsigned) click token may redirect to: the shop itself plus any tracked hosts. */
function ownHosts(): string[] {
    const opts = getOptions();
    const out = new Set<string>();
    try { out.add(new URL(opts.publicBaseUrl || '').hostname.toLowerCase()); } catch { /* unset */ }
    for (const h of opts.trackedHosts || []) { const v = String(h).toLowerCase().replace(/^https?:\/\//, '').split('/')[0]; if (v) out.add(v); }
    for (const h of opts.clickRedirectAllowedDomains || []) { const v = String(h).toLowerCase().replace(/^\*\./, ''); if (v) out.add(v); }
    return [...out].filter(Boolean);
}

/** Process-wide rate limiter shared across all open / click / bounce
 *  requests. Sized to comfortably handle a normal store's traffic while
 *  blocking floods. Configurable via plugin options. */
let limiter: RateLimiter | null = null;
function getLimiter(): RateLimiter {
    if (!limiter) {
        const rl = getOptions().rateLimit || { capacity: 60, windowMs: 60_000 };
        limiter = new RateLimiter({ capacity: rl.capacity, windowMs: rl.windowMs });
    }
    return limiter;
}

// 1×1 transparent GIF (43 bytes) returned by the open-tracking endpoint.
const ONE_PX_GIF = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    'base64',
);

import { getRealIp } from './proxy-headers';
import { verifyClickSignature } from './click-signature';

const PLUGIN_ID_FOR_STORE = 'vendure-plugin-email-tracking';
function realIp(req: Request): string | null { return getRealIp(req, getOptions().trustedIpHeaders || []); }

/** Bounded integer from a query/body value; null when it is not one. */
function intParam(v: unknown, min: number, max: number): number | null {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : null;
}
function dateParam(v: unknown): Date | null {
    if (!v) return null;
    const d = new Date(String(v));
    return Number.isNaN(d.getTime()) ? null : d;
}
/** The channel an admin read is scoped to: null for the default channel (sees everything). */
function scopedChannel(ctx: RequestContext): number | null {
    if (!ctx?.channelId) return null;
    if (ctx.channel?.code === '__default_channel__' || String(ctx.channelId) === '1') return null;
    return Number(ctx.channelId);
}

function requireAdmin(ctx: RequestContext, res: Response, write: boolean | 'ops' = false): boolean {
    if (!ctx?.activeUserId) {
        res.status(401).json({ error: 'Authentication required' });
        return false;
    }
    // 'ops': self-update and licence changes affect the whole install.
    const needed = write === 'ops' ? [Permission.SuperAdmin] : write ? [Permission.UpdateCustomer] : [Permission.ReadCustomer];
    if (!ctx.userHasPermissions(needed)) {
        res.status(403).json({ error: 'Insufficient permissions' });
        return false;
    }
    return true;
}

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

    private licenceStore = new LicenceStore((sql: string, params?: any[]) => adapterFor(this.connection.rawConnection).query(sql, params));

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
        applySecurityHeaders(res);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
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

        const id = this.resolveSignedId(token);
        if (id !== null && hasPremiumAccess()) {
            // Open tracking is a paid feature. Unlicensed installs still
            // serve the pixel (so emails don't show a broken image) but
            // do not record the open.
            this.tracking.recordOpen(id, ip, req.headers['user-agent'] as string || null)
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
        const id = this.resolveSignedId(token);
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
            await this.tracking.recordClick(id, url, ip, req.headers['user-agent'] as string || null)
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
            await this.tracking.recordClick(Number(link.emailLogId), recorded, ip, req.headers['user-agent'] as string || null)
                .catch((e: any) => Logger.warn(`click log fail (link ${link.id}): ${e?.message}`, loggerCtx));
        }
        res.setHeader('Cache-Control', 'no-store');
        return res.redirect(302, url);
    }

    /**
     * Resolve a path parameter back to a numeric email-log id.
     *
     * If a `signingSecret` is configured, we expect a token of the form
     * `<id>.<hmac>`. If no secret is configured, we accept a bare
     * numeric id (legacy behaviour) — but still parse strictly so a
     * malicious caller can't slip a path traversal in.
     */
    private resolveSignedId(raw: string): number | null {
        if (!raw) return null;
        const secret = getOptions().signingSecret;
        if (secret && raw.includes('.')) {
            const value = verifySignedValue(raw, secret);
            if (!value || !/^\d{1,12}$/.test(value)) return null;
            const id = parseInt(value, 10);
            return id > 0 ? id : null;
        }
        // Bare id: only the exact decimal form ("12abc" and 64-hex link tokens are not ids).
        if (!/^\d{1,12}$/.test(raw)) return null;
        const id = parseInt(raw, 10);
        return id > 0 ? id : null;
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
        if (bounceIp && !getLimiter().allow(`bounce|${bounceIp}`)) {
            res.setHeader('Retry-After', '60');
            return res.status(429).json({ error: 'Too many requests' });
        }
        if (secret) {
            const sig = (req.headers['x-signature'] as string)
                || (req.headers['x-hub-signature-256'] as string)
                || '';
            // Use rawBody if available; otherwise reconstruct from the
            // parsed body. Vendure mounts `express.json()` globally so
            // rawBody isn't preserved by default — recommend wiring it
            // for /email-track/bounce specifically. The reconstructed
            // form is consistent enough for HMAC if the sender uses
            // canonical JSON.
            const payload = (req as any).rawBody
                ? (req as any).rawBody
                : Buffer.from(JSON.stringify(body || {}));
            if (!verifyHmacSha256(payload, sig, secret)) {
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
     * orderCode, status, type, recipient, and a date range.
     *
     * GET /email-track/log?customerId=&orderId=&status=&take=
     */
    /** Validated WHERE for the log list and export (400 on a bad value); non-default channels only see their own rows. */
    private buildLogFilter(ctx: RequestContext, q: any): { where: string[]; params: any[] } | { error: string } {
        const where: string[] = [];
        const params: any[] = [];
        const int = (name: string, col: string) => {
            if (q[name] === undefined || q[name] === '') return true;
            const n = intParam(q[name], 1, 2147483647);
            if (n === null) return false;
            where.push(`\`${col}\` = ?`); params.push(n); return true;
        };
        if (!int('customerId', 'customerId') || !int('orderId', 'orderId') || !int('invoiceId', 'invoiceId')) return { error: 'ids must be positive integers' };
        if (q.orderCode) { where.push('\`orderCode\` = ?'); params.push(String(q.orderCode).slice(0, 64)); }
        if (q.status) { where.push('status = ?'); params.push(String(q.status).slice(0, 32)); }
        if (q.type) { where.push('type = ?'); params.push(String(q.type).slice(0, 64)); }
        if (q.recipient) { where.push('recipient LIKE ?'); params.push(`%${String(q.recipient).slice(0, 190).replace(/[\\%_]/g, m => '\\' + m)}%`); }
        if (q.from) { const d = dateParam(q.from); if (!d) return { error: 'from is not a date' }; where.push('\`createdAt\` >= ?'); params.push(d); }
        if (q.to) { const d = dateParam(q.to); if (!d) return { error: 'to is not a date' }; where.push('\`createdAt\` <= ?'); params.push(d); }
        const scope = scopedChannel(ctx);
        if (scope) { where.push('\`channelId\` = ?'); params.push(scope); }
        return { where, params };
    }

    @Get('log')
    async listLog(@Ctx() ctx: RequestContext, @Req() req: Request, @Res() res: Response) {
        if (!requireAdmin(ctx, res, false)) return;
        const q = req.query as any;
        const take = intParam(q.take, 1, 500) ?? 100;
        const skip = intParam(q.skip, 0, 10_000_000) ?? 0;
        const built = this.buildLogFilter(ctx, q);
        if ('error' in built) return res.status(400).json({ error: built.error });
        const { where, params } = built;

        const whereClause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
        // Backticks: email_log is a TypeORM entity table, so its camelCase columns are quoted on Postgres.
        const rows = await adapterFor(this.connection.rawConnection).query(
            `SELECT id, \`createdAt\`, type, recipient, subject, status,
                    \`customerId\`, \`orderId\`, \`orderCode\`, \`invoiceId\`, \`applicationId\`,
                    \`channelId\`, \`openCount\`, \`firstOpenedAt\`, \`lastOpenedAt\`,
                    \`clickCount\`, \`firstClickedAt\`, \`smtpResponse\`, \`errorMessage\`
             FROM email_log
             ${whereClause}
             ORDER BY id DESC
             LIMIT ? OFFSET ?`,
            [...params, take, skip],
        );
        const [{ total }] = await adapterFor(this.connection.rawConnection).query(
            `SELECT COUNT(*) AS total FROM email_log${whereClause}`, params,
        );
        return res.json({ items: rows, total: Number(total) || 0, take, skip });
    }

    /** Admin: aggregate counts by status for a quick dashboard tile. */
    @Get('log/summary')
    async logSummary(@Ctx() ctx: RequestContext, @Req() req: Request, @Res() res: Response) {
        if (!requireAdmin(ctx, res, false)) return;
        const fromDays = intParam((req.query as any).fromDays, 1, 365) ?? 30;
        const scope = scopedChannel(ctx);
        const rows = await adapterFor(this.connection.rawConnection).query(
            `SELECT status, COUNT(*) AS n, SUM(\`openCount\`) AS opens, SUM(\`clickCount\`) AS clicks
             FROM email_log
             WHERE \`createdAt\` >= DATE_SUB(NOW(), INTERVAL ? DAY)${scope ? ' AND \`channelId\` = ?' : ''}
             GROUP BY status`,
            scope ? [fromDays, scope] : [fromDays],
        );
        const summary: any = { sent: 0, failed: 0, deferred: 0, bounced: 0, complained: 0, opens: 0, clicks: 0, fromDays };
        for (const r of rows) {
            summary[r.status] = Number(r.n);
            summary.opens += Number(r.opens) || 0;
            summary.clicks += Number(r.clicks) || 0;
        }
        return res.json(summary);
    }

    /** Admin: full detail for one event including the clicks JSON. */
    @Get('log/:id')
    async logDetail(@Ctx() ctx: RequestContext, @Param('id') idParam: string, @Res() res: Response) {
        if (!requireAdmin(ctx, res, false)) return;
        const id = parseInt(idParam, 10);
        if (!id) return res.status(400).json({ error: 'Invalid id' });
        const row = await this.connection.rawConnection.getRepository(EmailLog).findOne({ where: { id } });
        // Same channel scope as the list: a channel admin never reads another channel's email.
        const scope = scopedChannel(ctx);
        if (!row || (scope && Number(row.channelId) !== scope)) return res.status(404).json({ error: 'Not found' });
        let clicks: any[] = [];
        let opens: any[] = [];
        try { clicks = JSON.parse(row.clicksJson || '[]'); } catch {}
        try { opens = JSON.parse(row.opensJson || '[]'); } catch {}
        return res.json({ ...row, clicks, opens, clicksJson: undefined, opensJson: undefined });
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
        const scope = scopedChannel(ctx);
        const rows = await adapterFor(this.connection.rawConnection).query(
            `SELECT type,
                    COUNT(*)                                                                AS sent,
                    SUM(CASE WHEN \`openCount\` > 0 THEN 1 ELSE 0 END)                       AS opened,
                    SUM(CASE WHEN \`clickCount\` > 0 THEN 1 ELSE 0 END)                      AS clicked,
                    SUM(CASE WHEN status='bounced' OR status='complained' THEN 1 ELSE 0 END) AS bounced,
                    SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END)                        AS failed,
                    SUM(CASE WHEN status='suppressed' THEN 1 ELSE 0 END)                    AS suppressed,
                    SUM(\`openCount\`)                                                       AS totalOpens,
                    SUM(\`clickCount\`)                                                      AS totalClicks
             FROM email_log
             WHERE \`createdAt\` >= DATE_SUB(NOW(), INTERVAL ? DAY)${scope ? ' AND \`channelId\` = ?' : ''}
             GROUP BY type
             ORDER BY sent DESC`,
            scope ? [days, scope] : [days],
        );
        return res.json({ days, types: rows.map((r: any) => ({
            ...r,
            openRate: r.sent > 0 ? (r.opened / r.sent) : 0,
            clickRate: r.sent > 0 ? (r.clicked / r.sent) : 0,
            ctor: r.opened > 0 ? (r.clicked / r.opened) : 0, // click-to-open
        })) });
    }

    /** Admin: CSV export of the log with the same filters as the list view. */
    @Get('log/export.csv')
    async exportCsv(@Ctx() ctx: RequestContext, @Req() req: Request, @Res() res: Response) {
        if (!requireAdmin(ctx, res, false)) return;
        if (!hasPremiumAccess()) {
            return res.status(402).json(premiumFeatureError('vendure-plugin-email-tracking'));
        }
        const q = req.query as any;
        const built = this.buildLogFilter(ctx, q);
        if ('error' in built) return res.status(400).json({ error: built.error });
        const { where, params } = built;
        const whereClause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
        const rows = await adapterFor(this.connection.rawConnection).query(
            `SELECT \`createdAt\`, type, recipient, subject, status,
                    \`openCount\`, \`clickCount\`, \`customerId\`, \`orderCode\`, \`invoiceId\`,
                    \`smtpMessageId\`, \`errorMessage\`
             FROM email_log ${whereClause}
             ORDER BY id DESC LIMIT 50000`,
            params,
        );
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="email-log-${new Date().toISOString().slice(0, 10)}.csv"`);
        const esc = (v: any): string => {
            if (v === null || v === undefined) return '';
            let s = String(v);
            // A cell starting with = + - @ (or a tab/CR) would run as a formula in Excel/Sheets.
            if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
            s = s.replace(/"/g, '""');
            return /[",\n]/.test(s) ? `"${s}"` : s;
        };
        const header = 'createdAt,type,recipient,subject,status,openCount,clickCount,customerId,orderCode,invoiceId,smtpMessageId,errorMessage\n';
        res.write(header);
        for (const r of rows) {
            res.write([
                esc(r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt),
                esc(r.type), esc(r.recipient), esc(r.subject), esc(r.status),
                esc(r.openCount), esc(r.clickCount), esc(r.customerId),
                esc(r.orderCode), esc(r.invoiceId),
                esc(r.smtpMessageId), esc(r.errorMessage),
            ].join(',') + '\n');
        }
        return res.end();
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
