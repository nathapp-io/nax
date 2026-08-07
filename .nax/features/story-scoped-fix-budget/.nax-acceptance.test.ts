import { afterEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG, NaxConfigSchema, pickSelector } from "../../../src/config";
import { EXHAUSTED_EXIT_REASONS, _storyOrchestratorDeps, runRectification } from "../../../src/execution";
import type { InternalBuildState } from "../../../src/execution";
import {
  appendStoryFixIterations,
  createStoryFixHistory,
  findingKey,
  getStoryFixState,
  runFixCycle,
  storyFixKey,
} from "../../../src/findings";
import type { Finding, FixCycle, FixCycleContext, FixStrategy, Iteration } from "../../../src/findings";
import { createDeclineLedger } from "../../../src/findings/cycle-retirement";
import { createRuntime } from "../../../src/runtime";
import type { NaxRuntime } from "../../../src/runtime";
import type { CallContext, DeterministicOperation, RunOperation } from "../../../src/operations";
import { makeMockAgentManager, makeNaxConfig } from "../../../test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Shared runtime bookkeeping — every makeTestRuntime/createRuntime instance is
// tracked and closed after each test (scripts/check-runtime-cleanup.sh).
// ─────────────────────────────────────────────────────────────────────────────

const createdRuntimes: NaxRuntime[] = [];

afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

function makeBudgetRuntime(storyScopedFixBudget: boolean): NaxRuntime {
  const config = makeNaxConfig({
    execution: { rectification: { storyScopedFixBudget } },
  } as never);
  const runtime = createRuntime(config, "/tmp/story-fix-budget-test", {
    featureName: "_test",
    agentManager: makeMockAgentManager(),
  });
  createdRuntimes.push(runtime);
  return runtime;
}

// ─────────────────────────────────────────────────────────────────────────────
// US-001 — config knob (AC-1..AC-3)
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-1: storyScopedFixBudget unset defaults to true", () => {
  test("AC-1: NaxConfigSchema.parse({}) resolves execution.rectification.storyScopedFixBudget to true", () => {
    const result = NaxConfigSchema.parse({});
    expect(result.execution.rectification.storyScopedFixBudget).toBe(true);
  });
});

describe("AC-2: a project layer setting storyScopedFixBudget false resolves to false", () => {
  test("AC-2: NaxConfigSchema.parse resolves storyScopedFixBudget: false", () => {
    const result = NaxConfigSchema.parse({
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        rectification: { ...DEFAULT_CONFIG.execution.rectification, storyScopedFixBudget: false },
      },
    });
    expect(result.execution.rectification.storyScopedFixBudget).toBe(false);
  });
});

