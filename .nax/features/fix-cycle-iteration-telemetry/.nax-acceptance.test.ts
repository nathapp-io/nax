import { describe, expect, test } from "bun:test";
import { findingKey, recordIteration, runFixCycle } from "../../../src/findings";
import type {
  Finding,
  FixApplied,
  FixCycle,
  RecordIterationContext,
  RecordIterationInput,
} from "../../../src/findings";
import type { CallOpFn } from "../../../src/findings/cycle";
import { makeLogger } from "../../../test/helpers";
import {
  makeCallOpMock,
  makeCtx,
  makeCycle,
  makeFinding,
  makeStrategy,
} from "../../../test/unit/findings/_cycle-fixtures";

// ─── Local test helpers ───────────────────────────────────────────────────────

const lintA = makeFinding({ source: "lint", message: "unused var", file: "src/a.ts", line: 1 });
const lintB = makeFinding({ source: "lint", message: "missing semicolon", file: "src/b.ts", line: 5 });

function makeFixApplied(overrides: Partial<FixApplied> & Pick<FixApplied, "strategyName" | "op">): FixApplied {
  return { targetFiles: [], summary: "", ...overrides };
}

function makeRecordCtx(overrides: Partial<RecordIterationContext> = {}): RecordIterationContext {
  return { storyId: "story-1", packageDir: "/tmp/test", cycleName: "test-cycle", ...overrides };
}

function makeRecordInput(overrides: Partial<RecordIterationInput<Finding>> = {}): RecordIterationInput<Finding> {
  return {
    findingsBefore: [],
    findingsAfter: [],
    fixesApplied: [],
    outcome: "unchanged",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    ...overrides,
  };
}

function makeEmptyCycle(): FixCycle<Finding> {
  return makeCycle([], [], async () => []);
}

/** Count `findings.cycle` / `iteration completed` records among captured logger calls. */
function iterationCompletedRecords(calls: ReturnType<typeof makeLogger>["calls"]) {
  return calls.filter((c) => c.stage === "findings.cycle" && c.message === "iteration completed");
}

// ─── AC-1 ──────────────────────────────────────────────────────────────────────

describe("AC-1: recordIteration is exported and callable", () => {
  test("AC-1: recordIteration is importable from the src/findings barrel as a function", () => {
    expect(typeof recordIteration).toBe("function");
  });
});

// ─── AC-2..AC-7: recordIteration append + log behaviour ────────────────────────

describe("AC-2..AC-7: recordIteration append and log behaviour", () => {
  test("AC-2: recordIteration on an empty cycle returns an Iteration with iterationNum 1", () => {
    const cycle = makeEmptyCycle();
    const returned = recordIteration(cycle, makeRecordInput(), makeRecordCtx(), null);
    expect(returned.iterationNum).toBe(1);
  });

  test("AC-3: the returned Iteration is the last element of cycle.iterations", () => {
    const cycle = makeEmptyCycle();
    const returned = recordIteration(cycle, makeRecordInput(), makeRecordCtx(), null);
    expect(cycle.iterations[cycle.iterations.length - 1]).toBe(returned);
  });

  test("AC-4: a second recordIteration call on the same cycle returns iterationNum 2", () => {
    const cycle = makeEmptyCycle();
    recordIteration(cycle, makeRecordInput(), makeRecordCtx(), null);
    const second = recordIteration(cycle, makeRecordInput(), makeRecordCtx(), null);
    expect(second.iterationNum).toBe(2);
  });

  test("AC-5: recordIteration emits exactly one record with stage findings.cycle and message 'iteration completed'", () => {
    const cycle = makeEmptyCycle();
    const mockLogger = makeLogger();
    recordIteration(cycle, makeRecordInput(), makeRecordCtx(), mockLogger as unknown as import("../../../src/logger").Logger);

    expect(mockLogger.calls).toHaveLength(1);
    expect(mockLogger.calls[0]?.stage).toBe("findings.cycle");
    expect(mockLogger.calls[0]?.message).toBe("iteration completed");
  });

  test("AC-6: the first key of the emitted data object is storyId", () => {
    const cycle = makeEmptyCycle();
    const mockLogger = makeLogger();
    recordIteration(cycle, makeRecordInput(), makeRecordCtx(), mockLogger as unknown as import("../../../src/logger").Logger);

    const data = mockLogger.calls[0]?.data ?? {};
    expect(Object.keys(data)[0]).toBe("storyId");
  });

  test("AC-7: a null or undefined logger does not throw, and the append still happens", () => {
    const cycle = makeEmptyCycle();

    expect(() => {
      const returnedNull = recordIteration(cycle, makeRecordInput(), makeRecordCtx(), null);
      expect(cycle.iterations[cycle.iterations.length - 1]).toBe(returnedNull);

      const returnedUndefined = recordIteration(cycle, makeRecordInput(), makeRecordCtx(), undefined);
      expect(cycle.iterations[cycle.iterations.length - 1]).toBe(returnedUndefined);
    }).not.toThrow();
  });
});

