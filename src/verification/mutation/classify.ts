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

export function classifyMutant(result: VerificationResult): MutantOutcome {
  switch (result.status) {
    case "TEST_FAILURE": {
      const executedTests = (result.passCount ?? 0) + (result.failCount ?? 0);
      return executedTests > 0 ? "killed" : "errored";
    }
    case "SUCCESS":
      return "survived";
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
