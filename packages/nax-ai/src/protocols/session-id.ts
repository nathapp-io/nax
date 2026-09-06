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
 * That forwarding is necessary but not sufficient: pi-ai sends an affinity
 * header only where a model's catalog entry also sets
 * `compat.sendSessionAffinityHeaders`, which defaults to false. So a provider
 * belongs in the table below whenever pi-ai will not put the id on the wire —
 * whether it lacks the spelling or simply never enables it.
 *
 * Two providers are exceptions, for different reasons — see the table.
 */

/**
 * Providers whose header pi-ai does not send.
 *
 * `opencode` (Zen, https://opencode.ai/zen) and `opencode-go`
 * (https://opencode.ai/zen/go) are separate catalog entries for one service;
 * https://opencode.ai/docs/go/ documents `x-opencode-session`, and OpenCode has
 * said requests without it may start erroring. Both are listed — gating on the
 * `-go` one alone would leave Zen unheadered. pi-ai has no support for this
 * header at any version.
 *
 * `openrouter` is a different failure. pi-ai *does* know the spelling: a model
 * whose `compat.sessionAffinityFormat` is "openrouter" gets `x-session-id`
 * (dist/api/openai-completions.js). But the branch is guarded by
 * `compat.sendSessionAffinityHeaders`, which `detectCompat` sets to false and
 * which not one openrouter catalog entry overrides, so the format never fires.
 * The id was reaching pi and being dropped a layer above the socket: every
 * OpenRouter generation record came back with `session_id: null`, and with it
 * no sticky routing to the endpoint holding the warm cache. OpenRouter reads
 * the header as its routing key and reports it per generation
 * (https://openrouter.ai/blog/tutorials/prompt-caching-sticky-routing/); a
 * body-level `session_id` would do the same, but no request field on this path
 * reaches the body.
 *
 * Listing it here rather than setting the compat flag is not a preference:
 * `ProviderOverride` deliberately exposes no `compat` (see providers/types.ts),
 * so the vendor table is the only lever this package has. It is also the more
 * durable one — provider-keyed rather than api-keyed, so it covers OpenRouter's
 * `anthropic-messages` entries as well as its `openai-completions` ones. If
 * pi-ai ever flips the gate, both sides write the same name and the same value
 * and the merge is a no-op.
 */
const VENDOR_SESSION_HEADERS: Readonly<Record<string, string>> = {
  opencode: "x-opencode-session",
  "opencode-go": "x-opencode-session",
  openrouter: "x-session-id",
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
