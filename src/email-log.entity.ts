import { DeepPartial, VendureEntity } from '@vendure/core';
import { Column, Entity, Index } from 'typeorm';

export type EmailLogStatus =
    | 'sent'        // SMTP accepted (250)
    | 'failed'      // SMTP rejected at submit-time (4xx/5xx) or threw
    | 'deferred'    // Temporary failure (4xx)
    | 'delivered'   // A provider webhook reported delivery to the receiving server (0.16.0)
    | 'bounced'     // Permanent failure (later)
    | 'complained'  // Recipient marked as spam (later)
    | 'suppressed'; // Refused at send-time because the recipient is on the suppression list

/**
 * One row per outgoing email. Captures send metadata + engagement:
 *   - Send: who, what, when, related order/invoice/customer/application,
 *           SMTP response, smtpMessageId.
 *   - Opens: first and last timestamp, count, the IP + UA of the first
 *            open (most useful — subsequent opens are usually the same
 *            recipient or a privacy-protection prefetch).
 *   - Clicks: JSON array of click events with url + ts + ip + ua.
 *
 * The tracking pixel and click-redirect endpoints live at
 *   /email-track/open/:id.gif  and  /email-track/click/:id?u=<encoded>.
 */
@Entity()
@Index('IDX_email_log_created', ['createdAt'])
@Index('IDX_email_log_status_created', ['status', 'createdAt'])
@Index('IDX_email_log_type_created', ['type', 'createdAt'])
export class EmailLog extends VendureEntity {
    constructor(input?: DeepPartial<EmailLog>) {
        super(input);
    }

    /** Logical email type: 'welcome', 'order-confirmation', 'invoice',
     * 'credit-chase', 'credit-chase-T-7', 'payment-terms-invite',
     * 'fraud-alert', 'gdpr-notice', 'newsletter-welcome', 'quote-request',
     * 'otp-code', 'password-reset', 'email-verification', etc. */
    @Index()
    @Column()
    type!: string;

    @Index()
    @Column()
    recipient!: string;

    @Column({ type: 'varchar', length: 512 })
    subject!: string;

    /** Optional FROM display, captured for the audit. */
    @Column({ nullable: true, length: 512 })
    fromAddress!: string;

    /** BCC (almost always sales@). Captured for completeness. */
    @Column({ nullable: true, length: 512 })
    bcc!: string;

    /** Reply-To override (e.g. quote-request emails reply-to the buyer). */
    @Column({ nullable: true, length: 512 })
    replyTo!: string;

    /** Free-text context, e.g. the chase stage 'T-7' / 'due' / 'T+14'. */
    @Column({ nullable: true })
    context!: string;

    @Column({ type: 'int', default: 1 })
    channelId!: number;

    // Cross-references — populated only when the email relates to one.
    @Index()
    @Column({ nullable: true })
    customerId!: number;

    @Index()
    @Column({ nullable: true })
    orderId!: number;

    @Index()
    @Column({ nullable: true })
    orderCode!: string;

    @Column({ nullable: true })
    invoiceId!: number;

    @Column({ nullable: true })
    applicationId!: number;

    // SMTP response — what Gmail / the relay said when we submitted.
    @Index()
    @Column({ type: 'varchar', default: 'sent' })
    status!: EmailLogStatus;

    @Column({ nullable: true, length: 512 })
    smtpResponse!: string;

    @Index()
    @Column({ nullable: true, length: 512 })
    smtpMessageId!: string;

    @Column({ type: 'text', nullable: true })
    errorMessage!: string;

    // Engagement.
    @Column({ type: 'int', default: 0 })
    openCount!: number;

    @Column({ type: Date, nullable: true })
    firstOpenedAt!: Date;

    @Column({ type: Date, nullable: true })
    lastOpenedAt!: Date;

    @Column({ nullable: true })
    firstOpenIp!: string;

    @Column({ type: 'text', nullable: true })
    firstOpenUserAgent!: string;

    /** JSON-encoded array of { ts, ip, ua }, mirroring clicksJson. Capped
     * at the most recent 50; older opens live as openCount only. */
    @Column({ type: 'text', nullable: true })
    opensJson!: string;

    @Column({ type: 'int', default: 0 })
    clickCount!: number;

    /** JSON-encoded array of { url, ts, ip, ua }. Capped to a sensible
     * size; older clicks beyond the cap are summarised numerically. */
    @Column({ type: 'text', nullable: true })
    clicksJson!: string;

    @Column({ type: Date, nullable: true })
    firstClickedAt!: Date;

    /**
     * Opens and clicks classified as machine traffic (0.17.0: security
     * scanners, link checkers, Apple Mail Privacy Protection, bots): recorded
     * on the event timeline but not counted in `openCount` / `clickCount`.
     */
    @Column({ type: 'int', default: 0 })
    machineCount!: number;

    /** Whether the email was sent via our "tracked" pipeline at all.
     * Always true for emails created by the service; left as a guard
     * for any future direct-insert tooling. */
    @Column({ type: 'boolean', default: true })
    tracked!: boolean;
}
