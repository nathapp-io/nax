/**
 * Tests for src/execution/lifecycle/acceptance-fix.ts
 *
 * Covers (US-005):
 * - fast paths that must survive the semantic-verdict deletion (no LLM call)
 * - the slow path: exactly one `acceptanceDiagnoseOp` dispatch via callOp
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeDiagnoseOutput, makeMockRuntime, makeNaxConfig, makePRD, makeStory } from "@test/helpers";
import type { NaxConfig } from "@/config/schema";
import { _diagnosisDeps, resolveAcceptanceDiagnosis } from "@/execution/lifecycle/acceptance-fix";
import type { AcceptanceLoopContext } from "@/execution/lifecycle/acceptance-loop";
import { acceptanceDiagnoseOp } from "@/operations";
import type { AcceptanceDiagnoseInput } from "@/operations/acceptance-diagnose";
import type { CallContext } from "@/operations/types";

function makeConfig(): NaxConfig {
  return makeNaxConfig({
    models: { claude: { fast: "haiku", balanced: "sonnet", powerful: "opus" } },
    agent: { protocol: "acp" },
  });
}

function makeAcceptanceCtx(withRuntime = false): AcceptanceLoopContext {
  // `withRuntime` is retained for readability at call sites (fast-path tests
  // never dereference `ctx.runtime`), but DispatchContext requires `runtime`
  // (and its `agentManager`/`sessionManager` siblings) unconditionally, so
  // both branches must supply a valid mock — sourced from ONE runtime so
  // `ctx.agentManager === ctx.runtime.agentManager`, as in production.
  const runtime = makeMockRuntime({ config: makeConfig() });
  void withRuntime;
  return {
    config: makeConfig(),
    prd: makePRD({ userStories: [makeStory({ id: "US-001", acceptanceCriteria: [] })] }),
    prdPath: "/tmp/prd.json",
    workdir: "/tmp/workdir",
    featureDir: "/tmp/features/test",
    feature: "test-feature",
    hooks: {} as AcceptanceLoopContext["hooks"],
    totalCost: 0,
    iterations: 0,
    storiesCompleted: 0,
    allStoryMetrics: [],
    pluginRegistry: {} as AcceptanceLoopContext["pluginRegistry"],
    statusWriter: {} as AcceptanceLoopContext["statusWriter"],
    agentManager: runtime.agentManager,
    sessionManager: runtime.sessionManager,
    abortSignal: new AbortController().signal,
    acceptanceTestPaths: [{ testPath: "/tmp/features/test/.nax-acceptance.test.ts", packageDir: "/tmp/workdir" }],
    runtime,
  };
}

function makeDiagnosisOpts() {
  return {
    testOutput: "(fail) AC-1: failed",
    testFileContent: "test('AC-1', () => {});",
    workdir: "/tmp/workdir",
    storyId: "US-001",
  };
}

/** A callOp stub that records every dispatch and never reaches an agent. */
function recordCallOp(calls: Array<{ ctx: CallContext; op: unknown; input: AcceptanceDiagnoseInput }>) {
  return async (ctx: CallContext, op: typeof acceptanceDiagnoseOp, input: AcceptanceDiagnoseInput) => {
    calls.push({ ctx, op, input });
    return makeDiagnoseOutput({ verdict: "source_bug", reasoning: "LLM diagnosis", confidence: 0.8 });
  };
}

let savedCallOp: typeof _diagnosisDeps.callOp;

beforeEach(() => {
  savedCallOp = _diagnosisDeps.callOp;
});

afterEach(() => {
  _diagnosisDeps.callOp = savedCallOp;
  mock.restore();
});

// ─── resolveAcceptanceDiagnosis fast paths ───────────────────────────────────

