import type { EmailLogStatus } from './email-log.entity';

/**
 * Normalised event vocabulary for the `email_event` timeline (0.16.0).
 *
 *   send outcomes   sent · failed · deferred · suppressed
 *   delivery        delivered · bounced (hard) · soft-bounce · complained ·
 *                   dropped (the provider refused or rejected it) · unsubscribed
 *   engagement      open · click
 */
export type EmailEventType =
    | 'sent'
    | 'failed'
    | 'deferred'
    | 'suppressed'
    | 'delivered'
    | 'bounced'
    | 'soft-bounce'
    | 'complained'
    | 'dropped'
    | 'unsubscribed'
    | 'open'
    | 'click';

export const EMAIL_EVENT_TYPES: readonly EmailEventType[] = [
    'sent', 'failed', 'deferred', 'suppressed', 'delivered', 'bounced', 'soft-bounce', 'complained', 'dropped',
    'unsubscribed', 'open', 'click',
];

/** Where an event came from. */
export type EmailEventSource =
    | 'smtp'            // our own send path (TrackingEmailSender / sendTracked)
    | 'pixel'           // the open pixel
    | 'redirect'        // the click redirector
    | 'bounce-webhook'  // the generic POST /email-track/bounce
    | 'postmark'
    | 'sendgrid'
    | 'mailgun'
    | 'ses'
    | 'admin';          // an administrator (manual suppression)

export type ProviderSlug = 'postmark' | 'sendgrid' | 'mailgun' | 'ses';
export const PROVIDER_SLUGS: readonly ProviderSlug[] = ['postmark', 'sendgrid', 'mailgun', 'ses'];

/**
 * Advisory, from the licence SDK's classifier — except `unverified`: an
 * open / click that came through a link without a signature (reason
 * `unsigned-token`). Anyone can produce one, so it is never classified as
 * human or machine.
 */
export type EventClassification = 'human_likely' | 'machine_likely' | 'unknown' | 'unverified';

/** The classification of an open / click through a bare (unsigned) id. */
export const UNVERIFIED: EventClassification = 'unverified';

/** The send-path outcomes (source `smtp`). */
export const SEND_OUTCOME_TYPES: readonly EmailEventType[] = ['sent', 'failed', 'deferred', 'suppressed'];

/**
 * Provider-reported types that are processed in every tier (they protect
 * the sender's reputation, like `/email-track/bounce` always has). Everything
 * else a provider reports (delivered, deferred, unsubscribed, opens, clicks)
 * needs premium access — the free-tier boot warning and `PREMIUM_FEATURES`
 * name them.
 */
export const FREE_PROVIDER_TYPES: readonly EmailEventType[] = ['bounced', 'soft-bounce', 'complained', 'dropped'];

/**
 * `email_log.status` precedence. A provider- or webhook-reported status only
 * replaces the current one when it ranks higher, so the final status never
 * moves backwards whatever order the events arrive in:
 *
 *   sent (0) < deferred (1) < delivered (2) < bounced (3) < complained (4) < failed (5) < suppressed (6)
 *
 * - `delivered` moves `sent` / `deferred` to `delivered`, never over
 *   bounced, complained or failed.
 * - a soft bounce / deferral (`deferred`) only replaces `sent`.
 * - a hard bounce replaces sent, deferred and delivered (a late
 *   asynchronous bounce after acceptance is real).
 * - a complaint replaces everything below it, including bounced.
 * - `failed` and `suppressed` are never overwritten by later events.
 *   `failed` comes from the send path (rejected at submit) and from a
 *   provider drop for a reason other than a bad address (unsubscribed
 *   address, spam content, a bad SMTPAPI header, quota): such a drop moves
 *   only `sent` / `deferred` to `failed` — see `statusChangeForEvent`.
 *   `suppressed` (never sent) comes from the send path only.
 */
export const STATUS_RANK: Record<EmailLogStatus, number> = {
    sent: 0,
    deferred: 1,
    delivered: 2,
    bounced: 3,
    complained: 4,
    failed: 5,
    suppressed: 6,
};

/** The status after applying `incoming` to `current` (unknown values rank lowest). */
export function nextStatus(current: string | null | undefined, incoming: EmailLogStatus): EmailLogStatus {
    const cur = (current || 'sent') as EmailLogStatus;
    return STATUS_RANK[incoming] > (STATUS_RANK[cur] ?? -1) ? incoming : cur;
}

/** Every status `incoming` may overwrite — the `status IN (…)` guard of the atomic update. */
export function statusesBelow(incoming: EmailLogStatus): EmailLogStatus[] {
    const r = STATUS_RANK[incoming];
    return (Object.keys(STATUS_RANK) as EmailLogStatus[]).filter(s => STATUS_RANK[s] < r);
}

/**
 * A status change: the status an event moves `email_log` to, and the
 * statuses it may replace — exactly the `status IN (…)` guard of the atomic
 * UPDATE (`EmailEventService.applyStatus`).
 */
export interface StatusChange {
    to: EmailLogStatus;
    from: EmailLogStatus[];
}

/** The precedence change towards `to`: it replaces every lower-ranked status. */
export function precedenceChange(to: EmailLogStatus): StatusChange {
    return { to, from: statusesBelow(to) };
}

/** The status after `change` is applied to `current` (what the guarded UPDATE does). */
export function applyStatusChange(current: string | null | undefined, change: StatusChange): string {
    const cur = current || 'sent';
    return (change.from as string[]).includes(cur) ? change.to : cur;
}

/**
 * The `email_log` status change a provider / webhook event makes (null: none).
 *
 * Every type follows the precedence (`precedenceChange`), except a drop for
 * a reason other than a bad address or a complaint: the provider refused to
 * send it (unsubscribed address, spam content, a bad SMTPAPI header, quota),
 * so it moves only `sent` / `deferred` to `failed` and never overwrites a
 * delivered, bounced or complained email.
 */
export function statusChangeForEvent(type: EmailEventType, suppress: string | null): StatusChange | null {
    switch (type) {
        case 'delivered': return precedenceChange('delivered');
        case 'bounced': return precedenceChange('bounced');
        case 'complained': return precedenceChange('complained');
        case 'soft-bounce':
        case 'deferred': return precedenceChange('deferred');
        case 'dropped':
            // Dropped for a bad address / complaint is bounce-equivalent.
            if (suppress === 'hard-bounce') return precedenceChange('bounced');
            if (suppress === 'complaint') return precedenceChange('complained');
            return { to: 'failed', from: ['sent', 'deferred'] };
        default: return null;
    }
}

/** The `email_log.status` a provider / webhook event moves the row towards (null: no change). */
export function statusForEvent(type: EmailEventType, suppress: string | null): EmailLogStatus | null {
    return statusChangeForEvent(type, suppress)?.to ?? null;
}

/** Human-readable label for an event type. */
export const EVENT_LABELS: Record<EmailEventType, string> = {
    sent: 'Email sent',
    failed: 'Send failed',
    deferred: 'Delivery deferred',
    suppressed: 'Send suppressed',
    delivered: 'Delivered',
    bounced: 'Hard bounce',
    'soft-bounce': 'Soft bounce',
    complained: 'Spam complaint',
    dropped: 'Dropped by provider',
    unsubscribed: 'Unsubscribed',
    open: 'Opened',
    click: 'Link clicked',
};

/** The key the outgoing correlation header carries for configured providers. */
export const CORRELATION_KEY = 'hulo-log-id';
