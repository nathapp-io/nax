/**
 * nax#1713: a declined agent-swap used to leave no trace. `runWithFallback`
 * returned terminally when `shouldSwap` said no, emitting nothing — so a run log
 * could not distinguish a swap that was *refused* from one never *considered*,
 * and diagnosing a real decline meant eliminating each gate by hand.
 *
 * `decideSwap` is the reason-carrying form; `shouldSwap` delegates to it and keeps
 * its boolean contract.
 */

import { describe, expect, test } from "bun:test";
import { decideSwap, type SwapFallbackConfig } from "@/agents/swap-decision";
import type { AdapterFailure } from "@/context/engine";

const AVAILABILITY: AdapterFailure = {
  outcome: "fail-quota",
  category: "availability",
  retriable: false,
  message: "quota",
};
const QUALITY: AdapterFailure = { outcome: "fail-unknown", category: "quality", retriable: false, message: "bad" };
const ABORTED: AdapterFailure = { outcome: "fail-aborted", category: "availability", retriable: false, message: "x" };

const ON: SwapFallbackConfig = { enabled: true, maxHopsPerStory: 2, onQualityFailure: false };

describe("decideSwap names the gate that declined (#1713)", () => {
  test("AC-1: fallback disabled", () => {
    expect(decideSwap(AVAILABILITY, 0, { ...ON, enabled: false })).toEqual({
      swap: false,
      reason: "fallback-disabled",
    });
  });

  test("AC-2: hop cap reached — a distinct reason from AC-1", () => {
    expect(decideSwap(AVAILABILITY, 2, ON)).toEqual({ swap: false, reason: "hop-cap-reached" });
  });

  test("AC-3: refused outcome", () => {
    expect(decideSwap(ABORTED, 0, ON)).toEqual({ swap: false, reason: "outcome-refused" });
  });

  // nax#1722 removed the `hasBundle` gate (and its "no-bundle" reason): a swap needs
  // no ContextBundle, and no CallContext in src/ ever carried one, so the gate declined
  // every swap on the run() path while the complete() path passed a literal `true`.
  test("AC-4: a swap with no bundle in play is not declined (nax#1722)", () => {
    expect(decideSwap(AVAILABILITY, 0, ON)).toEqual({ swap: true });
  });

  test("absent failure", () => {
    expect(decideSwap(undefined, 0, ON)).toEqual({ swap: false, reason: "no-failure" });
  });

  test("quality failure with onQualityFailure off — the last decline path", () => {
    expect(decideSwap(QUALITY, 0, ON)).toEqual({ swap: false, reason: "quality-failure-declined" });
  });

  test("every decline reason is distinct", () => {
    const reasons = [
      decideSwap(undefined, 0, ON),
      decideSwap(ABORTED, 0, ON),
      decideSwap(AVAILABILITY, 0, { ...ON, enabled: false }),
      decideSwap(AVAILABILITY, 2, ON),
      decideSwap(QUALITY, 0, ON),
    ].map((d) => (d.swap ? "swap" : d.reason));

    expect(new Set(reasons).size).toBe(5);
  });

  test("swaps on an availability failure inside the cap", () => {
    expect(decideSwap(AVAILABILITY, 0, ON)).toEqual({ swap: true });
  });

  test("swaps on a quality failure when onQualityFailure is set", () => {
    expect(decideSwap(QUALITY, 0, { ...ON, onQualityFailure: true })).toEqual({ swap: true });
  });
});
