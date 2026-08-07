import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { CallOpFn } from "@/findings/cycle";
import { classifyOutcome, runFixCycle } from "@/findings";
import type { FixCycle, FixStrategy, Iteration, ValidateResult } from "@/findings";
import type { Finding } from "@/findings";
import type { Logger } from "@/logger";
import { makeLogger } from "@test/helpers";
import {
  lintA,
  lintB,
  makeCallOpMock,
  makeCtx,
  makeCycle,
  makeFinding,
  makeStrategy,
  noopOp,
  typecheckC,
} from "./_cycle-fixtures";

beforeEach(() => {
  // reset per-test state; individual tests inject _deps inline
});

// ─── classifyOutcome ──────────────────────────────────────────────────────────

describe("classifyOutcome", () => {
  test.each([
    [[], [], "resolved"],
    [[lintA], [], "resolved"],
    [[lintA], [lintA], "unchanged"],
    [[lintA, lintB], [lintA], "partial"],
    [[], [lintA], "regressed"],
    [[lintA], [lintA, lintB], "regressed"],
    [[lintA], [lintB], "regressed"],
    [[lintA], [typecheckC], "regressed-different-source"],
    [[lintA], [lintA, typecheckC], "regressed-different-source"],
  ])("classifyOutcome($before, $after) → $expected", (before, after, expected) => {
    expect(classifyOutcome(before, after)).toBe(expected);
  });
});

// ─── runFixCycle — bail: no-strategy ──────────────────────────────────────────

