/**
 * ctrl+b on a running foreground agent run: the call returns at once with the task it was
 * adopted as, the run keeps going under the registry, its later activity goes to the task and
 * its spend stays correct. The registry is the real one; the nested run is scripted.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { SessionEvent } from "@nathapp/nax-agent";
import {
  makeAgentCatalog,
  makeAgentResource,
  makeLogger,
  makeNaxConfig,
  makeScriptedSession,
  textDeltaEvent,
  toolCallEvent,
  toolResultEvent,
  turnEndEvent,
  waitForCondition,
  withDepsRestore,
} from "@test/helpers";
import { createChatAskController } from "@/chat/ask-controller";
import { _backgroundTaskDeps, type ChatBackgroundTasks, createBackgroundTasks } from "@/chat/background";
import { _subagentRunsDeps, createSubagentRuns, type SubagentRuns } from "@/chat/subagent-runs";
import type { RunSubagentInput, RunSubagentResult } from "@/chat/subagent-session";

const reviewer = makeAgentResource({ name: "reviewer" });
const original = { ..._backgroundTaskDeps };
let logs: Map<string, string>;

beforeEach(() => {
  logs = new Map();
  Object.assign(_backgroundTaskDeps, {
    randomHex: () => "0123abcd",
    mkdir: () => {},
    appendLog: async (path: string, chunk: Uint8Array) => {
      logs.set(path, (logs.get(path) ?? "") + new TextDecoder().decode(chunk));
    },
    readLog: async (path: string) => logs.get(path) ?? "",
  });
});
afterEach(() => {
  Object.assign(_backgroundTaskDeps, original);
});

/** A nested run that emits `before`, parks until released, then ends with `result`. */
function scriptedRun(before: readonly SessionEvent[] = []) {
  const gate = Promise.withResolvers<RunSubagentResult>();
  const started = Promise.withResolvers<RunSubagentInput>();
  _subagentRunsDeps.runSubagent = mock(async (input: RunSubagentInput) => {
    for (const event of before) input.onEvent(event);
    started.resolve(input);
    return gate.promise;
  });
  return { input: started.promise, finish: (result: RunSubagentResult) => gate.resolve(result) };
}

function setup(options: { registry?: boolean } = {}) {
  const tasks = createBackgroundTasks({ outputDir: "/o", now: () => new Date(0), logger: makeLogger() });
  const listener = mock((_event: SessionEvent) => {});
  const runs: SubagentRuns = createSubagentRuns({
    current: () => ({ sessionId: "chat-1", mode: "guarded", model: "anthropic/chat" }),
    catalog: makeAgentCatalog([reviewer]),
    config: makeNaxConfig(),
    cwd: "/repo",
    repoRoot: "/repo",
    toolProviders: [],
    loopHandlers: [],
    asks: createChatAskController({ mode: "guarded", answer: () => {} }),
    ledger: () => undefined,
    turnListener: () => listener,
    ...(options.registry === false ? {} : { backgroundTasks: (): ChatBackgroundTasks => tasks }),
  });
  return { tasks, runs, listener };
}

