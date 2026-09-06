/**
 * Construction of the nax-ai client.
 *
 * defaultProviders() loads a ~650KB bundled catalog, so the client is built once and
 * memoised. Tests replace the builder through _clientDeps rather than reaching
 * the network or the catalog.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createClient, type ProtocolOptions } from "@nathapp/nax-ai";
import { _clientDeps, _resetNativeClient, buildNativeClient, getNativeClient } from "@/agents/native/client";
import { naxCredentialStore } from "@/agents/native/credentials";

const REAL_BUILD = _clientDeps.build;
// A real client with no providers and no protocols: constructing it loads no
// catalog and touches no network, so the builder swap counts builds, nothing
// more.
const FAKE_CLIENT = createClient({ providers: [], protocols: {} });

afterEach(() => {
  _clientDeps.build = REAL_BUILD;
  _resetNativeClient();
});

describe("getNativeClient", () => {
  test("builds the client once and reuses it", async () => {
    let built = 0;
    _clientDeps.build = async () => {
      built += 1;
      return FAKE_CLIENT;
    };

    const a = await getNativeClient();
    const b = await getNativeClient();

    expect(built).toBe(1);
    expect(a).toBe(b);
  });

  test("does not memoise a failed build, so a later call can succeed", async () => {
    let attempt = 0;
    _clientDeps.build = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("catalog unavailable");
      return FAKE_CLIENT;
    };

    await expect(getNativeClient()).rejects.toThrow("catalog unavailable");
    await expect(getNativeClient()).resolves.toBe(FAKE_CLIENT);
    expect(attempt).toBe(2);
  });
});

describe("buildNativeClient", () => {
  // test/preload.ts overwrites _clientDeps.build with a sentinel before any
  // test file loads, so the real builder is only reachable through this
  // named export, not through _clientDeps.build.
  test("constructs a real client synchronously, with no network reached", async () => {
    const client = await buildNativeClient();
    expect(typeof client.model).toBe("function");
    expect(typeof client.complete).toBe("function");
    expect(typeof client.pricing).toBe("function");
  });

  test("names nax to defaultProtocols, so provider dashboards can attribute its traffic", async () => {
    const realDefaultProtocols = _clientDeps.defaultProtocols;
    let seenClientApp: unknown;
    _clientDeps.defaultProtocols = ((options?: ProtocolOptions) => {
      seenClientApp = options?.clientApp;
      return realDefaultProtocols(options);
    }) as typeof _clientDeps.defaultProtocols;

    try {
      await buildNativeClient();
    } finally {
      _clientDeps.defaultProtocols = realDefaultProtocols;
    }

    // nax-ai owns which vendor spells this in which header (HTTP-Referer and
    // X-Title for OpenRouter); nax owns only the identity. Without it every
    // request carries pi-ai's hardcoded "pi (<platform> ...)" User-Agent and
    // nothing else, so nax traffic is indistinguishable from any other pi-ai
    // consumer's in the provider account paying for it.
    expect(seenClientApp).toEqual({ name: "nax", url: "https://github.com/nathapp-io/nax" });
  });

  test("passes the credential store to defaultProtocols, so a stored credential reaches a run", async () => {
    const realDefaultProtocols = _clientDeps.defaultProtocols;
    let seenCredentials: unknown;
    _clientDeps.defaultProtocols = ((options?: ProtocolOptions) => {
      seenCredentials = options?.credentials;
      return realDefaultProtocols(options);
    }) as typeof _clientDeps.defaultProtocols;

    try {
      // The real buildNativeClient, called directly (not through _clientDeps.build,
      // which test/preload.ts sentinels): this proves the seam nax-ai actually
      // reads (defaultProtocols). ClientOptions once carried a `credentials`
      // field that createClient never read; nax-ai 0.1.4 removed it.
      await buildNativeClient();
    } finally {
      _clientDeps.defaultProtocols = realDefaultProtocols;
    }

    expect(seenCredentials).toBe(naxCredentialStore());
  });
});
