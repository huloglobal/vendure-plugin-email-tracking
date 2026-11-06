import { Injectable } from '@nestjs/common';
import { ConfigService, HistoryService, Logger, Order, OrderService, RequestContext, TransactionalConnection, User } from '@vendure/core';
import { adapterFor } from '@huloglobal/vendure-licence-sdk';
import { Brackets } from 'typeorm';
import { EmailEvent } from './email-event.entity';
import { EmailLog } from './email-log.entity';
import { deliveryEventsConfigured } from './http-helpers';
import { AttemptInfo, attemptStates, sendClock, TimelineStart, timeOf } from './send-attempts';
import {
    decodeCursor, eventIdOfKey, eventItem, eventTypesForFilter, formatMoney, historyItem, legacyItems, LogEventStats,
    matchesFilter, pageOf, PaymentInfo, SortKey, sortKeyOf, compareKeys, compareItems, TimelineFilter, TimelineItem, toIso, withAttempt,
} from './timeline';

const loggerCtx = 'OrderActivityService';

/** Shown next to every IP-derived location, in the UI, the exports and the PDF. */
export const LOCATION_CAUTION =
    'IP-derived location is approximate. It can show a mail provider\'s image proxy, a VPN, a corporate gateway or a security '
    + 'scanner rather than the recipient. Do not rely on it alone for any decision.';

/** Hard cap on the items one export or report collects. */
export const EXPORT_MAX_ITEMS = 10_000;
/** History entries read per order. */
const HISTORY_MAX = 2_000;

/**
 * The page size for `HistoryService.getHistoryForOrder`: at most 100, and
 * never above the list limit Vendure enforces for the request's API type
 * (`adminListQueryLimit` for the admin API, `shopListQueryLimit` otherwise —
 * these REST routes run as a custom API), which throws when `take` is over it.
 */
export function historyPageSize(apiType: string | undefined, apiOptions: { shopListQueryLimit?: number; adminListQueryLimit?: number } | undefined): number {
    const limit = Number(apiType === 'admin' ? apiOptions?.adminListQueryLimit : apiOptions?.shopListQueryLimit);
    return Number.isFinite(limit) && limit >= 1 ? Math.min(100, Math.floor(limit)) : 100;
}

export interface ActivitySummary {
    order: {
        id: number; code: string; state: string; placedAt: string | null;
        total: number; currencyCode: string; totalFormatted: string;
        paymentState: string; customerEmail: string | null; customerName: string | null;
    };
    /**
     * Counted per email: a retried email counts once, by its latest attempt (send-attempts.ts). `attempts`: every
     * email_log row. `sent`: accepted by the mail server. `delivered`: reported by a provider webhook — never known
     * without one (`deliveryEvents`). `sending`: no reply from the mail server yet. `retrying`: refused for the time
     * being, the retry is due. `deferred`: put off by the mail server (a 4xx reply) or, after accepting it, by the
     * receiving server. `unknown`: no reply was ever recorded (the send was cut off). `failed`: refused for good, or
     * every retry failed. `suppressed`: not sent, the recipient is on the suppression list.
     */
    emails: {
        total: number; attempts: number; sent: number; delivered: number; sending: number; retrying: number; deferred: number; unknown: number;
        failed: number; suppressed: number; opened: number; firstOpenAt: string | null; clicked: number; bounced: number;
    };
    /** `recorded` is the email_log counter (hits through bare ids never move it while a signing
     *  secret exists); the classified figures count events, and `unverified` events — through a
     *  link without a signature — are counted only in `unsigned`. */
    opens: { recorded: number; human: number; machine: number; unknown: number; unsigned: number };
    clicks: { recorded: number; human: number; machine: number; unknown: number; unsigned: number };
    /** Vendure's order history could not be read (the timeline then has email rows only). */
    historyUnavailable: boolean;
    /** Deliveries can be reported: a provider webhook is configured and its delivery events are recorded (not the free tier). */
    deliveryEvents: boolean;
}

