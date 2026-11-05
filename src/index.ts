/**
 * `@huloglobal/vendure-plugin-email-tracking` — public exports.
 *
 * Consumers wire the plugin into Vendure via `EmailTrackingPlugin.init()`,
 * pass `new TrackingEmailSender()` to the `@vendure/email-plugin`'s
 * `emailSender` option, and (optionally) inject `EmailTrackingService`
 * into their own custom controllers to send tracked emails outside the
 * email-plugin pipeline (e.g. ad-hoc transactional sends from plugin
 * code).
 */

export { EmailTrackingPlugin } from './plugin';
export { TrackingEmailSender } from './tracking-email-sender';
export { EmailTrackingService } from './email-tracking.service';
export { EmailLog, EmailLogStatus } from './email-log.entity';
export { EmailSuppression } from './email-suppression.entity';
export { EmailLink, EmailLinkType } from './email-link.entity';
export { EmailLinkService } from './email-link.service';
export { EmailTrackingPluginOptions, ProviderWebhookOptions } from './options';
export { parseEmailClient, ParsedClient } from './parse-ua';
// 0.16.0 — event timeline, order activity, provider webhooks, IP enrichment
export { EmailEvent } from './email-event.entity';
export { EmailEventService, RecordEventInput } from './email-event.service';
export { OrderActivityService, ActivitySummary } from './order-activity.service';
export { exportEmailEvidencePermission } from './permissions';
export { IpEnrichmentOptions, IpEnrichmentResult } from './ip-enrichment';
export { EmailEventType, EmailEventSource, EventClassification, STATUS_RANK, nextStatus } from './event-types';
export { TimelineItem, TimelineFilter } from './timeline';
