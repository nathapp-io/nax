/**
 * Web address safety: the destination check `web__fetch` makes at connect time.
 *
 * Two entry points answer one question. `isBlockedAddress` classifies a resolved
 * address; `createCheckedLookup` wraps the resolver so the address that was classified
 * is the address the socket connects to. Node's HTTP client builds its connection from
 * this lookup's answer, so a DNS reply that changes between the check and the connect
 * cannot reach a blocked address -- there is no window in which a second answer is used
 * unchecked.
 *
 * The ranges are the ones a page fetch has no business reaching: loopback, unspecified,
 * link-local (including the cloud metadata address 169.254.169.254), private, CGNAT,
 * multicast and reserved, in both families, plus an IPv4 address wearing an IPv6 hat
 * (`::ffff:127.0.0.1`) which would otherwise be classified as public v6.
 *
 * A blocked answer is a `NaxError` with code `WEB_ADDRESS_BLOCKED` rather than a plain
 * resolver failure: the caller must be able to tell "the destination is not allowed"
 * apart from "the destination does not exist", and only the first is worth reporting as
 * a refusal.
 */

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import { NaxError } from "#src/infra/index";

/**
 * What a refused destination carries, so the fetch layer can re-raise it unchanged: a
 * destination refused by the connect-time lookup reaches the caller as the same error, never
 * as a generic connection failure.
 */
export const ADDRESS_BLOCKED = "WEB_ADDRESS_BLOCKED";

/** The `stage` on every error this module raises. */
const STAGE = "web-fetch";

/** One 16-bit group of an IPv6 address: up to four hex digits, either case. */
const HEX_GROUP = /^[0-9a-f]{1,4}$/i;

/** A dotted-quad IPv4 address. */
const DOTTED_QUAD = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** The largest value one octet of an IPv4 address may hold. */
const MAX_OCTET = 255;

/** How many 16-bit groups an IPv6 address has. */
const IPV6_GROUPS = 8;

/**
 * Test seam: the resolver `createCheckedLookup` asks, and nothing else. Typed as Node's
 * `LookupFunction` -- the contract `http.request`'s `lookup` option takes and the one
 * `createCheckedLookup` returns -- so a test answers with a plain function rather than
 * an overload set. The default forwards to `dns.lookup`; DNS is never contacted by a
 * test, and a real connection still resolves through the OS resolver.
 */
export const _webAddressDeps: { lookup: LookupFunction } = {
  lookup: (hostname, options, callback) => {
    dnsLookup(hostname, options, callback);
  },
};

/**
 * Whether `ip` is an address a page fetch must refuse: loopback, unspecified,
 * link-local, private, CGNAT, multicast or reserved, in either family.
 *
 * An IPv4-mapped IPv6 address is unwrapped and classified as the IPv4 address it
 * carries, so `::ffff:127.0.0.1` and `::ffff:7f00:1` are both loopback. Text that is
 * not an address at all is reported as blocked: this is a destination guard, and an
 * answer it cannot read is an answer it cannot vouch for.
 */
export function isBlockedAddress(ip: string): boolean {
  const text = ip.trim();
  const v4 = ipv4Bytes(text);
  if (v4 !== null) return isBlockedIpv4(v4);
  const v6 = ipv6Groups(text);
  return v6 === null ? true : isBlockedIpv6(v6);
}

/**
 * The `lookup` a page fetch hands to `node:http`/`node:https`: every address the
 * resolver returns is classified before it is handed back, and a blocked one replaces
 * the answer with a `WEB_ADDRESS_BLOCKED` error. Node connects to what this calls back
 * with, so the check and the connection cannot disagree.
 *
 * `all: true` is honoured by acting on the answer rather than the options: whether the
 * resolver returned one address or a list, every address in it is checked, and the
 * answer is passed through untouched only when all of them are public.
 *
 * An `origin` listed in `allowOrigins` skips the check. That exemption exists for the
 * configured SearXNG base URL, which is frequently on a private network by design and
 * is the operator's own choice of destination, not a page's.
 */
export function createCheckedLookup(p: { allowOrigins: readonly string[]; origin: string }): LookupFunction {
  const exempt = isAllowedOrigin(p.origin, p.allowOrigins);
  return (hostname, options, callback) => {
    _webAddressDeps.lookup(hostname, options, (error, address, family) => {
      if (error !== null || exempt) {
        callback(error, address, family);
        return;
      }
      const blocked = firstBlockedAnswer(address);
      if (blocked === undefined) {
        callback(null, address, family);
        return;
      }
      callback(blockedAddressError(hostname, blocked), address, family);
    });
  };
}

/** The first blocked address in a resolver answer, or `undefined` when every one is public. */
function firstBlockedAnswer(address: string | readonly LookupAddress[]): string | undefined {
  const answers = typeof address === "string" ? [address] : address.map((answer) => answer.address);
  return answers.find((candidate) => isBlockedAddress(candidate));
}

/**
 * The refusal a blocked destination raises, naming the host that resolved to it. Exported
 * because the fetch layer raises the same refusal for an IP literal, which Node never resolves
 * and so never hands to the checked lookup: one refusal, one message, both entry points.
 */
