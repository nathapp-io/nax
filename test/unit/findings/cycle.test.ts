import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CallOpFn } from "../../../src/findings/cycle";
import { classifyOutcome, runFixCycle } from "../../../src/findings/cycle";
import type { FixCycle, FixCycleContext, FixStrategy, Iteration } from "../../../src/findings/cycle-types";
import type { Finding } from "../../../src/findings/types";
import { makeNaxConfig } from "../../helpers";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeFinding(overrides: Partial<Finding> & Pick<Finding, "source" | "message">): Finding {
  return {
    severity: "error",
    category: "test",
    ...overrides,
  };
}

const lintA = makeFinding({ source: "lint", message: "unused var", file: "src/a.ts", line: 1 });
const lintB = makeFinding({ source: "lint", message: "missing semicolon", file: "src/b.ts", line: 5 });
const typecheckC = makeFinding({ source: "typecheck", message: "TS2304: Cannot find name", file: "src/c.ts", line: 3 });

function makeCtx(): FixCycleContext {
  const config = makeNaxConfig();
  return {
    runtime: {
      configLoader: { current: () => config },
      agentManager: { getDefault: () => "claude" } as FixCycleContext["runtime"]["agentManager"],
      sessionManager: {} as FixCycleContext["runtime"]["sessionManager"],
      packages: { resolve: () => ({ select: () => config }) } as unknown as FixCycleContext["runtime"]["packages"],
      projectDir: "/tmp/test",
    } as unknown as FixCycleContext["runtime"],
    packageView: { select: () => config } as unknown as FixCycleContext["packageView"],
    packageDir: "/tmp/test",
    storyId: "story-1",
    agentName: "claude",
  };
}

const noopOp = {
  name: "noop-op",
  kind: "complete" as const,
  stage: "verify" as const,
  config: [],
  build: () => "",
  parse: () => null,
  jsonMode: false,
} as unknown as FixStrategy<Finding, unknown, unknown>["fixOp"];

function makeStrategy(
  overrides: Partial<FixStrategy<Finding, unknown, unknown>> & Pick<FixStrategy<Finding, unknown, unknown>, "name">,
): FixStrategy<Finding, unknown, unknown> {
  return {
    appliesTo: () => true,
    fixOp: noopOp,
    buildInput: () => ({}),
    maxAttempts: 3,
    coRun: "co-run-sequential",
    ...overrides,
  };
}

function makeCycle(
  findings: Finding[],
  strategies: FixStrategy<Finding, unknown, unknown>[],
  validateFn: (ctx: FixCycleContext) => Promise<Finding[]>,
  overrides?: Partial<FixCycle<Finding>>,
): FixCycle<Finding> {
  return {
    findings,
    iterations: [],
    strategies,
    validate: validateFn,
    config: { maxAttemptsTotal: 10, validatorRetries: 1 },
    ...overrides,
  };
}

// callOp mock that returns a fixed output without calling real ops
function makeCallOpMock(returnValue: unknown = {}): ReturnType<typeof mock> {
  return mock(async () => returnValue);
}

beforeEach(() => {
  // reset per-test state; individual tests inject _deps inline
});

// ─── classifyOutcome ──────────────────────────────────────────────────────────

describe("classifyOutcome", () => {
  test("resolved — both empty", () => {
    expect(classifyOutcome([], [])).toBe("resolved");
  });

  test("resolved — before non-empty, after empty", () => {
    expect(classifyOutcome([lintA], [])).toBe("resolved");
  });

  test("unchanged — same finding key", () => {
    expect(classifyOutcome([lintA], [lintA])).toBe("unchanged");
  });

  test("partial — one resolved, one remains", () => {
    const before = [lintA, lintB];
    const after = [lintA];
    expect(classifyOutcome(before, after)).toBe("partial");
  });

  test("regressed — new finding appears in same source", () => {
    const before = [lintA];
    const after = [lintA, lintB];
    expect(classifyOutcome(before, after)).toBe("regressed");
  });

  test("regressed — all before resolved but new same-source finding appeared", () => {
    const before = [lintA];
    const after = [lintB]; // lintA resolved but lintB appeared (same source)
    expect(classifyOutcome(before, after)).toBe("regressed");
  });

  test("regressed-different-source — source disappears, new source appears", () => {
    const before = [lintA];
    const after = [typecheckC];
    expect(classifyOutcome(before, after)).toBe("regressed-different-source");
  });

  test("regressed-different-source — before has lint, after has lint + typecheck", () => {
    const before = [lintA];
    const after = [lintA, typecheckC];
    expect(classifyOutcome(before, after)).toBe("regressed-different-source");
  });
});

