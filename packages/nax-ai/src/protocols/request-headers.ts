/**
 * Per-request headers: validation at the boundary, and precedence against auth.
 *
 * A neutral map, and the escape hatch for anything not modelled: a consumer can
 * always spell a header itself here.
 *
 * An earlier revision of this comment said the package "must not grow a
 * `sessionId` field or a vendor's header name". That was overdrawn and
 * `session-id.ts` now does both. The line worth keeping is narrower: nax-ai
 * must not learn what a consumer's session *is*. Carrying an opaque id that
 * pi-ai already models on its own stream options, and knowing which vendor
 * spells it in which header, is wire knowledge — which is precisely what this
 * package exists to hold. See session-id.ts for the full argument.
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
 *
 * Deliberately not a forbidden-NAME list: `host`, `content-length` and
 * `connection` are legal tokens and pass this check. undici refuses to let a
 * caller set them, so duplicating its list here would drift from it.
 */
const FORBIDDEN_IN_VALUE = /[\r\n\0]/;

/**
 * Checked as well as the syntax rules because this is a published package with
 * untyped consumers. A non-string slipped through as `String(value)` in the
 * regex test and was then dropped silently by the null filter below, so a JS
 * caller's mistake became a missing header rather than an error.
 */
function assertHeaderValue(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`Invalid header value for ${JSON.stringify(name)}: expected a string, got ${typeof value}.`);
  }
  if (FORBIDDEN_IN_VALUE.test(value)) {
    throw new Error(`Invalid header value for ${JSON.stringify(name)}: it may not contain CR, LF or NUL.`);
  }
}

export function assertValidHeaders(headers: Readonly<Record<string, string | null>> | undefined): void {
  if (headers === undefined) return;
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(name)) {
      throw new Error(`Invalid header name ${JSON.stringify(name)}: expected an RFC 9110 token.`);
    }
    assertHeaderValue(name, value);
  }
}

/**
 * A session id becomes a header value — here for the vendor header, and inside
 * pi-ai for the affinity ones — so it needs the same check. Without this, the
 * identical bad string produced a named error through `headers` and an opaque
 * one from inside a provider SDK through `sessionId`.
 */
export function assertValidSessionId(sessionId: string | undefined): void {
  if (sessionId === undefined) return;
  assertHeaderValue("sessionId", sessionId);
}

/** `{}` collapsed to undefined, so an empty map never reaches the wire as one. */
export function withoutEmpty<T>(headers: Readonly<Record<string, T>>): Readonly<Record<string, T>> | undefined {
  return Object.keys(headers).length === 0 ? undefined : headers;
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
  // Header names are case-insensitive on the wire but case-sensitive as object
  // keys, so `Authorization` and `authorization` would both survive a plain
  // spread. pi happens to re-merge case-insensitively with auth last, but that
  // makes the guarantee pi's rather than ours — and a backend handing this map
  // straight to fetch would get "a, b" as one corrupted credential. Drop the
  // request-side spelling instead of relying on someone else's dedup.
  const authNames = new Set(Object.keys(authHeaders ?? {}).map((name) => name.toLowerCase()));
  const keptRequestHeaders = Object.fromEntries(
    Object.entries(requestHeaders ?? {}).filter(([name]) => !authNames.has(name.toLowerCase())),
  );
  const merged = { ...keptRequestHeaders, ...authHeaders };
  // null is pi-ai's "do not send this header" (see createPiAuthResolver, which
  // filters it the same way). Because auth is spread last, a null there also
  // suppresses a request header of the same name, which is the reading that
  // keeps auth authoritative over the merge.
  return Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== null));
}
