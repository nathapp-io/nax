/**
 * Mutation classification — VerificationResult -> MutantOutcome.
 *
 * Pure mapping from the runner's verification status to the outcome a
 * mutant produced: the tests caught it (killed), they missed it
 * (survived), or the verification never produced a signal (errored).
 */

import { NaxError } from "@/errors";
import type { VerificationResult } from "../types";
import type { MutantOutcome } from "./types";

/**
 * Whether `result` carries evidence that tests actually ran — a non-negative
 * pass or fail count above zero. Shared by the TEST_FAILURE and SUCCESS arms
 * of {@link classifyMutant}: a run that produced no such evidence proves
 * nothing about the mutant either way.
 */
function hasTestEvidence(result: VerificationResult): boolean {
  const passCount = result.passCount ?? 0;
  const failCount = result.failCount ?? 0;
  return passCount >= 0 && failCount >= 0 && (passCount > 0 || failCount > 0);
}

export function classifyMutant(result: VerificationResult): MutantOutcome {
  switch (result.status) {
    case "TEST_FAILURE":
      return hasTestEvidence(result) ? "killed" : "errored";
    case "SUCCESS":
      // BUG-13 (nax review 20260829, issue #1207): a scoped command that exits 0
      // having executed ZERO tests is not a pass — it is inconclusive, mirroring
      // verify-scoped.ts's #1207 rationale. Left unconditional, this classified
      // every mutant as "survived" (the worst possible test-quality verdict) for
      // a run that proved nothing — language-independent cases include Go
      // `[no test files]` on a helper-only file and Mocha on a spec-less mapped
      // `.js` file.
      return hasTestEvidence(result) ? "survived" : "errored";
    case "ENVIRONMENTAL_FAILURE":
    case "ASSET_CHECK_FAILED":
    case "TIMEOUT":
      return "errored";
    default: {
      const _exhaustive: never = result.status;
      throw new NaxError(`[mutation-classify] unhandled status: ${String(_exhaustive)}`, "MUTATION_UNHANDLED_STATUS", {
        stage: "mutation-classify",
        status: _exhaustive as string,
      });
    }
  }
}
