import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { BackgroundCommandEnd, BackgroundCommandHandle } from "@nathapp/nax-agent";
import { makeLogger } from "@test/helpers";
import type { BackgroundAgentEnd, BackgroundAgentHandle } from "@/chat/background";
import { _backgroundTaskDeps, createBackgroundTasks } from "@/chat/background";

const AGENT_ID_PATTERN = /^agent-[0-9a-f]{8}$/;
const original = { ..._backgroundTaskDeps };
let sequence = 0;
let logs: Map<string, string>;
beforeEach(() => {
  sequence = 0;
  logs = new Map();
  Object.assign(_backgroundTaskDeps, {
    randomHex: () => (sequence++ === 0 ? "1a2b3c4d" : sequence.toString(16).padStart(8, "0")),
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

function agentHandle(agent = "code-reviewer", task = "Review the spec\nat a.md") {
  const end = Promise.withResolvers<BackgroundAgentEnd>();
  const stop = mock(() => {});
  const handle: BackgroundAgentHandle = { agent, task, ended: end.promise, stop };
  const finish = async (value: Partial<BackgroundAgentEnd> = {}) => {
    end.resolve({ outcome: "succeeded", text: "", ...value });
    await end.promise;
  };
  return { handle, stop, finish };
}

function commandHandle() {
  const end = Promise.withResolvers<BackgroundCommandEnd>();
  const stop = mock(() => {});
  const handle: BackgroundCommandHandle = { command: "bun test", origin: "agent", ended: end.promise, stop };
  const finish = async (value: Partial<BackgroundCommandEnd> = {}) => {
    end.resolve({ exitCode: 0, timedOut: false, aborted: false, ...value });
    await end.promise;
  };
  return { handle, stop, finish };
}

function fixture() {
  const tasks = createBackgroundTasks({ outputDir: "/o", now: () => new Date(0), logger: makeLogger() });
  return {
    tasks,
    adoptAgent(agent?: string, task?: string) {
      const call = agentHandle(agent, task);
      const sink = tasks.adoptAgent(call.handle);
      return { ...call, sink, id: sink.id };
    },
    adopt() {
      const call = commandHandle();
      return { ...call, id: tasks.adopt(call.handle).id };
    },
  };
}

describe("adopting a background agent task", () => {
  test("AC-1 allocates an agent-prefixed id matching the task id pattern", () => {
    expect(fixture().adoptAgent().id).toMatch(AGENT_ID_PATTERN);
  });

  test("AC-2 records an agent task with the agent name and the task's first line", () => {
    const f = fixture();
    const a = f.adoptAgent();
    expect(f.tasks.list()).toHaveLength(1);
    expect(f.tasks.get(a.id)).toMatchObject({
      kind: "agent",
      state: "running",
      origin: "agent",
      command: "code-reviewer: Review the spec",
    });
  });

  test("AC-3 truncates a long first line to 80 characters in the command", () => {
    const f = fixture();
    const line = "x".repeat(120);
    const a = f.adoptAgent("code-reviewer", `${line}\nsecond line`);
    expect(f.tasks.get(a.id)?.command).toBe(`code-reviewer: ${"x".repeat(80)}`);
  });

  test("writes the agent header line to the task log", async () => {
    const f = fixture();
    const a = f.adoptAgent();
    expect(await f.tasks.output(a.id)).toContain("[nax] agent code-reviewer: Review the spec");
  });
});

describe("background agent task endings", () => {
  test("AC-4 a succeeded agent task records the outcome, no exit code, and its text", async () => {
    const f = fixture();
    const a = f.adoptAgent();
    await a.finish({ outcome: "succeeded", text: "No findings." });
    const task = f.tasks.get(a.id);
    expect(task?.state).toBe("succeeded");
    expect(task?.exitCode).toBeUndefined();
    const output = await f.tasks.output(a.id);
    expect(output).toContain("No findings.");
    expect(output).toContain("[nax] agent ended: succeeded");
  });

  test("AC-5 a failed agent task notifies with the agent notice line", async () => {
    const f = fixture();
    const a = f.adoptAgent();
    await a.finish({ outcome: "failed", text: "boom" });
    expect(f.tasks.get(a.id)?.state).toBe("failed");
    const notice = f.tasks.peekNotice();
    expect(notice).toContain(
      `[nax-tasks] background agent ${a.id} (code-reviewer: Review the spec) ended: failed, log /o/chat-tasks/${a.id}.log`,
    );
    expect(await f.tasks.output(a.id)).toContain("boom");
    expect(await f.tasks.output(a.id)).toContain("[nax] agent ended: failed");
  });

  test("succeeded and failed agent tasks join the unnoticed set", async () => {
    const f = fixture();
    const ok = f.adoptAgent();
    const bad = f.adoptAgent("general", "find the bug");
    await ok.finish({ outcome: "succeeded", text: "fine" });
    await bad.finish({ outcome: "failed", text: "boom" });
    const notice = f.tasks.peekNotice();
    expect(notice).toContain(ok.id);
    expect(notice).toContain(bad.id);
  });
});

describe("stopping a background agent task", () => {
  test("AC-6 stop calls the handle once and marks the record stopped", () => {
    const f = fixture();
    const a = f.adoptAgent();
    expect(f.tasks.stop(a.id).state).toBe("stopped");
    expect(a.stop).toHaveBeenCalledTimes(1);
    expect(f.tasks.get(a.id)?.state).toBe("stopped");
  });

  test("AC-7 a stopped agent task stays stopped when it ends late and never notifies", async () => {
    const f = fixture();
    const a = f.adoptAgent();
    f.tasks.stop(a.id);
    await a.finish({ outcome: "succeeded", text: "late" });
    expect(f.tasks.get(a.id)?.state).toBe("stopped");
    expect(f.tasks.peekNotice()).toBeUndefined();
  });

  test("AC-8 stopAll stops the shell and the agent task and waits for both endings", async () => {
    const f = fixture();
    const shell = f.adopt();
    const agent = f.adoptAgent();
    const done = mock(() => {});
    const closing = f.tasks.stopAll().then(done);
    expect(shell.stop).toHaveBeenCalledTimes(1);
    expect(agent.stop).toHaveBeenCalledTimes(1);
    await shell.finish({ aborted: true });
    expect(done).not.toHaveBeenCalled();
    await agent.finish({ outcome: "stopped" });
    await closing;
    expect(done).toHaveBeenCalledTimes(1);
    expect(f.tasks.running()).toEqual([]);
  });
});

describe("the background agent sink", () => {
  test("AC-9 appendLine on a running task reaches the log", async () => {
    const f = fixture();
    const a = f.adoptAgent();
    a.sink.appendLine("[tool] Read");
    expect(await f.tasks.output(a.id)).toContain("[tool] Read");
  });

  test("AC-10 appendLine after the task ended adds nothing", async () => {
    const f = fixture();
    const a = f.adoptAgent();
    await a.finish({ outcome: "succeeded", text: "done" });
    a.sink.appendLine("[tool] Write");
    expect(await f.tasks.output(a.id)).not.toContain("[tool] Write");
  });
});

describe("listing background agent tasks", () => {
  test("AC-11 running() returns the shell and the agent task, the agent one tagged", () => {
    const f = fixture();
    const shell = f.adopt();
    const agent = f.adoptAgent();
    const running = f.tasks.running();
    expect(running).toHaveLength(2);
    expect(running.find((task) => task.id === shell.id)?.kind).toBeUndefined();
    expect(running.find((task) => task.id === agent.id)?.kind).toBe("agent");
  });
});
