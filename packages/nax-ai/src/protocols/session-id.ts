/**
 * Vendor spellings of a session id.
 *
 * A session id is a wire concern, not a consumer concept. The scope statement
 * in src/index.ts keeps this package clear of consumer vocabulary — including
 * the word "sessions" — and carrying an id does not breach it: pi-ai already
 * models `sessionId` on its own stream options, so this mirrors an upstream
 * primitive rather than importing anyone's domain. What a session *is* remains
 * entirely the consumer's to decide.
 *
 * Most vendors need nothing here. Passing `sessionId` to pi-ai is what makes
 * `x-session-id`, `session_id`, `x-client-request-id` and `x-session-affinity`
 * appear, each selected from a per-model `compat.sessionAffinityFormat`, and
 * the same value keys prompt caching. Reimplementing that mapping would
 * duplicate a table pi-ai maintains against the model catalog.
 *
 * OpenCode is the exception: pi-ai has no support for its header at any
 * version, so it is added here.
 */

/**
 * Providers whose header pi-ai does not send.
 *
 * `opencode` (Zen, https://opencode.ai/zen) and `opencode-go`
 * (https://opencode.ai/zen/go) are separate catalog entries for one service;
 * https://opencode.ai/docs/go/ documents `x-opencode-session`, and OpenCode has
 * said requests without it may start erroring. Both are listed — gating on the
 * `-go` one alone would leave Zen unheadered.
 */
const VENDOR_SESSION_HEADERS: Readonly<Record<string, string>> = {
  opencode: "x-opencode-session",
  "opencode-go": "x-opencode-session",
};

/**
 * Returns undefined — not an empty object — whenever there is nothing to add,
 * so a caller merges nothing at all.
 */
export function vendorSessionHeaders(
  provider: string,
  sessionId: string | undefined,
): Readonly<Record<string, string>> | undefined {
  if (sessionId === undefined || sessionId === "") return undefined;
  // Own properties only: a plain object literal inherits `constructor`,
  // `toString` and friends, and indexing it with one of those provider names
  // would produce a header named after a function body.
  if (!Object.hasOwn(VENDOR_SESSION_HEADERS, provider)) return undefined;
  const header = VENDOR_SESSION_HEADERS[provider];
  if (header === undefined) return undefined;
  return { [header]: sessionId };
}
