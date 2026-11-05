/**
 * US-003: the one guarded unattended `runSubagent` call, the status a `turn_end` maps to and the
 * cost the run reports.
 *
 * Every test enters through `runAgentTask` with `_agentsRunExecDeps.runSubagent` stubbed, so what
 * is asserted is the call the command makes and the result it derives — no session is opened and
 * no agent runs.
 */
import { describe, expect, test } from "bun:test";
import type { SessionEvent, ToolProvider } from "@nathapp/nax-agent";
import { assertDefined, makeNaxConfig, withDepsRestore } from "@test/helpers";
import {
  _agentsRunExecDeps,
  AGENTS_RUN_PARENT_SESSION_ID,
  type AgentsRunTaskInput,
  runAgentTask,
} from "@/cli/agents-run-exec";
import { NaxError } from "@/errors";
import type { AgentResource } from "@/resources";

type RunSubagentInput = Parameters<typeof _agentsRunExecDeps.runSubagent>[0];
type RunSubagentResult = Awaited<ReturnType<typeof _agentsRunExecDeps.runSubagent>>;
type TurnEnd = Extract<SessionEvent, { type: "turn_end" }>;

const AT = "2026-10-01T00:00:00.000Z";
const EVENT_BASE = { sessionId: "nested-1", turnId: "turn-1", at: AT, metadata: {} };
const MODEL = "anthropic/claude-sonnet";

const agent: AgentResource = {
  kind: "agent",
  name: "spec-reviewer",
  qualifiedName: "spec-reviewer",
  description: "Reviews specs",
  prompt: "Review the spec you are given.",
  path: "/repo/.claude/agents/spec-reviewer.md",
  origin: { kind: "claude-project" },
};

function provider(id: string): ToolProvider {
  return { id, kind: "static", stages: ["*"], tools: async () => [] };
}

/** A turn_end carrying the fields every status test does not care about. */
function turnEnd(overrides: Partial<TurnEnd> & Pick<TurnEnd, "status">): TurnEnd {
  return {
    ...EVENT_BASE,
    type: "turn_end",
    output: "",
    usage: { inputTokens: 10, outputTokens: 5 },
    costUsd: 0,
    ...overrides,
  };
}

function input(overrides: Partial<AgentsRunTaskInput> = {}): AgentsRunTaskInput {
  return {
    agent,
    task: "review the spec",
    model: MODEL,
    allowedTools: ["Read", "Grep"],
    toolProviders: [provider("nax-workflow")],
    loopHandlers: [],
    cwd: "/repo/packages/nax",
    repoRoot: "/repo",
    config: makeNaxConfig(),
    ...overrides,
  };
}

interface ScriptedRun {
  /** The input every stubbed call received, in order. */
  readonly calls: RunSubagentInput[];
}

/**
 * Install a stub that emits `events` in order and then resolves `result` — or rejects with
 * `reject`, which is how a run whose nested session never opened comes back.
 */
function stubRun(
  options: { events?: readonly SessionEvent[]; result?: RunSubagentResult; reject?: unknown } = {},
): ScriptedRun {
  const calls: RunSubagentInput[] = [];
  const stub = async (request: RunSubagentInput): Promise<RunSubagentResult> => {
    calls.push(request);
    for (const event of options.events ?? []) request.onEvent(event);
    if (options.reject !== undefined) throw options.reject;
    return options.result ?? { content: "" };
  };
  _agentsRunExecDeps.runSubagent = stub;
  return { calls };
}

/** The call input without its hooks, which the AC compares separately. */
function withoutHooks(call: RunSubagentInput): Record<string, unknown> {
  const leftover: Record<string, unknown> = { ...call };
  delete leftover.onEvent;
  delete leftover.onSession;
  delete leftover.signal;
  return leftover;
}

