/**
 * E2E: cross-attempt review-recurrence circuit-breaker (#1666 Part C).
 *
 * `runOrchestratorE2E()` normally creates a fresh runtime per call and closes
 * it before returning, and it returns at `ExecutionPlan.run()` — never
 * reaching `decideStageAction` in post-run.ts, where the breaker is consumed.
 * Neither limitation lets a test observe the counter actually accumulating
 * ACROSS attempts, which is the entire point of Part C (see
 * `test/helpers/e2e/orchestrator-harness.ts`'s `sharedRuntime` option, added
 * for this file).
 *
 * `adversarial-recurrence-demotion.e2e.test.ts`, despite its name, exercises a
 * finding recurring across review ROUNDS WITHIN ONE ExecutionPlan.run() call —
 * that is the pre-existing within-cycle oscillation counter's territory
 * (oscillation-store.ts). This file drives several SEPARATE
 * `runOrchestratorE2E()` calls against one shared runtime, simulating
 * escalation re-running the whole story attempt after attempt, which is what
 * the NEW cross-attempt counter (recurrence-store.ts) is for and the old one
 * is structurally blind to.
 *
 * Not wiring the full post-run stage through the harness — asserting
 * `inspectRecurrenceBreaker(ctx).trip` directly against the shared runtime
 * after N attempts is the valuable, sufficient check (per review).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { makeMockRuntime, makeNaxConfig, makeTestContext, makeTestStory, runOrchestratorE2E } from "@test/helpers";
import { inspectRecurrenceBreaker } from "@/execution";
import type { NaxRuntime } from "@/runtime";

const AC_TEXT = "The loop must not read past the end of the array under any input.";

// `runOrchestratorE2E()`'s CallContext.storyId is hardcoded to "US-001"
// (`makeMockCallContext`'s default — the harness never threads `story.id` into
// it), so every attempt in this file records into the shared runtime's store
// under "US-001" regardless of the PRD story's own id. Each test below uses its
// own fresh `sharedRuntime`, so this is harmless here — just query the breaker
// under "US-001" to match.

const tw = () => ({ output: JSON.stringify({ filesChanged: ["test/a.test.ts"] }) });
const impl = () => ({ output: JSON.stringify({ filesChanged: ["src/a.ts"] }) });
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
const verifier = () => ({ output: PASSING_VERDICT });
const PASS_ADVERSARIAL = () => ({ output: JSON.stringify({ passed: true, findings: [] }) });

/**
 * A blocking semantic finding at a given `line`. Two calls with the same
 * `line` produce the SAME `findingRecurrenceKey` (source+file+line — semantic
 * findings never carry `rule`); different `line`s produce different keys.
 *
 * `verifiedBy` is present (so `sanitizeRefModeFindings` does not downgrade it
 * to "unverifiable" for lacking evidence) but points at a file that does not
 * exist in the scripted (non-git) temp workdir, so `checkFindingEvidence`
 * reports "unreadable" — which `substantiateSemanticEvidence` does NOT
 * downgrade (only "unmatched" does). `acIndex: 1` clears the AC-grounding
 * filter. Same technique as `adversarial-recurrence-demotion.e2e.test.ts`.
 */
function semanticBlock(line: number): string {
  return JSON.stringify({
    passed: false,
    findings: [
      {
        severity: "error",
        category: "logic",
        file: "src/a.ts",
        line,
        issue: "loop bound is off by one and can read past the array end",
        suggestion: "use < instead of <= for the upper bound",
        acIndex: 1,
        verifiedBy: { file: "src/a.ts", observed: "for (let i = 0; i <= arr.length; i++)" },
      },
    ],
  });
}

let sharedRuntime: NaxRuntime | undefined;
afterEach(async () => {
  await sharedRuntime?.close();
  sharedRuntime = undefined;
});

/**
 * Mirrors `orchestrator-harness.ts`'s `makeE2EConfig()` defaults exactly.
 * The shared runtime's config is fixed at construction (ConfigLoader has no
 * live-update seam) and governs `full-suite-gate`'s command resolution via
 * `ctx.packageView.config` — it must agree with what each attempt's own
 * per-call config carries, or the gate fails to detect a test command.
 */
