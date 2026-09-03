/**
 * Session identity for native requests.
 *
 * nax owns what a session *is*; nax-ai owns how one reaches a provider. So this
 * file derives an id and stops there — which header carries it, and for which
 * vendor, is nax-ai's business (`vendorSessionHeaders`, plus everything pi-ai
 * already derives from a per-model affinity format and the prompt-cache key).
 * An earlier revision kept that mapping here, which meant nax had learned a
 * vendor vocabulary it has no reason to know.
 *
 * The id is a hash, never the session name. nax builds session ids from role,
 * story and feature ("implementer-US-001-auth-system"), so sending one raw
 * would hand a third party the shape of a private repository's work for no
 * gain — a provider needs an opaque token it can match, and nothing else.
 * Hashing also makes the value safe to put on the wire by construction,
 * whatever the id happened to contain.
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
 * A fresh key for a caller that has no session id of its own.
 *
 * `complete()` is one call with no successor, so there is nothing to name. A
 * fresh key per *call* would satisfy the letter of it and defeat the purpose,
 * since affinity only pays when two requests share an id. The adapter holds one
 * of these for its own lifetime, which the agent registry's adapter cache
 * scopes to a run, so the one-shots of a run share a backend while unrelated
 * runs do not.
 */
export function newSessionKey(): string {
  return randomUUID();
}
