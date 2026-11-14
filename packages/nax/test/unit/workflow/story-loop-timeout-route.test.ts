import { describe, expect, mock, test } from "bun:test";
import { makeStoryLoopAdvisor, makeStoryLoopHarness, storyLoopFixtures } from "@test/helpers";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import type { ImplementerQuestionRequest } from "@/workflow/advisor";
import { runStoryLoop } from "@/workflow/story-loop";
import type { GateRunResult } from "@/workflow/types";

const scoped: GateRunResult = {
  red: true,
  states: { scoped: "red" },
  timedOut: ["scoped"],
  findings: [{ kind: "gate", gate: "scoped", severity: "important", issue: "timeout" }],
};
const suite: GateRunResult = { ...storyLoopFixtures.SUITE_RED, timedOut: ["full-suite"] };
const facts = { protectedPaths: [], commands: {}, candidates: [] };

describe("runStoryLoop timeout route", () => {
  test("repeated scoped timeout asks once after one fix with timing", async () => {
    const answer = mock(async (_q: ImplementerQuestionRequest) => null);
    const timeoutFacts = mock(async () => ({ baselineTimedOut: false, limitSeconds: 600 }));
    const h = makeStoryLoopHarness(
      { gates: [scoped, scoped] },
      { advisor: makeStoryLoopAdvisor({ answerQuestion: answer }), steps: { timeoutFacts } },
    );
    await runStoryLoop(h.env);
    expect(h.turns.filter((t) => t.kind === "fix")).toHaveLength(1);
    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer.mock.calls[0]?.[0]).toMatchObject({
      status: "GATE_TIMEOUT",
      timing: { gates: ["scoped"], baselineTimedOut: false, repeated: true, limitSeconds: 600 },
    });
  });
  test.each([null, "raise the limit"])("baseline timeout asks without a fix or answer turn: %s", async (response) => {
    const answer = mock(async (_q: ImplementerQuestionRequest) => response);
    const timeoutFacts = mock(async () => ({ baselineTimedOut: true, limitSeconds: 600 }));
    const configFacts = mock(async (_g: readonly import("@/workflow/types").GateName[]) => facts);
    const h = makeStoryLoopHarness(
      { gates: [scoped] },
      { advisor: makeStoryLoopAdvisor({ answerQuestion: answer }), steps: { timeoutFacts, configFacts } },
    );
    expect((await runStoryLoop(h.env)).state).toBe("complete-gate-open");
    expect(h.turns.filter((t) => t.kind === "fix" || t.kind === "answer")).toHaveLength(0);
    expect(timeoutFacts).toHaveBeenCalledTimes(1);
    expect(configFacts).toHaveBeenCalledWith(["scoped"]);
    expect(answer.mock.calls[0]?.[0]).toMatchObject({
      timing: { gates: ["scoped"], baselineTimedOut: true, repeated: false, limitSeconds: 600 },
      facts,
    });
    expect(h.ledger).toContain("gate timeout on scoped (baseline): no fix round, asked the advisor");
    if (response) expect(h.ledger).toContain("gate timeout advice: raise the limit");
  });
  test("an advisor exception closes gate-open without a fix", async () => {
    const h = makeStoryLoopHarness(
      { gates: [scoped] },
      {
        advisor: makeStoryLoopAdvisor({
          answerQuestion: async () => {
            throw new Error("advisor failed");
          },
        }),
        steps: { timeoutFacts: async () => ({ baselineTimedOut: true, limitSeconds: 600 }) },
      },
    );
    expect((await runStoryLoop(h.env)).state).toBe("complete-gate-open");
    expect(h.turns.filter((t) => t.kind === "fix")).toHaveLength(0);
  });
  test("no timeouts do not read timing facts", async () => {
    const timeoutFacts = mock(async () => ({ baselineTimedOut: false, limitSeconds: 600 }));
    await runStoryLoop(makeStoryLoopHarness({}, { steps: { timeoutFacts } }).env);
    expect(timeoutFacts).not.toHaveBeenCalled();
  });
  test.each(["throw", "unwired"])("missing timing facts (%s) still routes repeated timeout", async (mode) => {
    const answer = mock(async (_q: ImplementerQuestionRequest) => null);
    const timeoutFacts = mock(async () => {
      throw new Error("facts failed");
    });
    const h = makeStoryLoopHarness(
      { gates: [scoped, scoped] },
      { advisor: makeStoryLoopAdvisor({ answerQuestion: answer }), steps: mode === "throw" ? { timeoutFacts } : {} },
    );
    await runStoryLoop(h.env);
    expect(h.turns.filter((t) => t.kind === "fix")).toHaveLength(1);
    expect(answer.mock.calls[0]?.[0].timing).toEqual({ gates: ["scoped"], baselineTimedOut: false, repeated: true });
  });
  test("throwing timing facts warn and a fix precedes the advisor", async () => {
    resetLogger();
    initLogger({ level: "silent" });
    const logs: LogEntry[] = [];
    addSink((entry) => logs.push(entry));
    const order: string[] = [];
    const h = makeStoryLoopHarness(
      {
        gates: [scoped, scoped],
        implement: (turn) => {
          order.push(turn.kind);
          return storyLoopFixtures.OK;
        },
      },
      {
        advisor: makeStoryLoopAdvisor({
          answerQuestion: async () => {
            order.push("advisor");
            return null;
          },
        }),
        steps: {
          timeoutFacts: async () => {
            throw new Error("facts failed");
          },
        },
      },
    );
    try {
      await runStoryLoop(h.env);
    } finally {
      resetLogger();
    }
    expect(order).toEqual(["implement", "fix", "advisor"]);
    expect(
      logs.some((entry) => entry.level === "warn" && entry.message.includes("Timeout facts could not be read")),
    ).toBe(true);
  });
  test("full suite baseline does not read scoped config facts", async () => {
    const configFacts = mock(async (_g: readonly import("@/workflow/types").GateName[]) => facts);
    const h = makeStoryLoopHarness(
      { suite: [suite] },
      { steps: { configFacts, timeoutFacts: async () => ({ baselineTimedOut: true, limitSeconds: 600 }) } },
    );
    await runStoryLoop(h.env);
    expect(configFacts).not.toHaveBeenCalled();
    expect(h.turns.filter((t) => t.kind === "fix")).toHaveLength(0);
  });
  test("a stale suite timeout is not repeated after a red lint pass", async () => {
    const answer = mock(async (_q: ImplementerQuestionRequest) => null);
    const h = makeStoryLoopHarness(
      { gates: [storyLoopFixtures.GREEN, storyLoopFixtures.RED_LINT], suite: [suite] },
      {
        advisor: makeStoryLoopAdvisor({ answerQuestion: answer }),
        steps: { timeoutFacts: async () => ({ baselineTimedOut: false, limitSeconds: 600 }) },
      },
    );
    await runStoryLoop(h.env);
    expect(answer.mock.calls.filter(([q]) => q.status === "GATE_TIMEOUT")).toHaveLength(0);
    expect(h.turns.filter((t) => t.kind === "fix")).toHaveLength(2);
  });
  test("repeated timeout takes precedence over unchanged BLOCKED stop", async () => {
    const h = makeStoryLoopHarness(
      {
        gates: [scoped, scoped],
        implement: (turn) =>
          turn.kind === "fix"
            ? {
                ...storyLoopFixtures.OK,
                reply: { status: "BLOCKED", commits: [], testSummary: "", interrupted: false },
              }
            : storyLoopFixtures.OK,
      },
      { steps: { timeoutFacts: async () => ({ baselineTimedOut: false, limitSeconds: 600 }) } },
    );
    await runStoryLoop(h.env);
    expect(h.ledger.some((line) => line.startsWith("fix round r1 blocked"))).toBe(false);
    expect(h.ledger).toContain("gate timeout on scoped (repeated): no fix round, asked the advisor");
  });
});
