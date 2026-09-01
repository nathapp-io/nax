/**
 * The nax-ai client, built once per process.
 *
 * defaultProviders() loads nax-ai's bundled catalog (~1290 models), so building per
 * call would pay that cost on every completion. The build is memoised, but a
 * FAILED build is not: a transient failure must not poison the process.
 *
 * This file and its siblings are the only place in src/ permitted to import
 * nax-ai (scripts/check-nax-ai-imports.ts).
 */

import { type Client, createClient, defaultProtocols, defaultProviders } from "@nathapp/nax-ai";

import { naxCredentialStore } from "./credentials";

/**
 * The real builder. Exported on its own — not just as `_clientDeps.build` —
 * because test/preload.ts overwrites `_clientDeps.build` with a sentinel
 * before any test file loads (to stop a real client leaking into the
 * module-level cache across files), which would otherwise make this
 * synchronous, no-network construction path uncoverable by any test.
 */
export async function buildNativeClient(): Promise<Client> {
  return createClient({
    providers: await defaultProviders(),
    protocols: _clientDeps.defaultProtocols({
      // The credential seam: pi resolves the store first, then ambient sources
      // (env vars, AWS profiles, ADC), so a stored credential owns its provider
      // and CI with only an environment variable keeps working. Passing it here
      // is what makes `nax auth login` reach a run. This is the only inlet:
      // ClientOptions once carried a `credentials` field that createClient
      // never read, and nax-ai 0.1.4 removed it for exactly that reason.
      credentials: naxCredentialStore(),
    }),
  });
}

/**
 * Test seam. `build` is replaced in tests so no catalog is loaded and no
 * network is reached. `defaultProtocols` is separately injectable so a test can
 * observe what buildNativeClient passes it (the credentials wiring above)
 * without loading the real catalog — see client.test.ts.
 */
export const _clientDeps = {
  build: buildNativeClient,
  defaultProtocols,
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
