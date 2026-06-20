import { describe, expect, test } from "bun:test";
import type { QualityCommandResult } from "@/quality/runner";
import { runOrchestratorE2E } from "@test/helpers";

const PASS_REVIEW = () => ({ output: JSON.stringify({ passed: true, findings: [] }) });
const impl = () => ({ output: JSON.stringify({ filesChanged: ["src/a.ts"] }) });

const ALWAYS_FAIL_TC: QualityCommandResult = {
  commandName: "typecheck",
  command: "tc",
  success: false,
  exitCode: 1,
  output: "TS2304: Cannot find name 'x'",
  durationMs: 1,
  timedOut: false,
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

describe("E2E: exhaustion + edge", () => {
  test("persistent typecheck failure exhausts rectification and fails the story", async () => {
    // autofix-implementer fires on every typecheck failure. With maxAttempts: 3,
    // the strategy fires 3 times, each time re-validating and failing again.
    // Observed 2026-06-14: exitReason="validate-short-circuit", iterationCount=3,
    // rectificationExhausted=true, success=false.
    const { result } = await runOrchestratorE2E({
      strategy: "test-after",
      agent: { implementer: impl, "reviewer-semantic": PASS_REVIEW, "reviewer-adversarial": PASS_REVIEW },
      gates: {
        typecheck: () => ALWAYS_FAIL_TC,
      },
    });
    expect(result.success).toBe(false);
    expect(result.rectificationExhausted).toBe(true);
  });

  test("greenfield-gate pauses with greenfield-no-tests when no tests exist (seed disabled)", async () => {
    // With the placeholder seed disabled, the scripted test-writer does not write real
    // files, so greenfield-gate finds no pre-existing tests and short-circuits the run
    // with pauseReason "greenfield-no-tests" (BUG-010). The implementer never runs.
    const tw = () => ({ output: JSON.stringify({ filesChanged: ["test/a.test.ts"] }) });
    const verifier = () => ({ output: PASSING_VERDICT });
    const { result, phaseLog } = await runOrchestratorE2E({
      strategy: "three-session-tdd",
      seedPlaceholderTest: false,
      agent: {
        "test-writer": tw,
        implementer: impl,
        verifier,
        "reviewer-semantic": PASS_REVIEW,
        "reviewer-adversarial": PASS_REVIEW,
      },
    });

    expect(result.success).toBe(false);
    const gateOut = result.phaseOutputs["greenfield-gate"] as { pauseReason?: string } | undefined;
    expect(gateOut?.pauseReason).toBe("greenfield-no-tests");
    // Short-circuit at the gate: implementer (canonical pos 3) never runs.
    expect(phaseLog).not.toContain("implementer");
  });

  test("no-strategy: a finding no loaded strategy matches exhausts with zero fix attempts", async () => {
    // With autofix disabled, the only loaded strategies are mechanical-lintfix (lintFix
    // present) and full-suite-rectify (verify-scoped present): one claims lint findings,
    // the other claims test-runner findings. A blocking adversarial finding (source
    // "adversarial") matches NEITHER, so the cycle exits "no-strategy" at iteration 0 —
    // rectification is exhausted and no fix op is ever dispatched. (Adversarial findings
    // survive substantiation without an AC index, unlike semantic findings — so this is
    // the clean way to land a surviving-but-unmatched finding.)
    const failingAdversarial = () => ({
      output: JSON.stringify({
        passed: false,
        findings: [
          {
            severity: "warning",
            category: "test-gap",
            file: "test/a.test.ts",
            line: 1,
            issue: "missing edge-case coverage",
            suggestion: "add the missing test",
            verifiedBy: { file: "test/a.test.ts", observed: "expect(fn(null))" },
          },
        ],
      }),
    });
    const { result, strategiesFired } = await runOrchestratorE2E({
      strategy: "test-after",
      // autofix off → no autofix-* strategies; blockingThreshold "warning" → the finding blocks.
      config: {
        quality: { autofix: { enabled: false } },
        review: { blockingThreshold: "warning" },
      } as unknown as Parameters<typeof runOrchestratorE2E>[0]["config"],
      agent: { implementer: impl, "reviewer-semantic": PASS_REVIEW, "reviewer-adversarial": failingAdversarial },
    });

    expect(result.success).toBe(false);
    expect(result.rectificationExhausted).toBe(true);
    // No fix op was dispatched — no loaded strategy matched the adversarial finding.
    expect(strategiesFired).toEqual([]);
  });

  test("bail-when: increasing typecheck failures abort before maxAttempts", async () => {
    // typecheck regresses (1 error → 2 errors) after the autofix-implementer fix. With
    // abortOnIncreasingFailures enabled and consecutiveIncreasesToBail=1, the cycle bails
    // on the first increase rather than burning all maxAttempts. Exhausted=true, but the
    // typecheck phase ran fewer times than the always-fail exhaustion case (3 attempts).
    let tcCall = 0;
    const tc = () => {
      const n = tcCall++;
      return {
        commandName: "typecheck",
        command: "tc",
        success: false,
        exitCode: 1,
        // attempt 0: one error; attempt 1+: two errors (increasing finding count).
        output: n === 0 ? "TS2304: Cannot find name 'a'" : "TS2304: name 'a'\nTS2305: name 'b'",
        durationMs: 1,
        timedOut: false,
      };
    };
    const { result, phaseLog } = await runOrchestratorE2E({
      strategy: "test-after",
      rectification: { maxAttempts: 5, abortOnIncreasingFailures: true, consecutiveIncreasesToBail: 1 },
      agent: { implementer: impl, "reviewer-semantic": PASS_REVIEW, "reviewer-adversarial": PASS_REVIEW },
      gates: { typecheck: tc },
    });

    expect(result.success).toBe(false);
    expect(result.rectificationExhausted).toBe(true);
    // Bailed early: typecheck ran far fewer than maxAttempts (5) times.
    expect(phaseLog.filter((p) => p === "typecheck-check").length).toBeLessThan(5);
  });

  test("greenfield-gate runs and does not prevent three-session completion", async () => {
    // The harness seeds a placeholder test file (test/placeholder.test.ts) so
    // greenfield-gate detects pre-existing tests and proceeds normally (does not pause
    // with "greenfield-no-tests"). Three-session completes all phases successfully.
    const tw = () => ({ output: JSON.stringify({ filesChanged: ["test/a.test.ts"] }) });
    const verifier = () => ({ output: PASSING_VERDICT });
    const { result, phaseLog } = await runOrchestratorE2E({
      strategy: "three-session-tdd",
      agent: {
        "test-writer": tw,
        implementer: impl,
        verifier,
        "reviewer-semantic": PASS_REVIEW,
        "reviewer-adversarial": PASS_REVIEW,
      },
    });
    // greenfield-gate must appear in the log (it always runs in three-session-tdd)
    expect(phaseLog).toContain("greenfield-gate");
    // With seeded placeholder.test.ts, greenfield-gate does NOT pause — three-session completes normally
    expect(result.success).toBe(true);
  });

  test("full-suite-gate regression during revalidation causes rectification failure (gateRegressedDuringRect stays false)", async () => {
    // Scenario: typecheck fails (call 0) → autofix-implementer fires → revalidation
    // runs full-suite-gate (call 1 → fails) and typecheck-check (call 1 → passes).
    // full-suite-gate failure in revalidation causes rectification to fail with
    // exitReason="validator-error" (iterationCount=0, single attempt).
    //
    // shouldSkipPhaseForRectification controls skipping phases in the MAIN pipeline
    // re-run, not in the revalidation set assembled by STRATEGY_TO_REVALIDATION_PHASES.
    // autofix-implementer revalidation always includes full-suite-gate regardless of
    // whether verifier passed — the verifier is in the main loop, not revalidation.
    // Therefore gateRegressedDuringRect stays false (the staleness guard never triggers)
    // because the revalidation failure is detected by the rectification engine itself,
    // not by the staleness-guard path.
    //
    // Observed 2026-06-14: success=false, gateRegressedDuringRect=false,
    // phaseLog includes full-suite-gate 3 times (1 initial pass + 2 revalidation failures).
    const tw = () => ({ output: JSON.stringify({ filesChanged: ["test/a.test.ts"] }) });
    const verifier = () => ({ output: PASSING_VERDICT });
    let tcCall = 0;
    let fsCall = 0;

    const { result, phaseLog } = await runOrchestratorE2E({
      strategy: "three-session-tdd",
      agent: {
        "test-writer": tw,
        implementer: impl,
        verifier,
        "reviewer-semantic": PASS_REVIEW,
        "reviewer-adversarial": PASS_REVIEW,
      },
      gates: {
        typecheck: () =>
          tcCall++ === 0
            ? {
                commandName: "typecheck",
                command: "tc",
                success: false,
                exitCode: 1,
                output: "TS2304",
                durationMs: 1,
                timedOut: false,
              }
            : {
                commandName: "typecheck",
                command: "tc",
                success: true,
                exitCode: 0,
                output: "",
                durationMs: 1,
                timedOut: false,
              },
        fullSuite: () =>
          fsCall++ === 0 ? { passed: true, failed: 0 } : { passed: false, failed: 1, output: "new failure" },
      },
    });

    // Staleness guard did NOT trigger — gateRegressedDuringRect is false because
    // the full-suite-gate regression was detected inside the revalidation set, not
    // the main pipeline loop where the staleness guard operates.
    expect(result.gateRegressedDuringRect).toBe(false);
    // Story fails because revalidation keeps hitting the regressed full-suite-gate.
    expect(result.success).toBe(false);
    // full-suite-gate appears 3 times: once in the main loop (passes), twice in
    // revalidation attempts (both fail because fsCall >= 1 always returns failed).
    expect(phaseLog.filter((p) => p === "full-suite-gate").length).toBe(3);
  });

  test("implementer UNRESOLVED on full-suite-rectify → agent-gave-up exhaustion carries unresolvedDetail (US-002)", async () => {
    // The full-suite gate fails with a test-runner finding → full-suite-rectify is the
    // sole matching strategy. On the rectification turn the implementer emits an
    // `UNRESOLVED:` sentinel (the AC5/AC6 relative-URL contradiction). fullSuiteRectifyOp
    // parses it → extractApplied returns { unresolved } (no test-edit declarations, so the
    // declaration-priority guard does not suppress it) → the cycle exits "agent-gave-up"
    // in round 1, threading unresolvedDetail through to StoryOrchestratorResult.
    //
    // This exercises the REAL producer→result chain (parse → extractApplied → cycle →
    // rectification spread → execution-plan), complementing the post-run unit test which
    // covers result→escalation-reason. Without the fix the sentinel was dropped, the cycle
    // ran extra rounds, and the diagnosis never surfaced.
    const UNRESOLVED_REASON =
      "AC5/AC6 pass relative loginUrl '/login' to OAuthModule.registerAsync; the library rejects relative URLs (new URL('/login') throws)";
    const tw = () => ({ output: JSON.stringify({ filesChanged: ["test/a.test.ts"] }) });
    const verifier = () => ({ output: PASSING_VERDICT });
    // Per-role attempt counter: attempt 0 = main implementer phase (normal output);
    // attempt 1+ = full-suite-rectify fix-op turns (emit the UNRESOLVED sentinel).
    const implementer = (attempt: number) =>
      attempt === 0
        ? { output: JSON.stringify({ filesChanged: ["src/a.ts"] }) }
        : { output: `Tried to fix the failing tests but cannot.\nUNRESOLVED: ${UNRESOLVED_REASON}` };

    const { result } = await runOrchestratorE2E({
      strategy: "three-session-tdd",
      agent: {
        "test-writer": tw,
        implementer,
        verifier,
        "reviewer-semantic": PASS_REVIEW,
        "reviewer-adversarial": PASS_REVIEW,
      },
      gates: {
        fullSuite: () => ({
          passed: false,
          failed: 1,
          output: "AC5/AC6 relative URL failure",
          // Structured failure → source:"test-runner", category:"failed-test" finding,
          // which is what full-suite-rectify.appliesTo matches.
          failures: [{ testName: "AC5 redirects to login", file: "test/oauth/admin.spec.ts", error: "Invalid URL" }],
        }),
      },
    });

    expect(result.success).toBe(false);
    expect(result.rectificationExhausted).toBe(true);
    // The implementer's diagnosis is threaded through verbatim so the escalated tier knows why.
    expect(result.unresolvedDetail).toBe(UNRESOLVED_REASON);
  });
});
