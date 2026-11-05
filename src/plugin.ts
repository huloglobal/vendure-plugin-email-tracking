import { Logger, PluginCommonModule, Type, VendurePlugin, TransactionalConnection } from '@vendure/core';
import { fingerprintPublicKey, Heartbeat, RevocationChecker, UpdateChecker, verifyLicence, warnIfIncompatibleVendure, LicenceStore, LicenceStatus, adapterFor } from '@huloglobal/vendure-licence-sdk';
import { EmailLog } from './email-log.entity';
import { EmailSuppression } from './email-suppression.entity';
import { EmailLink } from './email-link.entity';
import { EmailLinkService } from './email-link.service';
import { EmailTrackingService } from './email-tracking.service';
import { EmailTrackingController } from './email-tracking.controller';
import { TrackingEmailSender } from './tracking-email-sender';
import { EmailTrackingPluginOptions, setLicenceStatus, setOptions, startEvaluation, getLicenceStatus, stopEvaluation, getOptions, applyGeneratedSigningSecret, setStatsProvider, getStatsProvider, isDefaultIpSalt } from './options';
import { ensureStoredSecret } from './stored-secret';
import { EmailTrackingAdminResolver, emailTrackingAdminApiSchema } from './admin-api';
import { EmailEvent } from './email-event.entity';
import { EmailEventService } from './email-event.service';
import { OrderActivityService } from './order-activity.service';
import { OrderActivityController } from './order-activity.controller';
import { EmailProviderWebhookController } from './email-provider-webhook.controller';
import { exportEmailEvidencePermission } from './permissions';
import { bounceBodyMiddleware, providerWebhookBodyMiddleware } from './raw-body';
import { databaseClockSkewMinutes } from './db-clock';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const PKG_VERSION: string = require('../package.json').version;
const PKG_NAME = '@huloglobal/vendure-plugin-email-tracking';

