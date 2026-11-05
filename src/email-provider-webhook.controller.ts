import { Controller, Param, Post, Req, Res } from '@nestjs/common';
import { Logger } from '@vendure/core';
import { applySecurityHeaders } from '@huloglobal/vendure-licence-sdk';
import { generateKeyPairSync, KeyObject } from 'crypto';
import { Request, Response } from 'express';
import { EmailEventService } from './email-event.service';
import { EmailTrackingService } from './email-tracking.service';
import { PROVIDER_SLUGS, ProviderSlug } from './event-types';
import { getWebhookLimits, providerConfigured, realIp } from './http-helpers';
import { getOptions, hasPremiumAccess, ProviderWebhookOptions } from './options';
import { parseJsonBody } from './raw-body';
import { mapMailgun, mapPostmark, mapSendgrid, mapSes, ProviderEvent } from './webhook-mappers';
import {
    CertCache, CertFetcher, confirmSnsSubscription, defaultCertFetcher, parseSendgridKey, ReplayCache,
    verifyMailgunSignature, verifyPostmarkAuth, verifySendgridSignature, verifySnsMessage,
} from './webhook-verify';

const loggerCtx = 'EmailProviderWebhook';

let certFetcher: CertFetcher = defaultCertFetcher;
/** Test hook: serve SNS signing certificates from somewhere else (e.g. a self-signed one). */
export function setSnsCertFetcher(f: CertFetcher | null): void {
    certFetcher = f || defaultCertFetcher;
}

/** Throwaway credentials: an unconfigured provider runs the check a configured one would, against these. */
const DECOY_POSTMARK = { username: 'hulo-unconfigured', password: 'hulo-unconfigured' };
const DECOY_MAILGUN_KEY = 'hulo-unconfigured';

/**
 * `POST /email-track/webhook/:provider` — delivery events from Postmark,
 * SendGrid, Mailgun and Amazon SES (via SNS).
 *
 * - Unknown slug → 404. Provider not configured, or a bad signature /
 *   credential / stale or replayed Mailgun token / stale SendGrid or SNS
 *   timestamp / SNS topic not on the allowlist → 401 with an empty body and
 *   `Connection: close`, answered here (after the same body read) for every
 *   one of them: nothing says which providers are on. An unconfigured
 *   SendGrid, Postmark or Mailgun runs the same signature check against
 *   throwaway credentials first, so the check's cost does not tell either
 *   (an unconfigured SES has no topic list, so it stops where a configured
 *   one stops for a topic not on its list). The body middleware
 *   (`raw-body.ts`) answers 404, 429 and the body checks (415 / 413 / 408 /
 *   400) the same way for every known slug; the checks here repeat 404 and
 *   429. SendGrid and Postmark bodies are parsed here, only once verified.
 * - Rate limits per client IP (`providerWebhooks.rateLimit`): a rejected
 *   request (400 / 401 here, the body checks there) spends the address's
 *   failure allowance, which is checked before any body is read; a verified
 *   request spends only its provider's verified allowance (429 when used up,
 *   so the provider retries later). Junk never throttles real events.
 * - Accepted → 204. A provider retry of an event already recorded is a
 *   no-op (unique dedupe key). If the status or suppression update fails
 *   the event row is removed again and the answer is 500, so the provider's
 *   retry is processed in full.
 * - Bounces, complaints and bad-address drops are processed in every tier;
 *   delivered, deferred, unsubscribe and engagement events need premium.
 */
@Controller('email-track/webhook')
export class EmailProviderWebhookController {
    private readonly mailgunReplay = new ReplayCache();
    private readonly certCache = new CertCache();
    private sendgridKeySource: string | undefined;
    private sendgridKey: KeyObject | null = null;
    /** A P-256 key nobody holds the private half of (the decoy check of an unconfigured SendGrid). */
    private readonly decoySendgridKey: KeyObject = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey;
    private readonly decoyReplay = new ReplayCache(1);

    constructor(private events: EmailEventService, private tracking: EmailTrackingService) {}

    private sendgridPublicKey(key: string | undefined): KeyObject | null {
        if (key !== this.sendgridKeySource) {
            this.sendgridKeySource = key;
            this.sendgridKey = parseSendgridKey(key);
            if (key && !this.sendgridKey) Logger.warn('providerWebhooks.sendgrid.verificationKey is not a usable ECDSA P-256 public key — SendGrid events are refused', loggerCtx);
        }
        return this.sendgridKey;
    }

    /** The verification an unconfigured provider would run if it were configured, against throwaway credentials (result unused). */
    private decoyCheck(provider: ProviderSlug, req: Request, body: any): void {
        if (provider === 'sendgrid') {
            verifySendgridSignature(this.decoySendgridKey, req.headers['x-twilio-email-event-webhook-signature'] as string | undefined,
                req.headers['x-twilio-email-event-webhook-timestamp'] as string | undefined, (req as any).rawBody);
        } else if (provider === 'postmark') {
            verifyPostmarkAuth(req.headers.authorization as string | undefined, DECOY_POSTMARK);
        } else if (provider === 'mailgun') {
            verifyMailgunSignature(body?.signature, DECOY_MAILGUN_KEY, this.decoyReplay);
        }
    }