interface ActivityContext {
    order: Order;
    payments: PaymentInfo[];
    history: TimelineItem[];
    /** The order history could not be loaded: shown in the JSON (`historyUnavailable`) and on the PDF. */
    historyUnavailable: boolean;
    legacy: TimelineItem[];
    logs: EmailLog[];
    stats: Map<number, LogEventStats & { delivered: number }>;
    emailInfo: Map<number, { id: number; type: string | null; subject: string | null }>;
    /** How each email_log row's send went, read with the order's other attempts. */
    attempts: Map<number, AttemptInfo>;
}

/**
 * Builds an order's activity timeline by merging three sources:
 * `email_event` rows for the order, items read from its `email_log` rows
 * (emails sent before 0.16.0, marked legacy, and sends still in flight or
 * cut off) and Vendure's own order history (state, payment, fulfilment,
 * refund, cancellation, modification, coupon and note entries — private
 * notes included, for admins). Send items are told with how their attempt
 * ended (send-attempts.ts): "Sending…", "Deferred, retrying", "Sent after 1
 * retry", "No reply recorded".
 */
@Injectable()
export class OrderActivityService {
    constructor(
        private connection: TransactionalConnection,
        private orderService: OrderService,
        private historyService: HistoryService,
        private configService: ConfigService,
    ) {}

    /** Decimal places of the host's money amounts (`MoneyStrategy.precision`, Vendure 2.2+; default 2). */
    private moneyPrecision(): number {
        const p = Number((this.configService?.entityOptions?.moneyStrategy as any)?.precision);
        return Number.isInteger(p) && p >= 0 && p <= 8 ? p : 2;
    }

    /** The order when the admin's active channel can see it (else undefined → 404). */
    findOrder(ctx: RequestContext, orderId: number): Promise<Order | undefined> {
        return this.orderService.findOne(ctx, orderId, ['customer', 'payments', 'payments.refunds', 'channels']);
    }

    /** Unscoped read for the signed evidence link (the link itself authorises the order). */
    async findOrderById(ctx: RequestContext, orderId: number): Promise<Order | undefined> {
        const o = await this.connection.getRepository(ctx, Order).findOne({
            where: { id: orderId },
            relations: ['customer', 'payments', 'payments.refunds', 'channels'],
        });
        return o || undefined;
    }

    /** `identifier` of the user who minted an evidence link. */
    async userIdentifier(ctx: RequestContext, userId: string): Promise<string> {
        try {
            const u = await this.connection.getRepository(ctx, User).findOne({ where: { id: userId } });
            return u?.identifier ? `${u.identifier} (user #${userId})` : `user #${userId}`;
        } catch {
            return `user #${userId}`;
        }
    }

    private async loadHistory(ctx: RequestContext, orderId: number): Promise<{ rows: any[]; failed: boolean }> {
        const out: any[] = [];
        const take = historyPageSize(ctx?.apiType, this.configService?.apiOptions);
        try {
            for (let skip = 0; skip < HISTORY_MAX; skip += take) {
                const page = await this.historyService.getHistoryForOrder(ctx, orderId, false, {
                    take, skip, sort: { createdAt: 'ASC' as any },
                } as any);
                out.push(...page.items);
                if (out.length >= page.totalItems || page.items.length < take) break;
            }
        } catch (e: any) {
            Logger.warn(`order history not loaded for order ${orderId}: ${e?.message}`, loggerCtx);
            return { rows: out, failed: true };
        }
        return { rows: out, failed: false };
    }

    /**
     * When the event timeline began on this install (null: no send event yet,
     * or no `email_event` table). Emails created before it are the legacy
     * ones; a later email without a send event is still in flight, was cut
     * off, or its event could not be written — never "sent before 0.16.0".
     */
    private readonly timeline = new TimelineStart();

