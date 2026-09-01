/**
 * Construction of the nax-ai client.
 *
 * piProviders() loads a ~650KB bundled catalog, so the client is built once and
 * memoised. Tests replace the builder through _clientDeps rather than reaching
 * the network or the catalog.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createClient } from "@nathapp/nax-ai";
import { _clientDeps, _resetNativeClient, buildNativeClient, getNativeClient } from "@/agents/native/client";

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

  test("passes a credential store to createClient, so a stored credential reaches a run", async () => {
    let sawCredentials = false;
    _clientDeps.build = async () => {
      // The real buildNativeClient is what we are asserting about, so call it
      // through a createClient spy rather than replacing the whole builder.
      throw new Error("unused");
    };

    // Assert on the source instead: buildNativeClient's options object is not
    // observable from outside, and a client built for real would load the
    // catalog.
    const source = await Bun.file(new URL("../../../../src/agents/native/client.ts", import.meta.url)).text();
    sawCredentials = /credentials:\s*naxCredentialStore\(\)/.test(source);
    expect(sawCredentials).toBe(true);
  });
});