    @Post(':provider')
    async receive(@Param('provider') providerParam: string, @Req() req: Request, @Res() res: Response) {
        applySecurityHeaders(res, { strict: true });
        const provider = String(providerParam || '').toLowerCase() as ProviderSlug;
        if (!PROVIDER_SLUGS.includes(provider)) return res.status(404).end();
        const ip = realIp(req);
        const limits = getWebhookLimits();
        // The body middleware checks this before reading; repeated for a host that parsed the body first.
        if (!(req as any).huloRateChecked && limits.blocked(ip)) {
            res.setHeader('Retry-After', '60');
            res.setHeader('Connection', 'close');
            return res.status(429).end();
        }
        /** Every refusal looks the same (status, empty body, headers) and spends the failure allowance. */
        const refuse = (status: 400 | 401) => {
            limits.chargeFailure(ip);
            res.setHeader('Connection', 'close');
            return res.status(status).end();
        };
        /** Verified: this provider's own allowance for the address (429 → the provider retries later). */
        const overVerified = () => {
            if (limits.allowVerified(provider, ip)) return false;
            res.setHeader('Retry-After', '60');
            res.status(429).end();
            return true;
        };
        const cfg: ProviderWebhookOptions = getOptions().providerWebhooks || {};
        let body: any = (req as any).body;
        let invalidJson = !!(req as any).huloBodyInvalid;
        if (!providerConfigured(provider, cfg)) {
            this.decoyCheck(provider, req, body);
            return refuse(401);
        }
        /** SendGrid and Postmark bodies arrive as bytes only (`raw-body.ts`): parsed once the request is verified. */
        const parseVerified = () => {
            if (!(req as any).huloBodyDeferred) return;
            ({ body, invalid: invalidJson } = parseJsonBody((req as any).rawBody));
        };
        let events: ProviderEvent[] = [];
        let mailgunToken: string | null = null;

        switch (provider) {
            case 'postmark': {
                if (!verifyPostmarkAuth(req.headers.authorization as string | undefined, cfg.postmark)) return refuse(401);
                parseVerified();
                if (invalidJson) return refuse(400);
                if (overVerified()) return;
                events = mapPostmark(body);
                break;
            }
            case 'sendgrid': {
                const ok = verifySendgridSignature(
                    this.sendgridPublicKey(cfg.sendgrid?.verificationKey),
                    req.headers['x-twilio-email-event-webhook-signature'] as string | undefined,
                    req.headers['x-twilio-email-event-webhook-timestamp'] as string | undefined,
                    (req as any).rawBody,
                );
                if (!ok) return refuse(401);
                parseVerified();
                if (invalidJson) return refuse(400);
                if (overVerified()) return;
                events = mapSendgrid(body);
                break;
            }
            case 'mailgun': {
                const verdict = verifyMailgunSignature(body?.signature, cfg.mailgun?.signingKey, this.mailgunReplay);
                if (verdict !== 'ok') return refuse(401);
                // Over the allowance: answered before the token is reserved, so Mailgun's retry passes.
                if (overVerified()) return;
                // Reserve the token now, before any await: concurrent requests replaying
                // this signature with other event data see it as used. Released below if
                // processing fails, so Mailgun's retry goes through.
                mailgunToken = String(body.signature.token);
                this.mailgunReplay.add(mailgunToken);
                events = mapMailgun(body);
                break;
            }
            case 'ses': {
                const verdict = await verifySnsMessage(body, cfg.ses?.topicArns, { fetchCert: certFetcher, cache: this.certCache, client: ip });
                if (verdict !== 'ok') return refuse(401);
                if (overVerified()) return;
                if (body.Type === 'SubscriptionConfirmation') {
                    const r = await confirmSnsSubscription(body, cfg.ses?.autoConfirmSubscription);
                    if (r === 'manual') Logger.info(`SNS subscription to ${body.TopicArn} awaits confirmation — open its SubscribeURL to confirm: ${body.SubscribeURL}`, loggerCtx);
                    else if (r === 'confirmed') Logger.info(`SNS subscription to ${body.TopicArn} confirmed`, loggerCtx);
                    else Logger.warn(`SNS subscription to ${body.TopicArn} not confirmed (${r})`, loggerCtx);
                    return res.status(204).end();
                }
                if (body.Type === 'UnsubscribeConfirmation') {
                    Logger.info(`SNS: unsubscribed from ${body.TopicArn}`, loggerCtx);
                    return res.status(204).end();
                }
                let message: any = null;
                try { message = JSON.parse(String(body.Message)); } catch { message = null; }
                events = message ? mapSes(message, String(body.MessageId)) : [];
                break;
            }
        }

        const deps = {
            premium: hasPremiumAccess(),
            recordEngagement: !!cfg.recordEngagement,
            suppress: (recipient: string, reason: string, note: string, channelId?: number) =>
                this.tracking.addSuppression(recipient, reason, note, channelId),
        };
        let failed = 0;
        for (const ev of events) {
            try {
                await this.events.ingest(ev, deps);
            } catch (e: any) {
                failed++;
                Logger.warn(`${provider} ${ev.type} event not processed: ${e?.message}`, loggerCtx);
            }
        }
        if (failed) {
            if (mailgunToken) this.mailgunReplay.delete(mailgunToken);
            return res.status(500).end();
        }
        return res.status(204).end();
    }
}
