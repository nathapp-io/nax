import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeTestRuntime, withInfoSpy } from "@test/helpers";
import { pickSelector } from "@/config";
import {
  _storyOrchestratorDeps,
  createNbfFlakeTriageTransaction,
  runNonBlockingFix,
  runRectification,
} from "@/execution";
import type { TriageResult } from "@/execution/story-orchestrator";
import type { Finding, FixCycle, FixCycleContext, FixCycleExitReason } from "@/findings";
import type { CallContext, RunOperation } from "@/operations";
import type { NaxRuntime } from "@/runtime";
import type { QuarantineMemo } from "@/verification";

const GATE_NAME = "full-suite-gate";
const FLAKE_KEY = "test/unit/flaky.test.ts::sometimes";
const REAL_KEY = "test/unit/real.test.ts::breaks";
const testSelector = pickSelector("nbf-readonly-flake-triage", "execution");

/** The op fixtures' config slice, derived from the selector so the two cannot drift. */
type TestOpConfig = ReturnType<(typeof testSelector)["select"]>;

const ADVISORY: Finding = {
  source: "adversarial-review",
  severity: "warning",
  category: "style",
  message: "advisory",
};

function failedTest(key: string): Finding {
  const [file, rule] = key.split("::");
  return {
    source: "test-runner",
    severity: "error",
    category: "failed-test",
    message: `failure: ${key}`,
    file,
    rule,
  };
}

function memoFixture(): { memo: QuarantineMemo; keys: Set<string> } {
  const keys = new Set<string>();
  return {
    keys,
    memo: {
      has: (key) => keys.has(key),
      add: (key) => {
        keys.add(key);
      },
    },
  };
}

function gateOp(): RunOperation<{ story: string }, { success: boolean; findings: Finding[] }, TestOpConfig> {
  return {
    kind: "run",
    name: GATE_NAME,
    stage: "verify",
    config: testSelector,
    session: { role: "verifier", lifetime: "fresh" },
    build: () => ({
      role: { id: "role", content: "gate", overridable: false },
      task: { id: "task", content: "", overridable: false },
    }),
    parse: () => ({ success: false, findings: [] }),
  };
}

function rectifyState(): Parameters<typeof runRectification>[1] {
  return {
    fullSuiteGate: { kind: "full-suite-gate", slot: { op: gateOp(), input: { story: "US-1404" } } },
    rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
  } as Parameters<typeof runRectification>[1];
}

let runtime: NaxRuntime | undefined;
let originalCallOp: typeof _storyOrchestratorDeps.callOp;
let originalRunFixCycle: typeof _storyOrchestratorDeps.runFixCycle;
let originalTriage: typeof _storyOrchestratorDeps.triage;

function makeCtx(): FixCycleContext {
  runtime = makeTestRuntime();
  return {
    runtime,
    packageView: runtime.packages.repo(),
    packageDir: "/tmp",
    agentName: "claude",
    storyId: "US-1404",
  };
}

async function captureValidate(
  ctx: CallContext,
  phaseOutputs: Record<string, unknown>,
  flakeTriage: ReturnType<typeof createNbfFlakeTriageTransaction>,
): Promise<FixCycle<Finding>["validate"]> {
  let captured: FixCycle<Finding> | undefined;
  _storyOrchestratorDeps.runFixCycle = mock(async (cycle: FixCycle<Finding>) => {
    captured = cycle;
    return {
      iterations: [],
      finalFindings: [],
      exitReason: "resolved" as FixCycleExitReason,
      costUsd: 0,
    };
  }) as typeof _storyOrchestratorDeps.runFixCycle;

  await runRectification(ctx, rectifyState(), {}, phaseOutputs, {
    initialFindings: [ADVISORY],
    maxAttempts: 2,
    nbfFlakeTriage: flakeTriage,
  });
  if (!captured) throw new Error("[test] rectification did not expose its validation cycle");
  return captured.validate;
}

beforeEach(() => {
  originalCallOp = _storyOrchestratorDeps.callOp;
  originalRunFixCycle = _storyOrchestratorDeps.runFixCycle;
  originalTriage = _storyOrchestratorDeps.triage;
});

afterEach(async () => {
  _storyOrchestratorDeps.callOp = originalCallOp;
  _storyOrchestratorDeps.runFixCycle = originalRunFixCycle;
  _storyOrchestratorDeps.triage = originalTriage;
  await runtime?.close();
  runtime = undefined;
});

