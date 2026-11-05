import { describe, expect, it } from 'vitest';
import { applyStatusChange, nextStatus, precedenceChange, STATUS_RANK, statusChangeForEvent, statusesBelow, statusForEvent } from './event-types';

describe('email_log status precedence', () => {
    it('delivered moves sent and deferred to delivered, never over bounced, complained or failed', () => {
        expect(nextStatus('sent', 'delivered')).toBe('delivered');
        expect(nextStatus('deferred', 'delivered')).toBe('delivered');
        expect(nextStatus('bounced', 'delivered')).toBe('bounced');
        expect(nextStatus('complained', 'delivered')).toBe('complained');
        expect(nextStatus('failed', 'delivered')).toBe('failed');
        expect(nextStatus('suppressed', 'delivered')).toBe('suppressed');
    });

    it('a soft bounce / deferral only replaces sent', () => {
        expect(nextStatus('sent', 'deferred')).toBe('deferred');
        expect(nextStatus('delivered', 'deferred')).toBe('delivered');
        expect(nextStatus('bounced', 'deferred')).toBe('bounced');
    });

    it('a hard bounce replaces delivered (late asynchronous bounce) but not a complaint', () => {
        expect(nextStatus('delivered', 'bounced')).toBe('bounced');
        expect(nextStatus('deferred', 'bounced')).toBe('bounced');
        expect(nextStatus('complained', 'bounced')).toBe('complained');
        expect(nextStatus('bounced', 'complained')).toBe('complained');
    });

    it('is order-independent: any arrival order of the same events ends on the highest rank', () => {
        const events = ['deferred', 'delivered', 'bounced', 'complained'] as const;
        const perms = [[0, 1, 2, 3], [3, 2, 1, 0], [1, 3, 0, 2], [2, 0, 3, 1]];
        for (const p of perms) {
            const end = p.reduce<string>((s, i) => nextStatus(s, events[i]), 'sent');
            expect(end).toBe('complained');
        }
    });

    it('treats an unknown current value as lowest', () => {
        expect(nextStatus('weird', 'deferred')).toBe('deferred');
        expect(nextStatus(null, 'delivered')).toBe('delivered');
    });

    it('statusesBelow is exactly the set the atomic UPDATE may overwrite', () => {
        expect(statusesBelow('delivered').sort()).toEqual(['deferred', 'sent']);
        expect(statusesBelow('deferred')).toEqual(['sent']);
        expect(statusesBelow('complained').sort()).toEqual(['bounced', 'deferred', 'delivered', 'sent']);
        expect(statusesBelow('sent')).toEqual([]);
        for (const s of statusesBelow('bounced')) expect(STATUS_RANK[s]).toBeLessThan(STATUS_RANK.bounced);
    });

    it('maps provider event types to the status they move towards', () => {
        expect(statusForEvent('delivered', null)).toBe('delivered');
        expect(statusForEvent('soft-bounce', null)).toBe('deferred');
        expect(statusForEvent('bounced', 'hard-bounce')).toBe('bounced');
        expect(statusForEvent('complained', 'complaint')).toBe('complained');
        expect(statusForEvent('dropped', 'hard-bounce')).toBe('bounced');
        expect(statusForEvent('dropped', 'complaint')).toBe('complained');
        expect(statusForEvent('dropped', null)).toBe('failed');
        expect(statusForEvent('open', null)).toBeNull();
        expect(statusForEvent('unsubscribed', null)).toBeNull();
    });

    it('precedenceChange applied to any current status always equals nextStatus (no truncated guard)', () => {
        const all = Object.keys(STATUS_RANK) as Array<keyof typeof STATUS_RANK>;
        for (const incoming of all) for (const current of all) {
            expect(applyStatusChange(current, precedenceChange(incoming)), `${current} + ${incoming}`).toBe(nextStatus(current, incoming));
        }
        expect(precedenceChange('failed').from).toEqual(['sent', 'deferred', 'delivered', 'bounced', 'complained']);
    });

    it('a drop for a reason other than a bad address moves only sent / deferred to failed', () => {
        const drop = statusChangeForEvent('dropped', null)!;
        expect(drop).toEqual({ to: 'failed', from: ['sent', 'deferred'] });
        expect(applyStatusChange('sent', drop)).toBe('failed');
        expect(applyStatusChange('deferred', drop)).toBe('failed');
        for (const kept of ['delivered', 'bounced', 'complained', 'suppressed', 'failed']) expect(applyStatusChange(kept, drop)).toBe(kept);
        // SendGrid spamreport, then dropped "Unsubscribed Address": still complained.
        expect(applyStatusChange(applyStatusChange('sent', statusChangeForEvent('complained', 'complaint')!), drop)).toBe('complained');
        expect(statusChangeForEvent('dropped', 'hard-bounce')).toEqual(precedenceChange('bounced'));
    });
});
