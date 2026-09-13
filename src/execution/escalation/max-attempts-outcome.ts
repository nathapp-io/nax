import type { FailureCategory } from "@/tdd/types";

/**
 * Determine the outcome when max attempts are reached for an escalation.
 *
 * Returns 'pause' if the failure category requires human review
 * (isolation-violation or verifier-rejected). For all other categories
 * (session-failure, tests-failing, or no category) returns 'fail'.
 *
 * Exported for unit-testing without running the full runner loop.
 */
export function resolveMaxAttemptsOutcome(failureCategory?: FailureCategory): "pause" | "fail" {
  if (!failureCategory) {
    return "fail";
  }

  switch (failureCategory) {
    case "isolation-violation":
    case "verifier-rejected":
    case "greenfield-no-tests":
    case "no-tests-authored":
    case "test-incorrect":
      return "pause";
    case "runtime-crash":
      return "pause";
    // Exhausted all tiers without ever running the configured review — the gate
    // stayed red and the story never got semantic/adversarial judgment. Needs a
    // human, same as verifier-rejected.
    case "review-incomplete":
      return "pause";
    case "session-failure":
    case "tests-failing":
    case "full-suite-gate-exhausted":
    case "dependency-prep":
      return "fail";
    default:
      // Exhaustive check: if a new FailureCategory is added, this will error
      failureCategory satisfies never;
      return "fail";
  }
}