describe("createNbfFlakeTriageTransaction", () => {
  test("buffers quarantined keys until commit while reading the run-scoped memo", () => {
    const base = memoFixture();
    base.memo.add("known.test.ts::known");
    const transaction = createNbfFlakeTriageTransaction({ baseMemo: base.memo, baselineKeys: new Set() });

    transaction.memo.add(FLAKE_KEY);

    expect(transaction.memo.has("known.test.ts::known")).toBe(true);
    expect(transaction.memo.has(FLAKE_KEY)).toBe(true);
    expect(base.keys.has(FLAKE_KEY)).toBe(false);
    transaction.commit();
    expect(base.keys.has(FLAKE_KEY)).toBe(true);
  });

  test("offers only new, unknown test failures for one probe per transaction", () => {
    const base = memoFixture();
    base.memo.add("known.test.ts::known");
    const transaction = createNbfFlakeTriageTransaction({
      baseMemo: base.memo,
      baselineKeys: new Set(["baseline.test.ts::before"]),
    });
    const findings = [
      failedTest(FLAKE_KEY),
      failedTest("known.test.ts::known"),
      failedTest("baseline.test.ts::before"),
      { ...failedTest("lint.ts::rule"), source: "lint" as const },
    ];

    expect(transaction.candidates(findings)).toEqual([findings[0]]);
    transaction.recordAttempt([findings[0] as Finding], true);
    expect(transaction.candidates(findings)).toEqual([]);
    expect(transaction.flakeTriageRan).toBe(true);
  });
});

describe("runRectification read-only NBF triage", () => {
  test("confirmed first-observation flake neither seeds repair nor short-circuits, without mutating the gate output", async () => {
    const ctx = makeCtx();
    const base = memoFixture();
    const transaction = createNbfFlakeTriageTransaction({ baseMemo: base.memo, baselineKeys: new Set() });
    const gateOutput = {
      success: false,
      passed: false,
      rawOutput: "bun test: 1 fail",
      findings: [failedTest(FLAKE_KEY)],
    };
    const phaseOutputs: Record<string, unknown> = { [GATE_NAME]: { success: true, passed: true, findings: [] } };
    const validate = await captureValidate(ctx, phaseOutputs, transaction);
    _storyOrchestratorDeps.callOp = mock(async () => gateOutput) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.triage = mock(
      async (findings: Finding[]): Promise<TriageResult> => [
        findings.map((finding) => ({ ...finding, category: "flaky-test" })),
        { quarantinedKeys: [FLAKE_KEY], flakeTriageRan: true },
      ],
    );

    const result = await validate(ctx, { mode: "full", strategiesRun: ["autofix-implementer"] });

    expect(result).toEqual({ findings: [], shortCircuited: false });
    expect(phaseOutputs[GATE_NAME]).toBe(gateOutput);
    expect(gateOutput).toEqual({
      success: false,
      passed: false,
      rawOutput: "bun test: 1 fail",
      findings: [failedTest(FLAKE_KEY)],
    });
    expect(transaction.memo.has(FLAKE_KEY)).toBe(true);
    expect(base.keys.has(FLAKE_KEY)).toBe(false);
  });

  test("mixed flake and genuine regression filters only the flake and keeps the gate blocking", async () => {
    const ctx = makeCtx();
    const base = memoFixture();
    const transaction = createNbfFlakeTriageTransaction({ baseMemo: base.memo, baselineKeys: new Set() });
    const findings = [failedTest(FLAKE_KEY), failedTest(REAL_KEY)];
    const phaseOutputs: Record<string, unknown> = { [GATE_NAME]: { success: true, passed: true, findings: [] } };
    const validate = await captureValidate(ctx, phaseOutputs, transaction);
    _storyOrchestratorDeps.callOp = mock(async () => ({
      success: false,
      rawOutput: "1 fail",
      findings,
    })) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.triage = mock(
      async (): Promise<TriageResult> => [
        [{ ...findings[0], category: "flaky-test" }, findings[1]],
        { quarantinedKeys: [FLAKE_KEY], flakeTriageRan: true },
      ],
    );

    const result = await validate(ctx, { mode: "full", strategiesRun: ["autofix-implementer"] });

    expect(result).toEqual({ findings: [findings[1]], shortCircuited: true });
    expect(transaction.memo.has(FLAKE_KEY)).toBe(true);
    expect(base.keys.has(FLAKE_KEY)).toBe(false);
  });

  test("keyless execution failure remains blocking even when a memo contains its synthetic key", async () => {
    const ctx = makeCtx();
    const base = memoFixture();
    base.memo.add("::");
    const transaction = createNbfFlakeTriageTransaction({ baseMemo: base.memo, baselineKeys: new Set() });
    const executionFailure: Finding = {
      source: "test-runner",
      severity: "error",
      category: "execution-failed",
      message: "test command crashed",
    };
    const phaseOutputs: Record<string, unknown> = { [GATE_NAME]: { success: true, findings: [] } };
    const validate = await captureValidate(ctx, phaseOutputs, transaction);
    _storyOrchestratorDeps.callOp = mock(async () => ({
      success: false,
      rawOutput: "process exited 1",
      findings: [executionFailure],
    })) as typeof _storyOrchestratorDeps.callOp;
    const triage = mock(
      async (findings: Finding[]) => [findings, { quarantinedKeys: [], flakeTriageRan: true }] as const,
    );
    _storyOrchestratorDeps.triage = triage as typeof _storyOrchestratorDeps.triage;

    const result = await validate(ctx, { mode: "full", strategiesRun: ["autofix-implementer"] });

    expect(result).toEqual({ findings: [executionFailure], shortCircuited: true });
    expect(triage).not.toHaveBeenCalled();
  });
});

