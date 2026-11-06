import { Permission, RequestContext } from '@vendure/core';
import { applySecurityHeaders, RateLimiter } from '@huloglobal/vendure-licence-sdk';
import { Request, Response } from 'express';
import { PROVIDER_SLUGS } from './event-types';
import { getOptions, hasPremiumAccess, ProviderWebhookOptions } from './options';
import { getRealIp } from './proxy-headers';

/** Process-wide rate limiter shared by the public endpoints (open, click,
 *  bounce, the evidence PDF), keyed `<route>|<ip>`. Sized by `rateLimit`.
 *  Provider webhooks have their own limits (`getWebhookLimits`). */
let limiter: RateLimiter | null = null;
export function getLimiter(): RateLimiter {
    if (!limiter) {
        const rl = getOptions().rateLimit || { capacity: 60, windowMs: 60_000 };
        limiter = new RateLimiter({ capacity: rl.capacity, windowMs: rl.windowMs });
    }
    return limiter;
}

export function realIp(req: Request): string | null {
    return getRealIp(req, getOptions().trustedIpHeaders || []);
}

/** Token buckets that can be checked without spending a token (the SDK limiter cannot). */
export class TokenBuckets {
    private readonly buckets = new Map<string, [number, number]>();
    constructor(private readonly capacity: number, private readonly windowMs: number, private readonly maxKeys = 10_000) {}

    private refill(key: string, now: number): number {
        const e = this.buckets.get(key);
        if (!e) return this.capacity;
        return Math.min(this.capacity, e[0] + (now - e[1]) * (this.capacity / this.windowMs));
    }

    /** True while `key` has a token left (nothing spent). */
    has(key: string, now = Date.now()): boolean {
        return this.refill(key, now) >= 1;
    }

    /** Spend a token; false (nothing spent) when none is left. */
    take(key: string, now = Date.now()): boolean {
        const tokens = this.refill(key, now);
        if (tokens < 1) return false;
        if (!this.buckets.has(key) && this.buckets.size >= this.maxKeys) {
            const oldest = this.buckets.keys().next().value;
            if (oldest !== undefined) this.buckets.delete(oldest);
        }
        this.buckets.delete(key); // re-insert: most recently used last
        this.buckets.set(key, [tokens - 1, now]);
        return true;
    }
}

/** Default per-IP allowance of verified provider requests (per provider). */
export const WEBHOOK_VERIFIED_DEFAULT = { capacity: 1200, windowMs: 60_000 };

/**
 * Rate limits of `POST /email-track/webhook/:provider`, per client IP
 * (`providerWebhooks.rateLimit`):
 *
 * - `failed` — requests that fail a body check or verification (400, 401,
 *   408, 413, 415) spend it; once an address has none left, its requests
 *   are answered 429 before their body is read. Default: `rateLimit`
 *   (60 per 60 s).
 * - `verified` — requests that pass verification spend it, per provider and
 *   address (default 1 200 per 60 s); a flood of junk never touches it, so
 *   it cannot throttle real bounce and complaint processing.
 */
export class WebhookLimits {
    private readonly failed: TokenBuckets;
    private readonly verified: TokenBuckets;
    constructor(failed: { capacity: number; windowMs: number }, verified: { capacity: number; windowMs: number }) {
        this.failed = new TokenBuckets(Math.max(1, failed.capacity), Math.max(1, failed.windowMs));
        this.verified = new TokenBuckets(Math.max(1, verified.capacity), Math.max(1, verified.windowMs));
    }
    /** The address has used up its failure allowance: answer 429 without reading the body. */
    blocked(ip: string | null): boolean {
        return !!ip && !this.failed.has(ip);
    }
    /** A rejected request (bad signature, unconfigured provider, bad body). */
    chargeFailure(ip: string | null): void {
        if (ip) this.failed.take(ip);
    }
    /** A verified request; false when this provider's allowance for the address is used up. */
    allowVerified(provider: string, ip: string | null): boolean {
        return !ip || this.verified.take(`${provider}|${ip}`);
    }
}

