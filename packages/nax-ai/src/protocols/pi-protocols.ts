/**
 * The registration surface for the pi-backed protocols.
 *
 * A consumer cannot assemble these entries itself: the four protocols must
 * share one pi-ai Models instance, and therefore one credential store and one
 * catalog, rather than constructing four. That is why this is exported rather
 * than documented.
 *
 * pi-ai is not imported here. The factory is lazy, so the import cost is paid
 * on first resolve of a protocol and not before.
 */

import type { CredentialStore } from "../types.ts";
import type { ProtocolEntries } from "./registry.ts";
import type { Transport } from "./types.ts";

/**
 * Neutral names for this module's public surface.
 *
 * This package exists to hide pi-ai behind its own vocabulary — that is its
 * whole reason to exist. Naming the public API after "pi" defeats that: the
 * name either starts lying the day the backend stops being pi-ai, or forces a
 * breaking rename at exactly the moment the internals change. `DEFAULT_*` /
 * `default*` name what these are (the client's default, pi-backed protocol
 * set), not what implements them today.
 */
export const DEFAULT_PROTOCOL_NAMES = [
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
] as const;

/** @deprecated Use {@link DEFAULT_PROTOCOL_NAMES}. Kept as a non-breaking alias. */
export const PI_PROTOCOL_NAMES = DEFAULT_PROTOCOL_NAMES;

export type ProtocolName = (typeof DEFAULT_PROTOCOL_NAMES)[number];

/** @deprecated Use {@link ProtocolName}. Kept as a non-breaking alias. */
export type PiProtocolName = ProtocolName;

export interface ProtocolOptions {
  /** Where OAuth and api-key credentials live. Omitted means ambient only. */
  readonly credentials?: CredentialStore;
  /**
   * Preferred transport, defaulting to "sse" rather than to pi-ai's "auto".
   *
   * Only openai-codex-responses offers a choice; the other three ignore this.
   * pi-ai prefers WebSocket there, and a WebSocket has no HTTP response for
   * the classifier's onResponse hook to observe, so every failure over it
   * classifies as "unknown" with no status and no retry-after — a rate limit
   * becomes invisible to a consumer's backoff. Correct classification is worth
   * more than Codex's cached-context path, so that is the default; pass "auto"
   * to trade back.
   *
   * Construction-time rather than per-request: it is meaningful to one of the
   * four protocols, and ProtocolRequest is the shared protocol-agnostic type.
   */
  readonly transport?: Transport;
}

/** @deprecated Use {@link ProtocolOptions}. Kept as a non-breaking alias. */
export type PiProtocolOptions = ProtocolOptions;

export function defaultProtocols(options: ProtocolOptions = {}): ProtocolEntries {
  return Object.fromEntries(
    DEFAULT_PROTOCOL_NAMES.map((name) => [
      name,
      {
        pi: async () => {
          const { createPiDeps, createPiProtocol } = await import("./pi-client.ts");
          return createPiProtocol(name, createPiDeps(options));
        },
      },
    ]),
  );
}

/** @deprecated Use {@link defaultProtocols}. Kept as a non-breaking alias. */
export const piProtocols = defaultProtocols;
