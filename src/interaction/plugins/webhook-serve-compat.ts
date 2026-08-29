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
 * The exact global objects present before any install patches them. Captured at
 * module load — the shim only patches via installServePortZeroCompat(), so at
 * load time Bun.serve/globalThis.fetch are pristine. Every restore reinstates
 * these same objects, which is what AC3/AC4 assert (identity, not port equality).
 */
const servePortZeroOriginalServe = Bun.serve;
const servePortZeroOriginalFetch = globalThis.fetch;

/**
 * SEC-06(b): the counter previously wrapped unconditionally after
 * PORT_ZERO_COMPAT_SPAN cycles and could reassign a port still held by a
 * live in-memory server (a long-running process with many webhook
 * start/stop cycles). Skip forward past any port still in inMemoryServers
 * instead of blindly overwriting it.
 */
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

export function installServePortZeroCompat(): () => void {
  if (servePortZeroCompatInstalled) {
    // Re-entrant call: the patch is already installed by a prior caller. Reference-
    // count it so this caller's restore only undoes its own share — the globals stay
    // patched until the LAST active caller restores. This keeps the patch alive for
    // concurrent webhook servers: the first server's restore must not tear down a
    // shim a second, still-active server depends on.
    servePortZeroCompatRefCount += 1;
  } else {
    const boundOriginalServe = Bun.serve.bind(Bun);
    const boundOriginalFetch = globalThis.fetch.bind(globalThis);
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
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
      const request =
        input instanceof Request ? input : new Request(input instanceof URL ? input.toString() : input, init);
      const url = new URL(request.url);
      const port = Number.parseInt(url.port, 10);
      if (
        (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
        url.pathname.startsWith(CALLBACK_PATH_PREFIX) &&
        inMemoryServers.has(port)
      ) {
        const server = inMemoryServers.get(port);
        if (!server) {
          return new Response("Not Found", { status: 404 });
        }
        return await server.fetch(request);
      }
      return boundOriginalFetch(input instanceof URL ? input.toString() : input, init);
    }) as typeof globalThis.fetch;
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
    (Bun as { serve: typeof Bun.serve }).serve = servePortZeroOriginalServe;
    globalThis.fetch = servePortZeroOriginalFetch;
  };
}
