import { DeepPartial, VendureEntity } from '@vendure/core';
import { Column, Entity, Index } from 'typeorm';

export type EmailLinkType =
    | 'invoice_view'
    | 'invoice_download'
    | 'order_view'
    | 'licence_view'
    | 'licence_setup'
    | 'product_page'
    | 'support'
    | 'support_ticket'
    | 'account_login'
    | 'password_reset'
    | 'payment'
    | 'refund'
    | 'terms'
    | 'privacy'
    | 'cookies'
    | 'unsubscribe'
    | 'preference_centre'
    | 'external'
    | 'other';

/**
 * One row per tracked link in a tracked email — lets the click
 * redirect identify EXACTLY which link was clicked rather than
 * merely "a link was clicked".
 *
 * Tokens are random non-guessable hex; they carry no order /
 * customer / email / licence-key data. The destination is stored
 * server-side (with a hash + redacted form) so we never need to
 * put it in a URL that a recipient's mail proxy or scanner can
 * read.
 *
 * Sensitive-link rule (callers MUST enforce):
 *   - `destinationUrlRedacted` MUST NOT contain raw licence keys,
 *     password-reset tokens or private invoice access tokens.
 *   - When `isSensitive` is true the click endpoint discards the
 *     raw destination from the recorded event and stores only the
 *     redacted form + the URL hash.
 */
@Entity({ name: 'email_link' })
@Index(['emailLogId'])
@Index(['linkToken'], { unique: true })
@Index(['orderId'])
@Index(['invoiceId'])
@Index(['linkType'])
@Index(['destinationUrlHost'])
@Index(['createdAt'])
export class EmailLink extends VendureEntity {
    constructor(input?: DeepPartial<EmailLink>) {
        super(input);
    }

    @Column({ type: 'int', nullable: true })
    emailLogId!: number | null;

    @Column({ type: 'int', nullable: true })
    orderId!: number | null;

    @Column({ type: 'int', nullable: true })
    invoiceId!: number | null;

    @Column({ type: 'int', nullable: true })
    customerId!: number | null;

    @Column({ type: 'int', nullable: true })
    supportTicketId!: number | null;

    /** Unique through the class-level `@Index(['linkToken'], { unique: true })`
     *  (IDX_d58a6a97b688ff39bf86a0f051). Not also `unique: true` here: on MySQL /
     *  MariaDB TypeORM gave both the same name, so a fresh `synchronize` failed. */
    @Column({ type: 'varchar', length: 64 })
    linkToken!: string;

    @Column({ type: 'int', default: 0 })
    linkIndex!: number;

    @Column({ type: 'varchar', length: 255, nullable: true })
    linkLabel!: string | null;

    @Column({ type: 'varchar', length: 512, nullable: true })
    linkText!: string | null;

    @Column({ type: 'varchar', length: 64, nullable: true })
    templateSection!: string | null;

    @Column({ type: 'varchar', length: 32 })
    linkType!: EmailLinkType;

    @Column({ type: 'text', nullable: true })
    destinationUrlRedacted!: string | null;

    @Column({ type: 'varchar', length: 255, nullable: true })
    destinationUrlHost!: string | null;

    @Column({ type: 'varchar', length: 512, nullable: true })
    destinationUrlPath!: string | null;

    @Column({ type: 'varchar', length: 64, nullable: true })
    destinationUrlHash!: string | null;

    @Column({ type: 'varchar', length: 64, nullable: true })
    signedDestinationToken!: string | null;

    @Column({ type: 'boolean', default: true })
    isTrackingEnabled!: boolean;

    @Column({ type: 'boolean', default: false })
    isSensitive!: boolean;

    @Column({ type: Date, precision: 3, nullable: true })
    expiresAt!: Date | null;
}
