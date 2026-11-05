import { Controller, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import { Ctx, Logger, Order, RequestContext } from '@vendure/core';
import { applySecurityHeaders, premiumFeatureError } from '@huloglobal/vendure-licence-sdk';
import { Request, Response } from 'express';
import { CSV_BOM, csvRow } from './csv';
import { buildEvidenceReport } from './evidence-report';
import { getLimiter, intParam, realIp, requireAdmin } from './http-helpers';
import { getOptions, hasPremiumAccess } from './options';
import { LOCATION_CAUTION, OrderActivityService } from './order-activity.service';
import { exportEmailEvidencePermission } from './permissions';
import { evidenceScopeFromParam, EVIDENCE_LINK_TTL_SEC, INTERNAL_NOTES_PARAM, signEvidenceLink, verifyEvidenceLink } from './signed-link';
import { evidenceItems, parseFilter, redacted, timelineSha256 } from './timeline';
import { EmailTrackingPlugin } from './plugin';

const loggerCtx = 'OrderActivityController';
const PLUGIN_ID = 'vendure-plugin-email-tracking';

/**
 * Order activity: the email timeline merged with Vendure's order history,
 * its exports, and the signed PDF evidence report.
 *
 *   GET  /email-track/orders/:orderId/activity        JSON page (filter, cursor, take, order)
 *   GET  /email-track/orders/:orderId/activity.csv    redacted CSV of the timeline (?filter= narrows it)
 *   GET  /email-track/orders/:orderId/activity.json   redacted JSON (?filter= narrows it; timelineSha256 only
 *                                                     unfiltered); ?evidence=1[&internalNotes=1] the PDF's
 *                                                     items; ?full=1 needs ExportEmailEvidence
 *   POST /email-track/orders/:orderId/evidence-link   5-minute signed URL for the PDF ({ internalNotes: true }
 *                                                     to print private order notes, marked internal)
 *   GET  /email-track/orders/:orderId/evidence.pdf    the PDF (signed URL, no session needed)
 *
 * Every admin endpoint needs ReadOrder and ReadCustomer, sees only orders on
 * the admin's active channel (404 otherwise) and is premium (402 unlicensed).
 */
/** `order-<code>-activity[-<filter>][-full]-<date>`: a filtered export never looks like the whole timeline. */
export function exportName(code: string, filter: string, full: boolean): string {
    const safe = String(code).replace(/[^A-Za-z0-9_-]/g, '');
    return `order-${safe}-activity${filter && filter !== 'all' ? `-${filter}` : ''}${full ? '-full' : ''}-${new Date().toISOString().slice(0, 10)}`;
}

@Controller('email-track/orders')
export class OrderActivityController {
    constructor(private activity: OrderActivityService) {}

    /** Auth, premium, id and channel scope shared by the admin endpoints; null when answered. */
    private async adminOrder(ctx: RequestContext, res: Response, idParam: string): Promise<Order | null> {
        applySecurityHeaders(res, { strict: true });
        res.setHeader('Cache-Control', 'private, no-store');
        if (!requireAdmin(ctx, res, 'order')) return null;
        if (!hasPremiumAccess()) {
            res.status(402).json(premiumFeatureError(PLUGIN_ID));
            return null;
        }
        const id = intParam(idParam, 1, 2147483647);
        if (id === null) {
            res.status(400).json({ error: 'orderId must be a positive integer' });
            return null;
        }
        const order = await this.activity.findOrder(ctx, id);
        if (!order) {
            res.status(404).json({ error: 'Not found' });
            return null;
        }
        return order;
    }

    @Get(':orderId/activity')
    async page(@Ctx() ctx: RequestContext, @Param('orderId') idParam: string, @Req() req: Request, @Res() res: Response) {
        const order = await this.adminOrder(ctx, res, idParam);
        if (!order) return;
        const q = req.query as any;
        const take = intParam(q.take, 1, 500) ?? 100;
        const dir = String(q.order || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc';
        const filter = parseFilter(q.filter);
        const page = await this.activity.page(ctx, order, { filter, cursor: q.cursor ? String(q.cursor) : null, take, order: dir });
        // The header summary only on the first page; "Load more" pages skip the aggregates.
        const summary = q.cursor ? undefined : await this.activity.summary(order, page.context);
        return res.json({
            orderId: Number(order.id),
            filter, order: dir, take,
            items: page.items.map(redacted),
            nextCursor: page.nextCursor,
            hasMore: page.hasMore,
            total: page.total,
            summary,
            historyUnavailable: page.context.historyUnavailable,
            warning: LOCATION_CAUTION,
        });
    }

    @Get(':orderId/activity.csv')
    async csv(@Ctx() ctx: RequestContext, @Param('orderId') idParam: string, @Req() req: Request, @Res() res: Response) {
        const order = await this.adminOrder(ctx, res, idParam);
        if (!order) return;
        if (!this.allowExport(req, res)) return;
        const filter = parseFilter((req.query as any).filter);
        const { items, truncated } = await this.activity.allItems(ctx, order, filter, false);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${exportName(order.code, filter, false)}.csv"`);
        const header = ['time_utc', 'kind', 'source', 'type', 'event', 'email_type', 'email_log_id', 'detail', 'classification', 'reasons',
            'city', 'region', 'country', 'org', 'asn', 'proxy', 'vpn', 'tor', 'datacentre', 'mobile', 'client', 'platform', 'bot',
            'ip_as_stored', 'url', 'link_index', 'link_text', 'actor', 'legacy'];
        // BOM first: Excel then reads the file as UTF-8. Header names are plain; every data cell is quoted.
        res.write(CSV_BOM + header.join(',') + '\n');
        for (const i of items) {
            res.write(csvRow([
                i.at, i.kind, i.source, i.type, i.label, i.emailType, i.emailLogId, i.detail, i.classification, i.reasons.join('|'),
                i.location?.city, i.location?.region, i.location?.country, i.network?.org, i.network?.asn,
                i.network?.isProxy, i.network?.isVpn, i.network?.isTor, i.network?.isHosting, i.network?.isMobile,
                i.client, i.platform, i.isBot, i.ip, i.url, i.linkIndex, i.linkText, i.actor, i.legacy,
            ]) + '\n');
        }
        if (truncated) res.write(csvRow(['# truncated at the export limit']) + '\n');
        return res.end();
    }

    @Get(':orderId/activity.json')
    async json(@Ctx() ctx: RequestContext, @Param('orderId') idParam: string, @Req() req: Request, @Res() res: Response) {
        const order = await this.adminOrder(ctx, res, idParam);
        if (!order) return;
        if (!this.allowExport(req, res)) return;
        const q = req.query as any;
        const full = q.full === '1' || q.full === 'true';
        // The evidence report's own selection (private notes left out unless asked for): its SHA-256 is the PDF's.
        const evidence = !full && (q.evidence === '1' || q.evidence === 'true');
        const internalNotes = evidence && (q.internalNotes === '1' || q.internalNotes === 'true');
        if (full && !ctx.userHasPermissions([exportEmailEvidencePermission.Permission])) {
            return res.status(403).json({ error: 'The full export needs the ExportEmailEvidence permission' });
        }
        const filter = evidence ? 'all' : parseFilter(q.filter);
        const { items, truncated, context } = await this.activity.allItems(ctx, order, filter, full);
        const summary = await this.activity.summary(order, context);
        const redactedItems = items.map(redacted);
        const selected = evidence ? evidenceItems(redactedItems, { internalNotes }) : null;
        const name = evidence ? `${exportName(order.code, 'all', false).replace(/-activity-/, '-activity-evidence-')}` : exportName(order.code, filter, full);
        res.setHeader('Content-Disposition', `attachment; filename="${name}.json"`);
        return res.json({
            orderId: Number(order.id),
            orderCode: order.code,
            generatedAt: new Date().toISOString(),
            filter,
            full,
            evidence,
            ...(evidence ? { internalNotes, internalNotesLeftOut: selected!.internalNotesLeftOut } : {}),
            truncated,
            summary,
            historyUnavailable: context.historyUnavailable,
            warning: LOCATION_CAUTION,
            // Over the redacted items of the whole timeline — with evidence=1 over the report's
            // selection, the value printed on the PDF; null for a filtered export.
            timelineSha256: filter === 'all' ? timelineSha256(selected ? selected.items : redactedItems) : null,
            items: full ? items : selected ? selected.items : redactedItems,
        });
    }

    @Post(':orderId/evidence-link')
    async evidenceLink(@Ctx() ctx: RequestContext, @Param('orderId') idParam: string, @Req() req: Request, @Res() res: Response) {
        const order = await this.adminOrder(ctx, res, idParam);
        if (!order) return;
        if (!this.allowExport(req, res)) return;
        const secret = getOptions().signingSecret;
        if (!secret) return res.status(503).json({ error: 'No signing secret is available (set signingSecret)' });
        // Private (internal) order notes only when the admin asks for them; the choice is part of the signature.
        const b: any = (req as any).body;
        const internalNotes = b?.internalNotes === true || (req.query as any)?.internalNotes === '1';
        const scope = internalNotes ? 'internal-notes' : 'standard';
        const { exp, sig } = signEvidenceLink(Number(order.id), String(ctx.activeUserId), secret, Date.now(), EVIDENCE_LINK_TTL_SEC, scope);
        const url = `/email-track/orders/${order.id}/evidence.pdf?exp=${exp}&uid=${encodeURIComponent(String(ctx.activeUserId))}`
            + `${internalNotes ? `&notes=${INTERNAL_NOTES_PARAM}` : ''}&sig=${sig}`;
        return res.json({ url, expiresAt: new Date(exp * 1000).toISOString(), ttlSeconds: EVIDENCE_LINK_TTL_SEC, internalNotes });
    }

    /** The PDF: authorised by the signed link alone, so it opens in a new tab under bearer-token auth too. */
    @Get(':orderId/evidence.pdf')
    async evidencePdf(@Ctx() ctx: RequestContext, @Param('orderId') idParam: string, @Query('exp') exp: string, @Query('uid') uid: string,
        @Query('sig') sig: string, @Query('notes') notes: string, @Req() req: Request, @Res() res: Response) {
        applySecurityHeaders(res);
        res.setHeader('Cache-Control', 'private, no-store');
        if (!this.allowExport(req, res)) return;
        const id = intParam(idParam, 1, 2147483647);
        const scope = evidenceScopeFromParam(notes);
        const verdict = id === null ? 'invalid' : verifyEvidenceLink(id, exp, uid, sig, getOptions().signingSecret, Date.now(), EVIDENCE_LINK_TTL_SEC, scope);
        if (verdict !== 'ok' || id === null) {
            return res.status(403).type('text/plain').send(verdict === 'expired'
                ? 'This report link has expired. Open the report again from the order page.'
                : 'Invalid report link.');
        }
        if (!hasPremiumAccess()) return res.status(402).json(premiumFeatureError(PLUGIN_ID));
        const order = await this.activity.findOrderById(ctx, id);
        if (!order) return res.status(404).type('text/plain').send('Not found');
        try {
            const { items, truncated, context } = await this.activity.allItems(ctx, order, 'all', false);
            const summary = await this.activity.summary(order, context);
            const internalNotes = scope === 'internal-notes';
            const selected = evidenceItems(items.map(redacted), { internalNotes });
            const pdf = buildEvidenceReport({
                shop: this.shopLabel(order),
                summary,
                items: selected.items,
                truncated,
                generatedAt: new Date(),
                generatedBy: await this.activity.userIdentifier(ctx, String(uid)),
                timelineSha256: timelineSha256(selected.items),
                producer: `${EmailTrackingPlugin.getPackageName()} ${EmailTrackingPlugin.getPackageVersion()}`,
                internalNotes,
                internalNotesLeftOut: selected.internalNotesLeftOut,
            });
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `inline; filename="order-${order.code}-activity-evidence.pdf"`);
            res.setHeader('Content-Length', String(pdf.length));
            return res.end(pdf);
        } catch (e: any) {
            Logger.error(`evidence report failed for order ${id}: ${e?.message}`, loggerCtx);
            return res.status(500).type('text/plain').send('The report could not be generated.');
        }
    }

    /** Per-IP limiter on the heavy exports and the public PDF route. */
    private allowExport(req: Request, res: Response): boolean {
        const ip = realIp(req);
        if (ip && !getLimiter().allow(`evidence|${ip}`)) {
            res.setHeader('Retry-After', '60');
            res.status(429).json({ error: 'Too many requests' });
            return false;
        }
        return true;
    }

    private shopLabel(order: Order): string {
        let host = '';
        try { host = new URL(getOptions().publicBaseUrl).host; } catch { host = getOptions().publicBaseUrl || ''; }
        const channel = (order.channels || []).find((c: any) => c.code !== '__default_channel__');
        return channel ? `${host} (channel ${channel.code})` : host || 'Vendure shop';
    }
}

