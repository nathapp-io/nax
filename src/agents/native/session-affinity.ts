/**
 * Session affinity for native requests.
 *
 * Providers route a session's requests to the same backend when they can
 * recognise the session, which is what keeps a prompt cache warm across the
 * turns of one conversation. Nothing beneath us does this today: pi-ai has the
 * machinery but gates it on a `sessionId` nax-ai never passes, and its flag
 * defaults off. So the id is ours to supply.
 *
 * The split here is the point. `nativeSessionId` is provider-agnostic — every
 * native session has one id, derived identically no matter who serves the
 * request. Only the *spelling* is per-vendor, because vendors disagree on the
 * header name. That keeps this from being an opencode special case: supporting
 * another vendor is a row in AFFINITY_HEADERS, not a second concept.
 *
 * The id is a hash, never the session name. nax builds session ids from role,
 * story and feature ("implementer-US-001-auth-system"), so sending one raw
 * would hand a third party the shape of a private repository's work for no
 * gain — a provider needs an opaque token it can match, and nothing else.
 * Hashing also makes the value a legal header value by construction, whatever
 * the id happened to contain.
 */

import { createHash, randomUUID } from "node:crypto";

/** 128 bits of a SHA-256, far past collision concerns for routing. */
const ID_LENGTH = 32;

/**
 * The session id, independent of who will serve the request.
 *
 * Deliberately not memoised: it is a hash of its input, so it is already stable
 * for a given session, and a cache keyed on session ids would outlive the runs
 * that created them.
 */
export function nativeSessionId(sessionKey: string): string {
  return createHash("sha256").update(sessionKey).digest("hex").slice(0, ID_LENGTH);
}

/**
 * One key for the whole process, used by the sessionless one-shot path.
 *
 * `complete()` has no session to name — it is a single call with no successor.
 * A fresh key per call would satisfy the letter of the header and defeat its
 * purpose, since affinity only pays when two requests share an id; a constant
 * would collide across concurrent nax processes. One id per process gives the
 * one-shots of a run a warm cache without pretending they are a conversation.
 */
const PROCESS_SESSION_KEY = randomUUID();

export function oneShotSessionKey(): string {
  return PROCESS_SESSION_KEY;
}

/**
 * Header name per provider id.
 *
 * Every entry needs a source; guessing a header name achieves nothing and sends
 * an identifier to a vendor that never asked for one.
 *
 *  - `opencode` (Zen, https://opencode.ai/zen) and `opencode-go`
 *    (https://opencode.ai/zen/go) are separate catalog entries for the same
 *    service. https://opencode.ai/docs/go/ documents `x-opencode-session`, and
 *    OpenCode has said requests without it may start erroring. Both are listed:
 *    gating on the `-go` one alone would leave Zen unheadered.
 *  - `openrouter` takes `x-session-id`, which is what pi-ai sends for it
 *    (`openai-completions.js`, sessionAffinityFormat "openrouter").
 *
 * Absent on purpose: the openai-format providers. pi-ai spells those
 * `session_id` / `x-client-request-id`, but it selects that from a per-MODEL
 * `compat.sessionAffinityFormat`, and nax-ai's ResolvedModel does not expose
 * it. Keying those off a provider id would be a different rule wearing the same
 * name, so they wait for the model property to become visible.
 */
const AFFINITY_HEADERS: Readonly<Record<string, string>> = {
  opencode: "x-opencode-session",
  "opencode-go": "x-opencode-session",
  openrouter: "x-session-id",
};

/**
 * Returns undefined — not an empty object — when a provider has no known
 * header, so the caller spreads nothing at all.
 */
export function sessionAffinityHeaders(
  provider: string,
  sessionKey: string,
): Readonly<Record<string, string>> | undefined {
  const header = AFFINITY_HEADERS[provider];
  if (header === undefined) return undefined;
  return { [header]: nativeSessionId(sessionKey) };
}
