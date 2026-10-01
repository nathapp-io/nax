/**
 * US-006 — `completeResultProvenance(result)` is the one place the manager's
 * complete path turns a `CompleteResult` into the provenance keys it spreads
 * onto a `CompleteDispatchEvent`: `pricingSource`, `rates` and `auth`.
 *
 * The helper exists because `src/agents/manager.ts` sits at its 600-line hard
 * ceiling, so the three conditional spreads live here and the manager replaces
 * its two inline spreads with one call. Every key is omitted — never written as
 * `undefined` — when the result carries nothing for it, so an ACP result
 * produces an event byte-identical to the pre-US-006 shape.
 *
 * Acceptance criteria covered: AC11, AC12.
 */

import { describe, expect, test } from "bun:test";
import { completeResultProvenance } from "@/agents/manager-dispatch";
import type { AuthStamp } from "@/agents/session-types";
import type { CompleteResult } from "@/agents/types";

const STAMP: AuthStamp = { fingerprint: "0123456789ab", source: "exec", account: "team-a" };

function result(over: Partial<CompleteResult> = {}): CompleteResult {
  return { output: "ok", tokenUsage: { inputTokens: 1, outputTokens: 1 }, estimatedCostUsd: 0, ...over };
}

describe("completeResultProvenance (US-006)", () => {
  // AC11 (success): a result the adapter stamped with a credential identity
  // reports that identity in the provenance object it hands the event.
  test("AC11: returns auth equal to result.auth when the result carries one", () => {
    const provenance = completeResultProvenance(result({ auth: STAMP }));

    expect(provenance.auth).toEqual(STAMP);
  });

  // AC12 (boundary): a result carrying none of the three provenance fields
  // yields an object with none of those keys — the manager's spread must add
  // nothing at all, not three `undefined` keys.
  test("AC12: returns an object with no auth, pricingSource or rates key when the result carries none of them", () => {
    const provenance = completeResultProvenance(result());

    expect("auth" in provenance).toBe(false);
    expect("pricingSource" in provenance).toBe(false);
    expect("rates" in provenance).toBe(false);
  });

  // AC11 boundary: `auth` is the only field provenanced here that a producer can
  // stamp alone, so a result carrying auth and nothing else must not fabricate
  // the sibling keys.
  test("AC11 boundary: an auth-only result omits pricingSource and rates", () => {
    const provenance = completeResultProvenance(result({ auth: STAMP }));

    expect("pricingSource" in provenance).toBe(false);
    expect("rates" in provenance).toBe(false);
  });
});
