/**
 * Tests for recordIteration — the helper that pairs the append
 * (`cycle.iterations.push(...)`) with the iteration-completed log emit.
 * ADR-022 cycle orchestration. see .nax/features/iteration-record-helper/spec.md.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { recordIteration } from "@/findings";
import type { FixCycle, Finding } from "@/findings";
import { makeLogger } from "@test/helpers";

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

    const call = logger.calls.find(
      (c) => c.stage === "findings.cycle" && c.message === "iteration completed",
    );
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

    const call = logger.calls.find(
      (c) => c.stage === "findings.cycle" && c.message === "iteration completed",
    );
    expect(call?.data).toBeDefined();
    expect(Object.keys(call!.data!)[0]).toBe("storyId");
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

    const call = logger.calls.find(
      (c) => c.stage === "findings.cycle" && c.message === "iteration completed",
    );
    expect(call?.data).toBeDefined();
    expect(Object.keys(call!.data!)[0]).toBe("storyId");
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