describe("runFixCycle — bail: no-strategy", () => {
  test("resolves immediately when findings is empty; exits no-strategy when no strategy appliesTo findings", async () => {
    const r1 = await runFixCycle(makeCycle([], [makeStrategy({ name: "lint-fix", appliesTo: (f) => f.source === "lint" })], async () => []), makeCtx(), "test-cycle", { // eslint-disable-next-line @typescript-eslint/no-explicit-any
callOp: makeCallOpMock() as unknown as CallOpFn});
    expect(r1.exitReason).toBe("resolved");
    expect(r1.iterations).toHaveLength(0);

    const r2 = await runFixCycle(makeCycle([lintA], [makeStrategy({ name: "typecheck-fix", appliesTo: (f) => f.source === "typecheck" })], async () => []), makeCtx(), "test-cycle", { // eslint-disable-next-line @typescript-eslint/no-explicit-any
callOp: makeCallOpMock() as unknown as CallOpFn});
    expect(r2.exitReason).toBe("no-strategy");
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

// ─── runFixCycle — bail: skip validate on final attempt (#897) ───────────────

describe("runFixCycle — skip validate on final allowed attempt", () => {
  test("calls validate with { mode: 'lite' } when single or all co-run strategies exhaust caps after a fix", async () => {
    const validateCalls1: Array<{ mode: "full" | "lite"; strategiesRun?: readonly string[] }> = [];
    const s1 = makeStrategy({ name: "lint-fix", maxAttempts: 1 });
    const r1 = await runFixCycle(makeCycle([lintA], [s1], async (_ctx, opts) => { validateCalls1.push(opts); return [lintA]; }), makeCtx(), "test-cycle", { // eslint-disable-next-line @typescript-eslint/no-explicit-any
callOp: makeCallOpMock() as unknown as CallOpFn});
    expect(validateCalls1).toHaveLength(1);
    expect(validateCalls1[0]).toMatchObject({ mode: "lite", strategiesRun: ["lint-fix"] });
    expect(r1.exitReason).toBe("max-attempts-per-strategy");

    const validateCalls2: Array<{ mode: "full" | "lite"; strategiesRun?: readonly string[] }> = [];
    const sA = makeStrategy({ name: "fix-a", maxAttempts: 1, coRun: "co-run-sequential" });
    const sB = makeStrategy({ name: "fix-b", maxAttempts: 1, coRun: "co-run-sequential" });
    const r2 = await runFixCycle(makeCycle([lintA], [sA, sB], async (_ctx, opts) => { validateCalls2.push(opts); return [lintA]; }), makeCtx(), "test-cycle", { // eslint-disable-next-line @typescript-eslint/no-explicit-any
callOp: makeCallOpMock() as unknown as CallOpFn});
    expect(validateCalls2).toHaveLength(1);
    expect(validateCalls2[0]).toMatchObject({ mode: "lite", strategiesRun: ["fix-a", "fix-b"] });
    expect(r2.exitReason).toBe("max-attempts-per-strategy");
  });

  test("reports the terminal iteration's cost on the lite-validate exits (#1369)", async () => {
    // Only the `continue`-to-companions path used to accumulate, so every
    // terminal exit in this branch under-reported spend as 0.
    const s = makeStrategy({
      name: "lint-fix",
      maxAttempts: 1,
      extractApplied: () => ({ summary: "", costUsd: 0.25 }),
    });
    const r = await runFixCycle(makeCycle([lintA], [s], async () => [lintA]), makeCtx(), "test-cycle", {
      callOp: makeCallOpMock() as unknown as CallOpFn,
    });
    expect(r.exitReason).toBe("max-attempts-per-strategy");
    expect(r.costUsd).toBeCloseTo(0.25, 5);
  });

  test("does not double-count cost when continuing to companion strategies (#1369)", async () => {
    // The exclusive strategy exhausts and short-circuits, handing off to an
    // uncapped companion. Its cost must be counted exactly once.
    const exclusive = makeStrategy({
      name: "mechanical-lintfix",
      maxAttempts: 1,
      coRun: "exclusive",
      appliesTo: (f) => f.source === "lint",
      extractApplied: () => ({ summary: "", costUsd: 1 }),
    });
    const companion = makeStrategy({
      name: "implementer",
      maxAttempts: 1,
      coRun: "co-run-sequential",
      appliesTo: (f) => f.source === "lint",
      extractApplied: () => ({ summary: "", costUsd: 1 }),
    });
    const cycle = makeCycle([lintA], [exclusive, companion], async () => ({ findings: [lintA], shortCircuited: true }));
    const r = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      callOp: makeCallOpMock() as unknown as CallOpFn,
    });
    // One attempt each, $1 apiece — never 3 (which is what double-counting the
    // first iteration would produce).
    expect(r.costUsd).toBeCloseTo(2, 5);
  });
});

// ─── runFixCycle — bail: agent-gave-up (#897) ────────────────────────────────

describe("runFixCycle — bail: agent-gave-up", () => {
  test("exits with agent-gave-up when extractApplied returns unresolved; takes priority over cap-exhausted on final attempt", async () => {
    let validateCalled = false;
    const s1 = makeStrategy({ name: "source-fix", extractApplied: () => ({ summary: "", unresolved: "Cannot resolve — conflicting requirements" }) });
    const r1 = await runFixCycle(makeCycle([lintA], [s1], async () => { validateCalled = true; return []; }), makeCtx(), "test-cycle", { // eslint-disable-next-line @typescript-eslint/no-explicit-any
callOp: makeCallOpMock() as unknown as CallOpFn});
    expect(r1.exitReason).toBe("agent-gave-up");
    expect(r1.unresolvedDetail).toBe("Cannot resolve — conflicting requirements");
    expect(validateCalled).toBe(false);
    expect(r1.iterations).toHaveLength(1);
    expect(r1.finalFindings).toEqual([lintA]);

    // agent-gave-up must win over cap-exhausted when maxAttempts=1 and UNRESOLVED fires simultaneously
    let validateCalled2 = false;
    const s2 = makeStrategy({ name: "source-fix", maxAttempts: 1, extractApplied: () => ({ summary: "", unresolved: "conflicting spec" }) });
    const r2 = await runFixCycle(makeCycle([lintA], [s2], async () => { validateCalled2 = true; return []; }), makeCtx(), "test-cycle", { // eslint-disable-next-line @typescript-eslint/no-explicit-any
callOp: makeCallOpMock() as unknown as CallOpFn});
    expect(r2.exitReason).toBe("agent-gave-up");
    expect(r2.unresolvedDetail).toBe("conflicting spec");
    expect(validateCalled2).toBe(false);
  });

  test("accumulates the iteration's cost when every strategy gives up (#1369)", async () => {
    const s1 = makeStrategy({
      name: "source-fix",
      extractApplied: () => ({ summary: "", unresolved: "cannot fix", costUsd: 0.42 }),
    });
    const r = await runFixCycle(makeCycle([lintA], [s1], async () => []), makeCtx(), "test-cycle", {
      callOp: makeCallOpMock() as unknown as CallOpFn,
    });
    expect(r.exitReason).toBe("agent-gave-up");
    expect(r.costUsd).toBeCloseTo(0.42, 5);
  });
});

// ─── runFixCycle — bail: validator-error ─────────────────────────────────────

describe("runFixCycle — bail: validator-error", () => {
  test("exits with validator-error after exhausting validatorRetries (2 calls total: first + 1 retry)", async () => {
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
    expect(validateCallCount).toBe(2);
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
  test("resolves after one iteration; records fixesApplied fields from extractApplied", async () => {
    const strategy = makeStrategy({ name: "lint-fix", extractApplied: () => ({ targetFiles: ["src/a.ts"], summary: "fixed unused var" }) });
    const cycle = makeCycle([lintA], [strategy], async () => []);
    const callOpMock = makeCallOpMock({ output: "done" });
    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", { // eslint-disable-next-line @typescript-eslint/no-explicit-any
callOp: callOpMock as unknown as CallOpFn});
    expect(result.exitReason).toBe("resolved");
    expect(result.finalFindings).toHaveLength(0);
    expect(result.iterations).toHaveLength(1);
    expect(result.iterations[0].outcome).toBe("resolved");
    expect(result.iterations[0].iterationNum).toBe(1);
    expect(callOpMock).toHaveBeenCalledTimes(1);
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

  test("iterates until resolved (maxAttempts exceeds iteration count)", async () => {
    let validateCall = 0;
    // maxAttempts=4 so the 3rd validate still runs (not skipped as final attempt)
    const strategy = makeStrategy({ name: "lint-fix", maxAttempts: 4 });
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

// ─── runFixCycle — validate mode opts ──────────────────────────────────────────

describe("runFixCycle — validate mode opts", () => {
  test("passes { mode: 'full' } to validate in non-terminal path", async () => {
    const validateCalls: Array<{ mode: "full" | "lite"; strategiesRun?: readonly string[] }> = [];
    const strategy = makeStrategy({ name: "lint-fix", maxAttempts: 2 });
    const cycle = makeCycle([lintA], [strategy], async (_ctx, opts) => {
      validateCalls.push(opts);
      return []; // resolved
    });
    const callOpMock = makeCallOpMock();

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", { // eslint-disable-next-line @typescript-eslint/no-explicit-any
callOp: callOpMock as unknown as CallOpFn});

    expect(result.exitReason).toBe("resolved");
    expect(validateCalls).toHaveLength(1);
    expect(validateCalls[0]).toMatchObject({ mode: "full", strategiesRun: ["lint-fix"] });
  });

});

// ─── runFixCycle — lite validate on terminal exhausted ───────────────────────

describe("runFixCycle — lite validate on terminal exhausted", () => {
  test("lite validate empty → resolved (AC2); non-empty → max-attempts-per-strategy (AC3)", async () => {
    const strategy = makeStrategy({ name: "lint-fix", maxAttempts: 1 });
    const emptyResult = await runFixCycle(makeCycle([lintA], [strategy], async () => []), makeCtx(), "test-cycle", { // eslint-disable-next-line @typescript-eslint/no-explicit-any
callOp: makeCallOpMock() as unknown as CallOpFn});
    expect(emptyResult.exitReason).toBe("resolved");
    expect(emptyResult.finalFindings).toEqual([]);
    expect(emptyResult.exhaustedStrategy).toBeUndefined();

    const nonEmptyResult = await runFixCycle(makeCycle([lintA], [makeStrategy({ name: "lint-fix", maxAttempts: 1 })], async () => [lintA, lintB]), makeCtx(), "test-cycle", { // eslint-disable-next-line @typescript-eslint/no-explicit-any
callOp: makeCallOpMock() as unknown as CallOpFn});
    expect(nonEmptyResult.exitReason).toBe("max-attempts-per-strategy");
    expect(nonEmptyResult.finalFindings).toEqual([lintA, lintB]);
    expect(nonEmptyResult.exhaustedStrategy).toBe("lint-fix");
  });

  test("iteration findingsAfter and cycle.findings both reflect lite result (AC4/AC5/AC6)", async () => {
    const strategy = makeStrategy({ name: "lint-fix", maxAttempts: 1 });
    // lintA before, lintB after (same source lint) → regressed
    const cycle = makeCycle([lintA], [strategy], async () => [lintB]);

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", { // eslint-disable-next-line @typescript-eslint/no-explicit-any
callOp: makeCallOpMock() as unknown as CallOpFn});

    expect(result.iterations).toHaveLength(1);
    expect(result.iterations[0].findingsAfter).toEqual([lintB]);
    expect(result.iterations[0].outcome).toBe("regressed");
    expect(cycle.findings).toEqual([lintB]);
  });

  test("lite validate throws: exits with max-attempts-per-strategy and no retry budget consumed (AC7)", async () => {
    let validateCallCount = 0;
    const strategy = makeStrategy({ name: "lint-fix", maxAttempts: 1 });
    const cycle = makeCycle([lintA], [strategy], async () => {
      validateCallCount++;
      throw new Error("lite validate failed");
    }, { config: { maxAttemptsTotal: 10, validatorRetries: 3 } });

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", { // eslint-disable-next-line @typescript-eslint/no-explicit-any
callOp: makeCallOpMock() as unknown as CallOpFn});

    expect(result.exitReason).toBe("max-attempts-per-strategy");
    expect(result.finalFindings).toEqual([lintA]);
    expect(result.exhaustedStrategy).toBe("lint-fix");
    // Only 1 call — no retries consumed even though validatorRetries=3
    expect(validateCallCount).toBe(1);
  });

  test("emits warn log with correct fields when terminal lite validate throws (AC8)", async () => {
    const mockLogger = makeLogger();
    const strategy = makeStrategy({ name: "lint-fix", maxAttempts: 1 });
    const cycle = makeCycle([lintA], [strategy], async () => {
      throw new Error("lite blew up");
    });
    const callOpMock = makeCallOpMock();

    await runFixCycle(cycle, makeCtx(), "my-cycle", { // eslint-disable-next-line @typescript-eslint/no-explicit-any
callOp: callOpMock as unknown as CallOpFn, logger: mockLogger as unknown as Logger});

    const warnCall = mockLogger.calls.find((c) => c.level === "warn" && c.stage === "findings.cycle");
    expect(warnCall).toBeDefined();
    expect(warnCall?.data).toMatchObject({
      storyId: "story-1",
      packageDir: "/tmp/test",
      cycleName: "my-cycle",
      error: "lite blew up",
    });
  });

  test.each([
    ["resolved (AC9)", async () => [], "resolved", { storyId: "story-1", packageDir: "/tmp/test", cycleName: "my-cycle", reason: "resolved" }],
    ["cap-exhausted (AC10)", async () => [lintA], "max-attempts-per-strategy", { storyId: "story-1", packageDir: "/tmp/test", cycleName: "my-cycle", reason: "max-attempts-per-strategy", exhaustedStrategy: "lint-fix", liteFindingsAfterCount: 1 }],
  ] as const)("emits info log with storyId as first key when lite validate %s", async (_label, validateFn, reason, expectedData) => {
    const mockLogger = makeLogger();
    const strategy = makeStrategy({ name: "lint-fix", maxAttempts: 1 });
    const cycle = makeCycle([lintA], [strategy], validateFn as (ctx: FixCycleContext, opts: { mode: "full" | "lite" }) => Promise<Finding[]>);
    const callOpMock = makeCallOpMock();

    await runFixCycle(cycle, makeCtx(), "my-cycle", { // eslint-disable-next-line @typescript-eslint/no-explicit-any
callOp: callOpMock as unknown as CallOpFn, logger: mockLogger as unknown as Logger});

    const infoCall = mockLogger.calls.find(
      (c) => c.level === "info" && c.stage === "findings.cycle" && c.data?.reason === reason,
    );
    expect(infoCall).toBeDefined();
    expect(Object.keys(infoCall!.data!)[0]).toBe("storyId");
    expect(infoCall?.data).toMatchObject(expectedData);
  });
});

// ─── runFixCycle — exclusive exhausted, co-run companion continues ───────────

describe("runFixCycle — exclusive strategy exhausted with uncapped companion", () => {
  test("co-run companion runs after exclusive strategy exhausts and validate short-circuits", async () => {
    // Reproduces the mechanical-lintfix (exclusive, maxAttempts=1) +
    // autofix-implementer (co-run-sequential) scenario: exclusive exhausts and
    // can't fix E501, but the companion LLM strategy should still get a turn.
    // Give each strategy a distinct fixOp name so callOrder can tell them apart.
    const exclusiveStrategy = makeStrategy({
      name: "mechanical-fix",
      coRun: "exclusive",
      maxAttempts: 1,
      fixOp: { ...noopOp, name: "mechanical-fix-op" } as typeof noopOp,
      appliesTo: (f) => f.source === "lint",
    });
    const companionStrategy = makeStrategy({
      name: "llm-fix",
      coRun: "co-run-sequential",
      maxAttempts: 2,
      fixOp: { ...noopOp, name: "llm-fix-op" } as typeof noopOp,
      appliesTo: (f) => f.source === "lint",
    });

    const callOrder: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callOpMock = (async (_ctx: any, op: any) => {
      callOrder.push(op.name as string);
      return {};
    }) as unknown as CallOpFn;

    let validateCall = 0;
    const cycle = makeCycle(
      [lintA],
      [exclusiveStrategy, companionStrategy],
      async () => {
        validateCall++;
        // Short-circuit on first lite-validate (mechanical fix ran but couldn't fix);
        // resolve on second full-validate (LLM fix succeeded).
        if (validateCall === 1) return { findings: [lintA], shortCircuited: true } as unknown as Finding[];
        return [];
      },
    );

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", { callOp: callOpMock });

    expect(result.exitReason).toBe("resolved");
    // Distinct op names prove: mechanical-fix ran first (exclusive), then llm-fix (companion).
    expect(callOrder).toEqual(["mechanical-fix-op", "llm-fix-op"]);
    expect(result.finalFindings).toHaveLength(0);
  });

  test("validate-short-circuit exits when exclusive exhausts AND no uncapped companions exist", async () => {
    const exclusiveOnly = makeStrategy({
      name: "mechanical-fix",
      coRun: "exclusive",
      maxAttempts: 1,
      appliesTo: (f) => f.source === "lint",
    });
    const validateResult: ValidateResult<Finding> = { findings: [lintA], shortCircuited: true };
    const cycle = makeCycle([lintA], [exclusiveOnly], async () => validateResult as unknown as Finding[]);

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", { // eslint-disable-next-line @typescript-eslint/no-explicit-any
callOp: makeCallOpMock() as unknown as CallOpFn });

    expect(result.exitReason).toBe("validate-short-circuit");
    expect(result.finalFindings).toEqual([lintA]);
  });
});