// Public key embedded at build time. The matching private key lives on
// HULO's licence server and never leaves it. If you fork this plugin
// privately you must replace this constant with your own public key.
const HULO_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoLmNM5UljRqe71drM6lR
Ba5vXrLOcV3GAHkYvnVFQSqdE0avrge/jsD7WdA6x8qQFNRugxQcxDJa2l0+C+BH
SbU9TimGwhA1yusHHfuz9LAXks5IQ48+2e6Pulh7iThXPJUnIKqKZUN5HhL79aaK
vrZKIgSfVhwE5PMPXWZ+Ij5IRf74PLIUn1Er75qhBXlDJ4vF8y8/3owURNC1XiUB
DGElwV/LYNoqAQei4oixe4EAxPGvFi11pgHiGuRxuWckA88y6ZHLt6urfAY9sCkj
kF+2dc2yS3j7lD+SYAaV5LQYYjePP1CYvxCZ7HHRKqthHopxY1hsK2tBtni3f7/c
UwIDAQAB
-----END PUBLIC KEY-----`;

const PLUGIN_ID = 'vendure-plugin-email-tracking';

const SIGNING_SECRET_STORE_KEY = 'vendure-plugin-email-tracking:signing-secret';
const REVOCATION_URL = process.env.HULO_LICENCE_REVOCATION_URL
    || 'https://elite.charity/licence/revoked.json';

/**
 * `@huloglobal/vendure-plugin-email-tracking`
 *
 * Logs every transactional email a Vendure server sends — Vendure-plugin
 * sends (order confirmation, OTP, password reset, invoice, etc.) plus
 * any custom sends routed through the exposed `EmailTrackingService`.
 * Each row captures recipient, subject, links to the related order /
 * customer / invoice, the SMTP response, plus per-event opens + clicks
 * via a 1×1 tracking pixel and a click redirector.
 *
 * Add to your Vendure config:
 *
 * ```ts
 * import { EmailTrackingPlugin, TrackingEmailSender } from '@huloglobal/vendure-plugin-email-tracking';
 *
 * export const config: VendureConfig = {
 *   plugins: [
 *     EmailTrackingPlugin.init({
 *       publicBaseUrl: 'https://shop.example.com',
 *       licenceKey: process.env.HULO_LICENCE_KEY,
 *     }),
 *     EmailPlugin.init({
 *       // ... your existing email-plugin config ...
 *       emailSender: new TrackingEmailSender(),
 *     }),
 *   ],
 * };
 * ```
 *
 * Add the admin UI extension by including `EmailTrackingPlugin.uiExtensions`
 * in your `compileUiExtensions` config.
 */
@VendurePlugin({
    imports: [PluginCommonModule],
    providers: [EmailEventService, EmailTrackingService, EmailTrackingAdminResolver, EmailLinkService, OrderActivityService],
    // A host plugin that imports EmailTrackingPlugin injects these very instances.
    exports: [EmailTrackingService, EmailEventService, EmailLinkService, OrderActivityService],
    controllers: [EmailTrackingController, OrderActivityController, EmailProviderWebhookController],
    entities: [EmailLog, EmailSuppression, EmailLink, EmailEvent],
    compatibility: '^3.0.0',
    adminApiExtensions: {
        schema: emailTrackingAdminApiSchema,
        resolvers: [EmailTrackingAdminResolver],
    },
    configuration: config => {
        // Settings → Roles: the full (unredacted) order activity export.
        config.authOptions.customPermissions = [...(config.authOptions.customPermissions || []), exportEmailEvidencePermission];
        // Exact request bytes for the provider webhooks (SendGrid signs them)
        // and the bounce HMAC. Unknown slugs (404) and addresses over their
        // failure allowance (429) are answered before a byte is read; every
        // known slug, configured or not, then gets the same body checks.
        config.apiOptions.middleware = [
            ...(config.apiOptions.middleware || []),
            { route: '/email-track/webhook', handler: providerWebhookBodyMiddleware(), beforeListen: true },
            { route: '/email-track/bounce', handler: bounceBodyMiddleware(), beforeListen: true },
        ];
        return config;
    },
})
export class EmailTrackingPlugin {
    private static licenceHost = '';
    /** Key activated from the admin UI or installed by the purchase claim —
     *  the heartbeat reports its jti (not "unlicensed") so the licence
     *  server keeps the usage stats for the install. */
    private static runtimeLicenceKey: string | null = null;
    /** Key passed to `init()` (env / config). */
    private static initLicenceKey: string | undefined;

    /** The licence key currently in force, if any. */
    static currentLicenceKey(): string | null {
        return EmailTrackingPlugin.runtimeLicenceKey || EmailTrackingPlugin.initLicenceKey || null;
    }

    /** Verify + apply a licence key at runtime (admin-UI activation). */
    static activateRuntimeLicence(key: string): LicenceStatus {
        const status = verifyLicence({
            licenceKey: key, pluginId: PLUGIN_ID, host: EmailTrackingPlugin.licenceHost,
            publicKey: HULO_PUBLIC_KEY, revokedIds: EmailTrackingPlugin.revocation?.getRevokedIds(),
        });
        if (status.valid) {
            setLicenceStatus(status);
            EmailTrackingPlugin.runtimeLicenceKey = key;
            stopEvaluation();
        }
        return status;
    }

    /** Drop an admin-activated key: back to unlicensed + evaluation. */
    static deactivateRuntimeLicence(): void {
        setLicenceStatus({
            valid: false,
            message: 'No licence key configured. The plugin will run in unlicensed (degraded) mode.',
        } as LicenceStatus);
        EmailTrackingPlugin.runtimeLicenceKey = null;
        startEvaluation(PKG_NAME, PKG_VERSION);
    }

    constructor(private connection: TransactionalConnection) {}

    /** Resolve the per-install signing secret (server and worker read the
     *  same row) and apply an admin-activated licence key persisted in the DB. */
    async onApplicationBootstrap() {
        const query = (sql: string, params?: any[], o?: any) => adapterFor(this.connection.rawConnection).query(sql, params, o);
        const store = new LicenceStore(query);
        if (!getOptions().signingSecret) {
            const secret = await ensureStoredSecret(store, query, SIGNING_SECRET_STORE_KEY);
            if (secret) {
                applyGeneratedSigningSecret(secret);
                Logger.warn(`email-tracking: no signingSecret configured — tracking links are signed with a generated per-install secret stored in hulo_licence_store (${SIGNING_SECRET_STORE_KEY}). Set signingSecret to keep links in already-sent emails valid across reinstalls and database restores.`, PKG_NAME);
            } else {
                Logger.warn('email-tracking: no signingSecret configured and the licence store is unavailable — tracking links stay unsigned', PKG_NAME);
            }
        }
        const skew = await databaseClockSkewMinutes(sql => query(sql), String((this.connection.rawConnection.options as any)?.type || ''));
        if (skew !== null && Math.abs(skew) >= 2) {
            Logger.warn(`email-tracking: the database's clock reads ${skew > 0 ? '+' : ''}${skew} minutes from this process's (different time zones?) — times the database sets (order history, email_log.createdAt) and those this process sets (email_event) disagree by that much on the order timeline and the evidence report. Run Node and the database in the same time zone (UTC recommended).`, PKG_NAME);
        }
        if (isDefaultIpSalt()) {
            Logger.warn(`email-tracking: ipSalt is not set — the email_event hashes (IP, recipient) are keyed with the ${getOptions().signingSecret ? 'signing secret' : 'public default salt'}, and the IP hashes in email_log's open / click history use the public default salt, so they can be reversed by trying every address. Set ipSalt to a long random value.`, PKG_NAME);
        }
        if (getLicenceStatus()?.valid) return;
        try {
            await store.ensureTable();
            const stored = await store.load(PLUGIN_ID);
            if (stored) {
                const st = EmailTrackingPlugin.activateRuntimeLicence(stored);
                // eslint-disable-next-line no-console
                if (st.valid) console.log(`[${PKG_NAME}] licence restored from admin activation — ${st.message}`);
            }
        } catch { /* store failures never affect boot */ }
    }

    private static revocation: RevocationChecker | null = null;
    private static updateChecker: UpdateChecker | null = null;
    private static heartbeat: Heartbeat | null = null;

    /** Per-process snapshot of the latest update status — read by the
     * controller's `/status` endpoint and the admin UI banner. */
    static getUpdateChecker(): UpdateChecker | null { return EmailTrackingPlugin.updateChecker; }
    static getPackageVersion(): string { return PKG_VERSION; }
    static getPackageName(): string { return PKG_NAME; }
    static getPluginId(): string { return PLUGIN_ID; }

    /** Wire the 30-day usage stats (numbers only) into both the evaluation
     *  client and the heartbeat, so the licence server sees what the plugin
     *  did before and after purchase. Called by the service at init. */
    static setStatsProvider(fn: () => Promise<Record<string, number>>): void {
        setStatsProvider(fn);
        EmailTrackingPlugin.heartbeat?.setStatsProvider(fn);
    }

    static init(options: EmailTrackingPluginOptions): Type<EmailTrackingPlugin> {
        setOptions(options);
        EmailTrackingPlugin.initLicenceKey = options.licenceKey;

        // Warn if @vendure/core at runtime is outside the tested
        // range. Non-fatal — the plugin boots and works.
        warnIfIncompatibleVendure({
            pluginPackageName: PKG_NAME,
            pluginPackageVersion: PKG_VERSION,
            supportedRange: { min: '3.5.0', max: '4.0.0' },
        });

        // Start the revocation checker once; safe to call init() again
        // during hot reloads — `RevocationChecker.start()` is idempotent.
        if (!EmailTrackingPlugin.revocation) {
            EmailTrackingPlugin.revocation = new RevocationChecker(REVOCATION_URL);
            EmailTrackingPlugin.revocation.start();
        }
        if (!EmailTrackingPlugin.updateChecker) {
            EmailTrackingPlugin.updateChecker = new UpdateChecker(PKG_NAME, PKG_VERSION);
            EmailTrackingPlugin.updateChecker.start();
        }

        const host = (options.publicBaseUrl || '')
            .replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        EmailTrackingPlugin.licenceHost = host;
        const status = verifyLicence({
            licenceKey: options.licenceKey,
            pluginId: PLUGIN_ID,
            host,
            publicKey: HULO_PUBLIC_KEY,
            revokedIds: EmailTrackingPlugin.revocation.getRevokedIds(),
        });
        setLicenceStatus(status);

        if (!status.valid) {
            // Unlicensed: register the install (no premium is granted by this; the 14-day
            // evaluation; premium paths stay on until it expires.
            startEvaluation(PKG_NAME, PKG_VERSION);
            // eslint-disable-next-line no-console
            console.warn(
                `[@huloglobal/vendure-plugin-email-tracking] ${status.message}` +
                ` — Running in FREE tier: opens + clicks NOT recorded, suppression list NOT enforced at send, per-template stats + CSV export disabled, order email activity + evidence report disabled, provider delivered/deferred/unsubscribe and engagement events NOT recorded (bounces, complaints and drops still are). Buy a licence at https://elite.charity/licence/buy/${PLUGIN_ID}`,
            );
        }

        if (!EmailTrackingPlugin.heartbeat) {
            EmailTrackingPlugin.heartbeat = new Heartbeat({
                packageName: PKG_NAME,
                packageVersion: PKG_VERSION,
                licenceKey: options.licenceKey,
                // Live key: admin-activated / claim-installed keys replace the init one.
                licenceKeyProvider: () => EmailTrackingPlugin.currentLicenceKey(),
                publicKeyFingerprint: fingerprintPublicKey(HULO_PUBLIC_KEY),
                // Lazy: the service installs the real provider after bootstrap.
                statsProvider: () => getStatsProvider()?.() ?? {},
            });
            EmailTrackingPlugin.heartbeat.start();
        }

        return EmailTrackingPlugin;
    }

    static uiExtensions = {
        extensionPath: __dirname + '/../ui',
        ngModules: [
            {
                type: 'lazy' as const,
                route: 'email-log',
                ngModuleFileName: 'email-log.module.ts',
                ngModuleName: 'EmailLogModule',
            },
            {
                type: 'shared' as const,
                ngModuleFileName: 'email-log-nav.module.ts',
                ngModuleName: 'EmailLogNavModule',
            },
        ],
    };
}