describe("resolveAcceptanceDiagnosis() — fast paths", () => {
  test("US-005 AC1: implement-only strategy returns source_bug with confidence 1.0 and never calls callOp", async () => {
    const calls: Array<{ ctx: CallContext; op: unknown; input: AcceptanceDiagnoseInput }> = [];
    _diagnosisDeps.callOp = recordCallOp(calls);

    const result = await resolveAcceptanceDiagnosis({
      ctx: makeAcceptanceCtx(),
      failures: { failedACs: ["AC-1"], testOutput: "fail" },
      totalACs: 10,
      strategy: "implement-only",
      diagnosisOpts: makeDiagnosisOpts(),
    });

    expect(result.verdict).toBe("source_bug");
    expect(result.confidence).toBe(1.0);
    expect(calls).toHaveLength(0);
  });

  test("US-005 AC2: diagnose-first + AC-ERROR sentinel returns test_bug with confidence 0.9 and never calls callOp", async () => {
    const calls: Array<{ ctx: CallContext; op: unknown; input: AcceptanceDiagnoseInput }> = [];
    _diagnosisDeps.callOp = recordCallOp(calls);

    const result = await resolveAcceptanceDiagnosis({
      ctx: makeAcceptanceCtx(),
      failures: { failedACs: ["AC-ERROR"], testOutput: "test crashed" },
      totalACs: 10,
      strategy: "diagnose-first",
      diagnosisOpts: makeDiagnosisOpts(),
    });

    expect(result.verdict).toBe("test_bug");
    expect(result.confidence).toBe(0.9);
    expect(calls).toHaveLength(0);
  });

  test("diagnose-first + >80% ACs failed returns test_bug without calling callOp", async () => {
    const calls: Array<{ ctx: CallContext; op: unknown; input: AcceptanceDiagnoseInput }> = [];
    _diagnosisDeps.callOp = recordCallOp(calls);

    const result = await resolveAcceptanceDiagnosis({
      ctx: makeAcceptanceCtx(),
      failures: {
        failedACs: ["AC-1", "AC-2", "AC-3", "AC-4", "AC-5", "AC-6", "AC-7", "AC-8", "AC-9"],
        testOutput: "fail",
      },
      totalACs: 10,
      strategy: "diagnose-first",
      diagnosisOpts: makeDiagnosisOpts(),
    });

    expect(result.verdict).toBe("test_bug");
    expect(result.confidence).toBe(0.9);
    expect(result.reasoning).toContain("Test-level failure");
    expect(calls).toHaveLength(0);
  });
});

// ─── resolveAcceptanceDiagnosis slow path ────────────────────────────────────

describe("resolveAcceptanceDiagnosis() — LLM diagnosis dispatch", () => {
  test("US-005 AC3: 1 of 10 ACs failed with diagnose-first calls callOp exactly once with acceptanceDiagnoseOp", async () => {
    const calls: Array<{ ctx: CallContext; op: unknown; input: AcceptanceDiagnoseInput }> = [];
    _diagnosisDeps.callOp = recordCallOp(calls);

    const result = await resolveAcceptanceDiagnosis({
      ctx: makeAcceptanceCtx(true), // runtime required for the slow path
      failures: { failedACs: ["AC-1"], testOutput: "(fail) AC-1" },
      totalACs: 10,
      strategy: "diagnose-first",
      diagnosisOpts: makeDiagnosisOpts(),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].op).toBe(acceptanceDiagnoseOp);
    expect(result.verdict).toBe("source_bug");
  });

  test("slow path dispatches diagnosis with the failed package context", async () => {
    const calls: Array<{ ctx: CallContext; op: unknown; input: AcceptanceDiagnoseInput }> = [];
    _diagnosisDeps.callOp = recordCallOp(calls);
    const packageConfig = makeNaxConfig({ execution: { permissionProfile: "safe" } });

    await resolveAcceptanceDiagnosis({
      ctx: makeAcceptanceCtx(true),
      failures: { failedACs: ["AC-1", "AC-2"], testOutput: "failure" },
      totalACs: 3,
      strategy: "diagnose-first",
      diagnosisOpts: {
        ...makeDiagnosisOpts(),
        workdir: "/tmp/workdir/packages/web",
        config: packageConfig,
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].ctx.packageDir).toBe("/tmp/workdir/packages/web");
    expect(calls[0].ctx.config?.execution?.permissionProfile).toBe("safe");
  });

  test("a low failure ratio always reaches the op and returns the LLM verdict verbatim", async () => {
    _diagnosisDeps.callOp = async () =>
      makeDiagnoseOutput({ verdict: "both", reasoning: "LLM diagnosis", confidence: 0.7 });

    const result = await resolveAcceptanceDiagnosis({
      ctx: makeAcceptanceCtx(true),
      failures: { failedACs: ["AC-1", "AC-2"], testOutput: "two failures" },
      totalACs: 10,
      strategy: "diagnose-first",
      diagnosisOpts: makeDiagnosisOpts(),
    });

    expect(result.verdict).toBe("both");
    expect(result.confidence).toBe(0.7);
  });
});
