/**
 * The auth port.
 *
 * pi-ai resolves credentials today, but a hand-written backend will need the
 * same thing and must not import pi-ai to get it. Keeping the port here, in
 * nax-ai's own vocabulary, is what stops "delete the pi backend" from also
 * deleting credential handling.
 */

import type { ModelRef } from "../types.ts";

/**
 * Request auth for one call.
 *
 * There is deliberately no `baseUrl`: it belongs to the model, and the
 * upstream request options have no per-request slot for it.
 */
export interface ResolvedAuth {
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface AuthResolver {
  /**
   * Refreshes an expired OAuth token as a side effect, under the store lock.
   *
   * Takes a `ModelRef` rather than a `ResolvedModel` so the pi protocol, which
   * holds a pi-ai model, can call this without first round-tripping through
   * the catalog.
   */
  resolve(ref: ModelRef): Promise<ResolvedAuth>;
}
