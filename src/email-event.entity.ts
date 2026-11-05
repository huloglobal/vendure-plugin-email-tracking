import { DeepPartial, VendureEntity } from '@vendure/core';
import { Column, Entity, Index } from 'typeorm';
import { EmailEventSource, EmailEventType, EventClassification } from './event-types';

/**
 * One row per email event (0.16.0) — the audit trail behind the order
 * activity timeline and the evidence report.
 *
 * Raw events are never deduplicated: every pixel fetch and every click is
 * its own row, up to `ENGAGEMENT_EVENTS_PER_DAY` opens and as many clicks
 * per email per UTC day (`UNSIGNED_EVENTS_PER_DAY` through bare ids), after
 * which one marker row stands for the rest of that day. The only other
 * exception is provider-retry idempotency — webhook events carry a
 * `dedupeKey` (SHA-256 of the provider's event id) under a unique index, so
 * a provider re-delivering the same event is ignored.
 *
 * The links (`emailLogId`, `orderId`, `customerId`, `channelId`) are copied
 * from the `email_log` row at insert time. A verified provider event that
 * matches no email is still recorded, unlinked, with `recipientHash`.
 *
 * Personal data: IPs follow `hashIpsInHistory` exactly as `email_log` does
 * (raw or hashed in `ip`; `ipHash` always hashed); the recipient is never
 * stored here in clear (`recipientHash` is a salted HMAC; email addresses in
 * `detail` and `payload` text are replaced by `<address>`, and a URL whose
 * query holds one is stored redacted); `payload` holds a small sanitised
 * subset of a provider's fields and never a message body.
 *
 * Retention: the sweeper prunes rows by their own age with the same `days`
 * as `email_log` (at least 3), so an open recorded after its email was sent
 * outlives that email's row until it is itself `days` old (it then shows
 * without its email type); under `maxRows`, the events of the emails it
 * removes go with them, and so do unlinked events older than the oldest
 * email kept.
 */
@Entity({ name: 'email_event' })
@Index('IDX_email_event_order', ['orderId', 'occurredAt'])
@Index('IDX_email_event_log', ['emailLogId', 'occurredAt'])
@Index('IDX_email_event_provider_message', ['providerMessageId'])
@Index('IDX_email_event_created', ['createdAt'])
@Index('UQ_email_event_dedupe', ['dedupeKey'], { unique: true })
export class EmailEvent extends VendureEntity {
    constructor(input?: DeepPartial<EmailEvent>) {
        super(input);
    }

    // ── Links (copied from email_log at insert time) ──────────────────
    @Column({ type: 'int', nullable: true })
    emailLogId!: number | null;

    @Column({ type: 'int', nullable: true })
    orderId!: number | null;

    @Column({ type: 'int', nullable: true })
    customerId!: number | null;

    @Column({ type: 'int', nullable: true })
    channelId!: number | null;

    // ── What, where from, when ─────────────────────────────────────────
    @Column({ type: 'varchar', length: 32 })
    type!: EmailEventType;

    @Column({ type: 'varchar', length: 32 })
    source!: EmailEventSource;

    @Column({ type: Date, precision: 3 })
    occurredAt!: Date;

    /** RFC 5322 Message-ID, without angle brackets. */
    @Column({ type: 'varchar', length: 255, nullable: true })
    messageId!: string | null;

    /** The provider's own id: from the SMTP reply on `sent` rows (SES `250 Ok <id>`,
     *  `queued as <id>`), or the id a webhook reported. */
    @Column({ type: 'varchar', length: 255, nullable: true })
    providerMessageId!: string | null;

    /** SHA-256 hex of the provider event identity; unique, NULL for first-party events. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    dedupeKey!: string | null;

    /** Salted HMAC of the lower-cased recipient address. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    recipientHash!: string | null;

    // ── Network ───────────────────────────────────────────────────────
    /** Raw or hashed per `hashIpsInHistory`. */
    @Column({ type: 'varchar', length: 64, nullable: true })
    ip!: string | null;

    @Column({ type: 'varchar', length: 64, nullable: true })
    ipHash!: string | null;

    /** Approximate location: local GeoLite2 first, else the enrichment provider. */
    @Column({ type: 'varchar', length: 8, nullable: true })
    country!: string | null;

    @Column({ type: 'varchar', length: 64, nullable: true })
    region!: string | null;

    @Column({ type: 'varchar', length: 128, nullable: true })
    city!: string | null;

    @Column({ type: 'varchar', length: 64, nullable: true })
    timezone!: string | null;

    // ── IP enrichment (opt-in, written asynchronously) ──────────────────
    @Column({ type: 'varchar', length: 16, nullable: true })
    asn!: string | null;

    @Column({ type: 'varchar', length: 255, nullable: true })
    org!: string | null;

    @Column({ type: 'boolean', nullable: true })
    isProxy!: boolean | null;

    @Column({ type: 'boolean', nullable: true })
    isVpn!: boolean | null;

    @Column({ type: 'boolean', nullable: true })
    isTor!: boolean | null;

    /** Datacentre / hosting network. */
    @Column({ type: 'boolean', nullable: true })
    isHosting!: boolean | null;

    @Column({ type: 'boolean', nullable: true })
    isMobile!: boolean | null;

    @Column({ type: 'varchar', length: 32, nullable: true })
    enrichedBy!: string | null;

    @Column({ type: Date, precision: 3, nullable: true })
    enrichedAt!: Date | null;

    // ── Client ────────────────────────────────────────────────────────
    /** Truncated to 1 000 characters. */
    @Column({ type: 'text', nullable: true })
    userAgent!: string | null;

    @Column({ type: 'varchar', length: 64, nullable: true })
    client!: string | null;

    @Column({ type: 'varchar', length: 32, nullable: true })
    platform!: string | null;

    @Column({ type: 'boolean', nullable: true })
    isBot!: boolean | null;

    /** Opens and clicks only: human_likely | machine_likely | unknown (advisory), or
     *  unverified for a hit through a bare (unsigned) id; null on a cap marker row. */
    @Column({ type: 'varchar', length: 16, nullable: true })
    classification!: EventClassification | null;

    /** Comma-separated reason codes (gmail-proxy, safelinks, datacentre, vpn, bot-ua, unsigned-token,
     *  events-capped on the one marker row of a day an email reached its cap, …). */
    @Column({ type: 'varchar', length: 255, nullable: true })
    classificationReasons!: string | null;

    // ── Clicks ────────────────────────────────────────────────────────
    /** The clicked destination; sensitive links in their redacted form. */
    @Column({ type: 'text', nullable: true })
    url!: string | null;

    @Column({ type: 'int', nullable: true })
    linkIndex!: number | null;

    @Column({ type: 'varchar', length: 128, nullable: true })
    linkText!: string | null;

    // ── Detail ────────────────────────────────────────────────────────
    /** Bounce reason, SMTP reply, provider status line, admin note. */
    @Column({ type: 'text', nullable: true })
    detail!: string | null;

    /** Small sanitised JSON: selected provider fields (truncated), link metadata
     *  on `sent` rows. Never a message body. */
    @Column({ type: 'text', nullable: true })
    payload!: string | null;
}
