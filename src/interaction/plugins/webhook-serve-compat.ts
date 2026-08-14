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

let servePortZeroCompatInstalled = false;
let servePortZeroCounter = 0;
const inMemoryServers = new Map<number, { fetch: (request: Request) => Response | Promise<Response> }>();

function nextCompatPort(): number {
  const port = PORT_ZERO_COMPAT_BASE + (servePortZeroCounter % PORT_ZERO_COMPAT_SPAN);
  servePortZeroCounter += 1;
  return port;
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

  inMemoryServers.set(port, {
    fetch: (request) =>
      fetchHandler.call(undefined as never, request, undefined as never) as Response | Promise<Response>,
  });

  return {
    port,
    stop: () => {
      inMemoryServers.delete(port);
    },
  } as ServeCompatReturn;
}

export function installServePortZeroCompat(): void {
  if (servePortZeroCompatInstalled) {
    return;
  }

  const originalServe = Bun.serve.bind(Bun);
  const originalFetch = globalThis.fetch.bind(globalThis);
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
        return originalServe(options);
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
    if ((url.hostname === "localhost" || url.hostname === "127.0.0.1") && inMemoryServers.has(port)) {
      const server = inMemoryServers.get(port);
      if (!server) {
        return new Response("Not Found", { status: 404 });
      }
      return await server.fetch(request);
    }
    return originalFetch(input instanceof URL ? input.toString() : input, init);
  }) as typeof globalThis.fetch;
  servePortZeroCompatInstalled = true;
}