    private async loadLogStats(orderId: number): Promise<Map<number, LogEventStats & { delivered: number }>> {
        const map = new Map<number, LogEventStats & { delivered: number }>();
        try {
            const rows: any[] = await adapterFor(this.connection.rawConnection).query(
                `SELECT \`emailLogId\`, MIN(\`occurredAt\`) AS firstAt,
                        SUM(CASE WHEN source = 'smtp' THEN 1 ELSE 0 END) AS sends,
                        SUM(CASE WHEN source <> 'smtp' AND type IN ('delivered', 'bounced', 'soft-bounce', 'complained', 'deferred', 'dropped') THEN 1 ELSE 0 END) AS statuses,
                        SUM(CASE WHEN type = 'delivered' THEN 1 ELSE 0 END) AS delivered
                 FROM email_event
                 WHERE \`orderId\` = ? AND \`emailLogId\` IS NOT NULL
                 GROUP BY \`emailLogId\``,
                [orderId],
            );
            for (const r of rows || []) {
                map.set(Number(r.emailLogId), {
                    firstAt: toIso(r.firstAt),
                    hasSend: Number(r.sends) > 0,
                    hasStatus: Number(r.statuses) > 0,
                    delivered: Number(r.delivered) || 0,
                });
            }
        } catch (e: any) {
            Logger.verbose(`email_event stats unavailable for order ${orderId}: ${e?.message}`, loggerCtx);
        }
        return map;
    }

    private async loadContext(ctx: RequestContext, order: Order, full: boolean): Promise<ActivityContext> {
        const orderId = Number(order.id);
        const db = adapterFor(this.connection.rawConnection);
        const dbType = String((this.connection.rawConnection.options as any)?.type || '');
        const [historyResult, logs, stats, clock] = await Promise.all([
            this.loadHistory(ctx, orderId),
            this.connection.rawConnection.getRepository(EmailLog).find({ where: { orderId }, order: { id: 'ASC' } as any, take: 1000 }),
            this.loadLogStats(orderId),
            // The database's "now": it wrote createdAt / updatedAt.
            sendClock((sql, params) => db.query(sql, params), dbType, this.timeline),
        ]);
        const { timelineFrom } = clock;
        const payments: PaymentInfo[] = (order.payments || []).map((p: any) => ({
            id: String(p.id), amount: Number(p.amount) || 0, method: String(p.method || ''), state: String(p.state || ''),
            refunds: (p.refunds || []).map((r: any) => ({ id: String(r.id), total: Number(r.total) || 0, reason: r.reason ?? null })),
        }));
        const precision = this.moneyPrecision();
        const history = historyResult.rows.map(h => historyItem(h, payments, order.currencyCode, full, precision));
        // An order's emails are all its attempts: retries are linked among them. A send event settles a missing reply.
        const attempts = attemptStates(logs, clock.now, { recorded: id => !!stats.get(id)?.hasSend, timelineFrom });
        const legacy = logs.flatMap(l => {
            const attempt = attempts.get(Number(l.id));
            // Legacy only when the row predates the event timeline; a send in flight never is.
            const old = attempt?.state !== 'sending' && (timelineFrom === null || (timeOf(l.createdAt) ?? 0) < timelineFrom);
            return legacyItems(l, stats.get(Number(l.id)), full, { legacy: old, attempt });
        });
        const emailInfo = new Map(logs.map(l => [Number(l.id), { id: Number(l.id), type: l.type ?? null, subject: l.subject ?? null }]));
        return { order, payments, history, historyUnavailable: historyResult.failed, legacy, logs, stats, emailInfo, attempts };
    }

