import { describe, expect, test } from "bun:test";
import { runOrchestratorE2E } from "@test/helpers";
import type { NaxConfig } from "@/config";
import type { QualityCommandResult } from "@/quality/runner";

const PASS_REVIEW = () => ({ output: JSON.stringify({ passed: true, findings: [] }) });
const impl = () => ({ output: JSON.stringify({ filesChanged: ["src/a.ts"] }) });

const PASS_TC: QualityCommandResult = {
  commandName: "typecheck", command: "tc", success: true, exitCode: 0,
  output: "", durationMs: 1, timedOut: false,
};
const FAIL_TC: QualityCommandResult = {
  commandName: "typecheck", command: "tc", success: false, exitCode: 1,
  output: "TS2304: Cannot find name 'x'", durationMs: 1, timedOut: false,
};

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

describe("E2E: agent-fix", () => {
  test("typecheck fail -> autofix-implementer -> revalidation chain", async () => {
    let tcCall = 0;
    const { result, phaseLog, strategiesFired } = await runOrchestratorE2E({
      strategy: "test-after",
      agent: { implementer: impl, "reviewer-semantic": PASS_REVIEW, "reviewer-adversarial": PASS_REVIEW },
      gates: {
        typecheck: () => tcCall++ === 0 ? FAIL_TC : PASS_TC,
      },
    });

    // Observed 2026-06-14: autofix-implementer fires on typecheck failure in test-after
    expect(result.success).toBe(true);
    expect(strategiesFired).toContain("autofix-implementer");

    // typecheck-check runs twice: once failing (triggers fix), once passing after
    // autofix-implementer revalidation (STRATEGY_TO_REVALIDATION_PHASES includes
    // lint-check, typecheck-check, full-suite-gate, semantic-review, adversarial-review).
    // full-suite-gate is absent in test-after (no full-suite gate, only verify-scoped).
    expect(phaseLog.filter((p) => p === "typecheck-check").length).toBe(2);
    expect(phaseLog.filter((p) => p === "lint-check").length).toBe(2);

    // verify-scoped (the test gate in test-after) runs once in the main loop — NOT
    // re-run after autofix-implementer (revalidation set excludes it).
    expect(phaseLog.filter((p) => p === "verify-scoped").length).toBe(1);

    // semantic-review and adversarial-review run once each (only after revalidation,
    // as the first typecheck failure short-circuits before reviews in the main loop
    // and revalidation runs them after the fix).
    expect(phaseLog.filter((p) => p === "semantic-review").length).toBe(1);
    expect(phaseLog.filter((p) => p === "adversarial-review").length).toBe(1);

    // Full observed sequence (locked from 2026-06-14 run):
    // implementer, verify-scoped, lint-check, typecheck-check [FAIL]
    // → autofix-implementer fires
    // → revalidation: lint-check, typecheck-check [PASS], semantic-review, adversarial-review
    expect(phaseLog).toEqual([
      "implementer",
      "verify-scoped",
      "lint-check",
      "typecheck-check",
      "lint-check",
      "typecheck-check",
      "semantic-review",
      "adversarial-review",
    ]);
  });

  test("three-session: typecheck fail -> autofix-implementer re-runs full-suite-gate, NOT verifier", async () => {
    // Strategy parity for autofix-implementer. In three-session the full-suite-gate IS
    // present, so the revalidation set [lint, typecheck, full-suite-gate, semantic, adversarial]
    // re-runs it (it was absent in the test-after variant above). The verifier is the
    // TDD-isolation judge — a once-per-story phase NOT in the revalidation set — so it
    // must run exactly once despite the source-code fix.
    const tw = () => ({ output: JSON.stringify({ filesChanged: ["test/a.test.ts"] }) });
    const verifier = () => ({ output: PASSING_VERDICT });
    let tcCall = 0;
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
        typecheck: () => (tcCall++ === 0 ? FAIL_TC : PASS_TC),
      },
    });

    expect(result.success).toBe(true);
    expect(strategiesFired).toContain("autofix-implementer");
    // full-suite-gate re-run by revalidation (present in three-session): runs twice.
    expect(phaseLog.filter((p) => p === "full-suite-gate").length).toBe(2);
    expect(phaseLog.filter((p) => p === "typecheck-check").length).toBe(2);
    expect(phaseLog.filter((p) => p === "lint-check").length).toBe(2);
    // SOUNDNESS: verifier NOT re-run by autofix-implementer (excluded from its set).
    expect(phaseLog.filter((p) => p === "verifier").length).toBe(1);
    expect(phaseLog.filter((p) => p === "semantic-review").length).toBe(1);
    expect(phaseLog.filter((p) => p === "adversarial-review").length).toBe(1);

    // Main loop short-circuits at typecheck-check (pos 8) → autofix-implementer →
    // revalidation in canonical order: full-suite-gate(4), lint(7), typecheck(8),
    // semantic(9), adversarial(10).
    expect(phaseLog).toEqual([
      "test-writer",
      "greenfield-gate",
      "implementer",
      "full-suite-gate",
      "verifier",
      "lint-check",
      "typecheck-check",
      "full-suite-gate",
      "lint-check",
      "typecheck-check",
      "semantic-review",
      "adversarial-review",
    ]);
  });

  test("adversarial(test-gap) -> autofix-test-writer -> revalidation set", async () => {
    const tw = () => ({ output: JSON.stringify({ filesChanged: ["test/a.test.ts"] }) });
    const verifier = () => ({ output: PASSING_VERDICT });
    let advAttempt = 0;

    const failingAdversarial = JSON.stringify({
      passed: false,
      findings: [{
        severity: "warning",
        category: "test-gap",
        file: "test/a.test.ts",
        line: 1,
        issue: "missing edge-case test for null input",
        suggestion: "add test for null handling",
        // verifiedBy.observed makes checkFindingEvidence return "unreadable" (file
        // doesn't exist in the temp workdir) rather than "missing-observed".
        // "unreadable" is not downgraded in substantiateAdversarialFindings, so the
        // "warning" finding stays blocking when blockingThreshold="warning".
        verifiedBy: { file: "test/a.test.ts", observed: "expect(fn(null))" },
      }],
    });
    const passingAdversarial = JSON.stringify({ passed: true, findings: [] });

    const { result, phaseLog, strategiesFired } = await runOrchestratorE2E({
      strategy: "three-session-tdd",
      config: { review: { blockingThreshold: "warning" } } as unknown as Partial<NaxConfig>,
      agent: {
        "test-writer": tw,
        implementer: impl,
        verifier,
        "reviewer-semantic": PASS_REVIEW,
        // attempt 0 → failing adversarial with test-gap finding; attempt 1+ → passing
        "reviewer-adversarial": () => ({ output: advAttempt++ === 0 ? failingAdversarial : passingAdversarial }),
      },
    });

    // Observed 2026-06-14: autofix-test-writer fires on test-gap adversarial finding
    // in three-session-tdd (autofix-test-writer is only assembled for three-session-tdd).
    expect(result.success).toBe(true);
    expect(strategiesFired).toContain("autofix-test-writer");

    // adversarial-review runs twice: once failing (triggers fix), once passing after
    // autofix-test-writer revalidation
    // (STRATEGY_TO_REVALIDATION_PHASES["autofix-test-writer"] =
    //   ["lint-check", "typecheck-check", "full-suite-gate", "adversarial-review"]).
    // phasesToRevalidate preserves canonical phase order, so full-suite-gate appears
    // before lint-check/typecheck-check in revalidation (canonical pos 4 vs 6/7).
    expect(phaseLog.filter((p) => p === "adversarial-review").length).toBe(2);
    expect(phaseLog.filter((p) => p === "lint-check").length).toBe(2);
    expect(phaseLog.filter((p) => p === "typecheck-check").length).toBe(2);
    expect(phaseLog.filter((p) => p === "full-suite-gate").length).toBe(2);

    // verifier and semantic-review each run once (not re-run by autofix-test-writer).
    expect(phaseLog.filter((p) => p === "verifier").length).toBe(1);
    expect(phaseLog.filter((p) => p === "semantic-review").length).toBe(1);

    // Full observed sequence (locked from 2026-06-14 run):
    // test-writer, greenfield-gate, implementer, full-suite-gate, verifier,
    // lint-check, typecheck-check, semantic-review, adversarial-review [FAIL]
    // → autofix-test-writer fires
    // → revalidation: full-suite-gate, lint-check, typecheck-check, adversarial-review [PASS]
    expect(phaseLog).toEqual([
      "test-writer",
      "greenfield-gate",
      "implementer",
      "full-suite-gate",
      "verifier",
      "lint-check",
      "typecheck-check",
      "semantic-review",
      "adversarial-review",
      "full-suite-gate",
      "lint-check",
      "typecheck-check",
      "adversarial-review",
    ]);
  });

  test("adversarial(error-path=source) -> autofix-implementer, NOT autofix-test-writer (#1333)", async () => {
    // Regression lock for #1333: in three-session TDD, a SOURCE-targeted adversarial
    // finding (category error-path ∈ BLOCKING_CATEGORIES → fixTarget "source" after the
    // real adversarialReviewOp normalizes it) must be claimed by autofix-implementer,
    // which can edit source — NOT autofix-test-writer, which is forbidden from touching
    // source. Prior to #1333 the test-writer's blanket clause claimed it, so the source
    // bug could never be fixed and rectification exhausted (repro: a downstream
    // tier3-analytics-tools US-002). This test would fire autofix-test-writer on the old
    // code. Compare with the test-gap (fixTarget=test) sibling above.
    const tw = () => ({ output: JSON.stringify({ filesChanged: ["test/a.test.ts"] }) });
    const verifier = () => ({ output: PASSING_VERDICT });
    let advAttempt = 0;

    // Mirrors the test-gap sibling exactly (same severity/threshold/evidence path so
    // substantiation keeps the finding blocking) — the ONLY change is the category,
    // which flips fixTarget test→source and therefore the fix lane test-writer→implementer.
    const failingAdversarial = JSON.stringify({
      passed: false,
      findings: [{
        severity: "warning",
        category: "error-path",
        file: "src/a.ts",
        line: 1,
        issue: "unaligned variance check bypasses the near-zero guard on shared dates",
        suggestion: "compute variance on the aligned window before applying the threshold",
        verifiedBy: { file: "src/a.ts", observed: "bm_var = benchmark_returns.var()" },
      }],
    });
    const passingAdversarial = JSON.stringify({ passed: true, findings: [] });

    const { result, phaseLog, strategiesFired } = await runOrchestratorE2E({
      strategy: "three-session-tdd",
      config: { review: { blockingThreshold: "warning" } } as unknown as Partial<NaxConfig>,
      agent: {
        "test-writer": tw,
        implementer: impl,
        verifier,
        "reviewer-semantic": PASS_REVIEW,
        // attempt 0 → failing source-category finding; attempt 1+ → passing.
        "reviewer-adversarial": () => ({ output: advAttempt++ === 0 ? failingAdversarial : passingAdversarial }),
      },
    });

    expect(result.success).toBe(true);
    // #1333 lock: the SOURCE finding routes to the implementer, never the test-writer.
    expect(strategiesFired).toContain("autofix-implementer");
    expect(strategiesFired).not.toContain("autofix-test-writer");

    // adversarial-review runs twice (fail → fix → pass).
    expect(phaseLog.filter((p) => p === "adversarial-review").length).toBe(2);
    // Orthogonal routing signal: autofix-implementer's revalidation set INCLUDES
    // semantic-review (runs twice), whereas autofix-test-writer EXCLUDES it (would run
    // once). Two semantic-review phases prove the implementer lane handled the finding.
    expect(phaseLog.filter((p) => p === "semantic-review").length).toBe(2);
    // verifier is a once-per-story phase, not in either revalidation set.
    expect(phaseLog.filter((p) => p === "verifier").length).toBe(1);

    // Full observed sequence: main loop fails at adversarial-review → autofix-implementer
    // fires → revalidation in canonical order (full-suite-gate, lint, typecheck,
    // semantic, adversarial).
    expect(phaseLog).toEqual([
      "test-writer",
      "greenfield-gate",
      "implementer",
      "full-suite-gate",
      "verifier",
      "lint-check",
      "typecheck-check",
      "semantic-review",
      "adversarial-review",
      "full-suite-gate",
      "lint-check",
      "typecheck-check",
      "semantic-review",
      "adversarial-review",
    ]);
  });
});