let webhookLimits: { key: string; limits: WebhookLimits } | null = null;
/** The process-wide webhook limits, rebuilt when their configuration changes. */
export function getWebhookLimits(): WebhookLimits {
    const o = getOptions();
    const failed = o.providerWebhooks?.rateLimit?.failed || o.rateLimit || { capacity: 60, windowMs: 60_000 };
    const verified = o.providerWebhooks?.rateLimit?.verified || WEBHOOK_VERIFIED_DEFAULT;
    const key = JSON.stringify([failed.capacity, failed.windowMs, verified.capacity, verified.windowMs]);
    if (!webhookLimits || webhookLimits.key !== key) webhookLimits = { key, limits: new WebhookLimits(failed, verified) };
    return webhookLimits.limits;
}

/** True when `slug`'s webhook has the credentials its verification needs (anything else answers 401). */
export function providerConfigured(slug: string, cfg: ProviderWebhookOptions | undefined = getOptions().providerWebhooks): boolean {
    const c = cfg || {};
    switch (slug) {
        case 'postmark': return !!(c.postmark?.username && c.postmark?.password);
        case 'sendgrid': return typeof c.sendgrid?.verificationKey === 'string' && !!c.sendgrid.verificationKey.trim();
        case 'mailgun': return !!c.mailgun?.signingKey;
        case 'ses': return Array.isArray(c.ses?.topicArns) && c.ses!.topicArns.some(Boolean);
        default: return false;
    }
}

/**
 * Why deliveries cannot be reported: no provider webhook is configured, or
 * the free tier, which does not record a provider's `delivered` events
 * (FREE_PROVIDER_TYPES). Null: they can be.
 */
export function deliveryEventsUnavailable(cfg: ProviderWebhookOptions | undefined = getOptions().providerWebhooks): 'no-webhook' | 'free-tier' | null {
    if (!PROVIDER_SLUGS.some(slug => providerConfigured(slug, cfg))) return 'no-webhook';
    return hasPremiumAccess() ? null : 'free-tier';
}

/** Deliveries can be reported: a provider webhook is configured and its delivery events are recorded. Without that, `delivered` is never known. */
export function deliveryEventsConfigured(cfg: ProviderWebhookOptions | undefined = getOptions().providerWebhooks): boolean {
    return deliveryEventsUnavailable(cfg) === null;
}

/** Bounded integer from a query/body value; null when it is not one. */
export function intParam(v: unknown, min: number, max: number): number | null {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

export function dateParam(v: unknown): Date | null {
    if (!v) return null;
    const d = new Date(String(v));
    return Number.isNaN(d.getTime()) ? null : d;
}

/** The channel an admin read is scoped to: null for the default channel (sees everything). */
export function scopedChannel(ctx: RequestContext): number | null {
    if (!ctx?.channelId) return null;
    if (ctx.channel?.code === '__default_channel__' || String(ctx.channelId) === '1') return null;
    return Number(ctx.channelId);
}

/**
 * Session + permission gate for the admin REST endpoints. `write`: false →
 * ReadCustomer, true → UpdateCustomer, 'ops' → SuperAdmin, 'order' → ReadOrder
 * AND ReadCustomer (order activity: Vendure's `userHasPermissions` is an OR,
 * so each permission is checked on its own).
 *
 * Every admin answer, refusals included, gets `Cache-Control: private,
 * no-store` — a CDN that caches by URL extension (Cloudflare caches `.csv`,
 * `.pdf`, `.js` …) must never keep an admin response and serve it to someone
 * else — and the licence SDK's security headers.
 */
export function requireAdmin(ctx: RequestContext, res: Response, write: boolean | 'ops' | 'order' = false): boolean {
    if (typeof (res as any)?.setHeader === 'function') {
        res.setHeader('Cache-Control', 'private, no-store');
        applySecurityHeaders(res);
    }
    if (!ctx?.activeUserId) {
        res.status(401).json({ error: 'Authentication required' });
        return false;
    }
    let ok: boolean;
    if (write === 'order') {
        ok = ctx.userHasPermissions([Permission.ReadOrder]) && ctx.userHasPermissions([Permission.ReadCustomer]);
    } else {
        const needed = write === 'ops' ? [Permission.SuperAdmin] : write ? [Permission.UpdateCustomer] : [Permission.ReadCustomer];
        ok = ctx.userHasPermissions(needed);
    }
    if (!ok) {
        res.status(403).json({ error: 'Insufficient permissions' });
        return false;
    }
    return true;
}
