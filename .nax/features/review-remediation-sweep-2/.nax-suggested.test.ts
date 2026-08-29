import { describe, expect, test } from "bun:test";

describe("review-remediation-sweep-2 acceptance", () => {
  /**
   * A fresh module instance so the module-level `servePortZeroCompatInstalled`
   * flag starts unset regardless of what earlier test files left behind — the
   * flag is sticky across imports of the same module specifier.
   */
  async function freshModule(tag: string) {
    return (await import(`@/interaction/plugins/webhook-serve-compat?rrs2=${tag}`)) as {
      installServePortZeroCompat: () => () => void;
    };
  }

  test("AC-1: second installServePortZeroCompat() call reference-shares patched globals and returns a no-op restore", async () => {
    const mod = await freshModule("ac1");

    const firstRestore = mod.installServePortZeroCompat();
    const serveAfterFirst = Bun.serve;
    const fetchAfterFirst = globalThis.fetch;

    const secondRestore = mod.installServePortZeroCompat();
    const serveAfterSecond = Bun.serve;
    const fetchAfterSecond = globalThis.fetch;

    // (1) Same patched function across both calls.
    expect(serveAfterSecond).toBe(serveAfterFirst);
    // (2) Same patched fetch across both calls.
    expect(fetchAfterSecond).toBe(fetchAfterFirst);

    // (3) The second call's restore is a no-op: invoking it must leave
    // Bun.serve and globalThis.fetch unchanged from their post-second-call values.
    secondRestore();
    expect(Bun.serve).toBe(serveAfterSecond);
    expect(globalThis.fetch).toBe(fetchAfterSecond);

    // Clean up: the first call's restore actually reinstates the originals.
    firstRestore();
  });
});