import { describe, expect, test } from "bun:test";
import type { NaxConfig } from "@/config";
import { runOrchestratorE2E } from "@test/helpers";

const PASS_REVIEW = () => ({ output: JSON.stringify({ passed: true, findings: [] }) });
const impl = () => ({ output: JSON.stringify({ filesChanged: ["src/a.ts"] }) });
const tw = () => ({ output: JSON.stringify({ filesChanged: ["test/a.test.ts"] }) });

const PASSING_VERDICT = JSON.stringify({
  version: 1,
  approved: true,
  tests: { allPassing: true, passCount: 3, failCount: 0 },
  testModifications: { detected: false, files: [], legitimate: true, reasoning: "no modifications" },
  acceptanceCriteria: { allMet: true, criteria: [] },
  quality: { rating: "good", issues: [] },
  fixes: [],
  reasoning: "All tests pass",
});

describe("E2E: full-suite-rectify (success path)", () => {
  test("three-session: failing gate -> full-suite-rectify edits tests -> verifier IS re-judged -> success", async () => {
    // full-suite-rectify is the ONLY strategy whose appliesTo matches a structured
    // test-runner finding, and the ONLY one whose revalidation set re-runs the
    // verifier (because it edits TEST code, which legitimately changes the verifier's
    // verdict). This locks both: (1) the strategy fires on a failing-test finding,
    // (2) the verifier runs after the test edit. The gate short-circuits the main loop
    // at canonical pos 4 — BEFORE the verifier (pos 5) — so the verifier running at all
    // proves it was pulled in by full-suite-rectify's revalidation set.
    const verifier = () => ({ output: PASSING_VERDICT });

    const { result, phaseLog, strategiesFired } = await runOrchestratorE2E({
      strategy: "three-session-tdd",
      agent: {
        "test-writer": tw,
        implementer: impl,
        verifier,
        "reviewer-semantic": PASS_REVIEW,
        "reviewer-adversarial": PASS_REVIEW,
      },
      gates: {
        // attempt 0 (main loop): structured failing-test finding → full-suite-rectify matches.
        // attempt 1+ (revalidation): tests now pass after the test edit.
        fullSuite: (attempt) =>
          attempt === 0
            ? {
                passed: false,
                failed: 1,
                output: "1 failing",
                failures: [{ testName: "edge case", file: "test/a.test.ts", error: "expected 2, got 1" }],
              }
            : { passed: true, failed: 0 },
      },
    });

    expect(result.success).toBe(true);
    expect(result.rectificationExhausted).toBeFalsy();
    expect(strategiesFired).toContain("full-suite-rectify");

    // gate runs twice: main loop (fail) + revalidation (pass).
    expect(phaseLog.filter((p) => p === "full-suite-gate").length).toBe(2);
    // The verifier — never reached in the main loop (gate short-circuited at pos 4) —
    // is re-judged by full-suite-rectify's revalidation set. This is the property that
    // distinguishes full-suite-rectify from autofix-implementer/autofix-test-writer,
    // both of which exclude the verifier.
    expect(phaseLog.filter((p) => p === "verifier").length).toBe(1);
    // Reviews still run (revalidation runs semantic; resume backfills adversarial).
    expect(phaseLog.filter((p) => p === "semantic-review").length).toBe(1);
    expect(phaseLog.filter((p) => p === "adversarial-review").length).toBe(1);

    expect(phaseLog).toEqual([
      "test-writer",
      "greenfield-gate",
      "implementer",
      "full-suite-gate",
      "full-suite-gate",
      "verifier",
      "lint-check",
      "typecheck-check",
      "semantic-review",
      "adversarial-review",
    ]);
  });

  test("single-session: failing verify-scoped is matched by full-suite-rectify (NOT no-strategy)", async () => {
    // Regression guard (build-plan-for-strategy.ts §"Without the verify-scoped arm").
    // In single-session there is no full-suite-gate; the scoped verify phase is the test
    // gate. A scoped test failure must still load full-suite-rectify — otherwise the cycle
    // exits "no-strategy" at iteration 0 and the story fails without a single fix attempt.
    // We drive verify-scoped to fail via a static failing test command (commands.test:"false");
    // because the command can't be made attempt-aware, the story ultimately exhausts — but
    // the point is that full-suite-rectify FIRED (was matched), not that it resolved.
    const { result, strategiesFired } = await runOrchestratorE2E({
      strategy: "test-after",
      config: { quality: { commands: { test: "false" } } } as unknown as Partial<NaxConfig>,
      agent: { implementer: impl, "reviewer-semantic": PASS_REVIEW, "reviewer-adversarial": PASS_REVIEW },
    });

    // The matching strategy is loaded and attempted — the no-strategy regression is guarded.
    expect(strategiesFired).toContain("full-suite-rectify");
    // Static failing command can't be fixed → story exhausts and fails (expected).
    expect(result.success).toBe(false);
    expect(result.rectificationExhausted).toBe(true);
  });
});

// ─── #1654: give-up falls through to the repo-scoped claimant ────────────────
//
// The deadlock this fixes: a test that is red for reasons outside the story is
// handed to a rectifier whose mandate forbids touching what is broken, so it
// answers UNRESOLVED, the cycle exits `agent-gave-up`, and every story in the
// package hits the same wall. These lock the end-to-end route from that refusal
// to a dispatch that is actually allowed to fix it.

