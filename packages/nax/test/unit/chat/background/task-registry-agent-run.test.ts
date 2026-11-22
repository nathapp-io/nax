/** The agent run the registry keeps per task: prompt, model, state and the recorded session events. */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeLogger, textDeltaEvent, toolCallEvent } from "@test/helpers";
import type { BackgroundAgentEnd, BackgroundAgentHandle } from "@/chat/background";
import {
  _backgroundTaskDeps,
  createBackgroundTasks,
  TASK_EVENTS_TOTAL_MAX_BYTES,
  TASK_EVENTS_TOTAL_MAX_ENTRIES,
} from "@/chat/background";

const original = { ..._backgroundTaskDeps };
let logs: Map<string, string>;
beforeEach(() => {
  logs = new Map();
  Object.assign(_backgroundTaskDeps, {
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

function adoptAgent(tasks: ReturnType<typeof createBackgroundTasks>, name: string) {
  const end = Promise.withResolvers<BackgroundAgentEnd>();
  const sink = tasks.adoptAgent({
    agent: name,
    task: `task ${name}`,
    ended: end.promise,
    stop: () => end.resolve({ outcome: "stopped", text: "" }),
  });
  const finish = async () => {
    end.resolve({ outcome: "succeeded", text: "" });
    await end.promise;
    await Promise.resolve();
  };
  return {
    sink,
    finish,
    settled: async () => {
      await end.promise;
      await Promise.resolve();
    },
  };
}

function setup() {
  const tasks = createBackgroundTasks({ outputDir: "/o", now: () => new Date(0), logger: makeLogger() });
  const end = Promise.withResolvers<BackgroundAgentEnd>();
  const handle: BackgroundAgentHandle = {
    agent: "reviewer",
    task: "Review the spec\nin full",
    model: "openai-codex/gpt-6-luna",
    ended: end.promise,
    stop: mock(() => {}),
  };
  const sink = tasks.adoptAgent(handle);
  return { tasks, sink, end };
}

describe("ChatBackgroundTasks.agentRun", () => {
  test("names the agent, the model, the whole prompt and the running state", () => {
    const { tasks, sink } = setup();
    expect(tasks.agentRun(sink.id)).toEqual({
      id: sink.id,
      agent: "reviewer",
      model: "openai-codex/gpt-6-luna",
      prompt: "Review the spec\nin full",
      state: "running",
      logRetained: true,
      events: [],
    });
  });

  test("keeps recorded events in order and still serves them after the run ended", async () => {
    const { tasks, sink, end } = setup();
    sink.record(toolCallEvent("c1"));
    sink.record(textDeltaEvent("done"));
    end.resolve({ outcome: "succeeded", text: "done" });
    await end.promise;
    await Promise.resolve();
    const run = tasks.agentRun(sink.id);
    expect(run?.state).toBe("succeeded");
    expect(run?.events.map((event) => event.type)).toEqual(["tool_call", "text_delta"]);
  });

  test("drops events recorded after the task stopped", () => {
    const { tasks, sink } = setup();
    tasks.stop(sink.id);
    sink.record(toolCallEvent("late"));
    expect(tasks.agentRun(sink.id)?.events).toEqual([]);
    expect(tasks.agentRun(sink.id)?.state).toBe("stopped");
  });

  test("is undefined for an unknown id and for a shell task", () => {
    const { tasks } = setup();
    expect(tasks.agentRun("agent-ffffffff")).toBeUndefined();
    const shell = tasks.adopt({
      command: "ls",
      origin: "agent",
      ended: new Promise(() => {}),
      stop: () => {},
    });
    expect(tasks.agentRun(shell.id)).toBeUndefined();
  });

  test("the task record does not carry the prompt or the events", () => {
    const { tasks, sink } = setup();
    sink.record(toolCallEvent("c1"));
    const record = tasks.get(sink.id);
    expect(record).toBeDefined();
    expect(Object.keys(record ?? {})).not.toContain("prompt");
    expect(Object.keys(record ?? {})).not.toContain("events");
  });

  test("onAgentEvents tells the task id per recorded event and stops after unsubscribe", () => {
    const { tasks, sink } = setup();
    const seen: string[] = [];
    const off = tasks.onAgentEvents((id) => seen.push(id));
    sink.record(toolCallEvent("c1"));
    off();
    sink.record(toolCallEvent("c2"));
    expect(seen).toEqual([sink.id]);
  });

  test("a throwing listener does not stop recording", () => {
    const { tasks, sink } = setup();
    tasks.onAgentEvents(() => {
      throw new Error("boom");
    });
    sink.record(toolCallEvent("c1"));
    expect(tasks.agentRun(sink.id)?.events).toHaveLength(1);
  });

  test("keeps the existing log line behaviour beside the recorded events", async () => {
    const { tasks, sink } = setup();
    sink.appendLine("[tool] Read");
    sink.record(toolCallEvent("c1"));
    expect(await tasks.output(sink.id)).toBe("[nax] agent reviewer: Review the spec\n[tool] Read");
  });
});

describe("the total event retention across tasks", () => {
  const limits = { ..._backgroundTaskDeps.eventLimits };
  beforeEach(() => {
    _backgroundTaskDeps.eventLimits = { entries: 6, bytes: Number.MAX_SAFE_INTEGER };
  });
  afterEach(() => {
    _backgroundTaskDeps.eventLimits = limits;
  });

  test("names the two limits", () => {
    expect(TASK_EVENTS_TOTAL_MAX_ENTRIES).toBeGreaterThan(0);
    expect(TASK_EVENTS_TOTAL_MAX_BYTES).toBeGreaterThan(0);
  });

  const retained = (tasks: ReturnType<typeof createBackgroundTasks>, id: string) => tasks.agentRun(id)?.logRetained;
  const newTasks = () => {
    let tick = 0;
    // A clock that moves on every read, so timestamps can never tie.
    return createBackgroundTasks({ outputDir: "/o", now: () => new Date(tick++ * 1000), logger: makeLogger() });
  };

  test("drops the log of the task that finished FIRST, whatever order the tasks started in", async () => {
    const tasks = newTasks();
    const a = adoptAgent(tasks, "a");
    const b = adoptAgent(tasks, "b");
    for (let at = 0; at < 3; at += 1) a.sink.record(toolCallEvent(`a${at}`));
    for (let at = 0; at < 3; at += 1) b.sink.record(toolCallEvent(`b${at}`));
    await b.finish();
    await a.finish();
    const c = adoptAgent(tasks, "c");
    c.sink.record(toolCallEvent("c0"));
    expect(retained(tasks, b.sink.id)).toBe(false);
    expect(tasks.agentRun(b.sink.id)).toMatchObject({ state: "succeeded", events: [] });
    expect(retained(tasks, a.sink.id)).toBe(true);
    expect(tasks.agentRun(a.sink.id)?.events).toHaveLength(3);
    expect(tasks.get(b.sink.id)?.state).toBe("succeeded");
  });

  test("a just-stopped task queues behind older finished ones instead of sorting first", async () => {
    const tasks = newTasks();
    const old = adoptAgent(tasks, "old");
    const stopped = adoptAgent(tasks, "stopped");
    for (let at = 0; at < 3; at += 1) old.sink.record(toolCallEvent(`o${at}`));
    for (let at = 0; at < 3; at += 1) stopped.sink.record(toolCallEvent(`s${at}`));
    await old.finish();
    tasks.stop(stopped.sink.id);
    await stopped.settled();
    const next = adoptAgent(tasks, "next");
    next.sink.record(toolCallEvent("n0"));
    expect(retained(tasks, old.sink.id)).toBe(false);
    expect(retained(tasks, stopped.sink.id)).toBe(true);
    expect(tasks.get(stopped.sink.id)?.state).toBe("stopped");
  });

  test("the running totals stay exact across merges, evictions and finishes", async () => {
    const tasks = newTasks();
    const a = adoptAgent(tasks, "a");
    for (let at = 0; at < 3; at += 1) a.sink.record(toolCallEvent(`a${at}`));
    await a.finish();
    const b = adoptAgent(tasks, "b");
    for (let at = 0; at < 3; at += 1) b.sink.record(toolCallEvent(`b${at}`));
    // Exactly at the limit (6): nothing is evicted, and a text run that merges adds no entry.
    expect(retained(tasks, a.sink.id)).toBe(true);
    b.sink.record(textDeltaEvent("x"));
    b.sink.record(textDeltaEvent("y"));
    expect(retained(tasks, a.sink.id)).toBe(false);
    // 3 (b) + 1 merged text = 4 left after a's 3 went: two more fit, the third does not.
    const c = adoptAgent(tasks, "c");
    c.sink.record(toolCallEvent("c0"));
    c.sink.record(toolCallEvent("c1"));
    await b.finish();
    expect(retained(tasks, b.sink.id)).toBe(true);
    c.sink.record(toolCallEvent("c2"));
    expect(retained(tasks, b.sink.id)).toBe(false);
    expect(tasks.agentRun(c.sink.id)?.events).toHaveLength(3);
  });

  test("tells the event listeners which task's log was evicted", async () => {
    const tasks = newTasks();
    const a = adoptAgent(tasks, "a");
    for (let at = 0; at < 4; at += 1) a.sink.record(toolCallEvent(`a${at}`));
    await a.finish();
    const seen: string[] = [];
    tasks.onAgentEvents((id) => seen.push(id));
    const b = adoptAgent(tasks, "b");
    for (let at = 0; at < 3; at += 1) b.sink.record(toolCallEvent(`b${at}`));
    expect(seen).toContain(a.sink.id);
  });

  test("never evicts a running task, however far over the limit", () => {
    const tasks = createBackgroundTasks({ outputDir: "/o", now: () => new Date(0), logger: makeLogger() });
    const a = adoptAgent(tasks, "a");
    const b = adoptAgent(tasks, "b");
    for (let at = 0; at < 5; at += 1) {
      a.sink.record(toolCallEvent(`a${at}`));
      b.sink.record(toolCallEvent(`b${at}`));
    }
    expect(tasks.agentRun(a.sink.id)).toMatchObject({ logRetained: true });
    expect(tasks.agentRun(a.sink.id)?.events).toHaveLength(5);
    expect(tasks.agentRun(b.sink.id)?.events).toHaveLength(5);
  });

  test("a task that finishes under pressure becomes evictable at once", async () => {
    const tasks = createBackgroundTasks({ outputDir: "/o", now: () => new Date(0), logger: makeLogger() });
    const a = adoptAgent(tasks, "a");
    const b = adoptAgent(tasks, "b");
    for (let at = 0; at < 4; at += 1) a.sink.record(toolCallEvent(`a${at}`));
    for (let at = 0; at < 4; at += 1) b.sink.record(toolCallEvent(`b${at}`));
    await a.finish();
    expect(tasks.agentRun(a.sink.id)).toMatchObject({ logRetained: false });
    expect(tasks.agentRun(b.sink.id)).toMatchObject({ logRetained: true });
  });
});
