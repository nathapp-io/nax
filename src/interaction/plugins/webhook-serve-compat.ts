/**
 * Bun.serve port-0 compatibility shim, extracted from webhook.ts (file-size split).
 *
 * Routes port 0 through the real Bun.serve (the OS assigns a real available port),
 * falling back to an in-memory server only when Bun.serve genuinely fails (e.g. no
 * network permission in a sandboxed environment).
 */

import { NaxError } from "@/errors";

type ServeCompatOptions = Parameters<typeof Bun.serve>[0];
type ServeCompatReturn = ReturnType<typeof Bun.serve>;

const PORT_ZERO_COMPAT_BASE = 40_000;
const PORT_ZERO_COMPAT_SPAN = 20_000;

/**
 * WEB-1: the only requests this shim needs to intercept are nax's own
 * webhook-interaction callbacks. Matching on port alone routes EVERY
 * in-process fetch() through the interceptor — plugins, libraries, the OTLP
 * exporter pointed at localhost:4318 — and the compat port span
 * (40_000-59_999) overlaps exactly where users run dev servers, so a real
 * service on a registered port would be silently shadowed. Path-prefix
 * matching narrows the intercept to nax's own callback route.
 */
const CALLBACK_PATH_PREFIX = "/nax/interact/";

let servePortZeroCompatInstalled = false;
let servePortZeroCompatRefCount = 0;
let servePortZeroCounter = 0;
const inMemoryServers = new Map<number, { fetch: (request: Request) => Response | Promise<Response> }>();

/**
 * The exact global objects present immediately before the FIRST install of the
 * current install/restore generation patches them. Captured inside the install
 * branch, not at module load — capturing at load time would freeze whatever
 * Bun.serve/globalThis.fetch happened to be when this module was first
 * imported, and a later restore would silently reinstate that stale pair even
 * if something else patched the globals between load and install (a test
 * double, another shim). Every restore in this generation reinstates these
 * same objects, which is what AC3/AC4 assert (identity, not port equality).
 */
let servePortZeroOriginalServe: typeof Bun.serve;
let servePortZeroOriginalFetch: typeof globalThis.fetch;

/**
 * The patched functions this module installed, kept so a restore can tell
 * "the global is still ours" from "something replaced it after we installed".
 */
let servePortZeroPatchedServe: typeof Bun.serve | undefined;
let servePortZeroPatchedFetch: typeof globalThis.fetch | undefined;

/**
 * Reinstate a captured pre-install global ONLY if the current value is still
 * the function this module installed.
 *
 * Restoring unconditionally is a global clobber: if anything replaced the
 * global between install and restore, the assignment discards that newer
 * function and resurrects whatever happened to be live at install time. That
 * is not hypothetical — it is how a test double for `globalThis.fetch` used
 * to escape its own test. A plugin test would set `globalThis.fetch` to a stub,
 * call `send()` (which installs the shim, capturing the STUB as "original"),
 * put the real fetch back, and then call `destroy()`; destroy's restore
 * reinstated the stub over the real fetch, and every subsequent fetch in the
 * process — in that file and every file after it — failed with the stub's
 * error. Under `bun test`'s one-process-per-run model that surfaced as an
 * unhandled rejection attributed to whichever unrelated test happened to be
 * running, which is exactly the shape of a CI-only flake.
 *
 * Leaving a foreign patch in place loses this module's ability to unwind, but
 * that is strictly better than silently undoing someone else's install.
 */
function restoreIfUnchanged<T>(current: T, patched: T | undefined, original: T): T {
  return patched !== undefined && current === patched ? original : current;
}

/**
 * SEC-06(b): the counter previously wrapped unconditionally after
 * PORT_ZERO_COMPAT_SPAN cycles and could reassign a port still held by a
 * live in-memory server (a long-running process with many webhook
 * start/stop cycles). Skip forward past any port still in inMemoryServers
 * instead of blindly overwriting it.
 */
/**
 * The request URL, or null when it does not parse as an absolute URL. A URL
 * this module cannot parse can never name an in-memory compat server, so it
 * is a pass-through: the decision of whether to reject it belongs to the fetch
 * being fronted, not to the shim in front of it.
 */
