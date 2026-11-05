/**
 * IP parsing, canonical form and private / reserved address detection for
 * the IP-enrichment gate: an address that can never identify a network on
 * the public internet is never sent to a lookup provider, and every lookup
 * (cache key, provider URL, custom `lookup(ip)`) uses the canonical form of
 * the validated address, never the raw header value.
 *
 * IPv4: 0/8, 10/8, 100.64/10 (CGNAT), 127/8, 169.254/16, 172.16/12,
 * 192.0.0/24, 192.0.2/24, 192.168/16, 198.18/15, 198.51.100/24,
 * 203.0.113/24, 224/4 (multicast), 240/4 and the broadcast address.
 * IPv6: :: and ::1, fc00::/7, fe80::/10, fec0::/10, ff00::/8 (multicast),
 * 2001:db8::/32, 64:ff9b:1::/48 (local-use NAT64), and — classified by the
 * IPv4 address they embed — the IPv4-mapped (`::ffff:a.b.c.d`, also in hex
 * form), IPv4-translated and IPv4-compatible forms, NAT64 64:ff9b::/96 and
 * 6to4 2002::/16. Anything that does not parse as an address — including
 * any address with a `%zone` suffix — counts as reserved.
 */
export function parseIPv4(s: string): number[] | null {
    const parts = s.split('.');
    if (parts.length !== 4) return null;
    const out: number[] = [];
    for (const p of parts) {
        if (!/^\d{1,3}$/.test(p)) return null;
        const n = Number(p);
        if (n > 255) return null;
        out.push(n);
    }
    return out;
}

/** Eight 16-bit groups, or null. Accepts `::` compression and a trailing
 *  dotted IPv4; rejects a `%zone` suffix. */
export function parseIPv6(input: string): number[] | null {
    let s = input.trim();
    if (s.includes('%')) return null;
    if (!s.includes(':')) return null;
    let tail: number[] = [];
    // A trailing dotted IPv4 (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) fills the last two groups.
    const lastColon = s.lastIndexOf(':');
    const last = s.slice(lastColon + 1);
    if (last.includes('.')) {
        const v4 = parseIPv4(last);
        if (!v4) return null;
        tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
        s = s.slice(0, lastColon + 1);
        // Keep a '::' that ends the prefix; drop a single separating ':'.
        if (!s.endsWith('::')) s = s.slice(0, -1);
    }
    const halves = s.split('::');
    if (halves.length > 2) return null;
    const toGroups = (h: string): number[] | null => {
        if (h === '') return [];
        const out: number[] = [];
        for (const g of h.split(':')) {
            if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
            out.push(parseInt(g, 16));
        }
        return out;
    };
    const head = toGroups(halves[0]);
    const rest = halves.length === 2 ? toGroups(halves[1]) : [];
    if (!head || !rest) return null;
    const total = head.length + rest.length + tail.length;
    if (halves.length === 1) {
        return total === 8 ? [...head, ...tail] : null;
    }
    if (total > 7) return null;
    return [...head, ...new Array(8 - total).fill(0), ...rest, ...tail];
}

/** RFC 5952 text form of eight groups: lower case, the longest run (2+) of zero groups as `::`. */
function formatIPv6(g: number[]): string {
    let bestStart = -1;
    let bestLen = 0;
    for (let i = 0; i < 8;) {
        if (g[i] !== 0) { i++; continue; }
        let j = i;
        while (j < 8 && g[j] === 0) j++;
        if (j - i > bestLen && j - i >= 2) { bestStart = i; bestLen = j - i; }
        i = j;
    }
    const hex = g.map(x => x.toString(16));
    if (bestStart < 0) return hex.join(':');
    const left = hex.slice(0, bestStart).join(':');
    const right = hex.slice(bestStart + bestLen).join(':');
    return `${left}::${right}`;
}

export interface ParsedIp {
    version: 4 | 6;
    /** IPv4 dotted quad (also for an IPv4-mapped IPv6 address), or RFC 5952 IPv6. */
    canonical: string;
    octets?: number[];
    groups?: number[];
}

/**
 * The validated address, or null: brackets (`[2001:db8::1]`) are removed,
 * a `%zone` suffix is refused, an IPv4-mapped IPv6 address becomes its IPv4
 * address, and IPv6 is written in its RFC 5952 form.
 */
export function parseIp(raw: string | null | undefined): ParsedIp | null {
    if (raw === null || raw === undefined) return null;
    let s = String(raw).trim();
    if (!s || s.length > 64) return null;
    if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
    if (s.includes('%') || s.includes('[') || s.includes(']')) return null;
    const v4 = parseIPv4(s);
    if (v4) return { version: 4, canonical: v4.join('.'), octets: v4 };
    const g = parseIPv6(s);
    if (!g) return null;
    const zeros = (from: number, to: number) => g.slice(from, to).every(x => x === 0);
    if (zeros(0, 5) && g[5] === 0xffff) {
        const o = [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255];
        return { version: 4, canonical: o.join('.'), octets: o };
    }
    return { version: 6, canonical: formatIPv6(g), groups: g };
}

/** The canonical form of an address (see `parseIp`), or null when it is not one. */
export function canonicalIp(raw: string | null | undefined): string | null {
    return parseIp(raw)?.canonical ?? null;
}

function isReservedV4(o: number[]): boolean {
    const [a, b, c] = o;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
    if (a === 192 && b === 168) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 198 && b === 51 && c === 100) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    if (a >= 224) return true; // multicast 224/4, reserved 240/4, broadcast
    return false;
}

export function isPrivateOrReservedIp(ip: string | null | undefined): boolean {
    const p = parseIp(ip);
    if (!p) return true;
    if (p.version === 4) return isReservedV4(p.octets!);
    const g = p.groups!;
    const v4At = (hi: number, lo: number): number[] => [g[hi] >> 8, g[hi] & 255, g[lo] >> 8, g[lo] & 255];
    const zeros = (from: number, to: number) => g.slice(from, to).every(x => x === 0);
    if (zeros(0, 8)) return true;                                     // ::
    if (zeros(0, 7) && g[7] === 1) return true;                       // ::1
    if (zeros(0, 4) && g[4] === 0xffff && g[5] === 0) return isReservedV4(v4At(6, 7)); // ::ffff:0:a.b.c.d
    if (zeros(0, 6)) return isReservedV4(v4At(6, 7));                 // ::a.b.c.d (deprecated)
    if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return isReservedV4(v4At(6, 7)); // NAT64 64:ff9b::/96
    if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true;  // local-use NAT64 64:ff9b:1::/48
    if (g[0] === 0x2002) return isReservedV4(v4At(1, 2));             // 6to4 2002:a.b.c.d::/48
    if ((g[0] & 0xfe00) === 0xfc00) return true;                      // fc00::/7
    if ((g[0] & 0xffc0) === 0xfe80) return true;                      // fe80::/10
    if ((g[0] & 0xffc0) === 0xfec0) return true;                      // fec0::/10
    if ((g[0] & 0xff00) === 0xff00) return true;                      // ff00::/8
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true;              // 2001:db8::/32
    return false;
}
