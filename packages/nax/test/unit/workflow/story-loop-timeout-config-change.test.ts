import { describe, expect, mock, test } from "bun:test";
import { makeStoryLoopAdvisor, makeStoryLoopHarness, storyLoopFixtures } from "@test/helpers";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import type { ConfigChangeAnswer } from "@/workflow/advisor";
import { runStoryLoop } from "@/workflow/story-loop";
import type { GateRunResult } from "@/workflow/types";

const timeout: GateRunResult = {
  red: true,
  states: { scoped: "red" },
  timedOut: ["scoped"],
  findings: [{ kind: "gate", gate: "scoped", severity: "important", issue: "timeout" }],
};
const change: ConfigChangeAnswer = {
  kind: "config-change",
  key: "testScoped",
  to: "test",
  script: "test",
  reason: "slow",
  decisionId: "D1",
  needsHumanConfirm: false,
};
const timeoutFacts = async () => ({ baselineTimedOut: true, limitSeconds: 600 });
const apply = async (c: ConfigChangeAnswer) => ({
  applied: true as const,
  key: c.key,
  to: c.to,
  from: undefined,
  commit: "abc",
});

describe("timeout config changes", () => {
  test("applied change reruns gates without an implementer and completes", async () => {
    const order: string[] = [];
    const gates = mock(async () => {
      order.push("gate");
      return order.filter((x) => x === "gate").length === 1 ? timeout : storyLoopFixtures.GREEN;
    });
    const h = makeStoryLoopHarness(
      {
        implement: (turn) => {
          order.push(turn.kind);
          return storyLoopFixtures.OK;
        },
      },
      {
        advisor: makeStoryLoopAdvisor({ answerQuestion: async () => change }),
        steps: { gates, timeoutFacts, applyConfigChange: apply },
      },
    );
    expect((await runStoryLoop(h.env)).state).toBe("complete");
    expect(order).toEqual(["implement", "gate", "gate"]);
    expect(gates).toHaveBeenCalledTimes(2);
  });
  test("a second timeout asks once and closes with timeout reason", async () => {
    const answer = mock(async () => change);
    const h = makeStoryLoopHarness(
      { gates: [timeout, timeout] },
      { advisor: makeStoryLoopAdvisor({ answerQuestion: answer }), steps: { timeoutFacts, applyConfigChange: apply } },
    );
    expect((await runStoryLoop(h.env)).reason).toBe("gate timeout: scoped");
    expect(answer).toHaveBeenCalledTimes(1);
  });
  test("refusal closes gate-open", async () => {
    const h = makeStoryLoopHarness(
      { gates: [timeout] },
      {
        advisor: makeStoryLoopAdvisor({ answerQuestion: async () => change }),
        steps: {
          timeoutFacts,
          applyConfigChange: async (c) => ({ applied: false, key: c.key, to: c.to, reason: "write-failed" }),
        },
      },
    );
    expect((await runStoryLoop(h.env)).state).toBe("complete-gate-open");
  });
  test("null answer records timeout and reason", async () => {
    const h = makeStoryLoopHarness({ gates: [timeout] }, { steps: { timeoutFacts } });
    expect((await runStoryLoop(h.env)).reason).toBe("gate timeout: scoped");
    expect(h.updates.some((u) => JSON.stringify(u.gateTimeouts) === '["scoped"]')).toBe(true);
  });
  test("stale suite timeout is not recorded after a red scoped pass", async () => {
    const oldSuite = { ...storyLoopFixtures.SUITE_RED, timedOut: ["full-suite" as const] };
    let calls = 0;
    const h = makeStoryLoopHarness(
      { gates: [storyLoopFixtures.GREEN, timeout], suite: [oldSuite] },
      { steps: { timeoutFacts: async () => ({ baselineTimedOut: ++calls === 2, limitSeconds: 600 }) } },
    );
    const outcome = await runStoryLoop(h.env);
    expect(outcome.reason).toBe("gate timeout: scoped");
    expect(h.record().gateTimeouts).toEqual(["scoped"]);
  });
  test("healthy story has no timeout key", async () => {
    const h = makeStoryLoopHarness();
    expect((await runStoryLoop(h.env)).state).toBe("complete");
    expect(h.updates.some((u) => "gateTimeouts" in u)).toBe(false);
  });
  test("write failure records refusal and closes gate-open", async () => {
    const h = makeStoryLoopHarness(
      { gates: [timeout] },
      {
        advisor: makeStoryLoopAdvisor({ answerQuestion: async () => change }),
        steps: {
          timeoutFacts,
          applyConfigChange: async () => {
            throw new Error("write failed");
          },
        },
      },
    );
    expect((await runStoryLoop(h.env)).state).toBe("complete-gate-open");
    expect(h.ledger.some((x) => x.includes("config change refused (write-failed)"))).toBe(true);
  });
  test("advisor rejection warns", async () => {
    resetLogger();
    initLogger({ level: "silent" });
    const logs: LogEntry[] = [];
    addSink((e) => logs.push(e));
    const h = makeStoryLoopHarness(
      { gates: [timeout] },
      {
        advisor: makeStoryLoopAdvisor({
          answerQuestion: async () => {
            throw new Error("failed");
          },
        }),
        steps: { timeoutFacts },
      },
    );
    try {
      await runStoryLoop(h.env);
    } finally {
      resetLogger();
    }
    expect(logs.some((e) => e.level === "warn" && e.message.includes("Gate timeout advisor failed"))).toBe(true);
  });
});