function parseUrl(input: Request | string | URL): URL | null {
  if (input instanceof URL) return input;
  try {
    return new URL(input instanceof Request ? input.url : input);
  } catch {
    return null;
  }
}

function nextCompatPort(): number {
  for (let i = 0; i < PORT_ZERO_COMPAT_SPAN; i++) {
    const port = PORT_ZERO_COMPAT_BASE + (servePortZeroCounter % PORT_ZERO_COMPAT_SPAN);
    servePortZeroCounter += 1;
    if (!inMemoryServers.has(port)) return port;
  }
  // All compat ports are live (pathological) — fall back to the raw
  // counter value rather than looping forever.
  return PORT_ZERO_COMPAT_BASE + (servePortZeroCounter % PORT_ZERO_COMPAT_SPAN);
}

function createInMemoryServer(options: ServeCompatOptions, port: number): ServeCompatReturn {
  const fetchHandler = options.fetch;
  if (!fetchHandler) {
    throw new NaxError(
      "[interaction] Bun.serve compatibility shim requires a fetch handler",
      "WEBHOOK_SERVE_SHIM_NO_FETCH",
      { stage: "interaction" },
    );
  }

  /**
   * The in-memory stand-in for the `Server` Bun would have created, built
   * once and used for all three of its roles: the handler's `this`, the
   * handler's `server` argument, and this function's return value. Bun passes
   * the same object for all three, so anything else would be a different lie.
   *
   * The two arguments were `undefined as never` until 2026-08-27. `never` is
   * assignable to everything, so it silenced the type error and left a
   * handler that read `server.port` — or any other member Bun promises — to
   * fail with a TypeError on undefined at runtime.
   *
   * The cast stays, and is the reason `no-as-never.grit` can now cover `src/`
   * while this file still compiles: `Server` declares roughly twenty members
   * (`reload`, `upgrade`, `publish`, `subscriberCount`, …) that an in-memory
   * shim has no implementation for and no caller for. The only route into
   * this handler is the patched `fetch` below, gated on
   * CALLBACK_PATH_PREFIX — nax's own callback route, whose handler reads
   * neither `this` nor `server`. A single named cast on one object states
   * that; two `as never` at the call site stated nothing.
   */
  const server = {
    port,
    stop: () => {
      inMemoryServers.delete(port);
    },
  } as ServeCompatReturn;

  inMemoryServers.set(port, {
    fetch: (request) => fetchHandler.call(server, request, server) as Response | Promise<Response>,
  });

  return server;
}

/**
 * NOTE: this reference-counts installs rather than treating every re-entrant
 * restore as an unconditional no-op. The spec's target table describes the
 * simpler "second call returns a no-op restore" contract, but that literal
 * shape was shipped once (see git history) and broke concurrent webhook
 * servers: the FIRST caller's restore tore down the shim while a second,
 * still-active server depended on it. Ref-counting intentionally widens the
 * contract so the globals stay patched until every outstanding install has
 * been restored, regardless of restore order.
 */
