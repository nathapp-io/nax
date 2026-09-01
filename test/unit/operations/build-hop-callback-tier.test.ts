/**
 * The run path applies a swapped hop's tier.
 *
 * Separate from the complete path because the two resolve their model in
 * different places: the complete path re-resolves inside the manager via
 * modelDefFor, while the run path resolves here, in the caller. Covering only
 * one leaves { agent, tier } working for complete ops and silently ignored for
 * run ops.
 */

import { describe, expect, test } from "bun:test";
import type { AdapterFailure } from "@/context/engine";
import { hopTier } from "@/operations/build-hop-callback";

const SWAP_FAILURE: AdapterFailure = {
  category: "availability",
  outcome: "fail-auth",
  retriable: false,
  message: "401",
};

describe("hopTier", () => {
  test("a primary hop uses the caller's effective tier", () => {
    expect(hopTier({ kind: "primary" }, "balanced")).toBe("balanced");
  });

  test("a swap with no tier uses the caller's effective tier", () => {
    expect(hopTier({ kind: "swap", failure: SWAP_FAILURE }, "balanced")).toBe("balanced");
  });

  test("a swap that named a tier uses it", () => {
    expect(hopTier({ kind: "swap", failure: SWAP_FAILURE, tier: "cheap" }, "balanced")).toBe("cheap");
  });

  test("a stale-retry uses the caller's effective tier", () => {
    expect(hopTier({ kind: "stale-retry", attempt: 1 }, "balanced")).toBe("balanced");
  });
});