describe("runNonBlockingFix quarantine transaction", () => {
  const baseArgs = {
    workdir: "/tmp/nax-1404",
    storyId: "US-1404",
    advisoryFindings: [ADVISORY],
    cfg: {
      enabled: true,
      scope: "triage",
      regressionAttempts: 1,
      verifierGuard: true,
      sourceDiffCap: { maxFiles: 10, maxLines: 500 },
    } as const,
    phaseOutputs: { [GATE_NAME]: { success: true } } as Record<string, unknown>,
    phaseCosts: {} as Record<string, number>,
  };
  const deps = {
    captureSnapshotRef: async () => ({ sha: "snapshot", untrackedBefore: null }),
    rollbackToRef: async () => {},
    measureSourceDiff: async () => ({ fileCount: 0, sourceLineCount: 0 }),
  };

  test("commits a confirmed flake only after the pass is kept", async () => {
    const base = memoFixture();
    const result = await runNonBlockingFix(
      {
        ...baseArgs,
        quarantineMemo: base.memo,
        gateBaselineKeys: new Set(),
        runRectify: async (_maxAttempts, transaction) => {
          transaction.memo.add(FLAKE_KEY);
          transaction.recordAttempt([failedTest(FLAKE_KEY)], true);
          return { rectificationExhausted: false };
        },
        keptTreeRegressed: (memo) => ({
          regressed: !memo?.has(FLAKE_KEY),
          regressedKeys: memo?.has(FLAKE_KEY) ? [] : [FLAKE_KEY],
          memoExcludedKeys: memo?.has(FLAKE_KEY) ? [FLAKE_KEY] : [],
          baselineKeySize: 0,
          keyless: false,
        }),
      },
      deps,
    );

    expect(result).toEqual({ ran: true, kept: true, restored: false });
    expect(base.keys.has(FLAKE_KEY)).toBe(true);
  });

  test("drops a buffered flake when the pass is restored", async () => {
    const base = memoFixture();
    let rolledBack = false;
    const result = await runNonBlockingFix(
      {
        ...baseArgs,
        quarantineMemo: base.memo,
        gateBaselineKeys: new Set(),
        runRectify: async (_maxAttempts, transaction) => {
          transaction.memo.add(FLAKE_KEY);
          transaction.recordAttempt([failedTest(FLAKE_KEY)], true);
          return { rectificationExhausted: true };
        },
      },
      {
        ...deps,
        rollbackToRef: async () => {
          rolledBack = true;
        },
      },
    );

    expect(result).toEqual({ ran: true, kept: false, restored: true });
    expect(rolledBack).toBe(true);
    expect(base.keys.has(FLAKE_KEY)).toBe(false);
  });

  test("restore diagnostics report that transaction-local triage ran", async () => {
    const data = await withInfoSpy(async (infoSpy) => {
      await runNonBlockingFix(
        {
          ...baseArgs,
          runRectify: async (_maxAttempts, transaction) => {
            transaction.recordAttempt([failedTest(REAL_KEY)], true);
            return { rectificationExhausted: true };
          },
          keptTreeRegressed: () => ({
            regressed: true,
            regressedKeys: [REAL_KEY],
            memoExcludedKeys: [],
            baselineKeySize: 0,
            keyless: false,
          }),
        },
        deps,
      );
      return infoSpy.mock.calls.find((call) => String(call[1]).includes("exhausted with"))?.[2] as
        | Record<string, unknown>
        | undefined;
    });

    expect(data?.flakeTriageRan).toBe(true);
  });

  test("source-diff-cap restore does not commit buffered flakes", async () => {
    const base = memoFixture();
    const result = await runNonBlockingFix(
      {
        ...baseArgs,
        cfg: { ...baseArgs.cfg, sourceDiffCap: { maxFiles: 1, maxLines: 1 } },
        quarantineMemo: base.memo,
        gateBaselineKeys: new Set(),
        runRectify: async (_maxAttempts, transaction) => {
          transaction.memo.add(FLAKE_KEY);
          transaction.recordAttempt([failedTest(FLAKE_KEY)], true);
          return { rectificationExhausted: false };
        },
      },
      {
        ...deps,
        measureSourceDiff: async () => ({ fileCount: 2, sourceLineCount: 2 }),
      },
    );

    expect(result).toEqual({ ran: true, kept: false, restored: true });
    expect(base.keys.has(FLAKE_KEY)).toBe(false);
  });
});