// ─── runFixCycle — bail: no-strategy ──────────────────────────────────────────

describe("runFixCycle — bail: no-strategy", () => {
  test("exits immediately when no strategies match and findings is empty", async () => {
    const strategy = makeStrategy({
      name: "lint-fix",
      appliesTo: (f) => f.source === "lint",
    });
    const cycle = makeCycle([], [strategy], async () => []);
    const ctx = makeCtx();
    const callOpMock = makeCallOpMock();

    const result = await runFixCycle(cycle, ctx, "test-cycle", { // eslint-disable-next-line @typescript-eslint/no-explicit-any
callOp: callOpMock as unknown as CallOpFn});

    expect(result.exitReason).toBe("no-strategy");
    expect(result.iterations).toHaveLength(0);
    expect(callOpMock).not.toHaveBeenCalled();
  });

  test("exits when findings present but no strategy appliesTo them", async () => {
    const strategy = makeStrategy({
      name: "typecheck-fix",
      appliesTo: (f) => f.source === "typecheck",
    });
    const cycle = makeCycle([lintA], [strategy], async () => []);
    const ctx = makeCtx();
    const callOpMock = makeCallOpMock();

    const result = await runFixCycle(cycle, ctx, "test-cycle", { // eslint-disable-next-line @typescript-eslint/no-explicit-any
callOp: callOpMock as unknown as CallOpFn});

    expect(result.exitReason).toBe("no-strategy");
  });

  test("uses appliesToVerdict fallback when findings is empty and verdict matches", async () => {
    let validated = false;
    const strategy = makeStrategy({
      name: "source-fix",
      appliesTo: () => false,
      appliesToVerdict: (v) => v === "source_bug",
    });
    const cycle = makeCycle(
      [],
      [strategy],
      async () => {
        validated = true;
        return [];
      },
      { verdict: "source_bug" },
    );
    const callOpMock = makeCallOpMock();

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", { // eslint-disable-next-line @typescript-eslint/no-explicit-any
callOp: callOpMock as unknown as CallOpFn});

    expect(result.exitReason).toBe("resolved");
    expect(callOpMock).toHaveBeenCalledTimes(1);
    expect(validated).toBe(true);
  });
});

// ─── runFixCycle — bail: max-attempts-per-strategy ───────────────────────────

describe("runFixCycle — bail: max-attempts-per-strategy", () => {
  test("exits when strategy has hit its maxAttempts cap", async () => {
    const strategy = makeStrategy({ name: "lint-fix", maxAttempts: 2 });

    const priorIterations: Iteration<Finding>[] = [
      {
        iterationNum: 1,
        findingsBefore: [lintA],
        fixesApplied: [{ strategyName: "lint-fix", op: "noop-op", targetFiles: [], summary: "" }],
        findingsAfter: [lintA],
        outcome: "unchanged",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
      },
      {
        iterationNum: 2,
        findingsBefore: [lintA],
        fixesApplied: [{ strategyName: "lint-fix", op: "noop-op", targetFiles: [], summary: "" }],
        findingsAfter: [lintA],
        outcome: "unchanged",
        startedAt: "2026-01-01T00:00:02.000Z",
        finishedAt: "2026-01-01T00:00:03.000Z",
      },
    ];

    const cycle = makeCycle([lintA], [strategy], async () => []);
    cycle.iterations.push(...priorIterations);

    const callOpMock = makeCallOpMock();
    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", { // eslint-disable-next-line @typescript-eslint/no-explicit-any
callOp: callOpMock as unknown as CallOpFn});

    expect(result.exitReason).toBe("max-attempts-per-strategy");
    expect(result.exhaustedStrategy).toBe("lint-fix");
    expect(callOpMock).not.toHaveBeenCalled();
  });
});

// ─── runFixCycle — bail: max-attempts-total ───────────────────────────────────