describe("E2E: repo-scoped test fix (#1654)", () => {
  const verifier = () => ({ output: PASSING_VERDICT });
  /** Story-scoped rectifier: declines the failing test as out of this story's scope. */
  const decliningImplementer = (attempt: number) =>
    attempt === 0
      ? { output: JSON.stringify({ filesChanged: ["src/a.ts"] }) }
      : { output: "UNRESOLVED: test/legacy/auth.spec.ts is outside this story's scope" };

  test("dispatches repo-scoped-test-fix after the story-scoped rectifier declines", async () => {
    let repoScopedDispatched = false;
    const { result } = await runOrchestratorE2E({
      strategy: "three-session-tdd",
      agent: {
        "test-writer": tw,
        implementer: decliningImplementer,
        verifier,
        "repo-scoped-test-fix": () => {
          repoScopedDispatched = true;
          return { output: JSON.stringify({ filesChanged: ["src/legacy/auth.ts"] }) };
        },
        "reviewer-semantic": PASS_REVIEW,
        "reviewer-adversarial": PASS_REVIEW,
      },
      // Red before the repo-scoped fix, green after it — the shape of a
      // pre-existing failure nobody in story scope was allowed to touch.
      gates: {
        fullSuite: (attempt: number) =>
          repoScopedDispatched
            ? { passed: true, failed: 0 }
            : {
                passed: false,
                failed: 1,
                output: `attempt ${attempt}: legacy auth spec red`,
                failures: [{ testName: "redirects to login", file: "test/legacy/auth.spec.ts", error: "Invalid URL" }],
              },
      },
    });

    // The dispatch is the discriminating assertion: before #1654 the cycle exited
    // `agent-gave-up` at the refusal and this role was never opened.
    expect(repoScopedDispatched).toBe(true);
    expect(result.success).toBe(true);

    // #1658 — the dispatch is recorded on the story result, so a reviewer meeting
    // an unrelated file in this story's commit can see what caused it.
    expect(result.repoScopedFixes).toHaveLength(1);
    expect(result.repoScopedFixes?.[0]?.triggeringTests).toEqual(["test/legacy/auth.spec.ts::redirects to login"]);
    expect(result.repoScopedFixes?.[0]?.declinedReason).toBe("test/legacy/auth.spec.ts is outside this story's scope");
    expect(result.repoScopedFixes?.[0]?.findingsCleared).toBe(true);
  });

  test("records a dispatch that fixed nothing while the story passed anyway (#1658)", async () => {
    // The case the issue calls out as most worth seeing. The fallthrough fires,
    // spends a session, does not fix the test — and the story still PASSES,
    // because the verifier explicitly passed and the verifier-SSOT carve-out
    // (`shouldSkipPhaseForRectification`) stops a gate failure the story did not
    // cause from failing it. Without the record, this run is indistinguishable
    // from one where the fallthrough never ran at all.
    let repoScopedDispatched = false;
    const { result } = await runOrchestratorE2E({
      strategy: "three-session-tdd",
      agent: {
        "test-writer": tw,
        implementer: decliningImplementer,
        verifier,
        "repo-scoped-test-fix": () => {
          repoScopedDispatched = true;
          return { output: "Looked at it; the failure is environmental." };
        },
        "reviewer-semantic": PASS_REVIEW,
        "reviewer-adversarial": PASS_REVIEW,
      },
      // Never goes green — the repo-scoped dispatch changed nothing.
      gates: {
        fullSuite: () => ({
          passed: false,
          failed: 1,
          output: "legacy auth spec red",
          failures: [{ testName: "redirects to login", file: "test/legacy/auth.spec.ts", error: "Invalid URL" }],
        }),
      },
    });

    expect(repoScopedDispatched).toBe(true);
    expect(result.success).toBe(true);
    expect(result.repoScopedFixes).toHaveLength(1);
    // `findingsCleared` is true here and says nothing useful: the carve-out
    // emptied the findings, not a repair. `filesChanged` is what discriminates —
    // the dispatch touched nothing, so a passing story means the carve-out
    // carried it. That combination is precisely what was invisible before.
    expect(result.repoScopedFixes?.[0]?.filesChanged).toEqual([]);
  });

  test("repoScopedFallback: false restores the deadlock", async () => {
    // Same scenario with the gate off — proves the dispatch above is what changed,
    // and that the escape hatch actually reaches the strategy registration.
    let repoScopedDispatched = false;
    const { result } = await runOrchestratorE2E({
      strategy: "three-session-tdd",
      config: { execution: { rectification: { repoScopedFallback: false } } } as Partial<NaxConfig>,
      agent: {
        "test-writer": tw,
        implementer: decliningImplementer,
        verifier,
        "repo-scoped-test-fix": () => {
          repoScopedDispatched = true;
          return { output: JSON.stringify({ filesChanged: ["src/legacy/auth.ts"] }) };
        },
        "reviewer-semantic": PASS_REVIEW,
        "reviewer-adversarial": PASS_REVIEW,
      },
      gates: {
        fullSuite: () => ({
          passed: false,
          failed: 1,
          output: "legacy auth spec red",
          failures: [{ testName: "redirects to login", file: "test/legacy/auth.spec.ts", error: "Invalid URL" }],
        }),
      },
    });

    expect(repoScopedDispatched).toBe(false);
    expect(result.success).toBe(false);
    expect(result.rectificationExhausted).toBe(true);
    // Nothing to report when the fallthrough never fired (#1658).
    expect(result.repoScopedFixes).toBeUndefined();
  });
});
