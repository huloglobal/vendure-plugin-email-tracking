import { describe, expect, it } from 'vitest';
import { canonicalIp, isPrivateOrReservedIp, parseIp, parseIPv6 } from './ip-utils';

describe('isPrivateOrReservedIp', () => {
    it('flags every private / reserved IPv4 range', () => {
        for (const ip of [
            '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.254', '192.168.1.25', '127.0.0.1', '127.8.9.10',
            '169.254.10.1', '100.64.0.1', '100.127.255.255', '0.0.0.0', '0.1.2.3', '224.0.0.1', '239.255.255.250',
            '240.0.0.1', '255.255.255.255', '192.0.2.10', '198.51.100.7', '203.0.113.9', '198.18.0.1', '192.0.0.8',
        ]) expect(isPrivateOrReservedIp(ip), ip).toBe(true);
    });

    it('lets public IPv4 through, including the edges next to private ranges', () => {
        for (const ip of ['8.8.8.8', '1.1.1.1', '81.2.69.142', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '11.0.0.1', '223.255.255.255', '192.169.0.1']) {
            expect(isPrivateOrReservedIp(ip), ip).toBe(false);
        }
    });

    it('flags IPv6 loopback, unspecified, ULA, link-local, site-local, multicast and documentation', () => {
        for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456:789a::1', 'fe80::1', 'fe80::1%eth0', 'febf::1', 'fec0::1', 'ff02::1', '2001:db8::1', '[::1]']) {
            expect(isPrivateOrReservedIp(ip), ip).toBe(true);
        }
    });

    it('lets public IPv6 through', () => {
        for (const ip of ['2001:4860:4860::8888', '2a00:1450:4009:81f::200e', '2606:4700:4700::1111']) {
            expect(isPrivateOrReservedIp(ip), ip).toBe(false);
        }
    });

    it('applies the IPv4 rules to IPv4-mapped, -translated and -compatible IPv6 forms', () => {
        expect(isPrivateOrReservedIp('::ffff:10.0.0.1')).toBe(true);
        expect(isPrivateOrReservedIp('::ffff:127.0.0.1')).toBe(true);
        expect(isPrivateOrReservedIp('::ffff:192.168.0.5')).toBe(true);
        expect(isPrivateOrReservedIp('::ffff:7f00:1')).toBe(true);        // 127.0.0.1 in hex
        expect(isPrivateOrReservedIp('::ffff:a9fe:0101')).toBe(true);     // 169.254.1.1
        expect(isPrivateOrReservedIp('0:0:0:0:0:ffff:100.64.1.1')).toBe(true);
        expect(isPrivateOrReservedIp('::ffff:0:172.16.0.1')).toBe(true);  // IPv4-translated
        expect(isPrivateOrReservedIp('::10.1.2.3')).toBe(true);           // IPv4-compatible
        expect(isPrivateOrReservedIp('::ffff:8.8.8.8')).toBe(false);
        expect(isPrivateOrReservedIp('::ffff:0808:0808')).toBe(false);
    });

    it('treats empty and malformed input as not look-up-able', () => {
        for (const ip of [null, undefined, '', 'localhost', '1.2.3', '1.2.3.256', '01.2.3.4.5', '::g', '1::2::3', 'abc']) {
            expect(isPrivateOrReservedIp(ip as any), String(ip)).toBe(true);
        }
    });
});

describe('parseIPv6', () => {
    it('expands :: and trailing dotted IPv4', () => {
        expect(parseIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
        expect(parseIPv6('2001:db8::')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]);
        expect(parseIPv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
        expect(parseIPv6('64:ff9b::1.2.3.4')).toEqual([0x64, 0xff9b, 0, 0, 0, 0, 0x0102, 0x0304]);
        expect(parseIPv6('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect(parseIPv6('1:2:3:4:5:6:7')).toBeNull();
        expect(parseIPv6('1:2:3:4:5:6:7:8:9')).toBeNull();
    });
});

describe('canonical addresses', () => {
    it('RFC 5952 for IPv6, the IPv4 address for a mapped one, brackets removed, zones refused', () => {
        expect(canonicalIp('2001:0DB8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8::1');
        expect(canonicalIp('2001:db8:0:0:1:0:0:1')).toBe('2001:db8::1:0:0:1');
        expect(canonicalIp('[2001:4860::1]')).toBe('2001:4860::1');
        expect(canonicalIp('::ffff:8.8.8.8')).toBe('8.8.8.8');
        expect(canonicalIp('::ffff:0808:0808')).toBe('8.8.8.8');
        expect(canonicalIp(' 81.2.69.142 ')).toBe('81.2.69.142');
        expect(canonicalIp('1:2:3:4:5:6:7:8')).toBe('1:2:3:4:5:6:7:8');
        expect(canonicalIp('1:0:3:4:5:6:7:8')).toBe('1:0:3:4:5:6:7:8'); // a single zero group is not compressed
        expect(canonicalIp('::')).toBe('::');
        for (const bad of ['fe80::1%eth0', '2001:4860:4860::8888%/../../x?y=1', '[::1', 'x', '', null]) expect(canonicalIp(bad as any), String(bad)).toBeNull();
        expect(parseIp('8.8.8.8')).toMatchObject({ version: 4, canonical: '8.8.8.8' });
        expect(parseIPv6('fe80::1%eth0')).toBeNull();
    });

    it('classifies NAT64 and 6to4 addresses by the IPv4 address they embed', () => {
        expect(isPrivateOrReservedIp('64:ff9b::10.0.0.1')).toBe(true);
        expect(isPrivateOrReservedIp('64:ff9b::a00:1')).toBe(true);
        expect(isPrivateOrReservedIp('64:ff9b::808:808')).toBe(false);   // 8.8.8.8
        expect(isPrivateOrReservedIp('64:ff9b:1::808:808')).toBe(true);  // local-use NAT64 prefix
        expect(isPrivateOrReservedIp('2002:a00:1::1')).toBe(true);       // 6to4 of 10.0.0.1
        expect(isPrivateOrReservedIp('2002:c0a8:101::1')).toBe(true);    // 6to4 of 192.168.1.1
        expect(isPrivateOrReservedIp('2002:808:808::1')).toBe(false);    // 6to4 of 8.8.8.8
    });
});
