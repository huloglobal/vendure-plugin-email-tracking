import { AsyncLocalStorage } from 'async_hooks';
import { Logger } from '@vendure/core';

/**
 * Who is sending the email in flight (0.17.0): the e-mail's type and what it
 * is about, as its sender knows them — never guessed from the subject.
 *
 * Vendure's EmailPlugin hands its `EmailSender` only the rendered email, so
 * `installEmailProcessorHook()` wraps `EmailProcessor.process()` (the job that
 * renders and sends each email) and runs it inside an AsyncLocalStorage scope
 * holding the event handler's type (`order-confirmation`, `password-reset`,
 * `email-verification`, `email-address-change`, or your own handler's) and
 * the order from its template variables. `TrackingEmailSender` reads it.
 *
 * Code that calls an EmailSender itself can label its email the same way:
 *
 *   await withEmailContext({ type: 'quote-sent', orderId: 12 }, () => sender.send(email, transport));
 */
export interface EmailSendContext {
    /** The e-mail's type, as its sender named it. */
    type?: string | null;
    orderId?: number | null;
    orderCode?: string | null;
    customerId?: number | null;
    channelId?: number | null;
}

const als = new AsyncLocalStorage<EmailSendContext>();

/** The context of the email being sent in this async scope, or null. */
export function currentEmailContext(): EmailSendContext | null {
    return als.getStore() ?? null;
}

/** Run `fn` with `ctx` as the context of every email it sends. */
export function withEmailContext<T>(ctx: EmailSendContext, fn: () => T): T {
    return als.run(sanitiseContext(ctx), fn);
}

const posInt = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null;
};

/** Type: letters, digits, `-`, `_`, `.`, `:` only, at most 64 characters (it is a log label and an exemption key). */
export function sanitiseType(t: unknown): string | null {
    const s = String(t ?? '').trim().slice(0, 64);
    return /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(s) ? s : null;
}

function sanitiseContext(c: EmailSendContext | null | undefined): EmailSendContext {
    const code = c?.orderCode ? String(c.orderCode).slice(0, 64) : null;
    return {
        type: sanitiseType(c?.type),
        orderId: posInt(c?.orderId),
        orderCode: code && /^[A-Za-z0-9_-]+$/.test(code) ? code : null,
        customerId: posInt(c?.customerId),
        channelId: posInt(c?.channelId),
    };
}

/**
 * The context of one EmailPlugin job (`IntermediateEmailDetails`): its event
 * type, the order in its template variables (Vendure's order handlers pass
 * `order`), the metadata's `orderId`, and the request context's channel.
 */
export function contextFromEmailJob(data: any): EmailSendContext {
    const vars = data?.templateVars || {};
    const order = vars.order && typeof vars.order === 'object' ? vars.order : null;
    const customerId = order?.customerId ?? order?.customer?.id ?? vars.customer?.id ?? null;
    const ctx = data?.ctx || {};
    const channelId = ctx?._channel?.id ?? ctx?.channel?.id ?? ctx?.channelId ?? null;
    return sanitiseContext({
        type: data?.type,
        orderId: order?.id ?? data?.metadata?.orderId ?? null,
        orderCode: order?.code ?? null,
        customerId,
        channelId,
    });
}

const HOOKED = Symbol.for('hulo.emailTracking.processorHook');

/**
 * Wrap `EmailProcessor.prototype.process` once per process (idempotent).
 * Returns false when the EmailPlugin's processor cannot be found (another
 * major version, or the EmailPlugin is not installed): emails are then
 * labelled from the subject, as before 0.17.0, and no suppression exemption
 * applies.
 */
export function installEmailProcessorHook(load: () => any = () => require('@vendure/email-plugin/lib/src/email-processor')): boolean {
    try {
        const mod = load();
        const proto = mod?.EmailProcessor?.prototype;
        if (!proto || typeof proto.process !== 'function') return false;
        if (proto[HOOKED]) return true;
        const original = proto.process;
        proto.process = function hulo_process(this: any, data: any) {
            let ctx: EmailSendContext;
            try { ctx = contextFromEmailJob(data); } catch { ctx = {}; }
            return als.run(ctx, () => original.call(this, data));
        };
        Object.defineProperty(proto, HOOKED, { value: true });
        return true;
    } catch (e: any) {
        Logger.verbose(`EmailProcessor hook not installed: ${e?.message}`, 'TrackingEmailSender');
        return false;
    }
}