describe("runFixCycle — bail: max-attempts-total", () => {
  test("exits when total fix invocations across all strategies exceeds cap", async () => {
    const strategyA = makeStrategy({ name: "fix-a", maxAttempts: 99 });
    const strategyB = makeStrategy({ name: "fix-b", maxAttempts: 99 });

    // 5 invocations each = 10 total = maxAttemptsTotal
    const priorIterations: Iteration<Finding>[] = Array.from({ length: 5 }, (_, i) => ({
      iterationNum: i + 1,
      findingsBefore: [lintA],
      fixesApplied: [
        { strategyName: "fix-a", op: "noop-op", targetFiles: [], summary: "" },
        { strategyName: "fix-b", op: "noop-op", targetFiles: [], summary: "" },
      ],
      findingsAfter: [lintA],
      outcome: "unchanged" as const,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
    }));

    const cycle = makeCycle([lintA], [strategyA, strategyB], async () => [], {
      config: { maxAttemptsTotal: 10, validatorRetries: 1 },
    });
    cycle.iterations.push(...priorIterations);

    const callOpMock = makeCallOpMock();
    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", { // eslint-disable-next-line @typescript-eslint/no-explicit-any
callOp: callOpMock as unknown as CallOpFn});

    expect(result.exitReason).toBe("max-attempts-total");
    expect(callOpMock).not.toHaveBeenCalled();
  });
});

// ─── runFixCycle — bail: bail-when ────────────────────────────────────────────

describe("runFixCycle — bail: bail-when", () => {
  test("exits when strategy bailWhen predicate fires", async () => {
    const strategy = makeStrategy({
      name: "lint-fix",
      bailWhen: (iters) => (iters.length > 0 && iters[iters.length - 1].outcome === "unchanged" ? "unchanged twice" : null),
    });

    const priorIter: Iteration<Finding> = {
      iterationNum: 1,
      findingsBefore: [lintA],
      fixesApplied: [{ strategyName: "lint-fix", op: "noop-op", targetFiles: [], summary: "" }],
      findingsAfter: [lintA],
      outcome: "unchanged",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
    };

    const cycle = makeCycle([lintA], [strategy], async () => []);
    cycle.iterations.push(priorIter);

    const callOpMock = makeCallOpMock();
    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", { // eslint-disable-next-line @typescript-eslint/no-explicit-any
callOp: callOpMock as unknown as CallOpFn});

    expect(result.exitReason).toBe("bail-when");
    expect(result.bailDetail).toBe("unchanged twice");
    expect(callOpMock).not.toHaveBeenCalled();
  });
});

// ─── runFixCycle — bail: validator-error ─────────────────────────────────────

describe("runFixCycle — bail: validator-error", () => {
  test("exits after exhausting validatorRetries", async () => {
    let validateCallCount = 0;
    const strategy = makeStrategy({ name: "lint-fix" });
    const cycle = makeCycle([lintA], [strategy], async () => {
      validateCallCount++;
      throw new Error("validator crashed");
    });
    const callOpMock = makeCallOpMock();

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", { // eslint-disable-next-line @typescript-eslint/no-explicit-any
callOp: callOpMock as unknown as CallOpFn});

    expect(result.exitReason).toBe("validator-error");
    // validatorRetries=1: first attempt + 1 retry = 2 calls
    expect(validateCallCount).toBe(2);
    // callOp was called (fix ran) but iterations not committed (validator failed)
    expect(callOpMock).toHaveBeenCalledTimes(1);
    expect(cycle.iterations).toHaveLength(0);
  });

  test("recovers when first validator call throws but retry succeeds", async () => {
    let validateCallCount = 0;
    const strategy = makeStrategy({ name: "lint-fix" });
    const cycle = makeCycle([lintA], [strategy], async () => {
      validateCallCount++;
      if (validateCallCount === 1) throw new Error("transient error");
      return []; // second attempt succeeds
    });
    const callOpMock = makeCallOpMock();

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", { // eslint-disable-next-line @typescript-eslint/no-explicit-any
callOp: callOpMock as unknown as CallOpFn});

    expect(result.exitReason).toBe("resolved");
    expect(validateCallCount).toBe(2);
    expect(cycle.iterations).toHaveLength(1);
    expect(cycle.iterations[0].outcome).toBe("resolved");
  });
});

// ─── runFixCycle — success paths ──────────────────────────────────────────────

