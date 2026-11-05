import { PermissionDefinition } from '@vendure/core';

/**
 * `ExportEmailEvidence` — the full (unredacted) order activity export:
 * every stored event column, provider payloads and full user agents
 * (`GET /email-track/orders/:orderId/activity.json?full=1`). Registered by
 * the plugin so it can be granted in Settings → Roles; SuperAdmin has it.
 */
export const exportEmailEvidencePermission = new PermissionDefinition({
    name: 'ExportEmailEvidence',
    description: 'Allows the full (unredacted) export of order email activity: every stored event column, provider payloads and full user agents',
});