    /** `email_event` rows for the order past the cursor (keyset), at most `limit`. */
    private async eventRows(orderId: number, types: string[] | null, cursor: SortKey | null, limit: number, order: 'asc' | 'desc'): Promise<any[]> {
        if (types && !types.length) return [];
        try {
            const asc = order === 'asc';
            const qb = this.connection.rawConnection.getRepository(EmailEvent).createQueryBuilder('e')
                .where('e.orderId = :orderId', { orderId });
            if (types) qb.andWhere('e.type IN (:...types)', { types });
            if (cursor) {
                const at = new Date(cursor.t);
                if (cursor.r < 2) {
                    // The cursor is a history / legacy item: events at the same instant sort after it.
                    qb.andWhere(asc ? 'e.occurredAt >= :at' : 'e.occurredAt < :at', { at });
                } else {
                    const cid = eventIdOfKey(cursor.k) ?? 0;
                    qb.andWhere(new Brackets(w => {
                        w.where(asc ? 'e.occurredAt > :at' : 'e.occurredAt < :at', { at })
                            .orWhere(new Brackets(w2 => {
                                w2.where('e.occurredAt = :at', { at }).andWhere(asc ? 'e.id > :cid' : 'e.id < :cid', { cid });
                            }));
                    }));
                }
            }
            return await qb.orderBy('e.occurredAt', asc ? 'ASC' : 'DESC').addOrderBy('e.id', asc ? 'ASC' : 'DESC').take(limit).getMany();
        } catch (e: any) {
            Logger.verbose(`email_event rows unavailable for order ${orderId}: ${e?.message}`, loggerCtx);
            return [];
        }
    }

    private async eventCount(orderId: number, types: string[] | null): Promise<number> {
        if (types && !types.length) return 0;
        try {
            const qb = this.connection.rawConnection.getRepository(EmailEvent).createQueryBuilder('e').where('e.orderId = :orderId', { orderId });
            if (types) qb.andWhere('e.type IN (:...types)', { types });
            return await qb.getCount();
        } catch {
            return 0;
        }
    }

    /** One page of the timeline (cursor pagination, `take` ≤ 500). */
    async page(ctx: RequestContext, order: Order, opts: { filter: TimelineFilter; cursor?: string | null; take: number; order: 'asc' | 'desc'; full?: boolean }) {
        const full = !!opts.full;
        const c = await this.loadContext(ctx, order, full);
        const cursor = decodeCursor(opts.cursor);
        const types = eventTypesForFilter(opts.filter);
        const orderId = Number(order.id);
        const rows = await this.eventRows(orderId, types, cursor, opts.take + 1, opts.order);
        const events = rows.map(r => withAttempt(eventItem(r, c.emailInfo.get(Number(r.emailLogId)), full), c.attempts.get(Number(r.emailLogId))));
        const others = [...c.history, ...c.legacy].filter(i => matchesFilter(i, opts.filter));
        const result = pageOf([...events, ...others], cursor, opts.take, opts.order);
        const total = others.length + await this.eventCount(orderId, types);
        return { ...result, total, context: c };
    }

    /** Every item (oldest first) for exports and the report, capped at EXPORT_MAX_ITEMS. */
    async allItems(ctx: RequestContext, order: Order, filter: TimelineFilter, full: boolean):
        Promise<{ items: TimelineItem[]; truncated: boolean; context: ActivityContext }> {
        const c = await this.loadContext(ctx, order, full);
        const rows = await this.eventRows(Number(order.id), eventTypesForFilter(filter), null, EXPORT_MAX_ITEMS + 1, 'asc');
        const events = rows.map(r => withAttempt(eventItem(r, c.emailInfo.get(Number(r.emailLogId)), full), c.attempts.get(Number(r.emailLogId))));
        const truncated = rows.length > EXPORT_MAX_ITEMS;
        const all = [...events.slice(0, EXPORT_MAX_ITEMS), ...c.history, ...c.legacy].filter(i => matchesFilter(i, filter));
        all.sort(compareItems);
        if (truncated) {
            // Keep everything up to the last event we loaded, so the cut is chronological.
            const lastKey = sortKeyOf(events[EXPORT_MAX_ITEMS - 1]);
            return { items: all.filter(i => compareKeys(sortKeyOf(i), lastKey) <= 0), truncated, context: c };
        }
        return { items: all, truncated, context: c };
    }

