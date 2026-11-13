import { describe, expect, it, vi } from 'vitest';

// TypeORM entities need emitted decorator metadata, which the test transform does not produce.
vi.mock('./email-log.entity', () => ({ EmailLog: class EmailLog {} }));
vi.mock('./email-suppression.entity', () => ({ EmailSuppression: class EmailSuppression {} }));
import {
    statsFromAggregate, digestStats, recentStatLines, buildSetupItems, tipsFromChecklist, PREMIUM_FEATURES, STAT_LABELS,
} from './email-tracking.service';

describe('statsFromAggregate', () => {
    it('maps the aggregate row to the licence-server keys (numbers only)', () => {
        const s = statsFromAggregate({ tracked: 200, opens: 340, clicks: 41, bounced: 3, opened: 120 });
        expect(s).toEqual({ emailsTracked: 200, emailOpens: 340, emailClicks: 41, emailsBounced: 3, openRatePct: 60 });
        for (const v of Object.values(s)) expect(typeof v).toBe('number');
    });

    it('is all zeros on an empty or failed aggregate and never divides by zero', () => {
        expect(statsFromAggregate(null)).toEqual({ emailsTracked: 0, emailOpens: 0, emailClicks: 0, emailsBounced: 0, openRatePct: 0 });
        expect(statsFromAggregate({ tracked: '0' as any, opened: 'x' as any })).toMatchObject({ emailsTracked: 0, openRatePct: 0 });
    });

    it('rounds the open rate to one decimal', () => {
        expect(statsFromAggregate({ tracked: 3, opened: 1 }).openRatePct).toBe(33.3);
    });
});

describe('digestStats / recentStatLines', () => {
    it('keeps the display order and carries the previous week', () => {
        const cur = statsFromAggregate({ tracked: 10, opens: 5, clicks: 2, bounced: 0, opened: 4 });
        const prev = statsFromAggregate({ tracked: 8, opens: 1, clicks: 0, bounced: 1, opened: 1 });
        const rows = digestStats(cur, prev);
        expect(rows.map(r => r.key)).toEqual(STAT_LABELS.map(l => l.key));
        expect(rows[0]).toMatchObject({ key: 'emailsTracked', value: 10, previous: 8, format: 'count' });
        expect(rows[4]).toMatchObject({ key: 'openRatePct', value: 40, previous: 12.5, format: 'percent' });
    });

    it('lists only the top three non-zero figures, formatted', () => {
        const lines = recentStatLines({ emailsTracked: 1234, emailOpens: 0, emailClicks: 7, emailsBounced: 2, openRatePct: 0 });
        expect(lines).toEqual([
            { label: 'emails tracked', value: '1,234' },
            { label: 'link clicks recorded', value: '7' },
            { label: 'bounces and complaints caught', value: '2' },
        ]);
        expect(recentStatLines({})).toEqual([]);
    });
});

describe('buildSetupItems', () => {
    it('is complete only when every real check passes', () => {
        const done = buildSetupItems({ hasRecentLog: true, publicBaseUrl: 'https://shop.example.com', bounceSecretConfigured: true, hasEngagement: true });
        expect(done.complete).toBe(true);
        expect(done.items.map(i => i.key)).toEqual(['sender', 'publicBaseUrl', 'bounceWebhook', 'engagement']);
    });

    it('treats localhost as an unset public base URL and flags the undone steps', () => {
        const list = buildSetupItems({ hasRecentLog: false, publicBaseUrl: 'http://localhost:3000', bounceSecretConfigured: false, hasEngagement: false });
        expect(list.complete).toBe(false);
        expect(list.items.every(i => !i.done)).toBe(true);
        expect(list.items[1].hint).toContain('publicBaseUrl');
        expect(buildSetupItems({ hasRecentLog: true, publicBaseUrl: 'http://127.0.0.1/', bounceSecretConfigured: true, hasEngagement: true }).items[1].done).toBe(false);
    });

    it('counts a configured provider webhook as the bounce feed', () => {
        const list = buildSetupItems({ hasRecentLog: true, publicBaseUrl: 'https://s.example', bounceSecretConfigured: false, providerWebhooksConfigured: true, hasEngagement: true });
        expect(list.items[2]).toMatchObject({ key: 'bounceWebhook', done: true });
        expect(list.items[2].hint).toContain('/email-track/webhook/:provider');
        expect(buildSetupItems({ hasRecentLog: true, publicBaseUrl: 'https://s.example', bounceSecretConfigured: false, hasEngagement: true }).items[2].done).toBe(false);
    });

    it('turns the undone items into at most three digest tips, in order', () => {
        const list = buildSetupItems({ hasRecentLog: false, publicBaseUrl: '', bounceSecretConfigured: false, hasEngagement: false });
        const tips = tipsFromChecklist(list, 'https://shop.example.com/admin/extensions/email-log');
        expect(tips).toHaveLength(3);
        expect(tips.map(t => t.title)).toEqual(['Email sender wrapped', 'Public base URL set', 'Bounce webhook secret configured']);
        expect(tips[0].url).toMatch(/^https:\/\/huloglobal\.com\//);
        const partial = buildSetupItems({ hasRecentLog: true, publicBaseUrl: 'https://s.example', bounceSecretConfigured: true, hasEngagement: false });
        expect(tipsFromChecklist(partial, null)).toEqual([expect.objectContaining({ title: 'First open or click recorded', url: undefined })]);
    });
});

describe('PREMIUM_FEATURES', () => {
    it('lists exactly the gated capabilities (0.17.0: opens, clicks and suppression are free; weekly report and checklist premium)', () => {
        expect(PREMIUM_FEATURES).toEqual([
            'Per-template open and click rates',
            'CSV export of the email log',
            'Order email activity timeline and PDF evidence report',
            'Provider delivery, deferral, unsubscribe and engagement events',
            'Weekly email report',
            'Setup checklist',
        ]);
        expect(PREMIUM_FEATURES.join(' ')).not.toMatch(/suppression|open and click tracking/i);
    });
});