// ─── AC-8..AC-14: runFixCycle exit paths emit iteration-completed records ──────

describe("AC-8..AC-14: runFixCycle routes every append site through recordIteration", () => {
  test("AC-8: agent-gave-up exit emits exactly one iteration-completed record with iterationNum 1", async () => {
    const mockLogger = makeLogger();
    const strategy = makeStrategy({
      name: "source-fix",
      extractApplied: () => ({ summary: "", unresolved: "Cannot resolve — conflicting requirements" }),
    });
    const cycle = makeCycle([lintA], [strategy], async () => []);

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      callOp: makeCallOpMock() as unknown as CallOpFn,
      logger: mockLogger as unknown as import("../../../src/logger").Logger,
    });

    expect(result.exitReason).toBe("agent-gave-up");
    const records = iterationCompletedRecords(mockLogger.calls);
    expect(records).toHaveLength(1);
    expect(records[0]?.data?.iterationNum).toBe(1);
  });

  test("AC-9: resolved exit via terminal lite validation emits exactly one iteration-completed record", async () => {
    const mockLogger = makeLogger();
    const strategy = makeStrategy({ name: "lint-fix", maxAttempts: 1 });
    const cycle = makeCycle([lintA], [strategy], async () => []);

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      callOp: makeCallOpMock() as unknown as CallOpFn,
      logger: mockLogger as unknown as import("../../../src/logger").Logger,
    });

    expect(result.exitReason).toBe("resolved");
    expect(iterationCompletedRecords(mockLogger.calls)).toHaveLength(1);
  });

  test("AC-10: validate-short-circuit exit via terminal lite validation emits exactly one iteration-completed record", async () => {
    const mockLogger = makeLogger();
    const strategy = makeStrategy({ name: "lint-fix", maxAttempts: 1, appliesTo: (f) => f.source === "lint" });
    const cycle = makeCycle([lintA], [strategy], async () => ({ findings: [lintA], shortCircuited: true }));

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      callOp: makeCallOpMock() as unknown as CallOpFn,
      logger: mockLogger as unknown as import("../../../src/logger").Logger,
    });

    expect(result.exitReason).toBe("validate-short-circuit");
    expect(iterationCompletedRecords(mockLogger.calls)).toHaveLength(1);
  });

  test("AC-11: max-attempts-per-strategy exit via a throwing terminal lite validation emits exactly one iteration-completed record", async () => {
    const mockLogger = makeLogger();
    const strategy = makeStrategy({ name: "lint-fix", maxAttempts: 1 });
    const cycle = makeCycle([lintA], [strategy], async () => {
      throw new Error("lite validate failed");
    });

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      callOp: makeCallOpMock() as unknown as CallOpFn,
      logger: mockLogger as unknown as import("../../../src/logger").Logger,
    });

    expect(result.exitReason).toBe("max-attempts-per-strategy");
    expect(iterationCompletedRecords(mockLogger.calls)).toHaveLength(1);
  });

  test("AC-12: a normal iteration that resolves emits exactly one iteration-completed record", async () => {
    const mockLogger = makeLogger();
    const strategy = makeStrategy({ name: "lint-fix" });
    const cycle = makeCycle([lintA], [strategy], async () => []);

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      callOp: makeCallOpMock() as unknown as CallOpFn,
      logger: mockLogger as unknown as import("../../../src/logger").Logger,
    });

    expect(result.exitReason).toBe("resolved");
    expect(iterationCompletedRecords(mockLogger.calls)).toHaveLength(1);
  });

  test("AC-13: two normal iterations then a terminal exit emit three iteration-completed records numbered 1, 2, 3", async () => {
    const mockLogger = makeLogger();
    let validateCall = 0;
    // maxAttempts=4 keeps every iteration on the normal (non-terminal) path.
    const strategy = makeStrategy({ name: "lint-fix", maxAttempts: 4 });
    const cycle = makeCycle([lintA], [strategy], async () => {
      validateCall++;
      if (validateCall < 3) return [lintA];
      return [];
    });

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      callOp: makeCallOpMock() as unknown as CallOpFn,
      logger: mockLogger as unknown as import("../../../src/logger").Logger,
    });

    expect(result.exitReason).toBe("resolved");
    const records = iterationCompletedRecords(mockLogger.calls);
    expect(records).toHaveLength(3);
    expect(records[0]?.data?.iterationNum).toBe(1);
    expect(records[1]?.data?.iterationNum).toBe(2);
    expect(records[2]?.data?.iterationNum).toBe(3);
  });

  test("AC-14: an agent-gave-up exit's iteration-completed record has outcome 'unchanged'", async () => {
    const mockLogger = makeLogger();
    const strategy = makeStrategy({
      name: "source-fix",
      extractApplied: () => ({ summary: "", unresolved: "cannot fix" }),
    });
    const cycle = makeCycle([lintA], [strategy], async () => []);

    const result = await runFixCycle(cycle, makeCtx(), "test-cycle", {
      callOp: makeCallOpMock() as unknown as CallOpFn,
      logger: mockLogger as unknown as import("../../../src/logger").Logger,
    });

    expect(result.exitReason).toBe("agent-gave-up");
    const records = iterationCompletedRecords(mockLogger.calls);
    expect(records[0]?.data?.outcome).toBe("unchanged");
  });
});