/** Resolve to whatever the promise threw; a resolution fails the test. */
async function rejectionOf(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("runAgentTask", () => {
  withDepsRestore(_agentsRunExecDeps);

  describe("the call", () => {
    test("AC-1: calls runSubagent exactly once", async () => {
      const script = stubRun({ events: [turnEnd({ status: "completed" })], result: { content: "done" } });
      await runAgentTask(input());
      expect(script.calls.length).toBe(1);
    });

    test("AC-2: passes the task, the resolved model and the unattended guarded run", async () => {
      const request = input();
      const script = stubRun();
      await runAgentTask(request);
      const call = script.calls[0];
      assertDefined(call, "runSubagent input");
      // The hooks travel with the run; the AC compares everything else on its own.
      expect(typeof call.onEvent).toBe("function");
      expect(typeof call.onSession).toBe("function");
      expect(withoutHooks(call)).toEqual({
        agent: request.agent,
        task: request.task,
        model: request.model,
        allowedTools: request.allowedTools,
        toolProviders: request.toolProviders,
        loopHandlers: request.loopHandlers,
        cwd: request.cwd,
        repoRoot: request.repoRoot,
        config: request.config,
        mode: "guarded",
        unattended: true,
        parentSessionId: "nax-agents-run",
      });
    });

    test("AC-3: AGENTS_RUN_PARENT_SESSION_ID is the run's own session id", () => {
      expect(AGENTS_RUN_PARENT_SESSION_ID).toBe("nax-agents-run");
    });

    test("carries the run's signal into the nested session", async () => {
      const controller = new AbortController();
      const script = stubRun();
      await runAgentTask(input({ signal: controller.signal }));
      expect(script.calls[0]?.signal).toBe(controller.signal);
    });
  });

  describe("status from a turn_end", () => {
    test("AC-4: a completed priced turn resolves the whole result", async () => {
      const script = stubRun({
        events: [turnEnd({ status: "completed", costUsd: 0.42, costSource: "computed" })],
        result: { content: "done" },
      });
      expect(await runAgentTask(input())).toEqual({
        agent: agent.qualifiedName,
        model: MODEL,
        status: "completed",
        output: "done",
        deniedAsks: [],
        costUsd: 0.42,
      });
      expect(script.calls.length).toBe(1);
    });

    test("AC-5: a cancelled turn resolves status cancelled", async () => {
      const script = stubRun({ events: [turnEnd({ status: "cancelled" })], result: { content: "stopped" } });
      expect((await runAgentTask(input())).status).toBe("cancelled");
      expect(script.calls.length).toBe(1);
    });

    test("AC-6: a timed_out turn resolves status timeout", async () => {
      const script = stubRun({ events: [turnEnd({ status: "timed_out" })], result: { content: "too slow" } });
      expect((await runAgentTask(input())).status).toBe("timeout");
      expect(script.calls.length).toBe(1);
    });

    test("AC-7: an errored turn resolves status failed", async () => {
      const script = stubRun({ events: [turnEnd({ status: "errored" })], result: { content: "boom" } });
      expect((await runAgentTask(input())).status).toBe("failed");
      expect(script.calls.length).toBe(1);
    });

    test("AC-8: an interrupted turn resolves status failed", async () => {
      const script = stubRun({ events: [turnEnd({ status: "interrupted" })], result: { content: "cut off" } });
      expect((await runAgentTask(input())).status).toBe("failed");
      expect(script.calls.length).toBe(1);
    });
  });

  describe("output", () => {
    test("AC-9: an errored turn reports the text runSubagent returned", async () => {
      const script = stubRun({
        events: [turnEnd({ status: "errored", error: { code: "TURN_FAILED", message: "boom" }, output: "" })],
        result: { isError: true, content: "subagent a errored: boom" },
      });
      const result = await runAgentTask(input());
      expect(result.output).toBe("subagent a errored: boom");
      expect(script.calls.length).toBe(1);
    });

    test("AC-10: a run that never reached a turn is failed, with the error text and no cost", async () => {
      const content = "[chat] subagent a could not start read-only: x";
      const script = stubRun({ result: { isError: true, content } });
      const result = await runAgentTask(input());
      expect(result.status).toBe("failed");
      expect(result.output).toBe(content);
      expect(Object.keys(result)).not.toContain("costUsd");
      expect(script.calls.length).toBe(1);
    });

    test("a completed turn with no text keeps the placeholder and stays completed", async () => {
      stubRun({
        events: [turnEnd({ status: "completed" })],
        result: { content: "(the subagent returned no text)" },
      });
      const result = await runAgentTask(input());
      expect(result.status).toBe("completed");
      expect(result.output).toBe("(the subagent returned no text)");
    });
  });

  describe("cost", () => {
    test("AC-11: an unpriced turn reports no costUsd at all", async () => {
      const script = stubRun({
        events: [turnEnd({ status: "completed", costUsd: 0, costSource: "unpriced" })],
        result: { content: "done" },
      });
      const result = await runAgentTask(input());
      expect(Object.keys(result)).not.toContain("costUsd");
      expect(script.calls.length).toBe(1);
    });

    test("AC-12: a reported cost is the turn's own", async () => {
      const script = stubRun({
        events: [turnEnd({ status: "completed", costUsd: 1.5, costSource: "reported" })],
        result: { content: "done" },
      });
      expect((await runAgentTask(input())).costUsd).toBe(1.5);
      expect(script.calls.length).toBe(1);
    });

    test("AC-13: a turn_end with no costSource is a computed cost", async () => {
      const script = stubRun({
        events: [turnEnd({ status: "completed", costUsd: 0.2 })],
        result: { content: "done" },
      });
      expect((await runAgentTask(input())).costUsd).toBe(0.2);
      expect(script.calls.length).toBe(1);
    });
  });

  describe("failure", () => {
    test("AC-14: a rejected runSubagent propagates the same error", async () => {
      const boom = new NaxError("the nested session could not open", "AGENTS_RUN_SESSION_FAILED", { stage: "test" });
      stubRun({ reject: boom });
      expect(await rejectionOf(runAgentTask(input()))).toBe(boom);
    });
  });
});
