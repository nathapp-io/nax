/**
 * US-006 (adversarial follow-up) — `completeResultProvenance` withholds `auth`
 * from a `CompleteResult` the dispatch ladder treated as a failure.
 *
 * `completeWithFallback` attaches `adapterFailure` to a result that is still
 * billed — an empty-output fail-stale (`manager.ts:269-280` spreads the
 * adapter's own result, so a stamp it carried survives) or the final hop of an
 * exhausted ladder — and `completeAsWithFallback` still emits a
 * `kind:"complete"` dispatch for it. Forwarding the stamp there would record a
 * FAILED call as a success-shaped `CostEvent` carrying a credential identity,
 * which the story's "only successful cost rows carry `auth`" rule forbids.
 *
 * The sibling file `manager-dispatch-provenance.test.ts` covers the successful
 * and absent cases (AC11, AC12); this one pins the failure boundary.
 */

import { describe, expect, test } from "bun:test";
import { completeResultProvenance } from "@/agents/manager-dispatch";
import type { AuthStamp } from "@/agents/session-types";
import type { CompleteResult } from "@/agents/types";
import type { AdapterFailure } from "@/context/engine";

const STAMP: AuthStamp = { fingerprint: "0123456789ab", source: "file" };

/** The marker `completeWithFallback` synthesises for an empty-output complete. */
const FAILURE: AdapterFailure = {
  category: "availability",
  outcome: "fail-stale",
  message: "[completeWithFallback] agent returned no output",
  retriable: true,
  reason: "empty-output",
};

function result(over: Partial<CompleteResult> = {}): CompleteResult {
  return { output: "ok", tokenUsage: { inputTokens: 4, outputTokens: 1 }, estimatedCostUsd: 0.0001, ...over };
}

describe("completeResultProvenance — failed results (US-006)", () => {
  test("omits auth when a stamped result also carries an adapterFailure", () => {
    const provenance = completeResultProvenance(result({ output: "", auth: STAMP, adapterFailure: FAILURE }));

    expect("auth" in provenance).toBe(false);
  });

  test("still forwards auth for a result the ladder kept as a success", () => {
    const provenance = completeResultProvenance(result({ auth: STAMP }));

    expect(provenance.auth).toEqual(STAMP);
  });

  test("does not fabricate the sibling keys on a failed result", () => {
    const provenance = completeResultProvenance(result({ output: "", adapterFailure: FAILURE }));

    expect(Object.keys(provenance)).toEqual([]);
  });

  // The AC added on review (2026-09-30) also promises the siblings still come
  // through. The test above cannot show that: its result carries no `pricingSource`
  // or `rates`, so "siblings survive" and "everything suppressed" look identical.
  test("still forwards pricingSource and rates on a failed result that carries them", () => {
    const rates = { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheCreationPer1M: 3.75 };
    const provenance = completeResultProvenance(
      result({ output: "", auth: STAMP, adapterFailure: FAILURE, pricingSource: "catalog-rates", rates }),
    );

    expect("auth" in provenance).toBe(false);
    expect(provenance.pricingSource).toBe("catalog-rates");
    expect(provenance.rates).toEqual(rates);
  });
});