function makeSharedRuntime(): NaxRuntime {
  return makeMockRuntime({
    config: makeNaxConfig({
      quality: {
        commands: { lint: "lint", typecheck: "tc", test: "true", lintFix: "lint --fix" },
        autofix: { enabled: true },
      },
      review: { enabled: true, checks: ["lint", "typecheck"] },
    }),
  });
}

function breakerCtxFor(runtime: NaxRuntime, storyId: string) {
  const ctx = makeTestContext({ story: makeTestStory({ id: storyId, title: "Recurrence breaker e2e" }) });
  ctx.config = {
    ...ctx.config,
    review: {
      ...ctx.config.review,
      conflictDetection: { enabled: true, maxOscillations: 2, maxCrossAttemptRecurrences: 2 },
    },
  } as typeof ctx.config;
  Object.defineProperty(ctx, "runtime", { value: runtime, configurable: true });
  return ctx;
}

describe("E2E: cross-attempt review-recurrence breaker", () => {
  test("the SAME semantic-review finding recurring across 3 attempts trips the breaker", async () => {
    sharedRuntime = makeSharedRuntime();

    for (let attempt = 0; attempt < 3; attempt++) {
      const { result } = await runOrchestratorE2E({
        strategy: "three-session-tdd",
        story: { acceptanceCriteria: [AC_TEXT] },
        sharedRuntime,
        rectification: { maxAttempts: 1 },
        agent: {
          "test-writer": tw,
          implementer: impl,
          verifier,
          // Every attempt: the SAME finding at the SAME line.
          "reviewer-semantic": () => ({ output: semanticBlock(5) }),
          "reviewer-adversarial": PASS_ADVERSARIAL,
        },
      });
      // The story fails every attempt on semantic-review's own finding — Part B
      // runs adversarial-review too, but it never overrides the verdict.
      expect(result.success).toBe(false);
    }

    const decision = inspectRecurrenceBreaker(breakerCtxFor(sharedRuntime, "US-001"));
    expect(decision.trip).toBe(true);
    expect(decision.source).toBe("semantic-review");
  });

  test("negative: a reviewer's first-ever appearance does not trip the breaker", async () => {
    sharedRuntime = makeSharedRuntime();

    const { result } = await runOrchestratorE2E({
      strategy: "three-session-tdd",
      story: { acceptanceCriteria: [AC_TEXT] },
      sharedRuntime,
      rectification: { maxAttempts: 1 },
      agent: {
        "test-writer": tw,
        implementer: impl,
        verifier,
        "reviewer-semantic": () => ({ output: semanticBlock(5) }),
        "reviewer-adversarial": PASS_ADVERSARIAL,
      },
    });

    expect(result.success).toBe(false);
    const decision = inspectRecurrenceBreaker(breakerCtxFor(sharedRuntime, "US-001"));
    expect(decision.trip).toBe(false);
  });

  test("negative: a DIFFERENT finding each attempt never recurs and does not trip the breaker", async () => {
    sharedRuntime = makeSharedRuntime();

    for (let attempt = 0; attempt < 3; attempt++) {
      const line = 5 + attempt; // a different location -> a different findingRecurrenceKey every attempt
      const { result } = await runOrchestratorE2E({
        strategy: "three-session-tdd",
        story: { acceptanceCriteria: [AC_TEXT] },
        sharedRuntime,
        rectification: { maxAttempts: 1 },
        agent: {
          "test-writer": tw,
          implementer: impl,
          verifier,
          "reviewer-semantic": () => ({ output: semanticBlock(line) }),
          "reviewer-adversarial": PASS_ADVERSARIAL,
        },
      });
      expect(result.success).toBe(false);
    }

    const decision = inspectRecurrenceBreaker(breakerCtxFor(sharedRuntime, "US-001"));
    expect(decision.trip).toBe(false);
  });
});
