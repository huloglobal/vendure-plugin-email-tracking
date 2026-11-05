/**
 * Imported FIRST by the e2e spec: the licence SDK reads these at module load.
 * Points every licence-server call (evaluation, heartbeat, revocation) at a
 * local address nothing listens on, so a test run never registers with the
 * live HULO licence server. The evaluation client is fail-closed, so the
 * suite starts unlicensed; premium paths are switched on in-process with
 * `setLicenceStatus({ valid: true, … })`.
 */
const unreachable = process.env.EMAIL_TRACKING_E2E_LICENCE_STUB || 'http://127.0.0.1:3079';
process.env.HULO_LICENCE_EVAL_URL = `${unreachable}/licence/eval/register`;
process.env.HULO_LICENCE_HEARTBEAT_URL = `${unreachable}/licence/heartbeat`;
process.env.HULO_LICENCE_REVOCATION_URL = `${unreachable}/licence/revoked.json`;
process.env.HULO_HEARTBEAT_DISABLED = 'true';
process.env.HULO_SELF_UPDATE = 'off';

export const E2E_PORT = Number(process.env.EMAIL_TRACKING_E2E_PORT || 3060);
