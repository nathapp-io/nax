/**
 * The nax-ai client, built once per process.
 *
 * piProviders() loads nax-ai's bundled catalog (~1290 models), so building per
 * call would pay that cost on every completion. The build is memoised, but a
 * FAILED build is not: a transient failure must not poison the process.
 *
 * This file and its siblings are the only place in src/ permitted to import
 * nax-ai (scripts/check-nax-ai-imports.ts).
 */

import { type Client, createClient, piProtocols, piProviders } from "@nathapp/nax-ai";

/** Test seam: replaced in tests so no catalog is loaded and no network is reached. */
export const _clientDeps = {
  build: async (): Promise<Client> =>
    createClient({
      providers: await piProviders(),
      protocols: piProtocols(),
    }),
};

let cached: Promise<Client> | undefined;

export async function getNativeClient(): Promise<Client> {
  if (cached === undefined) {
    // Cache the promise, not the value, so concurrent callers share one build.
    // Drop it on rejection: a failed catalog load should not be permanent.
    cached = _clientDeps.build().catch((err: unknown) => {
      cached = undefined;
      throw err;
    });
  }
  return cached;
}

/** Clears the memo. Tests only. */
export function _resetNativeClient(): void {
  cached = undefined;
}