// ─── AC-15..AC-25: widened payload (identities, fix targets, counts) ───────────

describe("AC-15..AC-25: recordIteration payload widening", () => {
  test("AC-15: findingKeysBefore is an array of findingKey(f) per entry in findingsBefore, in order", () => {
    const cycle = makeEmptyCycle();
    const input = makeRecordInput({ findingsBefore: [lintA, lintB] });
    const returned = recordIteration(cycle, input, makeRecordCtx(), null);
    const record = cycle.iterations[cycle.iterations.length - 1] as unknown as { findingKeysBefore: string[] };

    expect(record.findingKeysBefore).toEqual([findingKey(lintA), findingKey(lintB)]);
    expect(returned).toBeDefined();
  });

  test("AC-16: findingKeysAfter is a single-element array equal to findingKey of the one finding in findingsAfter", () => {
    const cycle = makeEmptyCycle();
    const input = makeRecordInput({ findingsAfter: [lintB] });
    recordIteration(cycle, input, makeRecordCtx(), null);
    const record = cycle.iterations[cycle.iterations.length - 1] as unknown as { findingKeysAfter: string[] };

    expect(record.findingKeysAfter).toEqual([findingKey(lintB)]);
  });

  test("AC-17: a finding present in both findingsBefore and findingsAfter has its key in both arrays at the matching index", () => {
    const cycle = makeEmptyCycle();
    const shared = lintA;
    const input = makeRecordInput({ findingsBefore: [lintB, shared], findingsAfter: [shared] });
    recordIteration(cycle, input, makeRecordCtx(), null);
    const record = cycle.iterations[cycle.iterations.length - 1] as unknown as {
      findingKeysBefore: string[];
      findingKeysAfter: string[];
    };

    expect(record.findingKeysBefore[1]).toBe(findingKey(shared));
    expect(record.findingKeysAfter[0]).toBe(findingKey(shared));
  });

  test("AC-18: record.findingsBefore is the numeric count (not the array) when findingsBefore has 2 entries", () => {
    const cycle = makeEmptyCycle();
    const input = makeRecordInput({ findingsBefore: [lintA, lintB] });
    recordIteration(cycle, input, makeRecordCtx(), null);
    const record = cycle.iterations[cycle.iterations.length - 1] as unknown as { findingsBefore: unknown };

    expect(record.findingsBefore).toBe(2);
    expect(typeof record.findingsBefore).toBe("number");
  });

  test("AC-19: record.findingsAfter is the numeric count (not the array) when findingsAfter has 1 entry", () => {
    const cycle = makeEmptyCycle();
    const input = makeRecordInput({ findingsAfter: [lintA] });
    recordIteration(cycle, input, makeRecordCtx(), null);
    const record = cycle.iterations[cycle.iterations.length - 1] as unknown as { findingsAfter: unknown };

    expect(record.findingsAfter).toBe(1);
    expect(typeof record.findingsAfter).toBe("number");
  });

  test("AC-20: fixTargetFiles is the de-duplicated, first-seen-order union of every fixesApplied[].targetFiles", () => {
    const cycle = makeEmptyCycle();
    const fixesApplied: FixApplied[] = [
      makeFixApplied({ strategyName: "s1", op: "op-1", targetFiles: ["a.ts", "b.ts"] }),
      makeFixApplied({ strategyName: "s2", op: "op-2", targetFiles: ["b.ts", "c.ts"] }),
    ];
    const input = makeRecordInput({ fixesApplied });
    recordIteration(cycle, input, makeRecordCtx(), null);
    const record = cycle.iterations[cycle.iterations.length - 1] as unknown as { fixTargetFiles: string[] };

    expect(record.fixTargetFiles).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  test("AC-21: fixSummaries contains one entry per fixesApplied entry, equal to its summary, in order", () => {
    const cycle = makeEmptyCycle();
    const fixesApplied: FixApplied[] = [
      makeFixApplied({ strategyName: "s1", op: "op-1", summary: "fixed unused var" }),
      makeFixApplied({ strategyName: "s2", op: "op-2", summary: "fixed missing semicolon" }),
    ];
    const input = makeRecordInput({ fixesApplied });
    recordIteration(cycle, input, makeRecordCtx(), null);
    const record = cycle.iterations[cycle.iterations.length - 1] as unknown as { fixSummaries: string[] };

    expect(record.fixSummaries).toEqual(["fixed unused var", "fixed missing semicolon"]);
  });

  test("AC-22: fixTargetFiles is absent (not present, not undefined) when fixesApplied is empty", () => {
    const cycle = makeEmptyCycle();
    const input = makeRecordInput({ fixesApplied: [] });
    recordIteration(cycle, input, makeRecordCtx(), null);
    const record = cycle.iterations[cycle.iterations.length - 1] as unknown as Record<string, unknown>;

    expect(Object.hasOwn(record, "fixTargetFiles")).toBe(false);
  });

  test("AC-23: fixSummaries is absent (not present, not undefined) when fixesApplied is empty", () => {
    const cycle = makeEmptyCycle();
    const input = makeRecordInput({ fixesApplied: [] });
    recordIteration(cycle, input, makeRecordCtx(), null);
    const record = cycle.iterations[cycle.iterations.length - 1] as unknown as Record<string, unknown>;

    expect(Object.hasOwn(record, "fixSummaries")).toBe(false);
  });

  test("AC-24: a finding with file, line, and rule all undefined is keyed via findingKey with null placeholders", () => {
    const cycle = makeEmptyCycle();
    const bareFinding: Finding = { source: "lint", severity: "error", category: "test", message: "bare finding" };
    const input = makeRecordInput({ findingsBefore: [bareFinding] });
    recordIteration(cycle, input, makeRecordCtx(), null);
    const record = cycle.iterations[cycle.iterations.length - 1] as unknown as { findingKeysBefore: string[] };

    expect(record.findingKeysBefore[0]).toBe(findingKey(bareFinding));
    expect(record.findingKeysBefore[0]).toBe(JSON.stringify(["lint", null, null, null, "bare finding"]));
  });

  test("AC-25: costUsd is absent (not present) when every fixesApplied entry has costUsd 0", () => {
    const cycle = makeEmptyCycle();
    const fixesApplied: FixApplied[] = [
      makeFixApplied({ strategyName: "s1", op: "op-1", costUsd: 0 }),
      makeFixApplied({ strategyName: "s2", op: "op-2", costUsd: 0 }),
    ];
    const input = makeRecordInput({ fixesApplied });
    recordIteration(cycle, input, makeRecordCtx(), null);
    const record = cycle.iterations[cycle.iterations.length - 1] as unknown as Record<string, unknown>;

    expect(Object.hasOwn(record, "costUsd")).toBe(false);
  });
});