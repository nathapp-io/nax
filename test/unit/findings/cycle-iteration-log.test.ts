/**
 * Tests for recordIteration — the helper that pairs the append
 * (`cycle.iterations.push(...)`) with the iteration-completed log emit.
 * ADR-022 cycle orchestration. see .nax/features/iteration-record-helper/spec.md.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { assertDefined, makeLogger } from "@test/helpers";
import type { Finding, FixCycle } from "@/findings";
import { findingKey, recordIteration } from "@/findings";

let cycle: FixCycle<Finding>;

beforeEach(() => {
  cycle = {
    findings: [],
    iterations: [],
    strategies: [],
    validate: async () => [],
    config: { maxAttemptsTotal: 10, validatorRetries: 1 },
  };
});

// ─── AC1: import path ─────────────────────────────────────────────────────────

describe("recordIteration — barrel export (AC1)", () => {
  test("is callable as a function when imported from the src/findings barrel", () => {
    expect(typeof recordIteration).toBe("function");
  });
});

// ─── AC2: iterationNum is 1-indexed ────────────────────────────────────────────

describe("recordIteration — iterationNum (AC2, AC4)", () => {
  test("first call on empty cycle returns Iteration with iterationNum=1", () => {
    const iter = recordIteration(
      cycle,
      {
        findingsBefore: [],
        findingsAfter: [],
        fixesApplied: [],
        outcome: "resolved",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
      },
      { cycleName: "test" },
      null,
    );
    expect(iter.iterationNum).toBe(1);
  });

  test("second call on same cycle returns Iteration with iterationNum=2", () => {
    recordIteration(
      cycle,
      {
        findingsBefore: [],
        findingsAfter: [],
        fixesApplied: [],
        outcome: "resolved",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
      },
      { cycleName: "test" },
      null,
    );
    const iter = recordIteration(
      cycle,
      {
        findingsBefore: [],
        findingsAfter: [],
        fixesApplied: [],
        outcome: "resolved",
        startedAt: "2026-01-01T00:00:02.000Z",
        finishedAt: "2026-01-01T00:00:03.000Z",
      },
      { cycleName: "test" },
      null,
    );
    expect(iter.iterationNum).toBe(2);
  });
});

// ─── AC3: last element of cycle.iterations is the returned Iteration ───────────

describe("recordIteration — append side-effect (AC3)", () => {
  test("returned Iteration becomes the last element of cycle.iterations", () => {
    const iter = recordIteration(
      cycle,
      {
        findingsBefore: [],
        findingsAfter: [],
        fixesApplied: [],
        outcome: "resolved",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
      },
      { cycleName: "test" },
      null,
    );
    expect(cycle.iterations).toHaveLength(1);
    expect(cycle.iterations[cycle.iterations.length - 1]).toBe(iter);
  });
});

// ─── AC5: emits exactly one iteration-completed log entry ────────────────────

describe("recordIteration — log emission (AC5)", () => {
  test("emits exactly one record with stage 'findings.cycle' and message 'iteration completed'", () => {
    const logger = makeLogger();
    recordIteration(
      cycle,
      {
        findingsBefore: [],
        findingsAfter: [],
        fixesApplied: [],
        outcome: "resolved",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
      },
      { cycleName: "my-cycle" },
      logger,
    );

    const iterationCompleted = logger.calls.filter(
      (c) => c.stage === "findings.cycle" && c.message === "iteration completed",
    );
    expect(iterationCompleted).toHaveLength(1);
  });

  test("includes iterationNum, outcome, and the expected data in the log entry", () => {
    const logger = makeLogger();
    const fixesApplied = [{ strategyName: "lint-fix", op: "op-x", targetFiles: [], summary: "" }];
    recordIteration(
      cycle,
      {
        findingsBefore: [],
        findingsAfter: [],
        fixesApplied,
        outcome: "partial",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
      },
      { cycleName: "my-cycle", storyId: "story-7" },
      logger,
    );

    const call = logger.calls.find((c) => c.stage === "findings.cycle" && c.message === "iteration completed");
    expect(call?.data).toMatchObject({
      cycleName: "my-cycle",
      iterationNum: 1,
      outcome: "partial",
      strategiesRan: ["lint-fix"],
    });
  });
});

// ─── AC6: data object first key is storyId ────────────────────────────────────

describe("recordIteration — storyId first key (AC6)", () => {
  test("the first key of the emitted data object is storyId", () => {
    const logger = makeLogger();
    recordIteration(
      cycle,
      {
        findingsBefore: [],
        findingsAfter: [],
        fixesApplied: [],
        outcome: "resolved",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
      },
      { cycleName: "my-cycle", storyId: "story-1", packageDir: "/tmp/p" },
      logger,
    );

    const call = logger.calls.find((c) => c.stage === "findings.cycle" && c.message === "iteration completed");
    assertDefined(call, "log entry");
    const data = call.data;
    assertDefined(data, "entry data");
    expect(Object.keys(data)[0]).toBe("storyId");
  });

  test("storyId is still the first key when ctx does not supply one", () => {
    const logger = makeLogger();
    recordIteration(
      cycle,
      {
        findingsBefore: [],
        findingsAfter: [],
        fixesApplied: [],
        outcome: "resolved",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
      },
      { cycleName: "my-cycle" },
      logger,
    );

    const call = logger.calls.find((c) => c.stage === "findings.cycle" && c.message === "iteration completed");
    assertDefined(call, "log entry");
    const data = call.data;
    assertDefined(data, "entry data");
    expect(Object.keys(data)[0]).toBe("storyId");
  });
});

// ─── AC7: append still happens when logger is null/undefined ──────────────────

describe("recordIteration — null/undefined logger (AC7)", () => {
  test("appends Iteration to cycle.iterations when logger is null", () => {
    const iter = recordIteration(
      cycle,
      {
        findingsBefore: [],
        findingsAfter: [],
        fixesApplied: [],
        outcome: "unchanged",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
      },
      { cycleName: "my-cycle" },
      null,
    );
    expect(cycle.iterations).toHaveLength(1);
    expect(cycle.iterations[0]).toBe(iter);
  });

  test("appends Iteration to cycle.iterations when logger is undefined", () => {
    const iter = recordIteration(
      cycle,
      {
        findingsBefore: [],
        findingsAfter: [],
        fixesApplied: [],
        outcome: "unchanged",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
      },
      { cycleName: "my-cycle" },
      undefined,
    );
    expect(cycle.iterations).toHaveLength(1);
    expect(cycle.iterations[0]).toBe(iter);
  });
});

// ─── US-002: finding identity + fix targets in emitted record ────────────────

function findingFixture(overrides: Partial<Finding> = {}): Finding {
  return {
    source: "lint",
    severity: "warning",
    category: "lint-rule",
    rule: "lint/no-unused",
    file: "src/foo.ts",
    line: 12,
    message: "unused variable",
    ...overrides,
  };
}

function recordCall(logger: ReturnType<typeof makeLogger>) {
  return logger.calls.find((c) => c.stage === "findings.cycle" && c.message === "iteration completed");
}

describe("recordIteration — findingKeysBefore (US-002 AC1)", () => {
  test("emits findingKeysBefore as findingKey applied to each finding, in order", () => {
    const logger = makeLogger();
    const a = findingFixture({ file: "src/a.ts", line: 1 });
    const b = findingFixture({ file: "src/b.ts", line: 2 });
    recordIteration(
      cycle,
      {
        findingsBefore: [a, b],
        findingsAfter: [],
        fixesApplied: [],
        outcome: "resolved",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
      },
      { cycleName: "my-cycle", storyId: "story-1" },
      logger,
    );
    const call = recordCall(logger);
    expect(call?.data?.findingKeysBefore).toEqual([findingKey(a), findingKey(b)]);
  });
});

describe("recordIteration — findingKeysAfter (US-002 AC2)", () => {
  test("emits findingKeysAfter as a single-element list with findingKey of that finding", () => {
    const logger = makeLogger();
    const only = findingFixture({ file: "src/only.ts", line: 9 });
    recordIteration(
      cycle,
      {
        findingsBefore: [],
        findingsAfter: [only],
        fixesApplied: [],
        outcome: "regressed",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
      },
      { cycleName: "my-cycle", storyId: "story-1" },
      logger,
    );
    const call = recordCall(logger);
    expect(call?.data?.findingKeysAfter).toEqual([findingKey(only)]);
  });
});

describe("recordIteration — identity carry-through (US-002 AC3)", () => {
  test("same finding object present in both lists yields its key in both arrays", () => {
    const logger = makeLogger();
    const shared = findingFixture({ file: "src/shared.ts", line: 5 });
    recordIteration(
      cycle,
      {
        findingsBefore: [shared],
        findingsAfter: [shared],
        fixesApplied: [],
        outcome: "unchanged",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
      },
      { cycleName: "my-cycle", storyId: "story-1" },
      logger,
    );
    const call = recordCall(logger);
    const key = findingKey(shared);
    expect(call?.data?.findingKeysBefore).toEqual([key]);
    expect(call?.data?.findingKeysAfter).toEqual([key]);
  });
});

describe("recordIteration — findingsBefore count (US-002 AC4)", () => {
  test("emits findingsBefore as the number 2 when there are two findings", () => {
    const logger = makeLogger();
    recordIteration(
      cycle,
      {
        findingsBefore: [findingFixture({ file: "src/a.ts" }), findingFixture({ file: "src/b.ts" })],
        findingsAfter: [],
        fixesApplied: [],
        outcome: "resolved",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
      },
      { cycleName: "my-cycle", storyId: "story-1" },
      logger,
    );
    const call = recordCall(logger);
    expect(call?.data?.findingsBefore).toBe(2);
  });
});

describe("recordIteration — findingsAfter count (US-002 AC5)", () => {
  test("emits findingsAfter as the number 1 when there is one finding", () => {
    const logger = makeLogger();
    recordIteration(
      cycle,
      {
        findingsBefore: [],
        findingsAfter: [findingFixture({ file: "src/only.ts" })],
        fixesApplied: [],
        outcome: "regressed",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
      },
      { cycleName: "my-cycle", storyId: "story-1" },
      logger,
    );
    const call = recordCall(logger);
    expect(call?.data?.findingsAfter).toBe(1);
  });
});

describe("recordIteration — fixTargetFiles de-duplication (US-002 AC6)", () => {
  test("lists each distinct targetFiles path once in first-seen order", () => {
    const logger = makeLogger();
    recordIteration(
      cycle,
      {
        findingsBefore: [],
        findingsAfter: [],
        fixesApplied: [
          { strategyName: "lint-fix", op: "op-x", targetFiles: ["src/a.ts", "src/b.ts"], summary: "first" },
          { strategyName: "typecheck-fix", op: "op-y", targetFiles: ["src/b.ts", "src/c.ts"], summary: "second" },
        ],
        outcome: "partial",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
      },
      { cycleName: "my-cycle", storyId: "story-1" },
      logger,
    );
    const call = recordCall(logger);
    expect(call?.data?.fixTargetFiles).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });
});

describe("recordIteration — fixSummaries ordering (US-002 AC7)", () => {
  test("emits fixSummaries containing summary values in the same order as fixesApplied", () => {
    const logger = makeLogger();
    recordIteration(
      cycle,
      {
        findingsBefore: [],
        findingsAfter: [],
        fixesApplied: [
          { strategyName: "lint-fix", op: "op-x", targetFiles: ["src/a.ts"], summary: "first-summary" },
          { strategyName: "typecheck-fix", op: "op-y", targetFiles: ["src/b.ts"], summary: "second-summary" },
        ],
        outcome: "partial",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
      },
      { cycleName: "my-cycle", storyId: "story-1" },
      logger,
    );
    const call = recordCall(logger);
    expect(call?.data?.fixSummaries).toEqual(["first-summary", "second-summary"]);
  });
});

describe("recordIteration — no fixTargetFiles when fixesApplied empty (US-002 AC8)", () => {
  test("omits fixTargetFiles key entirely when fixesApplied is empty", () => {
    const logger = makeLogger();
    recordIteration(
      cycle,
      {
        findingsBefore: [findingFixture()],
        findingsAfter: [findingFixture()],
        fixesApplied: [],
        outcome: "unchanged",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
      },
      { cycleName: "my-cycle", storyId: "story-1" },
      logger,
    );
    const call = recordCall(logger);
    assertDefined(call, "log entry");
    const data = call.data;
    assertDefined(data, "entry data");
    expect(Object.hasOwn(data, "fixTargetFiles")).toBe(false);
  });
});

describe("recordIteration — no fixSummaries when fixesApplied empty (US-002 AC9)", () => {
  test("omits fixSummaries key entirely when fixesApplied is empty", () => {
    const logger = makeLogger();
    recordIteration(
      cycle,
      {
        findingsBefore: [],
        findingsAfter: [],
        fixesApplied: [],
        outcome: "resolved",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
      },
      { cycleName: "my-cycle", storyId: "story-1" },
      logger,
    );
    const call = recordCall(logger);
    assertDefined(call, "log entry");
    const data = call.data;
    assertDefined(data, "entry data");
    expect(Object.hasOwn(data, "fixSummaries")).toBe(false);
  });
});

describe("recordIteration — null-position findings (US-002 AC10)", () => {
  test("logs findingKey as-is when file, line, and rule are all undefined", () => {
    const logger = makeLogger();
    const sparse = findingFixture({ file: undefined, line: undefined, rule: undefined });
    recordIteration(
      cycle,
      {
        findingsBefore: [sparse],
        findingsAfter: [],
        fixesApplied: [],
        outcome: "resolved",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
      },
      { cycleName: "my-cycle", storyId: "story-1" },
      logger,
    );
    const call = recordCall(logger);
    expect(call?.data?.findingKeysBefore).toEqual([findingKey(sparse)]);
  });
});

describe("recordIteration — costUsd omission (US-002 AC11)", () => {
  test("omits costUsd key when every fixesApplied entry has costUsd equal to zero", () => {
    const logger = makeLogger();
    recordIteration(
      cycle,
      {
        findingsBefore: [],
        findingsAfter: [],
        fixesApplied: [
          { strategyName: "lint-fix", op: "op-x", targetFiles: ["src/a.ts"], summary: "first", costUsd: 0 },
          { strategyName: "typecheck-fix", op: "op-y", targetFiles: ["src/b.ts"], summary: "second", costUsd: 0 },
        ],
        outcome: "partial",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:00:01.000Z",
      },
      { cycleName: "my-cycle", storyId: "story-1" },
      logger,
    );
    const call = recordCall(logger);
    assertDefined(call, "log entry");
    const data = call.data;
    assertDefined(data, "entry data");
    expect(Object.hasOwn(data, "costUsd")).toBe(false);
  });
});