describe("runFixCycle — success paths", () => {
  test("resolves after one iteration when validator returns empty", async () => {
    const strategy = makeStrategy({ name: "lint-fix" });
    const cycle = makeCycle([lintA], [strategy], async () => []);
    const callOpMock = makeCallOpMock();

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", { // eslint-disable-next-line @typescript-eslint/no-explicit-any
callOp: callOpMock as unknown as CallOpFn});

    expect(result.exitReason).toBe("resolved");
    expect(result.finalFindings).toHaveLength(0);
    expect(result.iterations).toHaveLength(1);
    expect(result.iterations[0].outcome).toBe("resolved");
    expect(result.iterations[0].iterationNum).toBe(1);
    expect(callOpMock).toHaveBeenCalledTimes(1);
  });

  test("records FixApplied with extractApplied output", async () => {
    const strategy = makeStrategy({
      name: "lint-fix",
      extractApplied: () => ({ targetFiles: ["src/a.ts"], summary: "fixed unused var" }),
    });
    const cycle = makeCycle([lintA], [strategy], async () => []);
    const callOpMock = makeCallOpMock({ output: "done" });

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", { // eslint-disable-next-line @typescript-eslint/no-explicit-any
callOp: callOpMock as unknown as CallOpFn});

    expect(result.exitReason).toBe("resolved");
    expect(result.iterations[0].fixesApplied[0].targetFiles).toEqual(["src/a.ts"]);
    expect(result.iterations[0].fixesApplied[0].summary).toBe("fixed unused var");
  });

  test("exclusive strategy wins over co-run peers", async () => {
    const called: string[] = [];
    const exclusiveStrategy = makeStrategy({
      name: "exclusive-fix",
      coRun: "exclusive",
    });
    const coRunStrategy = makeStrategy({
      name: "co-run-fix",
      coRun: "co-run-sequential",
    });

    const callOpMock = mock(async (_ctx: unknown, op: { name: string }) => {
      called.push(op.name);
      return {};
    });

    const cycle = makeCycle([lintA], [exclusiveStrategy, coRunStrategy], async () => []);
    await runFixCycle(cycle, makeCtx(), "test-cycle", { // eslint-disable-next-line @typescript-eslint/no-explicit-any
callOp: callOpMock as unknown as CallOpFn});

    expect(called).toHaveLength(1);
    expect(called[0]).toBe("noop-op");
    expect(cycle.iterations[0].fixesApplied[0].strategyName).toBe("exclusive-fix");
  });

  test("co-run strategies both execute in order", async () => {
    const called: string[] = [];

    const strategyA = makeStrategy({
      name: "fix-a",
      fixOp: { ...noopOp, name: "op-a" } as typeof noopOp,
      coRun: "co-run-sequential",
    });
    const strategyB = makeStrategy({
      name: "fix-b",
      fixOp: { ...noopOp, name: "op-b" } as typeof noopOp,
      coRun: "co-run-sequential",
    });

    const callOpMock = mock(async (_ctx: unknown, op: { name: string }) => {
      called.push(op.name);
      return {};
    });

    const cycle = makeCycle([lintA], [strategyA, strategyB], async () => []);
    await runFixCycle(cycle, makeCtx(), "test-cycle", { // eslint-disable-next-line @typescript-eslint/no-explicit-any
callOp: callOpMock as unknown as CallOpFn});

    expect(called).toEqual(["op-a", "op-b"]);
  });

  test("iterates until resolved", async () => {
    let validateCall = 0;
    const strategy = makeStrategy({ name: "lint-fix" });
    // First two validations return a finding, third returns empty
    const cycle = makeCycle([lintA], [strategy], async () => {
      validateCall++;
      if (validateCall < 3) return [lintA];
      return [];
    });
    const callOpMock = makeCallOpMock();

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", { // eslint-disable-next-line @typescript-eslint/no-explicit-any
callOp: callOpMock as unknown as CallOpFn});

    expect(result.exitReason).toBe("resolved");
    expect(result.iterations).toHaveLength(3);
    expect(result.iterations[0].outcome).toBe("unchanged");
    expect(result.iterations[1].outcome).toBe("unchanged");
    expect(result.iterations[2].outcome).toBe("resolved");
    expect(callOpMock).toHaveBeenCalledTimes(3);
  });
});