    /**
     * Header figures: the order, its emails, and human / machine opens and
     * clicks. Emails are counted once each, by their latest attempt (a
     * retried email is one email): accepted by the mail server, sending,
     * retrying, deferred, no reply recorded, failed, suppressed; delivered as
     * a provider webhook reported it. The opened / first open / clicked /
     * recorded figures come from the `email_log` counters, which hits through
     * bare (unsigned) ids never move while a signing secret exists (the
     * evidence report needs one); those hits are counted only in `unsigned`.
     * Cap marker rows are not opens or clicks and are not counted.
     */
    async summary(order: Order, c: ActivityContext): Promise<ActivitySummary> {
        const logs = c.logs;
        const classes = { open: { human: 0, machine: 0, unknown: 0, unsigned: 0 }, click: { human: 0, machine: 0, unknown: 0, unsigned: 0 } };
        const bump = (type: string, cls: string | null, n: number) => {
            const k = type === 'click' ? classes.click : type === 'open' ? classes.open : null;
            if (!k) return;
            if (cls === 'unverified') k.unsigned += n;
            else if (cls === 'human_likely') k.human += n;
            else if (cls === 'machine_likely') k.machine += n;
            else k.unknown += n;
        };
        try {
            const rows: any[] = await adapterFor(this.connection.rawConnection).query(
                `SELECT type, classification, COUNT(*) AS n
                 FROM email_event WHERE \`orderId\` = ? AND type IN ('open', 'click')
                   AND (\`classificationReasons\` IS NULL OR \`classificationReasons\` NOT LIKE '%events-capped%')
                 GROUP BY type, classification`,
                [Number(order.id)],
            );
            for (const r of rows || []) bump(String(r.type), r.classification ?? null, Number(r.n) || 0);
        } catch { /* email_event not migrated yet */ }
        for (const i of c.legacy) if (i.type === 'open' || i.type === 'click') bump(i.type, i.classification, 1);

        const precision = this.moneyPrecision();
        const firstOpen = logs.map(l => toIso(l.firstOpenedAt)).filter((x): x is string => !!x).sort()[0] || null;
        const payments = c.payments.slice().sort((a, b) => Number(b.id) - Number(a.id)); // latest first
        const paymentState = payments.length
            ? payments.map(p => `${p.state} (${formatMoney(p.amount, order.currencyCode, precision)} via ${p.method})`).join('; ')
            : 'No payment';
        const customer: any = order.customer;
        const info = (l: EmailLog) => c.attempts.get(Number(l.id));
        // One row per email: its latest attempt (a retried attempt has its retry after it).
        const latest = logs.filter(l => (info(l)?.retriedBy ?? null) === null);
        const emails = (pick: (i: AttemptInfo) => boolean) => latest.filter(l => { const i = info(l); return !!i && pick(i); }).length;
        return {
            order: {
                id: Number(order.id), code: order.code, state: order.state,
                placedAt: toIso(order.orderPlacedAt), total: Number(order.totalWithTax) || 0, currencyCode: order.currencyCode,
                totalFormatted: formatMoney(order.totalWithTax, order.currencyCode, precision), paymentState,
                customerEmail: customer?.emailAddress ?? null,
                customerName: customer ? [customer.firstName, customer.lastName].filter(Boolean).join(' ') || null : null,
            },
            emails: {
                total: latest.length,
                attempts: logs.length,
                sent: emails(i => i.accepted),
                delivered: logs.filter(l => l.status === 'delivered' || (c.stats.get(Number(l.id))?.delivered ?? 0) > 0).length,
                sending: emails(i => i.state === 'sending'),
                retrying: emails(i => i.state === 'retrying'),
                deferred: emails(i => i.state === 'deferred'),
                unknown: emails(i => i.state === 'unknown'),
                failed: emails(i => i.state === 'failed'),
                suppressed: emails(i => i.state === 'suppressed'),
                opened: logs.filter(l => Number(l.openCount) > 0).length,
                firstOpenAt: firstOpen,
                clicked: logs.filter(l => Number(l.clickCount) > 0).length,
                bounced: logs.filter(l => l.status === 'bounced' || l.status === 'complained').length,
            },
            opens: { recorded: logs.reduce((n, l) => n + (Number(l.openCount) || 0), 0), ...classes.open },
            clicks: { recorded: logs.reduce((n, l) => n + (Number(l.clickCount) || 0), 0), ...classes.click },
            historyUnavailable: c.historyUnavailable,
            deliveryEvents: deliveryEventsConfigured(),
        };
    }
}
