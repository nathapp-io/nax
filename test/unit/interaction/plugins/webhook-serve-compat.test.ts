/**
 * Tests for the Bun.serve port-0 compatibility shim (SEC-06).
 *
 * The shim previously installed unconditionally as a module-level side
 * effect of importing webhook.ts, and its compat-port counter could wrap
 * and silently overwrite a still-live in-memory server entry.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { installServePortZeroCompat } from "../../../../src/interaction/plugins/webhook-serve-compat";

describe("installServePortZeroCompat (SEC-06)", () => {
  const originalServe = Bun.serve;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    (Bun as { serve: typeof Bun.serve }).serve = originalServe;
    globalThis.fetch = originalFetch;
  });

  test("installing is idempotent and only patches globals once", () => {
    installServePortZeroCompat();
    const patchedServe = Bun.serve;
    const patchedFetch = globalThis.fetch;

    installServePortZeroCompat();
    expect(Bun.serve).toBe(patchedServe);
    expect(globalThis.fetch).toBe(patchedFetch);
  });
});

describe("webhook.ts does not install the compat shim at module scope (SEC-06)", () => {
  test("installServePortZeroCompat() is not called at the top level of webhook.ts", async () => {
    // Regression guard: the shim used to run as a module-level side effect
    // of importing webhook.ts (monkey-patching Bun.serve/fetch process-wide
    // merely by being imported, e.g. via the plugin registry, even when the
    // webhook plugin is never configured). It must now be called only from
    // inside startServer(), not at module scope.
    const source = await Bun.file(
      new URL("../../../../src/interaction/plugins/webhook.ts", import.meta.url),
    ).text();
    const topLevelCall = /^installServePortZeroCompat\(\);\s*$/m;
    expect(topLevelCall.test(source)).toBe(false);
    expect(source).toContain("installServePortZeroCompat();");
  });
});