export function blockedAddressError(host: string, address: string): NaxError {
  return new NaxError(`refused to fetch ${host}: it resolves to a private or local address`, ADDRESS_BLOCKED, {
    stage: STAGE,
    host,
    address,
  });
}

/**
 * Whether the request's origin is exempt. Both sides are reduced to their origin first,
 * so an allow-list entry written as a base URL (`http://host:8080/`) matches the origin
 * it belongs to, and an entry that is not a URL matches nothing. Exported because the
 * fetch layer exempts an allowed origin's IP literal too, which never reaches the lookup.
 */
export function isAllowedOrigin(origin: string, allowOrigins: readonly string[]): boolean {
  const requested = originOf(origin);
  if (requested === null) return false;
  return allowOrigins.some((allowed) => originOf(allowed) === requested);
}

/** The origin of an http(s) URL, or `null` when the text does not parse as one. */
function originOf(text: string): string | null {
  try {
    return new URL(text).origin;
  } catch {
    // Unparseable text has no origin, so it can never match an allowed one.
    return null;
  }
}

/** The four octets of a dotted-quad address, or `null` when the text is not one. */
function ipv4Bytes(text: string): number[] | null {
  const match = DOTTED_QUAD.exec(text);
  if (match === null) return null;
  const octets = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])];
  return octets.every((octet) => octet <= MAX_OCTET) ? octets : null;
}

/** The eight 16-bit groups of an IPv6 address, or `null` when the text is not one. */
function ipv6Groups(text: string): number[] | null {
  const folded = foldIpv4Tail(text);
  if (folded === null) return null;
  const halves = folded.split("::");
  if (halves.length > 2) return null;
  const head = hexGroups(halves[0]);
  const tail = halves.length === 2 ? hexGroups(halves[1]) : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === IPV6_GROUPS ? head : null;
  // `::` stands for one or more zero groups; it cannot stand for none.
  const zeros = IPV6_GROUPS - head.length - tail.length;
  if (zeros < 1) return null;
  const padding = new Array<number>(zeros).fill(0);
  return [...head, ...padding, ...tail];
}

/** One colon-separated run of an IPv6 address as 16-bit groups; `null` if a group is malformed. */
function hexGroups(part: string): number[] | null {
  if (part === "") return [];
  const groups: number[] = [];
  for (const group of part.split(":")) {
    if (!HEX_GROUP.test(group)) return null;
    groups.push(Number.parseInt(group, 16));
  }
  return groups;
}

/**
 * Rewrite a trailing dotted-quad as two hex groups, so `::ffff:127.0.0.1` and
 * `::ffff:7f00:1` reach the group parser in the same form. `null` when the tail looks
 * like an IPv4 address but is not one.
 */
function foldIpv4Tail(text: string): string | null {
  const separator = text.lastIndexOf(":");
  if (separator === -1) return text;
  const tail = text.slice(separator + 1);
  if (!tail.includes(".")) return text;
  const bytes = ipv4Bytes(tail);
  if (bytes === null) return null;
  const high = (bytes[0] << 8) | bytes[1];
  const low = (bytes[2] << 8) | bytes[3];
  return `${text.slice(0, separator + 1)}${high.toString(16)}:${low.toString(16)}`;
}

/** Whether the IPv4 octets fall inside any refused range. */
function isBlockedIpv4(bytes: readonly number[]): boolean {
  const [first, second] = bytes;
  if (first === 0) return true; // 0.0.0.0/8, unspecified
  if (first === 10 || first === 127) return true; // private, loopback
  if (first === 169 && second === 254) return true; // link-local, incl. cloud metadata
  if (first === 172 && second >= 16 && second <= 31) return true; // 172.16.0.0/12
  if (first === 192 && second === 168) return true; // 192.168.0.0/16
  if (first === 100 && second >= 64 && second <= 127) return true; // 100.64.0.0/10, CGNAT
  if (first >= 224 && first <= 239) return true; // 224.0.0.0/4, multicast
  return first >= 240; // 240.0.0.0/4, reserved
}

/** Whether the IPv6 groups fall inside any refused range or carry a blocked IPv4 address. */
function isBlockedIpv6(groups: readonly number[]): boolean {
  const leading = groups.slice(0, IPV6_GROUPS - 1);
  // :: (unspecified) and ::1 (loopback) are nothing but a final group of 0 or 1.
  if (leading.every((group) => group === 0)) return groups[IPV6_GROUPS - 1] <= 1;
  // ::ffff:a.b.c.d is an IPv4 address wearing an IPv6 hat: same octets, same answer.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return isBlockedIpv4(groups.slice(6).flatMap((group) => [group >> 8, group & 0xff]));
  }
  if ((groups[0] & 0xffc0) === 0xfe80) return true; // fe80::/10, link-local
  if ((groups[0] & 0xfe00) === 0xfc00) return true; // fc00::/7, unique local
  return (groups[0] & 0xff00) === 0xff00; // ff00::/8, multicast
}
