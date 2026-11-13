import { BlockList, isIP } from 'net';
import { getOptions } from './options';

/**
 * Admin-editable tracking settings (0.17.0), kept in `hulo_plugin_prefs`
 * (keys below) so the server (pixel, redirector) and the worker (sending)
 * read the same values. Each process holds a copy refreshed every minute
 * and at once in the process that saved a change.
 *
 *   tracking.opens           on | off   the open pixel (default: init `trackOpens`, else on)
 *   tracking.clicks          on | off   link rewriting and click recording (default: init `trackClicks`, else on)
 *   tracking.trustedProxies  comma-separated IPs / CIDR ranges, added to init `trustedProxies`
 *
 * Switching a kind off stops it at once for new e-mails and new hits; what
 * was recorded stays until retention removes it.
 */
export const PREF_OPENS = 'tracking.opens';
export const PREF_CLICKS = 'tracking.clicks';
export const PREF_PROXIES = 'tracking.trustedProxies';

export interface TrackingSettings {
    trackOpens: boolean;
    trackClicks: boolean;
    /** Proxies added in the admin UI (the init list is reported separately and cannot be removed there). */
    trustedProxies: string[];
}

export interface TrackingSettingsView extends TrackingSettings {
    /** Ranges from `EmailTrackingPlugin.init({ trustedProxies })`. */
    configuredProxies: string[];
    /** `trustedIpHeaders` from init: the proxy headers that may name the visitor. */
    trustedIpHeaders: string[];
}

/** Most ranges kept (admin list). */
export const MAX_PROXIES = 100;

let stored: { opens: boolean | null; clicks: boolean | null; proxies: string[] } = { opens: null, clicks: null, proxies: [] };

/** The switches in force in this process. */
export function trackingSwitches(): { opens: boolean; clicks: boolean } {
    const o = getOptions();
    return {
        opens: stored.opens ?? (o.trackOpens !== false),
        clicks: stored.clicks ?? (o.trackClicks !== false),
    };
}

/** Every trusted proxy range in force: init `trustedProxies` plus the admin list. */
export function trustedProxyRanges(): string[] {
    const init = parseProxies(getOptions().trustedProxies || []);
    return Array.from(new Set([...init, ...stored.proxies]));
}

export function currentSettings(): TrackingSettingsView {
    const s = trackingSwitches();
    return {
        trackOpens: s.opens,
        trackClicks: s.clicks,
        trustedProxies: [...stored.proxies],
        configuredProxies: parseProxies(getOptions().trustedProxies || []),
        trustedIpHeaders: [...(getOptions().trustedIpHeaders || [])],
    };
}

/** Apply the stored prefs (a `PluginPrefs.all()` map) to this process. */
export function applyStoredPrefs(p: Record<string, string | null | undefined>): void {
    const flag = (v: string | null | undefined) => (v === 'on' ? true : v === 'off' ? false : null);
    stored = {
        opens: flag(p[PREF_OPENS]),
        clicks: flag(p[PREF_CLICKS]),
        proxies: parseProxies(p[PREF_PROXIES] || ''),
    };
}

/** Test hook: forget the stored prefs. */
export function resetStoredPrefs(): void {
    stored = { opens: null, clicks: null, proxies: [] };
}

/**
 * Validate a settings patch from the admin. Returns the prefs to write
 * (`null` removes one) or an error. Unknown keys are ignored.
 */
export function settingsPatch(body: any): { prefs: Record<string, string | null> } | { error: string } {
    const prefs: Record<string, string | null> = {};
    for (const [key, pref] of [['trackOpens', PREF_OPENS], ['trackClicks', PREF_CLICKS]] as const) {
        if (body?.[key] === undefined) continue;
        if (typeof body[key] !== 'boolean') return { error: `${key} must be true or false` };
        prefs[pref] = body[key] ? 'on' : 'off';
    }
    if (body?.trustedProxies !== undefined) {
        const raw = body.trustedProxies;
        const list = Array.isArray(raw) ? raw.map(String) : String(raw ?? '').split(/[\s,]+/);
        const items = list.map(x => x.trim()).filter(Boolean);
        const bad = items.filter(x => !validRange(x));
        if (bad.length) return { error: `not an IP address or CIDR range: ${bad.slice(0, 3).join(', ')}` };
        if (items.length > MAX_PROXIES) return { error: `at most ${MAX_PROXIES} trusted proxies` };
        const clean = parseProxies(items);
        prefs[PREF_PROXIES] = clean.length ? clean.join(',') : null;
    }
    return { prefs };
}

// ── IP ranges ────────────────────────────────────────────────────────────

/** `::ffff:1.2.3.4` → `1.2.3.4`; anything else as given (trimmed). */
export function normaliseIp(ip: string): string {
    return String(ip || '').trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '').replace(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i, '$1');
}

/** A single IP or a CIDR range (IPv4 or IPv6). */
export function validRange(r: string): boolean {
    const s = String(r || '').trim();
    const slash = s.indexOf('/');
    if (slash < 0) return isIP(normaliseIp(s)) !== 0;
    const net = normaliseIp(s.slice(0, slash));
    const bits = s.slice(slash + 1);
    const family = isIP(net);
    if (!family || !/^\d{1,3}$/.test(bits)) return false;
    return Number(bits) <= (family === 6 ? 128 : 32);
}

/** Valid ranges only, lower-cased, without duplicates, at most MAX_PROXIES. */
export function parseProxies(raw: string | string[]): string[] {
    const list = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,]+/);
    const out: string[] = [];
    for (const r of list) {
        const s = String(r || '').trim().toLowerCase();
        if (s && validRange(s) && !out.includes(s)) out.push(s);
    }
    return out.slice(0, MAX_PROXIES);
}

const blockLists = new Map<string, BlockList>();

function blockListFor(ranges: string[]): BlockList {
    const key = ranges.join(',');
    let bl = blockLists.get(key);
    if (bl) return bl;
    bl = new BlockList();
    for (const r of ranges) {
        const [netRaw, bits] = r.split('/');
        const net = normaliseIp(netRaw);
        const family = isIP(net) === 6 ? 'ipv6' : 'ipv4';
        if (bits === undefined) bl.addAddress(net, family);
        else bl.addSubnet(net, Number(bits), family);
    }
    if (blockLists.size > 20) blockLists.clear();
    blockLists.set(key, bl);
    return bl;
}

/** True when `ip` falls in one of `ranges` (IPv4, IPv6, IPv4-mapped IPv6). */
export function inRanges(ip: string | null | undefined, ranges: string[]): boolean {
    if (!ip || !ranges.length) return false;
    const a = normaliseIp(ip);
    const family = isIP(a);
    if (!family) return false;
    try {
        return blockListFor(ranges).check(a, family === 6 ? 'ipv6' : 'ipv4');
    } catch {
        return false;
    }
}
