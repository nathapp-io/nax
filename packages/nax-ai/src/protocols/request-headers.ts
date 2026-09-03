/**
 * Per-request headers: validation at the boundary, and precedence against auth.
 *
 * A neutral map is the whole surface. nax-ai's scope statement keeps consumer
 * vocabulary out of this package, so it must not grow a `sessionId` field or a
 * vendor's header name — a consumer that needs a provider's session-affinity
 * header supplies it here, and this package stays ignorant of what it means.
 */

/** RFC 9110 token: the characters a header name may legally use. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Rejects anything that could terminate a header line.
 *
 * fetch would refuse most of these itself, but far downstream and with a
 * message naming neither the header nor the caller. Failing here means a
 * consumer that interpolates an id into a header value learns immediately,
 * rather than seeing a transport error from inside a provider SDK.
 */
const FORBIDDEN_IN_VALUE = /[\r\n\0]/;

export function assertValidHeaders(headers: Readonly<Record<string, string>> | undefined): void {
  if (headers === undefined) return;
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name)) {
      throw new Error(`Invalid header name ${JSON.stringify(name)}: expected an RFC 9110 token.`);
    }
    if (FORBIDDEN_IN_VALUE.test(value)) {
      throw new Error(`Invalid header value for ${JSON.stringify(name)}: it may not contain CR, LF or NUL.`);
    }
  }
}

/**
 * Merge order: auth last, so auth wins.
 *
 * The alternative — letting the caller override — would make a mistyped header
 * name in a consumer able to replace a credential header, and the failure would
 * look like a provider auth outage rather than a caller bug. Nothing is lost by
 * the strict direction: a caller wanting different credentials has an auth
 * resolver for that.
 *
 * Returns undefined when both sides are empty so the option stays absent
 * entirely rather than being set to `{}`.
 */
export function mergeRequestHeaders(
  requestHeaders: Readonly<Record<string, string | null>> | undefined,
  authHeaders: Readonly<Record<string, string | null>> | undefined,
): Record<string, string> | undefined {
  if (requestHeaders === undefined && authHeaders === undefined) return undefined;
  const merged = { ...requestHeaders, ...authHeaders };
  // null is pi-ai's "do not send this header" (see createPiAuthResolver, which
  // filters it the same way). Because auth is spread last, a null there also
  // suppresses a request header of the same name, which is the reading that
  // keeps auth authoritative over the merge.
  return Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== null));
}