describe("SubagentRuns.run with ctrl+b", () => {
  withDepsRestore(_subagentRunsDeps);

  test("a foreground run makes the registry report a foreground call until it ends", async () => {
    const { tasks, runs } = setup();
    const run = scriptedRun();
    const pending = runs.run(reviewer, "check it");
    await run.input;
    expect(tasks.hasForeground()).toBe(true);
    run.finish({ content: "answer" });
    expect(await pending).toEqual({ content: "answer" });
    expect(tasks.hasForeground()).toBe(false);
  });

  test("moveForeground returns the tool call at once with a task id while the run goes on", async () => {
    const { tasks, runs } = setup();
    const run = scriptedRun();
    const pending = runs.run(reviewer, "check it");
    await run.input;
    expect(tasks.moveForeground()).toBe(true);
    expect(await pending).toEqual({ isError: false, content: "moved to the background as agent-0123abcd" });
    const [task] = tasks.running();
    expect(task).toMatchObject({ id: "agent-0123abcd", kind: "agent", state: "running" });
    expect(tasks.hasForeground()).toBe(false);
    run.finish({ content: "late answer" });
  });

  test("the moved task ends with the run's outcome and queues a notice", async () => {
    const { tasks, runs } = setup();
    const run = scriptedRun();
    const pending = runs.run(reviewer, "check it");
    await run.input;
    tasks.moveForeground();
    await pending;
    run.finish({ content: "late answer" });
    await waitForCondition(() => tasks.get("agent-0123abcd")?.state === "succeeded");
    expect(tasks.peekNotice()).toContain("agent-0123abcd");
    expect(await tasks.output("agent-0123abcd")).toContain("late answer");
  });

  test("a failed run after the move ends the task failed", async () => {
    const { tasks, runs } = setup();
    const run = scriptedRun();
    const pending = runs.run(reviewer, "check it");
    await run.input;
    tasks.moveForeground();
    await pending;
    run.finish({ isError: true, content: "boom" });
    await waitForCondition(() => tasks.get("agent-0123abcd")?.state === "failed");
  });

  test("tool activity before the move reaches the turn; activity after it goes to the task only", async () => {
    const { tasks, runs, listener } = setup();
    const run = scriptedRun([toolCallEvent("c1")]);
    const pending = runs.run(reviewer, "check it");
    const input = await run.input;
    expect(listener).toHaveBeenCalledTimes(1);
    tasks.moveForeground();
    await pending;
    input.onEvent(toolResultEvent("c1"));
    input.onEvent(toolCallEvent("c2"));
    expect(listener).toHaveBeenCalledTimes(1);
    const events = tasks.agentRun("agent-0123abcd")?.events ?? [];
    expect(events.map((event) => event.type)).toEqual(["tool_call", "tool_result", "tool_call"]);
    expect(await tasks.output("agent-0123abcd")).toContain("[tool] Read");
    run.finish({ content: "ok" });
  });

  test("the view's events start at the run's first event, including text the turn never saw", async () => {
    const { tasks, runs } = setup();
    const run = scriptedRun([textDeltaEvent("thinking out loud")]);
    const pending = runs.run(reviewer, "check it");
    await run.input;
    tasks.moveForeground();
    await pending;
    expect(tasks.agentRun("agent-0123abcd")?.events[0]).toMatchObject({
      type: "text_delta",
      text: "thinking out loud",
    });
    run.finish({ content: "ok" });
  });

  test("the task carries the full prompt and the resolved model", async () => {
    const { tasks, runs } = setup();
    const run = scriptedRun();
    const pending = runs.run(reviewer, "line one\nline two");
    await run.input;
    tasks.moveForeground();
    await pending;
    expect(tasks.agentRun("agent-0123abcd")).toMatchObject({
      agent: reviewer.qualifiedName,
      prompt: "line one\nline two",
      model: "anthropic/chat",
    });
    run.finish({ content: "ok" });
  });

  test("the parent turn's abort and settle() no longer reach a moved run", async () => {
    const { tasks, runs } = setup();
    const run = scriptedRun();
    const controller = new AbortController();
    const pending = runs.run(reviewer, "check it", controller.signal);
    const input = await run.input;
    tasks.moveForeground();
    await pending;
    controller.abort();
    await runs.settle();
    expect(input.signal?.aborted).toBe(false);
    run.finish({ content: "ok" });
  });

  test("the parent turn's abort before the move still cancels the run", async () => {
    const { runs } = setup();
    const run = scriptedRun();
    const controller = new AbortController();
    const pending = runs.run(reviewer, "check it", controller.signal);
    const input = await run.input;
    controller.abort();
    expect(input.signal?.aborted).toBe(true);
    run.finish({ isError: true, content: "cancelled" });
    await pending;
  });

  test("a run the parent turn already cancelled is not moved, and no task is adopted", async () => {
    const { tasks, runs } = setup();
    const run = scriptedRun();
    const controller = new AbortController();
    const pending = runs.run(reviewer, "check it", controller.signal);
    await run.input;
    controller.abort();
    tasks.moveForeground();
    run.finish({ isError: true, content: "subagent reviewer cancelled: cancelled" });
    expect(await pending).toEqual({ isError: true, content: "subagent reviewer cancelled: cancelled" });
    expect(tasks.list()).toEqual([]);
  });

  test("a run cancelled through cancelAll on its open session is not moved either", async () => {
    const { tasks, runs } = setup();
    const run = scriptedRun();
    const pending = runs.run(reviewer, "check it");
    const input = await run.input;
    input.onSession?.(makeScriptedSession("nested-1", async function* () {}));
    runs.cancelAll();
    tasks.moveForeground();
    run.finish({ isError: true, content: "cancelled" });
    expect((await pending).content).toBe("cancelled");
    expect(tasks.list()).toEqual([]);
  });

  test("stopping the moved task aborts the run", async () => {
    const { tasks, runs } = setup();
    const run = scriptedRun();
    const pending = runs.run(reviewer, "check it");
    const input = await run.input;
    tasks.moveForeground();
    await pending;
    tasks.stop("agent-0123abcd");
    expect(input.signal?.aborted).toBe(true);
    run.finish({ isError: true, content: "cancelled" });
  });

  test("a run that already ended offers nothing to move", async () => {
    const { tasks, runs } = setup();
    const run = scriptedRun();
    const pending = runs.run(reviewer, "check it");
    await run.input;
    run.finish({ content: "answer" });
    await pending;
    expect(tasks.moveForeground()).toBe(false);
  });

  test("with no registry the run is a plain foreground run", async () => {
    const { runs } = setup({ registry: false });
    const run = scriptedRun();
    const pending = runs.run(reviewer, "check it");
    await run.input;
    run.finish({ content: "answer" });
    expect(await pending).toEqual({ content: "answer" });
    expect(runs.backgroundAvailable()).toBe(false);
  });
});

describe("SubagentRuns spend of a moved run", () => {
  withDepsRestore(_subagentRunsDeps);

  test("spend before the move is the turn's; spend after it waits one turn like a background run", async () => {
    const { tasks, runs } = setup();
    const run = scriptedRun();
    const pending = runs.run(reviewer, "check it");
    const input = await run.input;
    input.onEvent(turnEndEvent("partial", 0.25));
    tasks.moveForeground();
    await pending;
    input.onEvent(turnEndEvent("rest", 0.5));
    // This turn carries only what the foreground part spent.
    expect(runs.costForTurn()).toBeCloseTo(0.25);
    runs.commitCost();
    expect(runs.costForTurn()).toBe(0);
    runs.commitCost();
    runs.beginTurn();
    expect(runs.costForTurn()).toBeCloseTo(0.5);
    runs.commitCost();
    expect(runs.costForTurn()).toBe(0);
    run.finish({ content: "ok" });
  });

  test("an unmoved foreground run's spend stays the turn's", async () => {
    const { runs } = setup();
    const run = scriptedRun();
    const pending = runs.run(reviewer, "check it");
    const input = await run.input;
    input.onEvent(turnEndEvent("done", 0.4));
    run.finish({ content: "done" });
    await pending;
    expect(runs.takeCost()).toBeCloseTo(0.4);
  });
});
