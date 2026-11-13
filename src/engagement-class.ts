import { classifyEmailEvent } from '@huloglobal/vendure-licence-sdk';
import { inRanges } from './tracking-settings';

/**
 * The advisory human / machine classification of an open or a click
 * (0.17.0), and whether it counts in the email's opens or clicks — the same
 * rules as the WordPress plugin:
 *
 * - the licence SDK's classifier (mail proxies, security gateways, bots,
 *   headless browsers, scanners, prefetch);
 * - plus Apple's own network (17.0.0.0/8), where Mail Privacy Protection
 *   fetches every image as the message arrives: an open from there gets the
 *   `apple-network` and `ampp` reasons and is machine traffic.
 *
 * Machine traffic is still recorded on the timeline (and the click still
 * redirects), but it is not counted in `openCount` / `clickCount` (nor
 * first-open / first-click): `email_log.machineCount` counts it instead.
 * Opens whose only strong machine signal is an image proxy that loads
 * images when the recipient opens the message (Gmail, Yahoo Mail, Outlook)
 * still count: the open itself is real.
 */
export const APPLE_NETWORK = ['17.0.0.0/8'];

export const OPEN_PROXIES: readonly string[] = ['gmail-proxy', 'yahoo-mail-proxy', 'outlook-proxy'];

/** The SDK's strong machine reasons, plus `ampp` from Apple's network. */
export const STRONG_MACHINE: readonly string[] = [
    'gmail-proxy', 'ampp', 'safelinks', 'proofpoint', 'mimecast', 'barracuda', 'forcepoint', 'symantec', 'cloudmark',
    'trend-micro', 'fireeye', 'inky', 'spam-filter', 'bot-ua', 'headless', 'cli-ua', 'scanner-ua',
    'tor', 'known-scanner', 'datacentre', 'high-risk-ip',
];

export interface EngagementClass {
    classification: 'human_likely' | 'machine_likely' | 'unknown';
    reasons: string[];
}

export function classifyEngagement(kind: 'open' | 'click', userAgent: string | null | undefined, ip: string | null | undefined, extra: Partial<Parameters<typeof classifyEmailEvent>[0]> = {}): EngagementClass {
    const cls = classifyEmailEvent({ ...extra, userAgent: userAgent || null, eventType: kind === 'open' ? 'email_open' : 'email_click' });
    const reasons = [...cls.reasons];
    let classification = cls.classification as EngagementClass['classification'];
    if (ip && inRanges(ip, APPLE_NETWORK)) {
        if (!reasons.includes('apple-network')) reasons.push('apple-network');
        if (kind === 'open') {
            if (!reasons.includes('ampp')) reasons.push('ampp');
            classification = 'machine_likely';
        }
    }
    return { classification, reasons };
}

/** Whether an open / click with this classification counts in the email's counters. */
export function engagementCounts(kind: 'open' | 'click', c: EngagementClass): boolean {
    if (c.classification !== 'machine_likely') return true;
    if (kind !== 'open') return false;
    const strong = c.reasons.filter(r => STRONG_MACHINE.includes(r) || OPEN_PROXIES.includes(r));
    return strong.length > 0 && strong.every(r => OPEN_PROXIES.includes(r));
}
