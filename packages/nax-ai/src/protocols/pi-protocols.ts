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

import type { ProviderOverride } from "../providers/types.ts";
import type { CredentialStore } from "../types.ts";
import type { ClientApp } from "./client-app.ts";
import { recordDeclaredOverrides } from "./override-declaration.ts";
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
  /**
   * How the calling application names itself upstream, for providers that read
   * one off the request and report on it.
   *
   * Construction-time for the opposite reason to `transport`: this is
   * meaningful to every protocol, but it is a constant of the process rather
   * than of the work, so repeating it on each request would be noise. Which
   * header carries it — and for which vendor — is this package's business; see
   * client-app.ts.
   *
   * Omitted means nothing extra is sent, and the request is identified only by
   * pi-ai's own `User-Agent`.
   */
  readonly clientApp?: ClientApp;
  /**
   * Declaration-data overrides for the backend catalog, in the same shape and
   * with the same semantics as `ClientOptions.providerOverrides`.
   *
   * Both are needed, and they are not the same catalog. `ClientOptions`
   * patches the one `client.model()`, `listModels()` and `pricing()` read;
   * this one patches the catalog the protocol resolves against at request
   * time. Supplying only the first is issue #36: the model resolves and prices
   * correctly and then throws "Unknown model" on the first real request.
   *
   * Pass the same array to both. The array's identity is the cache key for the
   * backend catalog built from it (see createPiDeps in pi-client.ts), so
   * reusing one array is also what keeps the four protocol entries sharing a
   * single instance.
   *
   * Better still, declare it once by passing a factory as `ClientOptions.protocols`:
   * `protocols: (o) => defaultProtocols({ ...o, credentials })`. Whichever form
   * is used, createClient rejects at construction a client whose overrides the
   * protocol entries do not cover — see protocols/override-declaration.ts.
   */
  readonly providerOverrides?: readonly ProviderOverride[];
}

/** @deprecated Use {@link ProtocolOptions}. Kept as a non-breaking alias. */
export type PiProtocolOptions = ProtocolOptions;

export function defaultProtocols(options: ProtocolOptions = {}): ProtocolEntries {
  const entries: ProtocolEntries = Object.fromEntries(
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

  // Recorded even when absent or empty, which is the case that matters:
  // "these entries declared no overrides" is the signal createClient uses to
  // catch a consumer who patched only the client-side catalog (issue #36).
  // Omitting the call here would make that state indistinguishable from
  // hand-built entries, which the check deliberately leaves alone.
  recordDeclaredOverrides(entries, options.providerOverrides ?? []);
  return entries;
}

/** @deprecated Use {@link defaultProtocols}. Kept as a non-breaking alias. */
export const piProtocols = defaultProtocols;
