/**
 * Injectable externals for the webhook interaction plugin, split out of
 * webhook.ts (file-size limit).
 */

import { sleep } from "@/utils/bun-deps";

/** @internal test seam — see each field for what it exists for. */
export const _webhookPluginDeps = {
  /** Injectable sleep — kept for backward compat with tests; unused by receive() (event-driven delivery). */
  sleep,
  /** Injectable clock for the rate limiter (SEC-8); tests advance it to exercise fixed-window rollover. */
  now: () => Date.now(),
  /**
   * Injectable outbound fetch for send(). Mirrors `_telegramPluginDeps.fetch` —
   * tests stub this rather than `globalThis.fetch`, which leaks across files and
   * (via the compat shim installed by startServer) can outlive the test that set
   * it. Delegates per call instead of binding at module load, so it still sees
   * the shim's patched global while a callback server is live.
   */
  fetch: (input: string | URL | Request, init?: RequestInit): Promise<Response> => globalThis.fetch(input, init),
};
