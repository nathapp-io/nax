/**
 * Execution-layer wrapper types.
 *
 * Failure categories. The canonical owner of `FailureCategory` is this module —
 * the execution layer and the pipeline/PRD layers import it from here rather
 * than from a strategy-specific module.
 */

/** Failure categories for story-run results. */
export type FailureCategory =
  /**
   * Test-writer violated file isolation or created no test files. Routed (escalate →
   * retryAsLite → pause) by the escalation layer's failure-category handling.
   *
   * NO producer currently emits this, by design — and the verifier *structurally cannot*
   * (Audit #8):
   *   - The *mechanical* isolation checks detect which files changed but cannot judge whether
   *     a change is legitimate (a stub in src/ may be required), so they stay advisory.
   *   - The verifier reviews the *implementer*, not the test-writer. Its verdict type has no
   *     field describing test-writer-wrote-source; `testModifications` describes the
   *     *implementer editing tests*, which correctly maps to `verifier-rejected`.
   *     Routing that to `isolation-violation` would be wrong — `retryAsLite` *relaxes* isolation
   *     on retry, the opposite of enforcing "don't edit tests."
   *
   * So a real producer would need NEW verifier scope (a verdict field where the verifier judges
   * the test-writer's isolation legitimacy) or a plugin. The routing/rollback machinery stays
   * wired for such a producer via the `verifierOutput.failureCategory` passthrough in the
   * failure-category derivation the post-run inspection layer owned (deleted, US-003); until a
   * producer arrives it is dormant, not dead.
   */
  | "isolation-violation"
  /** A session crashed, timed out, or the agent failed to produce usable output */
  | "session-failure"
  /** Tests were written and implemented but still fail after all sessions */
  | "tests-failing"
  /** Verifier found concrete test assertions that conflict with otherwise-met acceptance criteria */
  | "test-incorrect"
  /** Full-suite gate failed and rectification retries exhausted before verifier */
  | "full-suite-gate-exhausted"
  /** Verifier explicitly rejected the implementation */
  | "verifier-rejected"
  /** Greenfield project with no test files — TDD not applicable (BUG-010) */
  | "greenfield-no-tests"
  /** Single-session implementer ran but authored no test files — re-runs implementer with test directive */
  | "no-tests-authored"
  /** A configured review phase (semantic / adversarial) never ran before the verdict */
  | "review-incomplete"
  /** Worktree dependency preparation failed before pipeline execution started */
  | "dependency-prep"
  | "runtime-crash";