// ─── runFixCycle — AC3/AC4: ValidateResult short-circuit flag ────────────────

describe("runFixCycle — ValidateResult short-circuit flag", () => {
  test("AC3: validate returning { findings: [], shortCircuited: true } exits as 'validate-short-circuit' not 'resolved'", async () => {
    // validate signals that it short-circuited (a phase failed); runFixCycle must NOT classify this as "resolved"
    const strategy = makeStrategy({ name: "lint-fix", maxAttempts: 1 });
    const validateResult: ValidateResult<Finding> = { findings: [], shortCircuited: true };
    const cycle = makeCycle([lintA], [strategy], async () => validateResult as unknown as Finding[]);

    const result = await runFixCycle(cycle, makeCtx(), "sc-cycle", { // eslint-disable-next-line @typescript-eslint/no-explicit-any
callOp: makeCallOpMock() as unknown as CallOpFn });

    expect(result.exitReason).toBe("validate-short-circuit");
    expect(result.finalFindings).toHaveLength(0);
  });

  test("AC4: validate returning { findings: [], shortCircuited: false } exits as 'resolved' (clean sweep)", async () => {
    // validate completed without short-circuiting; empty findings should still be "resolved"
    const strategy = makeStrategy({ name: "lint-fix", maxAttempts: 1 });
    const validateResult: ValidateResult<Finding> = { findings: [], shortCircuited: false };
    const cycle = makeCycle([lintA], [strategy], async () => validateResult as unknown as Finding[]);

    const result = await runFixCycle(cycle, makeCtx(), "sc-cycle", { // eslint-disable-next-line @typescript-eslint/no-explicit-any
callOp: makeCallOpMock() as unknown as CallOpFn });

    expect(result.exitReason).toBe("resolved");
    expect(result.finalFindings).toHaveLength(0);
  });
});

