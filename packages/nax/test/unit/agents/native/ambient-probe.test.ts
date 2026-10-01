/**
 * The ambient credential probe.
 *
 * It exists to answer "can this agent authenticate to anything at all?" and
 * it must never answer "no" when it does not know. A false negative prunes an
 * agent that would have worked; a false positive costs one request-time auth
 * error that is already handled.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { makeFakeClock } from "@test/helpers";
import { _authDeps, anyAmbientCredential } from "@/agents/native/auth";

const REAL_PROVIDER_IDS = _authDeps.providerIds;
const REAL_AMBIENT = _authDeps.ambientAuthAvailable;
const REAL_SET_TIMEOUT = _authDeps.setTimeout;
const REAL_CLEAR_TIMEOUT = _authDeps.clearTimeout;

afterEach(() => {
  _authDeps.providerIds = REAL_PROVIDER_IDS;
  _authDeps.ambientAuthAvailable = REAL_AMBIENT;
  _authDeps.setTimeout = REAL_SET_TIMEOUT;
  _authDeps.clearTimeout = REAL_CLEAR_TIMEOUT;
});

describe("anyAmbientCredential", () => {
  test("is true when any provider is satisfied", async () => {
    _authDeps.providerIds = async () => ["a", "b", "c"];
    _authDeps.ambientAuthAvailable = async (id: string) => id === "c";

    expect(await anyAmbientCredential()).toBe(true);
  });

  test("is false when no provider is satisfied", async () => {
    _authDeps.providerIds = async () => ["a", "b"];
    _authDeps.ambientAuthAvailable = async () => false;

    expect(await anyAmbientCredential()).toBe(false);
  });

  test("is false when the catalog is empty", async () => {
    _authDeps.providerIds = async () => [];
    _authDeps.ambientAuthAvailable = async () => true;

    expect(await anyAmbientCredential()).toBe(false);
  });

  test("short-circuits: a satisfied provider resolves without awaiting the rest", async () => {
    let resolveSlow: ((value: boolean) => void) | undefined;
    const slow = new Promise<boolean>((resolve) => {
      resolveSlow = resolve;
    });
    _authDeps.providerIds = async () => ["fast-yes", "slow"];
    _authDeps.ambientAuthAvailable = (id: string) => {
      if (id === "fast-yes") return Promise.resolve(true);
      return slow;
    };

    expect(await anyAmbientCredential()).toBe(true);
    resolveSlow?.(false);
  });

  test("a throwing probe is not a satisfied provider, and does not propagate", async () => {
    _authDeps.providerIds = async () => ["boom", "ok"];
    _authDeps.ambientAuthAvailable = async (id: string) => {
      if (id === "boom") throw new Error("resolve exploded");
      return true;
    };

    expect(await anyAmbientCredential()).toBe(true);
  });

  test("a throwing probe alone is false, not a rejection", async () => {
    _authDeps.providerIds = async () => ["boom"];
    _authDeps.ambientAuthAvailable = async () => {
      throw new Error("resolve exploded");
    };

    expect(await anyAmbientCredential()).toBe(false);
  });

  test("a hung probe times out to TRUE, never pruning on a slow answer", async () => {
    // Drive the AMBIENT_PROBE_TIMEOUT_MS (2_000ms) off a virtual clock so the
    // "hung probe" assertion costs no wall-clock. The expiry branch is the
    // contract under test, not the real-time wait — the same race resolves
    // either way, just deterministically and in <1ms instead of 2s.
    const clock = makeFakeClock();
    _authDeps.setTimeout = clock.setTimeout as typeof _authDeps.setTimeout;
    _authDeps.clearTimeout = clock.clearTimeout as typeof _authDeps.clearTimeout;
    _authDeps.providerIds = async () => ["hangs"];
    _authDeps.ambientAuthAvailable = () => new Promise<boolean>(() => {});

    const result = anyAmbientCredential();
    // Exhaust microtasks so the sweep's `providerIds` resolves and arms the
    // expiry timer before we advance; otherwise the timer is never scheduled
    // and `advance` finds nothing to fire.
    await Promise.resolve();
    await clock.advance(2_000);

    expect(await result).toBe(true);
    // Expiry fired exactly once; no leftover timer from the finally clearTimeout.
    expect(clock.pending()).toBe(0);
  });
});