describe("AC-3: a non-boolean storyScopedFixBudget fails validation", () => {
  test('AC-3: NaxConfigSchema.parse throws for storyScopedFixBudget: "yes"', () => {
    expect(() =>
      NaxConfigSchema.parse({ execution: { rectification: { storyScopedFixBudget: "yes" } } }),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-001 — story-fix-history store (AC-4..AC-9)
// ─────────────────────────────────────────────────────────────────────────────

function sfhIter(num: number): Iteration<Finding> {
  return {
    iterationNum: num,
    findingsBefore: [],
    findingsAfter: [],
    fixesApplied: [{ strategyName: "sfh-strategy", op: "noop-op", targetFiles: [], summary: "" }],
    outcome: "unchanged",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
  };
}

describe("AC-4: storyFixKey differentiates by tier", () => {
  test('AC-4: storyFixKey("US-004","fast") !== storyFixKey("US-004","powerful")', () => {
    expect(storyFixKey("US-004", "fast")).not.toBe(storyFixKey("US-004", "powerful"));
  });
});

describe("AC-5: storyFixKey defaults tier to 'default'", () => {
  test('AC-5: storyFixKey("US-004") === storyFixKey("US-004","default")', () => {
    expect(storyFixKey("US-004")).toBe(storyFixKey("US-004", "default"));
  });
});

describe("AC-6: getStoryFixState on an unwritten key returns an empty state", () => {
  test("AC-6: iterations is empty and declines is an empty map", () => {
    const store = createStoryFixHistory();
    const state = getStoryFixState(store, storyFixKey("US-unwritten"));
    expect(state.iterations).toHaveLength(0);
    expect(state.declines.size).toBe(0);
  });
});

describe("AC-7: appendStoryFixIterations preserves supplied order", () => {
  test("AC-7: getStoryFixState returns the two iterations in order", () => {
    const store = createStoryFixHistory();
    const key = storyFixKey("US-order");
    const [iterA, iterB] = [sfhIter(1), sfhIter(2)];
    appendStoryFixIterations(store, key, [iterA, iterB]);
    expect(getStoryFixState(store, key).iterations).toEqual([iterA, iterB]);
  });
});

describe("AC-8: appendStoryFixIterations appends rather than replaces", () => {
  test("AC-8: two single-iteration appends yield a length-2 iterations array", () => {
    const store = createStoryFixHistory();
    const key = storyFixKey("US-append");
    appendStoryFixIterations(store, key, [sfhIter(1)]);
    appendStoryFixIterations(store, key, [sfhIter(2)]);
    expect(getStoryFixState(store, key).iterations).toHaveLength(2);
  });
});

describe("AC-9: appending under one key leaves other keys untouched", () => {
  test("AC-9: a different key's state stays empty", () => {
    const store = createStoryFixHistory();
    appendStoryFixIterations(store, storyFixKey("US-key1"), [sfhIter(1)]);
    expect(getStoryFixState(store, storyFixKey("US-key2")).iterations).toHaveLength(0);
  });
});

describe("AC-10: createRuntime exposes a stable storyFixHistory instance", () => {
  test("AC-10: repeated reads return the same instance", () => {
    const runtime = createRuntime(DEFAULT_CONFIG, "/tmp/story-fix-budget-ac10", { featureName: "_test" });
    createdRuntimes.push(runtime);
    expect(runtime.storyFixHistory).toBeDefined();
    expect(runtime.storyFixHistory).toBe(runtime.storyFixHistory);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-002 — runFixCycle consumes priorIterations (AC-11..AC-18)
// ─────────────────────────────────────────────────────────────────────────────

function fbFinding(id: string): Finding {
  return { severity: "error", category: "test", source: "lint", message: `fb-finding-${id}`, file: `f-${id}.ts` };
}

function fbIterWithFix(num: number, strategyName: string, before: Finding[], after: Finding[]): Iteration<Finding> {
  return {
    iterationNum: num,
    findingsBefore: before,
    fixesApplied: [{ strategyName, op: "fb-noop-op", targetFiles: [], summary: "" }],
    findingsAfter: after,
    outcome: "unchanged",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
  };
}

const fbNoopOp = {
  name: "fb-noop-op",
  kind: "complete" as const,
  stage: "verify" as const,
  config: [],
  build: () => "",
  parse: () => null,
  jsonMode: false,
} as unknown as FixStrategy<Finding, unknown, unknown>["fixOp"];

function fbStrategy(name: string, maxAttempts: number, bailWhen?: FixStrategy<Finding, unknown, unknown>["bailWhen"]): FixStrategy<Finding, unknown, unknown> {
  return {
    name,
    appliesTo: (f) => f.source === "lint",
    fixOp: fbNoopOp,
    buildInput: () => ({}),
    maxAttempts,
    coRun: "exclusive",
    ...(bailWhen ? { bailWhen } : {}),
  };
}

function fbCtx(): FixCycleContext {
  const config = makeNaxConfig();
  return {
    runtime: {
      configLoader: { current: () => config },
      agentManager: makeMockAgentManager(),
      sessionManager: {} as FixCycleContext["runtime"]["sessionManager"],
      packages: { resolve: () => ({ select: () => config }) } as unknown as FixCycleContext["runtime"]["packages"],
      projectDir: "/tmp",
    } as unknown as FixCycleContext["runtime"],
    packageView: { select: () => config } as unknown as FixCycleContext["packageView"],
    packageDir: "/tmp",
    storyId: "fb-story",
    agentName: "claude",
  };
}

function fbCycle(
  findings: Finding[],
  strategies: FixStrategy<Finding, unknown, unknown>[],
  validateFn: FixCycle<Finding>["validate"],
  overrides?: Partial<FixCycle<Finding>>,
): FixCycle<Finding> {
  return {
    findings,
    iterations: [],
    strategies,
    validate: validateFn,
    config: { maxAttemptsTotal: 20, validatorRetries: 1 },
    ...overrides,
  } as FixCycle<Finding>;
}

function fbCallOpMock(returnValue: unknown = {}) {
  return mock(async () => returnValue);
}

describe("AC-11: three priorIterations exhaust a 3-attempt per-strategy cap before any dispatch", () => {
  test("AC-11: exitReason max-attempts-per-strategy, exhaustedStrategy S, no live iteration recorded", async () => {
    const F = fbFinding("11");
    const prior = [fbIterWithFix(1, "S", [F], [F]), fbIterWithFix(2, "S", [F], [F]), fbIterWithFix(3, "S", [F], [F])];
    const strategy = fbStrategy("S", 3);
    const callOpMock = fbCallOpMock();
    const cycle = fbCycle([F], [strategy], async () => [F], { priorIterations: prior } as never);
    const result = await runFixCycle(cycle, fbCtx(), "test-cycle", { callOp: callOpMock as never });
    expect(result.exitReason).toBe("max-attempts-per-strategy");
    expect(result.exhaustedStrategy).toBe("S");
    expect(result.iterations).toHaveLength(0);
    expect(callOpMock).toHaveBeenCalledTimes(0);
  });
});

describe("AC-12: two priorIterations leave exactly one dispatch of remaining capacity", () => {
  test("AC-12: the strategy dispatches once and the cycle resolves on that single live iteration", async () => {
    const F = fbFinding("12");
    const prior = [fbIterWithFix(1, "S", [F], [F]), fbIterWithFix(2, "S", [F], [F])];
    const strategy = fbStrategy("S", 3);
    const callOpMock = fbCallOpMock();
    const cycle = fbCycle([F], [strategy], async () => [], { priorIterations: prior } as never);
    const result = await runFixCycle(cycle, fbCtx(), "test-cycle", { callOp: callOpMock as never });
    expect(callOpMock).toHaveBeenCalledTimes(1);
    expect(result.iterations).toHaveLength(1);
    expect(result.iterations[0]?.fixesApplied[0]?.strategyName).toBe("S");
  });
});

describe("AC-13: priorIterations totalling maxAttemptsTotal exhausts the total cap immediately", () => {
  test("AC-13: exitReason max-attempts-total, no fix operation dispatched", async () => {
    const F = fbFinding("13");
    const prior = [fbIterWithFix(1, "S1", [F], [F]), fbIterWithFix(2, "S2", [F], [F]), fbIterWithFix(3, "S3", [F], [F])];
    const strategy = fbStrategy("S1", 20);
    const callOpMock = fbCallOpMock();
    const cycle = fbCycle(
      [F],
      [strategy],
      async () => [F],
      { priorIterations: prior, config: { maxAttemptsTotal: 3, validatorRetries: 1 } } as never,
    );
    const result = await runFixCycle(cycle, fbCtx(), "test-cycle", { callOp: callOpMock as never });
    expect(result.exitReason).toBe("max-attempts-total");
    expect(result.iterations).toHaveLength(0);
    expect(callOpMock).toHaveBeenCalledTimes(0);
  });
});

describe("AC-14: a no-progress bail fires once priorIterations plus the live iteration reach the threshold", () => {
  test("AC-14: exitReason bail-when after the first live non-progressing iteration", async () => {
    const F = fbFinding("14");
    const prior = [fbIterWithFix(1, "S", [F], [F]), fbIterWithFix(2, "S", [F], [F])];
    const bailWhen = (iters: Iteration<Finding>[]) => {
      if (iters.length < 3) return null;
      const trailing = iters.slice(-3);
      const allNoProgress = trailing.every((it) => {
        const before = new Set(it.findingsBefore.map(findingKey));
        const after = new Set(it.findingsAfter.map(findingKey));
        return before.size > 0 && [...before].every((k) => after.has(k));
      });
      return allNoProgress ? "no-progress: 3 consecutive stalled iterations" : null;
    };
    const strategy = fbStrategy("S", 20, bailWhen);
    const cycle = fbCycle([F], [strategy], async () => [F], { priorIterations: prior } as never);
    const result = await runFixCycle(cycle, fbCtx(), "test-cycle", { callOp: fbCallOpMock() as never });
    expect(result.exitReason).toBe("bail-when");
  });
});

describe("AC-15: a live iteration that resolves the finding does not bail", () => {
  test("AC-15: exitReason is not bail-when when the first live iteration clears the finding", async () => {
    const F = fbFinding("15");
    const prior = [fbIterWithFix(1, "S", [F], [F]), fbIterWithFix(2, "S", [F], [F])];
    const bailWhen = (iters: Iteration<Finding>[]) => {
      if (iters.length < 3) return null;
      const trailing = iters.slice(-3);
      const allNoProgress = trailing.every((it) => {
        const before = new Set(it.findingsBefore.map(findingKey));
        const after = new Set(it.findingsAfter.map(findingKey));
        return before.size > 0 && [...before].every((k) => after.has(k));
      });
      return allNoProgress ? "no-progress" : null;
    };
    const strategy = fbStrategy("S", 20, bailWhen);
    const cycle = fbCycle([F], [strategy], async () => [], { priorIterations: prior } as never);
    const result = await runFixCycle(cycle, fbCtx(), "test-cycle", { callOp: fbCallOpMock() as never });
    expect(result.exitReason).not.toBe("bail-when");
    expect(result.exitReason).toBe("resolved");
  });
});

describe("AC-16: priorIterations omitted preserves today's per-cycle cap behaviour", () => {
  test("AC-16: dispatches the strategy exactly maxAttempts (3) times", async () => {
    const F = fbFinding("16");
    const strategy = fbStrategy("S", 3);
    const callOpMock = fbCallOpMock();
    const cycle = fbCycle([F], [strategy], async () => [F]);
    const result = await runFixCycle(cycle, fbCtx(), "test-cycle", { callOp: callOpMock as never });
    expect(result.iterations).toHaveLength(3);
    for (const iter of result.iterations) {
      expect(iter.fixesApplied[0]?.strategyName).toBe("S");
    }
  });
});

describe("AC-17: FixCycleResult.iterations reports only this cycle's live iterations", () => {
  test("AC-17: with three priorIterations and one live iteration, result.iterations has length 1", async () => {
    const F = fbFinding("17");
    const prior = [fbIterWithFix(1, "S", [F], [F]), fbIterWithFix(2, "S", [F], [F]), fbIterWithFix(3, "S", [F], [F])];
    const strategy = fbStrategy("S", 10);
    const cycle = fbCycle([F], [strategy], async () => [], { priorIterations: prior } as never);
    const result = await runFixCycle(cycle, fbCtx(), "test-cycle", { callOp: fbCallOpMock() as never });
    expect(result.iterations).toHaveLength(1);
  });
});

describe("AC-18: the first live iteration is numbered 1 regardless of prior cycle count", () => {
  test("AC-18: iterationNum === 1 with three priorIterations seeded", async () => {
    const F = fbFinding("18");
    const prior = [fbIterWithFix(1, "S", [F], [F]), fbIterWithFix(2, "S", [F], [F]), fbIterWithFix(3, "S", [F], [F])];
    const strategy = fbStrategy("S", 10);
    const cycle = fbCycle([F], [strategy], async () => [], { priorIterations: prior } as never);
    const result = await runFixCycle(cycle, fbCtx(), "test-cycle", { callOp: fbCallOpMock() as never });
    expect(result.iterations[0]?.iterationNum).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-002 — createDeclineLedger with a caller-supplied backing map (AC-19..AC-21)
// ─────────────────────────────────────────────────────────────────────────────

function ldrStrategy(name: string): FixStrategy<Finding, unknown, unknown> {
  return { name, appliesTo: () => true, fixOp: fbNoopOp, buildInput: () => ({}), maxAttempts: 3 };
}

describe("AC-19: a ledger over a backing map that already declined a finding reports it retired", () => {
  test("AC-19: isRetiredFor is true with no recordDeclined call, and the map is untouched", () => {
    const F: Finding = { severity: "error", category: "test", source: "lint", message: "ldr-19" };
    const S = ldrStrategy("S");
    const map = new Map<string, Set<string>>([["S", new Set([findingKey(F)])]]);
    const ledger = createDeclineLedger<Finding>(map as never);
    expect(ledger.isRetiredFor(S, [F])).toBe(true);
    expect(map.get("S")?.has(findingKey(F))).toBe(true);
  });
});

describe("AC-20: recordDeclined writes through to the caller-supplied backing map", () => {
  test("AC-20: the declined finding's key is present under the strategy afterwards", () => {
    const F: Finding = { severity: "error", category: "test", source: "lint", message: "ldr-20" };
    const S = ldrStrategy("S");
    const map = new Map<string, Set<string>>();
    const ledger = createDeclineLedger<Finding>(map as never);
    ledger.recordDeclined(S, [F]);
    expect(map.has("S")).toBe(true);
    expect(map.get("S")?.has(findingKey(F))).toBe(true);
  });
});

describe("AC-21: a ledger with no backing map starts clean and records normally", () => {
  test("AC-21: isRetiredFor is false until recordDeclined is called", () => {
    const F: Finding = { severity: "error", category: "test", source: "lint", message: "ldr-21" };
    const S = ldrStrategy("S");
    const ledger = createDeclineLedger<Finding>();
    expect(ledger.isRetiredFor(S, [F])).toBe(false);
    ledger.recordDeclined(S, [F]);
    expect(ledger.isRetiredFor(S, [F])).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-003/US-004 — runRectification production seam (AC-22..AC-36)
// ─────────────────────────────────────────────────────────────────────────────

const rbTestSel = pickSelector("test-story-fix-budget-sel", "execution");
const RB_FIXOP_NAME = "rb-fixop";

const RB_FINDING: Finding = {
  source: "test-runner",
  category: "failed-test",
  severity: "error",
  message: "rb gate finding",
  file: "test/rb.test.ts",
};

const rbGateOp: DeterministicOperation<unknown, unknown, typeof DEFAULT_CONFIG> = {
  kind: "deterministic",
  name: "full-suite-gate",
  stage: "verify",
  config: rbTestSel as never,
  execute: async () => ({ success: false, findings: [], normalizedFindings: [], estimatedCostUsd: 0 }),
};

const rbFixOp: RunOperation<{ story: string }, { applied: boolean }, typeof DEFAULT_CONFIG> = {
  kind: "run",
  name: RB_FIXOP_NAME,
  stage: "rectification",
  config: rbTestSel as never,
  session: { role: "implementer", lifetime: "warm" },
  build: () => ({
    role: { id: "r", content: "Fix", overridable: false },
    task: { id: "t", content: "Fix the findings", overridable: false },
  }),
  parse: () => ({ applied: true }),
};

function rbFixStrategy(maxAttempts: number): FixStrategy<Finding, { story: string }, { applied: boolean }> {
  return {
    name: "rb-fix-strategy",
    appliesTo: (f) => f.source === "test-runner",
    fixOp: rbFixOp,
    buildInput: () => ({ story: "S1" }),
    maxAttempts,
    coRun: "exclusive",
  };
}

function rbState(maxAttempts: number): InternalBuildState {
  return {
    fullSuiteGate: { kind: "full-suite-gate", slot: { op: rbGateOp, input: {} } },
    rectification: {
      maxAttempts: 20,
      strategies: [rbFixStrategy(maxAttempts) as unknown as FixStrategy<Finding, unknown, unknown, unknown>],
      abortOnIncreasingFailures: false,
      abortOnNoProgress: false,
    },
  } as InternalBuildState;
}

function rbSeedPhaseOutputs(): Record<string, unknown> {
  return { "full-suite-gate": { success: false, findings: [RB_FINDING], normalizedFindings: [RB_FINDING] } };
}

function rbCtx(runtime: NaxRuntime, storyId: string, tier?: string): CallContext {
  return {
    runtime,
    packageView: runtime.packages.repo(),
    packageDir: "/tmp",
    agentName: "claude",
    storyId,
    ...(tier !== undefined
      ? { phaseTelemetry: { testStrategy: "test-after" as const, sessionModel: "single-session" as const, tier } }
      : {}),
  } as CallContext;
}

async function rbRun(
  runtime: NaxRuntime,
  opts: {
    storyId: string;
    tier?: string;
    maxAttempts?: number;
    resolveAfterCalls?: number;
    overrides?: Record<string, unknown>;
  },
) {
  const { storyId, tier, maxAttempts = 3, resolveAfterCalls = Number.POSITIVE_INFINITY, overrides } = opts;
  let dispatchCount = 0;
  let gateCalls = 0;
  const origCallOp = _storyOrchestratorDeps.callOp;
  _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { kind: string; name: string }) => {
    if (op.kind === "deterministic") {
      gateCalls++;
      if (gateCalls >= resolveAfterCalls) {
        return { success: true, findings: [], normalizedFindings: [], estimatedCostUsd: 0 };
      }
      return { success: false, findings: [RB_FINDING], normalizedFindings: [RB_FINDING], estimatedCostUsd: 0 };
    }
    if (op.name === RB_FIXOP_NAME) {
      dispatchCount++;
      return { applied: true };
    }
    return { success: true };
  }) as typeof _storyOrchestratorDeps.callOp;

  try {
    const ctx = rbCtx(runtime, storyId, tier);
    const phaseOutputs = rbSeedPhaseOutputs();
    const result = await runRectification(ctx, rbState(maxAttempts), {}, phaseOutputs, {
      skipGateTriage: true,
      ...overrides,
    } as never);
    return { result, phaseOutputs, dispatchCount };
  } finally {
    _storyOrchestratorDeps.callOp = origCallOp;
  }
}

describe("AC-22: a second runRectification for the same story+tier dispatches nothing once the cap is spent", () => {
  test("AC-22: storyScopedFixBudget enabled — second call's dispatch count is 0", async () => {
    const runtime = makeBudgetRuntime(true);
    const first = await rbRun(runtime, { storyId: "S1", maxAttempts: 3 });
    expect(first.dispatchCount).toBe(3);
    const second = await rbRun(runtime, { storyId: "S1", maxAttempts: 3 });
    expect(second.dispatchCount).toBe(0);
  });
});

describe("AC-23: the spent-budget second call records max-attempts-per-strategy", () => {
  test("AC-23: phaseOutputs.rectification.exitReason === 'max-attempts-per-strategy'", async () => {
    const runtime = makeBudgetRuntime(true);
    await rbRun(runtime, { storyId: "S1", maxAttempts: 3 });
    const second = await rbRun(runtime, { storyId: "S1", maxAttempts: 3 });
    expect((second.phaseOutputs.rectification as { exitReason: string }).exitReason).toBe(
      "max-attempts-per-strategy",
    );
  });
});

describe("AC-24: storyScopedFixBudget disabled resets the budget every call", () => {
  test("AC-24: the second call dispatches the strategy again (fresh cap)", async () => {
    const runtime = makeBudgetRuntime(false);
    await rbRun(runtime, { storyId: "S1", maxAttempts: 3 });
    const second = await rbRun(runtime, { storyId: "S1", maxAttempts: 3 });
    expect(second.dispatchCount).toBe(3);
  });
});

describe("AC-25: a different escalation tier gets a fresh budget", () => {
  test("AC-25: tier 'balanced' dispatches after tier 'fast' exhausted its own budget", async () => {
    const runtime = makeBudgetRuntime(true);
    await rbRun(runtime, { storyId: "S1", tier: "fast", maxAttempts: 3 });
    const second = await rbRun(runtime, { storyId: "S1", tier: "balanced", maxAttempts: 3 });
    expect(second.dispatchCount).toBe(3);
  });
});

describe("AC-26: the story-fix-history store accumulates iterations across two calls", () => {
  test("AC-26: 2 iterations then 1 more yields lengths 2 then 3", async () => {
    const runtime = makeBudgetRuntime(true);
    await rbRun(runtime, { storyId: "S1", maxAttempts: 2 });
    const key = storyFixKey("S1");
    expect(getStoryFixState(runtime.storyFixHistory, key).iterations).toHaveLength(2);
    await rbRun(runtime, { storyId: "S1", maxAttempts: 3 });
    expect(getStoryFixState(runtime.storyFixHistory, key).iterations).toHaveLength(3);
  });
});

describe("AC-27: a resume-pass re-entry consumes only the remaining per-strategy budget", () => {
  test("AC-27: main pass resolves after 2 dispatches; resume pass dispatches once more then caps out", async () => {
    const runtime = makeBudgetRuntime(true);
    const mainPass = await rbRun(runtime, { storyId: "S1", maxAttempts: 3, resolveAfterCalls: 2 });
    expect(mainPass.dispatchCount).toBe(2);
    expect(mainPass.result.rectificationExhausted).not.toBe(true);

    const resumePass = await rbRun(runtime, { storyId: "S1", maxAttempts: 3 });
    expect(resumePass.dispatchCount).toBe(1);
    expect(
      EXHAUSTED_EXIT_REASONS.has((resumePass.phaseOutputs.rectification as { exitReason: string }).exitReason),
    ).toBe(true);
  });
});

describe("AC-28: with storyScopedFixBudget disabled the resume pass gets a fresh cap", () => {
  test("AC-28: resume pass dispatches the strategy the full 3 times", async () => {
    const runtime = makeBudgetRuntime(false);
    const mainPass = await rbRun(runtime, { storyId: "S1", maxAttempts: 3, resolveAfterCalls: 2 });
    expect(mainPass.dispatchCount).toBe(2);

    const resumePass = await rbRun(runtime, { storyId: "S1", maxAttempts: 3 });
    expect(resumePass.dispatchCount).toBe(3);
  });
});

describe("AC-29: the non-blocking-fix override path records no story-fix-history state", () => {
  test("AC-29: getStoryFixState for that story stays empty after an initialFindings-seeded call", async () => {
    const runtime = makeBudgetRuntime(true);
    await rbRun(runtime, {
      storyId: "S1",
      maxAttempts: 3,
      overrides: { initialFindings: [RB_FINDING] },
    });
    const key = storyFixKey("S1");
    expect(getStoryFixState(runtime.storyFixHistory, key).iterations).toHaveLength(0);
  });
});

describe("AC-30: a non-blocking-fix call does not poison the blocking budget", () => {
  test("AC-30: a later blocking runRectification dispatches the full per-strategy cap", async () => {
    const runtime = makeBudgetRuntime(true);
    await rbRun(runtime, { storyId: "S1", maxAttempts: 3, overrides: { initialFindings: [RB_FINDING] } });
    const blocking = await rbRun(runtime, { storyId: "S1", maxAttempts: 3 });
    expect(blocking.dispatchCount).toBe(3);
    expect(
      EXHAUSTED_EXIT_REASONS.has((blocking.phaseOutputs.rectification as { exitReason: string }).exitReason),
    ).toBe(true);
  });
});

// ─── AC-31/AC-32: oscillation totals and iterationCount are unaffected by the carry-in ───

function oscIter(num: number, before: Finding[], after: Finding[]): Iteration<Finding> {
  return {
    iterationNum: num,
    findingsBefore: before,
    findingsAfter: after,
    fixesApplied: [{ strategyName: "osc-strategy", op: "noop-op", targetFiles: [], summary: "" }],
    outcome: "unchanged",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
  };
}

describe("AC-31: rectificationOscillations counts a genuine reappear, not a first reveal", () => {
  test("AC-31: cycle1 resolves-then-reappears F1 (count 1); cycle2 has no F1 — total stays 1", async () => {
    const runtime = makeBudgetRuntime(true);
    const F1: Finding = { severity: "error", category: "test", source: "gate", message: "osc-f1" };
    const origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    const origCallOp = _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.callOp = mock(async (_ctx: unknown, op: { kind: string }) =>
      op.kind === "deterministic"
        ? { success: true, findings: [], normalizedFindings: [], estimatedCostUsd: 0 }
        : { success: true },
    ) as typeof _storyOrchestratorDeps.callOp;
    try {
      const ctx = rbCtx(runtime, "S1");
      _storyOrchestratorDeps.runFixCycle = mock(async () => ({
        iterations: [oscIter(1, [F1], []), oscIter(2, [], [F1])],
        finalFindings: [],
        exitReason: "resolved" as const,
        costUsd: 0,
      })) as typeof _storyOrchestratorDeps.runFixCycle;
      await runRectification(ctx, rbState(3), {}, rbSeedPhaseOutputs(), { skipGateTriage: true } as never);

      _storyOrchestratorDeps.runFixCycle = mock(async () => ({
        iterations: [oscIter(1, [], [])],
        finalFindings: [],
        exitReason: "resolved" as const,
        costUsd: 0,
      })) as typeof _storyOrchestratorDeps.runFixCycle;
      await runRectification(ctx, rbState(3), {}, rbSeedPhaseOutputs(), { skipGateTriage: true } as never);

      expect(runtime.rectificationOscillations.get("S1")).toBe(1);
    } finally {
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
      _storyOrchestratorDeps.callOp = origCallOp;
    }
  });
});

describe("AC-32: phaseOutputs.rectification.iterationCount reports only the latest cycle", () => {
  test("AC-32: a 2-iteration cycle followed by a 1-iteration cycle reports iterationCount 1", async () => {
    const runtime = makeBudgetRuntime(true);
    const origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    const origCallOp = _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.callOp = mock(async () => ({ success: true })) as typeof _storyOrchestratorDeps.callOp;
    try {
      const ctx = rbCtx(runtime, "S1");
      _storyOrchestratorDeps.runFixCycle = mock(async () => ({
        iterations: [oscIter(1, [], []), oscIter(2, [], [])],
        finalFindings: [],
        exitReason: "resolved" as const,
        costUsd: 0,
      })) as typeof _storyOrchestratorDeps.runFixCycle;
      await runRectification(ctx, rbState(3), {}, rbSeedPhaseOutputs(), { skipGateTriage: true } as never);

      _storyOrchestratorDeps.runFixCycle = mock(async () => ({
        iterations: [oscIter(1, [], [])],
        finalFindings: [],
        exitReason: "resolved" as const,
        costUsd: 0,
      })) as typeof _storyOrchestratorDeps.runFixCycle;
      const phaseOutputs2 = rbSeedPhaseOutputs();
      await runRectification(ctx, rbState(3), {}, phaseOutputs2, { skipGateTriage: true } as never);

      expect((phaseOutputs2.rectification as { iterationCount: number }).iterationCount).toBe(1);
    } finally {
      _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
      _storyOrchestratorDeps.callOp = origCallOp;
    }
  });
});

describe("AC-33: exhausting one story's budget does not affect a different story", () => {
  test("AC-33: US-002 dispatches normally after US-001 exhausts its own budget", async () => {
    const runtime = makeBudgetRuntime(true);
    await rbRun(runtime, { storyId: "US-001", maxAttempts: 3 });
    const other = await rbRun(runtime, { storyId: "US-002", maxAttempts: 3 });
    expect(other.dispatchCount).toBeGreaterThan(0);
  });
});

describe("AC-34: a runtime missing storyFixHistory fails open, never throws", () => {
  test("AC-34: runRectification completes normally when storyFixHistory is undefined", async () => {
    const runtime = makeBudgetRuntime(true);
    (runtime as unknown as Record<string, unknown>).storyFixHistory = undefined;
    const outcome = await rbRun(runtime, { storyId: "S1", maxAttempts: 3 });
    expect(outcome.dispatchCount).toBeGreaterThanOrEqual(0);
  });
});

describe("AC-35: an absent phaseTelemetry still shares a single 'default' budget", () => {
  test("AC-35: two calls with no tier share the budget — first dispatches 3, second dispatches 0", async () => {
    const runtime = makeBudgetRuntime(true);
    const first = await rbRun(runtime, { storyId: "S1", maxAttempts: 3 });
    expect(first.dispatchCount).toBe(3);
    const second = await rbRun(runtime, { storyId: "S1", maxAttempts: 3 });
    expect(second.dispatchCount).toBe(0);
  });
});

describe("AC-36: an absent storyId records no story-fix-history state", () => {
  test("AC-36: runtime.storyFixHistory stays empty when ctx.storyId is absent", async () => {
    const runtime = makeBudgetRuntime(true);
    const ctx: CallContext = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
    } as CallContext;
    await runRectification(ctx, rbState(3), {}, rbSeedPhaseOutputs(), { skipGateTriage: true } as never);
    expect(runtime.storyFixHistory?.size ?? 0).toBe(0);
  });
});