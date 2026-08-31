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

export const PI_PROTOCOL_NAMES = [
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
] as const;

export type PiProtocolName = (typeof PI_PROTOCOL_NAMES)[number];

export interface PiProtocolOptions {
  /** Where OAuth and api-key credentials live. Omitted means ambient only. */
  readonly credentials?: CredentialStore;
}

export function piProtocols(options: PiProtocolOptions = {}): ProtocolEntries {
  return Object.fromEntries(
    PI_PROTOCOL_NAMES.map((name) => [
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
