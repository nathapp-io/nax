/**
 * Tests for the Bun.serve port-0 compatibility shim (SEC-06).
 *
 * The shim previously installed unconditionally as a module-level side
 * effect of importing webhook.ts, and its compat-port counter could wrap
 * and silently overwrite a still-live in-memory server entry.
 *
 * All tests use the plain static import plus `_resetServePortZeroCompatForTests()`
 * for isolation — never a cache-busted dynamic re-import. Bun's coverage
 * instrumentation cannot merge line hits across multiple instances of the
 * same source file, so re-importing this module with a unique query string
 * per test corrupts this file's own reported coverage (see the docstring on
 * `_resetServePortZeroCompatForTests`, which exists precisely to give a test
 * a clean slate against the ONE shared module instance instead).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mockFetch } from "@test/helpers";
import {
  _resetServePortZeroCompatForTests,
  installServePortZeroCompat,
} from "@/interaction/plugins/webhook-serve-compat";

describe("installServePortZeroCompat (SEC-06)", () => {
  const originalServe = Bun.serve;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    _resetServePortZeroCompatForTests();
  });

  afterEach(() => {
    _resetServePortZeroCompatForTests();
    (Bun as { serve: typeof Bun.serve }).serve = originalServe;
    globalThis.fetch = originalFetch;
  });

  test("installing is idempotent and only patches globals once", () => {
    const firstRestore = installServePortZeroCompat();
    const patchedServe = Bun.serve;
    const patchedFetch = globalThis.fetch;

    // The contract added by US-004 (and reference-counted by a later fix, see
    // the "concurrent installs" test below): installServePortZeroCompat()
    // returns a restore function. Restores are reference-counted, not
    // unconditional no-ops — the globals stay patched until every
    // outstanding install has been restored, regardless of order.
    const secondRestore = installServePortZeroCompat() as unknown;
    expect(typeof secondRestore).toBe("function");
    expect(Bun.serve).toBe(patchedServe);
    expect(globalThis.fetch).toBe(patchedFetch);
    // AC5 (US-004): invoking the second call's restore decrements the
    // refcount but does not reinstate the originals — the first caller's
    // install is still outstanding, so Bun.serve and globalThis.fetch stay
    // equal to the patched functions the first call installed.
    (secondRestore as () => void)();
    expect(Bun.serve).toBe(patchedServe);
    expect(globalThis.fetch).toBe(patchedFetch);
    // Clean up: the first call's restore reinstates the originals. Without it the
    // module-level installation flag stays set, making every later install in this
    // file a no-op (the AC3/AC4 tests below assert a genuine first install).
    (firstRestore as () => void)();
  });

  test("AC3: the first install returns a restore whose invocation reinstates the pre-install globalThis.fetch", () => {
    const firstRestore = installServePortZeroCompat();
    expect(typeof firstRestore).toBe("function");
    expect(globalThis.fetch).not.toBe(originalFetch);

    firstRestore();
    expect(globalThis.fetch).toBe(originalFetch);
  });

  test("AC4: the first install returns a restore whose invocation reinstates the pre-install Bun.serve", () => {
    const firstRestore = installServePortZeroCompat();
    expect(typeof firstRestore).toBe("function");
    expect(Bun.serve).not.toBe(originalServe);

    firstRestore();
    expect(Bun.serve).toBe(originalServe);
  });

  test("concurrent installs are reference-counted: the patch survives until the last restore", () => {
    // This is the regression guard for the review finding: a re-entrant install
    // must not leave the first server's restore able to tear down a shim a
    // second, still-active server depends on.
    const firstRestore = installServePortZeroCompat();
    const patchedServe = Bun.serve;
    const patchedFetch = globalThis.fetch;
    const secondRestore = installServePortZeroCompat();
    expect(Bun.serve).toBe(patchedServe);
    expect(globalThis.fetch).toBe(patchedFetch);

    // The first server is destroyed first — its restore must NOT tear down the
    // shim the still-active second server depends on.
    firstRestore();
    expect(Bun.serve).toBe(patchedServe);
    expect(globalThis.fetch).toBe(patchedFetch);

    // Only the last active caller's restore reinstates the originals.
    secondRestore();
    expect(Bun.serve).toBe(originalServe);
    expect(globalThis.fetch).toBe(originalFetch);
  });
});

describe("the in-memory fallback server", () => {
  const originalServe = Bun.serve;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    _resetServePortZeroCompatForTests();
  });

  afterEach(() => {
    _resetServePortZeroCompatForTests();
    (Bun as { serve: typeof Bun.serve }).serve = originalServe;
    globalThis.fetch = originalFetch;
  });

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

    installServePortZeroCompat();

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

describe("the in-memory fallback server — edge branches", () => {
  const originalServe = Bun.serve;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    _resetServePortZeroCompatForTests();
  });

  afterEach(() => {
    _resetServePortZeroCompatForTests();
    (Bun as { serve: typeof Bun.serve }).serve = originalServe;
    globalThis.fetch = originalFetch;
  });

  test("throws WEBHOOK_SERVE_SHIM_NO_FETCH when the fallback is invoked with no fetch handler", () => {
    (Bun as { serve: typeof Bun.serve }).serve = (() => {
      throw new Error("no network permission");
    }) as typeof Bun.serve;

    installServePortZeroCompat();

    // `routes` makes `fetch` optional in Bun.serve's own type — no cast
    // needed to construct a validly-typed options object with no fetch
    // handler, which is exactly the shape the shim must reject at runtime.
    expect(() => Bun.serve({ port: 0, routes: {} })).toThrow("Bun.serve compatibility shim requires a fetch handler");
  });

  test("a nonzero requested port that the real serve rejects falls back to that same port", async () => {
    (Bun as { serve: typeof Bun.serve }).serve = (() => {
      throw new Error("no network permission");
    }) as typeof Bun.serve;

    installServePortZeroCompat();

    const server = Bun.serve({ port: 45123, fetch: () => new Response("ok") });
    expect(server.port).toBe(45123);
    await server.stop();
  });

  test("requesting a port already backed by an in-memory server reassigns via the compat counter", async () => {
    (Bun as { serve: typeof Bun.serve }).serve = (() => {
      throw new Error("no network permission");
    }) as typeof Bun.serve;

    installServePortZeroCompat();

    const first = Bun.serve({ port: 45124, fetch: () => new Response("first") });
    expect(first.port).toBe(45124);

    // Second serve() call for the SAME port, while the first in-memory server
    // still holds it — must be reassigned to a different compat port rather
    // than silently overwriting the first server's map entry.
    const second = Bun.serve({ port: 45124, fetch: () => new Response("second") });
    expect(second.port).not.toBe(45124);

    await first.stop();
    await second.stop();
  });

  test("the patched fetch passes non-callback requests through to the original fetch", async () => {
    const passthroughCalls: string[] = [];
    globalThis.fetch = (async (input: Request | string | URL) => {
      passthroughCalls.push(String(input));
      return new Response("passthrough");
    }) as typeof globalThis.fetch;

    (Bun as { serve: typeof Bun.serve }).serve = (() => {
      throw new Error("no network permission");
    }) as typeof Bun.serve;

    const restore = installServePortZeroCompat();

    // Not the nax callback path prefix, so the shim must delegate to the
    // captured original fetch rather than intercepting it.
    const response = await fetch("http://localhost:45125/some/other/path");
    expect(await response.text()).toBe("passthrough");
    expect(passthroughCalls).toContain("http://localhost:45125/some/other/path");

    restore();
  });

  test("_resetServePortZeroCompatForTests restores the pre-install globals and clears the install flag", () => {
    (Bun as { serve: typeof Bun.serve }).serve = (() => {
      throw new Error("no network permission");
    }) as typeof Bun.serve;
    const throwingServe = Bun.serve;
    const preInstallFetch = globalThis.fetch;

    installServePortZeroCompat();
    expect(Bun.serve).not.toBe(throwingServe);
    expect(globalThis.fetch).not.toBe(preInstallFetch);

    _resetServePortZeroCompatForTests();

    expect(Bun.serve).toBe(throwingServe);
    expect(globalThis.fetch).toBe(preInstallFetch);

    // The install flag was force-cleared, so installing again must genuinely
    // re-patch rather than silently no-op as a stale re-entrant call.
    const secondRestore = installServePortZeroCompat();
    expect(Bun.serve).not.toBe(throwingServe);
    secondRestore();
    expect(Bun.serve).toBe(throwingServe);
  });

  test("the patched fetch delegates inputs it cannot parse instead of rejecting them itself", async () => {
    // The shim used to build a throwaway `new Request(input, init)` just to
    // read `.url`. That constructor is stricter than the fetch it fronts, so
    // an input the underlying fetch would have accepted -- a relative URL,
    // which a polyfill or a test double can resolve against its own base --
    // was rejected by the shim before the real fetch ever saw it. The shim's
    // job is to intercept nax's own callback route, not to police URLs.
    const seen: string[] = [];
    globalThis.fetch = mockFetch(async (input) => {
      seen.push(String(input));
      return new Response("resolved-by-the-original");
    });

    (Bun as { serve: typeof Bun.serve }).serve = (() => {
      throw new Error("no network permission");
    }) as typeof Bun.serve;

    const restore = installServePortZeroCompat();
    try {
      const response = await fetch("/not/an/absolute/url");
      expect(await response.text()).toBe("resolved-by-the-original");
      expect(seen).toEqual(["/not/an/absolute/url"]);
    } finally {
      restore();
    }
  });

  test("restore does NOT clobber a globalThis.fetch installed after the shim was installed", async () => {
    // Regression guard. The restore used to reinstate the captured pre-install
    // global unconditionally. That made this sequence -- which is exactly what
    // a plugin test doing "stub fetch -> send() -> unstub fetch -> destroy()"
    // performs -- resurrect a dead stub over the live fetch, for the rest of
    // the process: `bun test` runs every file in one process, so every later
    // fetch in every later file failed with the stub's error, surfacing as an
    // unhandled rejection blamed on whichever unrelated test was running.
    const stub = mockFetch(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });

    globalThis.fetch = stub;
    // Install while the stub is live, so the stub is what gets captured as
    // "the original" -- the precondition for the old clobber.
    const restore = installServePortZeroCompat();

    // Something else puts a different fetch back before the restore runs.
    const replacement = mockFetch(async () => new Response("live"));
    globalThis.fetch = replacement;

    restore();

    // The replacement survives; the stale stub is not resurrected.
    expect(globalThis.fetch).toBe(replacement);
    const response = await globalThis.fetch("http://localhost:45126/x");
    expect(await response.text()).toBe("live");
  });

  test("_resetServePortZeroCompatForTests also leaves a post-install globalThis.fetch alone", () => {
    globalThis.fetch = mockFetch(async () => new Response("captured-at-install"));
    installServePortZeroCompat();

    const replacement = mockFetch(async () => new Response("live"));
    globalThis.fetch = replacement;

    _resetServePortZeroCompatForTests();

    expect(globalThis.fetch).toBe(replacement);
  });

  test("_resetServePortZeroCompatForTests is a no-op when nothing is installed", () => {
    // Guards the `if (servePortZeroCompatInstalled)` early-return branch —
    // called with no prior install, it must not throw or touch the globals.
    expect(() => _resetServePortZeroCompatForTests()).not.toThrow();
    expect(Bun.serve).toBe(originalServe);
    expect(globalThis.fetch).toBe(originalFetch);
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
