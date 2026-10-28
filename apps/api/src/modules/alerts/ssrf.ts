import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * Server-side request forgery (SSRF) defence for customer-supplied webhook URLs (PRD ALERT-007,
 * OWASP SSRF Prevention Cheat Sheet). A webhook URL is attacker-controlled input that makes OUR
 * server send a request. Without this check it could reach MongoDB, Redis, Loki, the internal
 * metrics port, or a cloud metadata endpoint (169.254.169.254).
 *
 * Enforced on save AND before every delivery:
 *  1. Scheme http/https only; no credentials in the URL.
 *  2. The hostname is resolved, and EVERY resolved address must be public (one private answer in a
 *     multi-record response is enough to block).
 *  3. The caller connects to the exact address validated here (DNS pinning), so a DNS answer
 *     that changes after validation (rebinding) cannot redirect the request.
 *  4. Redirects are never followed (enforced by the deliverer).
 */

const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, including broadcast
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b::', 96], // NAT64 (embeds IPv4)
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6');
}

/** Extracts an embedded IPv4 address from IPv4-mapped (::ffff:a.b.c.d) or compatible forms. */
function embeddedIpv4(address: string): string | null {
  const match = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (match?.[1]) return match[1];
  // ::ffff:7f00:1 (hex form of the mapped address).
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (hex?.[1] && hex[2]) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) {
    const v4 = embeddedIpv4(address);
    if (v4) return blocked.check(v4, 'ipv4');
    return blocked.check(address, 'ipv6');
  }
  return true; // not an IP at all: refuse
}

export type UrlCheck =
  { ok: true; url: URL; address: string; family: 4 | 6 } | { ok: false; reason: string };

export interface UrlPolicy {
  /** Development/test only: allow private and loopback targets (e.g. a local receiver). */
  allowPrivateNetworks: boolean;
  /** Resolver, injectable for tests. Returns every address for the host. */
  resolve?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
}

const defaultResolve = (hostname: string) => dnsLookup(hostname, { all: true, verbatim: true });

/**
 * Validates a webhook URL and resolves the single address to connect to. The reasons are safe to
 * show the owner (they never include resolved internal addresses).
 */
export async function checkWebhookUrl(raw: string, policy: UrlPolicy): Promise<UrlCheck> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'Not a valid URL' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: 'Only http and https URLs are allowed' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'URLs with embedded credentials are not allowed' };
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (!policy.allowPrivateNetworks && /(^|\.)localhost$/i.test(hostname)) {
    return { ok: false, reason: 'Destination resolves to a private or reserved network address' };
  }

  let addresses: Array<{ address: string; family: number }>;
  if (isIP(hostname)) {
    addresses = [{ address: hostname, family: isIP(hostname) }];
  } else {
    try {
      addresses = await (policy.resolve ?? defaultResolve)(hostname);
    } catch {
      return { ok: false, reason: 'Destination host could not be resolved' };
    }
  }
  if (addresses.length === 0)
    return { ok: false, reason: 'Destination host could not be resolved' };

  if (!policy.allowPrivateNetworks && addresses.some((a) => isBlockedAddress(a.address))) {
    return { ok: false, reason: 'Destination resolves to a private or reserved network address' };
  }
  const chosen = addresses[0] as { address: string; family: number };
  return { ok: true, url, address: chosen.address, family: chosen.family === 6 ? 6 : 4 };
}

/** Display form that never reveals path tokens (e.g. chat-webhook secrets in the path). */
export function urlPreview(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname.length > 1 ? '/…' : '/'}`;
  } catch {
    return '(invalid URL)';
  }
}
