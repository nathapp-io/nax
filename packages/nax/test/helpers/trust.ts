/**
 * Test isolation for the process-scoped trust registry (US-002).
 *
 * `test/preload.ts` marks the filesystem root trusted so every test starts in a
 * trusted process -- the ~30 existing test files that call a now-gated seam
 * would otherwise be refused. A test of the *untrusted* path (a backstop
 * refusal) needs the opposite state, but clearing the registry itself leaks:
 * the preload's trust is gone for every later test file in the same process,
 * and a missed restore turns into a phantom failure somewhere else.
 *
 * Registering both halves here is the fix -- `beforeEach` clears, `afterEach`
 * restores the preload's state, so the leak cannot survive one test.
 *
 * ```ts
 * describe("loadPlugins", () => {
 *   useUntrustedRegistry();
 *   test("refuses a project plugin without trust", ...);
 * });
 * ```
 */

import { afterEach, beforeEach } from "bun:test";
import { markTrusted, resetTrustRegistry } from "@/trust";

/** The root `test/preload.ts` trusts, restored after each test. */
const PRELOADED_ROOT = "/";

/** Run the enclosing suite against an empty registry, restoring trust after. */
export function useUntrustedRegistry(): void {
  beforeEach(() => {
    resetTrustRegistry();
  });

  afterEach(() => {
    markTrusted(PRELOADED_ROOT);
  });
}
