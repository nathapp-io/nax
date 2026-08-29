/**
 * Tests for the Bun.serve port-0 compatibility shim (SEC-06).
 *
 * The shim previously installed unconditionally as a module-level side
 * effect of importing webhook.ts, and its compat-port counter could wrap
 * and silently overwrite a still-live in-memory server entry.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { installServePortZeroCompat } from "@/interaction/plugins/webhook-serve-compat";

describe("installServePortZeroCompat (SEC-06)", () => {
  const originalServe = Bun.serve;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    (Bun as { serve: typeof Bun.serve }).serve = originalServe;
    globalThis.fetch = originalFetch;
  });

  /**
   * A fresh module instance per call, so `servePortZeroCompatInstalled` starts
   * false regardless of what earlier tests in this file or sibling files left
   * behind (the flag is module-level and sticky). Without this, AC3/AC4 would
   * silently no-op — and not patch — whenever the shared module's flag is
   * already set by an earlier install that was never restored.
   */
  async function freshInstall(tag: string): Promise<() => void> {
    const mod = (await import(`@/interaction/plugins/webhook-serve-compat?sec06=${tag}`)) as {
      installServePortZeroCompat: () => () => void;
    };
    return mod.installServePortZeroCompat();
  }

  test("installing is idempotent and only patches globals once", () => {
    const firstRestore = installServePortZeroCompat();
    const patchedServe = Bun.serve;
    const patchedFetch = globalThis.fetch;

    // The contract added by US-004: installServePortZeroCompat() returns a
    // restore function. The first call's restore reinstates the originals;
    // a re-entrant call must return a no-op so it cannot uninstall the
    // first caller's patch.
    const secondRestore = installServePortZeroCompat() as unknown;
    expect(typeof secondRestore).toBe("function");
    expect(Bun.serve).toBe(patchedServe);
    expect(globalThis.fetch).toBe(patchedFetch);
    // AC5 (US-004): the second call's restore is a no-op. Invoking it must
    // leave Bun.serve and globalThis.fetch still equal to the patched functions
    // the first call installed — the second caller cannot uninstall the first
    // caller's patch.
    (secondRestore as () => void)();
    expect(Bun.serve).toBe(patchedServe);
    expect(globalThis.fetch).toBe(patchedFetch);
    // Clean up: the first call's restore reinstates the originals. Without it the
    // module-level installation flag stays set, making every later install in this
    // file a no-op (the AC3/AC4 tests below assert a genuine first install).
    (firstRestore as () => void)();
  });

  test("AC3: the first install returns a restore whose invocation reinstates the pre-install globalThis.fetch", async () => {
    const firstRestore = await freshInstall("ac3");
    expect(typeof firstRestore).toBe("function");
    expect(globalThis.fetch).not.toBe(originalFetch);

    firstRestore();
    expect(globalThis.fetch).toBe(originalFetch);
  });

  test("AC4: the first install returns a restore whose invocation reinstates the pre-install Bun.serve", async () => {
    const firstRestore = await freshInstall("ac4");
    expect(typeof firstRestore).toBe("function");
    expect(Bun.serve).not.toBe(originalServe);

    firstRestore();
    expect(Bun.serve).toBe(originalServe);
  });
});

describe("the in-memory fallback server", () => {
  const originalServe = Bun.serve;
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    (Bun as { serve: typeof Bun.serve }).serve = originalServe;
    globalThis.fetch = originalFetch;
  });

  /**
   * A fresh module instance per call. `servePortZeroCompatInstalled` is
   * module-level state, so the sibling describe's install() would otherwise
   * make this one a no-op: the flag stays true across the afterEach that
   * restores the globals, and the shim would never re-patch.
   */
  async function freshShim(tag: string): Promise<{ install: () => void }> {
    const mod = (await import(`@/interaction/plugins/webhook-serve-compat?compat=${tag}`)) as {
      installServePortZeroCompat: () => void;
    };
    return { install: mod.installServePortZeroCompat };
  }

  test("passes the handler a real server object for `this` and for `server`", async () => {
    // The two arguments were `undefined as never` — a lie the bottom type
    // hid. Any handler that read `server.port` (or anything else Bun passes)
    // got a TypeError on undefined instead. They are the same value Bun
    // would pass: the server being created.
    let seenServer: unknown;
    let seenThis: unknown;

    // Force the in-memory path: the shim captures Bun.serve at install time
    // and only falls back when that captured serve throws.
    (Bun as { serve: typeof Bun.serve }).serve = (() => {
      throw new Error("no network permission");
    }) as typeof Bun.serve;

    const { install } = await freshShim("server-arg");
    install();

    const server = Bun.serve({
      port: 0,
      fetch(this: unknown, _req: Request, passed: unknown) {
        seenThis = this;
        seenServer = passed;
        return new Response("ok");
      },
    });

    const response = await fetch(`http://localhost:${server.port}/nax/interact/probe`);
    expect(await response.text()).toBe("ok");

    expect(seenServer).toBeDefined();
    // Identity, not port equality — strictly the stronger claim, and the one
    // Bun makes: the handler is handed the very object `serve()` returned.
    expect(seenServer).toBe(server);
    // Bun passes that same server as `this` as well as as the second argument.
    expect(seenThis).toBe(server);

    await server.stop();
  });
});

describe("webhook.ts does not install the compat shim at module scope (SEC-06)", () => {
  test("installServePortZeroCompat() is not called at the top level of webhook.ts", async () => {
    // Regression guard: the shim used to run as a module-level side effect
    // of importing webhook.ts (monkey-patching Bun.serve/fetch process-wide
    // merely by being imported, e.g. via the plugin registry, even when the
    // webhook plugin is never configured). It must now be called only from
    // inside startServer(), not at module scope.
    const source = await Bun.file(new URL("../../../../src/interaction/plugins/webhook.ts", import.meta.url)).text();
    const topLevelCall = /^installServePortZeroCompat\(\);\s*$/m;
    expect(topLevelCall.test(source)).toBe(false);
    expect(source).toContain("installServePortZeroCompat();");
  });
});