// ─── runFixCycle — iteration-completed log emission (US-001 AC8-14) ──────────

describe("runFixCycle — iteration-completed log emission", () => {
  const iterationCompletedCalls = (logger: ReturnType<typeof makeLogger>) =>
    logger.calls.filter((c) => c.level === "info" && c.stage === "findings.cycle" && c.message === "iteration completed");

  test("AC8: agent-gave-up exit emits one iteration-completed record with iterationNum=1", async () => {
    const mockLogger = makeLogger();
    const strategy = makeStrategy({ extractApplied: () => ({ summary: "", unresolved: "Cannot resolve" }) });
    const cycle = makeCycle([lintA], [strategy], async () => []);

    const result = await runFixCycle(cycle, makeCtx(), "my-cycle", {
      callOp: makeCallOpMock() as unknown as CallOpFn,
      logger: mockLogger as unknown as Logger,
    });
    expect(result.exitReason).toBe("agent-gave-up");

    const calls = iterationCompletedCalls(mockLogger);
    expect(calls).toHaveLength(1);
    expect(calls[0].data).toMatchObject({ iterationNum: 1 });
  });

  test("AC9: terminal lite validate returns no findings → resolved → emits one iteration-completed record", async () => {
    const mockLogger = makeLogger();
    const strategy = makeStrategy({ name: "lint-fix", maxAttempts: 1 });
    const cycle = makeCycle([lintA], [strategy], async () => []);

    const result = await runFixCycle(cycle, makeCtx(), "my-cycle", {
      callOp: makeCallOpMock() as unknown as CallOpFn,
      logger: mockLogger as unknown as Logger,
    });
    expect(result.exitReason).toBe("resolved");

    const calls = iterationCompletedCalls(mockLogger);
    expect(calls).toHaveLength(1);
  });

  test("AC10: terminal lite validate short-circuits → validate-short-circuit → emits one iteration-completed record", async () => {
    const mockLogger = makeLogger();
    const strategy = makeStrategy({ name: "lint-fix", maxAttempts: 1 });
    const validateResult: ValidateResult<Finding> = { findings: [lintA], shortCircuited: true };
    const cycle = makeCycle([lintA], [strategy], async () => validateResult as unknown as Finding[]);

    const result = await runFixCycle(cycle, makeCtx(), "my-cycle", {
      callOp: makeCallOpMock() as unknown as CallOpFn,
      logger: mockLogger as unknown as Logger,
    });
    expect(result.exitReason).toBe("validate-short-circuit");

    const calls = iterationCompletedCalls(mockLogger);
    expect(calls).toHaveLength(1);
  });

  test("AC11: terminal lite validate throws → max-attempts-per-strategy → emits one iteration-completed record", async () => {
    const mockLogger = makeLogger();
    const strategy = makeStrategy({ name: "lint-fix", maxAttempts: 1 });
    const cycle = makeCycle([lintA], [strategy], async () => {
      throw new Error("lite validate failed");
    });

    const result = await runFixCycle(cycle, makeCtx(), "my-cycle", {
      callOp: makeCallOpMock() as unknown as CallOpFn,
      logger: mockLogger as unknown as Logger,
    });
    expect(result.exitReason).toBe("max-attempts-per-strategy");

    const calls = iterationCompletedCalls(mockLogger);
    expect(calls).toHaveLength(1);
  });

  test("AC12: one normal resolving iteration → emits exactly one iteration-completed record", async () => {
    const mockLogger = makeLogger();
    const strategy = makeStrategy({ name: "lint-fix" });
    const cycle = makeCycle([lintA], [strategy], async () => []);

    const result = await runFixCycle(cycle, makeCtx(), "my-cycle", {
      callOp: makeCallOpMock() as unknown as CallOpFn,
      logger: mockLogger as unknown as Logger,
    });
    expect(result.exitReason).toBe("resolved");

    const calls = iterationCompletedCalls(mockLogger);
    expect(calls).toHaveLength(1);
    expect(calls[0].data).toMatchObject({ iterationNum: 1 });
  });

  test("AC13: two normal iterations before terminal exit → iterationNum sequence is [1, 2, 3]", async () => {
    const mockLogger = makeLogger();
    // Validate twice returning a remaining finding; on the third iteration, returns resolved.
    let validateCall = 0;
    const strategy = makeStrategy({ name: "lint-fix", maxAttempts: 5 });
    const cycle = makeCycle([lintA], [strategy], async () => {
      validateCall++;
      if (validateCall < 3) return [lintA];
      return [];
    });

    const result = await runFixCycle(cycle, makeCtx(), "my-cycle", {
      callOp: makeCallOpMock() as unknown as CallOpFn,
      logger: mockLogger as unknown as Logger,
    });
    expect(result.exitReason).toBe("resolved");
    expect(result.iterations).toHaveLength(3);

    const calls = iterationCompletedCalls(mockLogger);
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.data?.iterationNum)).toEqual([1, 2, 3]);
  });

  test("AC14: agent-gave-up exit → emitted iteration record has outcome === 'unchanged'", async () => {
    const mockLogger = makeLogger();
    const strategy = makeStrategy({ extractApplied: () => ({ summary: "", unresolved: "Cannot resolve" }) });
    const cycle = makeCycle([lintA], [strategy], async () => []);

    const result = await runFixCycle(cycle, makeCtx(), "my-cycle", {
      callOp: makeCallOpMock() as unknown as CallOpFn,
      logger: mockLogger as unknown as Logger,
    });
    expect(result.exitReason).toBe("agent-gave-up");

    const calls = iterationCompletedCalls(mockLogger);
    expect(calls).toHaveLength(1);
    expect(calls[0].data).toMatchObject({ outcome: "unchanged", iterationNum: 1 });
  });
});
