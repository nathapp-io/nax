/** The agent run the registry keeps per task: prompt, model, state and the recorded session events. */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeLogger, textDeltaEvent, toolCallEvent } from "@test/helpers";
import type { BackgroundAgentEnd, BackgroundAgentHandle } from "@/chat/background";
import { _backgroundTaskDeps, createBackgroundTasks } from "@/chat/background";

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