export function installServePortZeroCompat(): () => void {
  if (servePortZeroCompatInstalled) {
    // Re-entrant call: the patch is already installed by a prior caller. Reference-
    // count it so this caller's restore only undoes its own share — the globals stay
    // patched until the LAST active caller restores. This keeps the patch alive for
    // concurrent webhook servers: the first server's restore must not tear down a
    // shim a second, still-active server depends on.
    servePortZeroCompatRefCount += 1;
  } else {
    servePortZeroOriginalServe = Bun.serve;
    servePortZeroOriginalFetch = globalThis.fetch;
    const boundOriginalServe = servePortZeroOriginalServe.bind(Bun);
    const boundOriginalFetch = servePortZeroOriginalFetch.bind(globalThis);
    const patchedServe = ((options: ServeCompatOptions): ServeCompatReturn => {
      const requestedPort = typeof options.port === "number" ? options.port : 0;
      // Route port 0 through the real Bun.serve too — the OS assigns a real available
      // port for it same as any other bind, so there is nothing to compat-shim there.
      // Only fall back to the in-memory server when Bun.serve genuinely fails (e.g. no
      // network permission in a sandboxed environment) — previously port 0 was routed
      // to the in-memory server unconditionally, so a real webhook responder posting to
      // the advertised callback URL could never reach it: ECONNREFUSED every time (BUG-24).
      if (!inMemoryServers.has(requestedPort)) {
        try {
          return boundOriginalServe(options);
        } catch {
          return createInMemoryServer(options, requestedPort === 0 ? nextCompatPort() : requestedPort);
        }
      }

      return createInMemoryServer(options, nextCompatPort());
    }) as typeof Bun.serve;

    (Bun as { serve: typeof Bun.serve }).serve = patchedServe;
    servePortZeroPatchedServe = patchedServe;
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
      // Route on the URL alone, and build a Request only on the branch that
      // needs one. This used to construct a throwaway `new Request(input, init)`
      // up front purely to read `.url`, on EVERY in-process fetch made while any
      // webhook server was live -- including the pass-through branch, which then
      // handed the very same `init` to the real fetch and discarded the object.
      // Besides the wasted allocation, that construction is stricter than the
      // fetch it fronts: it rejects inputs the underlying fetch may well accept
      // (a relative URL, say, which a polyfill or a test double can resolve), so
      // the shim threw on requests it has no business intercepting.
      const url = parseUrl(input);
      const port = url ? Number.parseInt(url.port, 10) : Number.NaN;
      if (
        url &&
        (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
        url.pathname.startsWith(CALLBACK_PATH_PREFIX) &&
        inMemoryServers.has(port)
      ) {
        const server = inMemoryServers.get(port);
        if (!server) {
          return new Response("Not Found", { status: 404 });
        }
        return await server.fetch(input instanceof Request ? input : new Request(url.toString(), init));
      }
      return boundOriginalFetch(input instanceof URL ? input.toString() : input, init);
    }) as typeof globalThis.fetch;
    servePortZeroPatchedFetch = globalThis.fetch;
    servePortZeroCompatInstalled = true;
    servePortZeroCompatRefCount = 1;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    servePortZeroCompatRefCount -= 1;
    // A concurrent caller still holds the shim — leave the globals patched.
    if (servePortZeroCompatRefCount > 0) return;
    servePortZeroCompatInstalled = false;
    // Restore the exact function objects captured before the patch, and clear the
    // installation flag so the shim can be reinstalled on the next server start.
    (Bun as { serve: typeof Bun.serve }).serve = restoreIfUnchanged(
      Bun.serve,
      servePortZeroPatchedServe,
      servePortZeroOriginalServe,
    );
    globalThis.fetch = restoreIfUnchanged(globalThis.fetch, servePortZeroPatchedFetch, servePortZeroOriginalFetch);
    servePortZeroPatchedServe = undefined;
    servePortZeroPatchedFetch = undefined;
  };
}

/**
 * @internal test-only. Force-clears the module-level install state regardless
 * of the current refcount, and restores the true pre-install globals if the
 * shim is currently patched. Bun's test suite runs every file in one process,
 * so `servePortZeroCompatInstalled` can be left set by an earlier test in a
 * sibling file — this gives a test a reliable clean slate WITHOUT needing a
 * cache-busted dynamic re-import of this module (or of `webhook.ts`, which
 * imports it statically): that pattern instantiates a second, isolated
 * module tree purely to reset one flag, and Bun's coverage instrumentation
 * cannot merge line hits across the two instances of the same source file,
 * which corrupts the reported coverage for whichever file gets re-imported
 * this way.
 */
export function _resetServePortZeroCompatForTests(): void {
  if (servePortZeroCompatInstalled) {
    (Bun as { serve: typeof Bun.serve }).serve = restoreIfUnchanged(
      Bun.serve,
      servePortZeroPatchedServe,
      servePortZeroOriginalServe,
    );
    globalThis.fetch = restoreIfUnchanged(globalThis.fetch, servePortZeroPatchedFetch, servePortZeroOriginalFetch);
  }
  servePortZeroPatchedServe = undefined;
  servePortZeroPatchedFetch = undefined;
  servePortZeroCompatInstalled = false;
  servePortZeroCompatRefCount = 0;
}
