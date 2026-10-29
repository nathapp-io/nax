import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { BackgroundCommandEnd, BackgroundCommandHandle } from "@nathapp/nax-agent";
import { makeLogger, withTempDir } from "@test/helpers";

let registry: typeof import("@/chat/background");
let original: typeof registry._backgroundTaskDeps;
let logs: Map<string, string>;
let logger: ReturnType<typeof makeLogger>;
const ID = "bash-1a2b3c4d";
const PATH = `/o/chat-tasks/${ID}.log`;
const NOW = "2026-10-29T00:00:00.000Z";
const encoder = new TextEncoder();
const LIMIT_LINE = "[nax] log limit reached; further output dropped";

beforeEach(async () => {
  registry = await import("@/chat/background");
  original = { ...registry._backgroundTaskDeps };
  logs = new Map();
  logger = makeLogger();
  Object.assign(registry._backgroundTaskDeps, {
    randomHex: () => "1a2b3c4d",
    mkdir: () => undefined,
    appendLog: async (path: string, chunk: Uint8Array) => {
      logs.set(path, (logs.get(path) ?? "") + new TextDecoder().decode(chunk));
    },
    readLog: async (path: string) => logs.get(path) ?? "",
  });
});
afterEach(() => {
  if (registry && original) Object.assign(registry._backgroundTaskDeps, original);
});

function fixture() {
  const end = Promise.withResolvers<BackgroundCommandEnd>();
  const handle: BackgroundCommandHandle = {
    command: "bun test",
    description: "tests",
    origin: "agent",
    ended: end.promise,
    stop: mock(() => {}),
  };
  const tasks = registry.createBackgroundTasks({ outputDir: "/o", now: () => new Date(NOW), logger });
  const sink = tasks.adopt(handle);
  const append = (text: string) => sink.append("stdout", encoder.encode(text));
  const finish = async (value: Partial<BackgroundCommandEnd> = {}) => {
    end.resolve({ exitCode: 0, timedOut: false, aborted: false, ...value });
    await end.promise;
    await tasks.output(sink.id);
  };
  return { tasks, sink, append, finish };
}

describe("createBackgroundTasks", () => {
  test("AC-1 adoption returns the generated sink id", () => {
    expect(fixture().sink.id).toBe(ID);
    expect(registry.TASK_ID_PATTERN.test(ID)).toBe(true);
  });
  test("AC-2 adoption records a running task", () => {
    expect(fixture().tasks.get(ID)).toMatchObject({
      state: "running",
      command: "bun test",
      description: "tests",
      origin: "agent",
      startedAt: NOW,
    });
  });
  test("AC-3 logs live in the machine-local chat-tasks directory", () => {
    expect(fixture().tasks.get(ID)?.logPath).toBe(PATH);
  });
  test("AC-4 stdout and stderr writes remain ordered across asynchronous appends", async () => {
    const f = fixture();
    const gate = Promise.withResolvers<void>();
    const appendLog = registry._backgroundTaskDeps.appendLog;
    let calls = 0;
    registry._backgroundTaskDeps.appendLog = async (path, chunk) => {
      if (++calls === 1) await gate.promise;
      await appendLog(path, chunk);
    };
    f.append("a");
    f.sink.append("stderr", encoder.encode("b"));
    f.append("c");
    gate.resolve();
    expect(await f.tasks.output(ID)).toBe("abc");
  });
  test("AC-5 output defaults to the last 40 of 50 lines", async () => {
    const f = fixture();
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    f.append(`${lines.join("\n")}\n`);
    expect(await f.tasks.output(ID)).toBe(lines.slice(-40).join("\n"));
  });
  test("AC-6 zero exit succeeds", async () => {
    const f = fixture();
    await f.finish();
    expect(f.tasks.get(ID)?.state).toBe("succeeded");
  });
  test("AC-7 completion timestamps the record", async () => {
    const f = fixture();
    await f.finish();
    expect(f.tasks.get(ID)?.endedAt).toBe(NOW);
  });
  test("AC-8 nonzero exit fails", async () => {
    const f = fixture();
    await f.finish({ exitCode: 2 });
    expect(f.tasks.get(ID)?.state).toBe("failed");
  });
  test("AC-9 the exit marker is the final log line even without an output newline", async () => {
    const f = fixture();
    f.append("output");
    await f.finish({ exitCode: 2 });
    expect(await f.tasks.output(ID)).toBe("output\n[nax] exit code 2");
  });
  test("AC-10 a launch error fails", async () => {
    const f = fixture();
    await f.finish({ exitCode: -1, launchError: "wrap failed" });
    expect(f.tasks.get(ID)?.state).toBe("failed");
    expect(await f.tasks.output(ID)).toBe("[nax] launch failed: wrap failed");
  });
  test("AC-11 the launch error is retained as a note", async () => {
    const f = fixture();
    await f.finish({ launchError: "wrap failed" });
    expect(f.tasks.get(ID)?.note).toBe("wrap failed");
  });
  test("AC-12 an aborted task stops", async () => {
    const f = fixture();
    await f.finish({ aborted: true });
    expect(f.tasks.get(ID)?.state).toBe("stopped");
  });
  test("AC-13 logging failure does not prevent success", async () => {
    const f = fixture();
    registry._backgroundTaskDeps.appendLog = async () => {
      throw new Error("disk full");
    };
    f.append("x");
    await f.finish();
    expect(f.tasks.get(ID)?.state).toBe("succeeded");
  });
  test("AC-14 logging failures warn exactly once", async () => {
    const f = fixture();
    registry._backgroundTaskDeps.appendLog = async () => {
      throw new Error("disk full");
    };
    f.append("x");
    f.append("y");
    await f.finish();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
  test("AC-15 reaching the byte cap appends one limit line", async () => {
    const f = fixture();
    f.sink.append("stdout", new Uint8Array(registry.TASK_LOG_MAX_BYTES).fill(120));
    expect((await f.tasks.output(ID)).split("\n").at(-1)).toBe(LIMIT_LINE);
    expect(encoder.encode(logs.get(PATH)).length).toBe(
      registry.TASK_LOG_MAX_BYTES + encoder.encode(`\n${LIMIT_LINE}\n`).length,
    );
  });
  test("AC-16 chunks after the limit marker are dropped", async () => {
    const f = fixture();
    f.sink.append("stdout", new Uint8Array(registry.TASK_LOG_MAX_BYTES).fill(120));
    await f.tasks.output(ID);
    const capped = logs.get(PATH);
    f.append("later");
    await f.tasks.output(ID);
    expect(logs.get(PATH)).toBe(capped);
  });
  test("AC-17 chunks queued and emitted after append failure are dropped", async () => {
    const f = fixture();
    const appendLog = mock(async () => {
      throw new Error("disk full");
    });
    registry._backgroundTaskDeps.appendLog = appendLog;
    f.append("x");
    f.append("queued");
    await f.tasks.output(ID);
    f.append("later");
    await f.tasks.output(ID);
    expect(appendLog).toHaveBeenCalledTimes(1);
  });
  test("AC-18 reaching the cap leaves the command running", async () => {
    const f = fixture();
    f.sink.append("stdout", new Uint8Array(registry.TASK_LOG_MAX_BYTES));
    await f.tasks.output(ID);
    expect(f.tasks.get(ID)?.state).toBe("running");
  });
  test("output clamps to 500 lines and handles unusable counts safely", async () => {
    const f = fixture();
    f.append(`${Array.from({ length: 600 }, (_, i) => i).join("\n")}\n`);
    expect((await f.tasks.output(ID, 999)).split("\n")).toHaveLength(500);
    for (const count of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5])
      expect(await f.tasks.output(ID, count)).toBe("");
    expect(await f.tasks.output("unknown")).toBe("");
  });
  test("lists newest first, filters running tasks, and returns isolated snapshots", async () => {
    const f = fixture();
    registry._backgroundTaskDeps.randomHex = () => "aaaaaaaa";
    const second = f.tasks.adopt({ command: "other", origin: "moved", ended: new Promise(() => {}), stop() {} });
    expect(f.tasks.list().map((t) => t.id)).toEqual([second.id, ID]);
    await f.finish();
    expect(f.tasks.running().map((t) => t.id)).toEqual([second.id]);
    const snapshot = f.tasks.get(ID);
    if (snapshot) Object.assign(snapshot, { state: "running" });
    expect(f.tasks.get(ID)?.state).toBe("succeeded");
  });
  test("production log adapters create a directory and append without truncating", async () => {
    await withTempDir(async (outputDir) => {
      Object.assign(registry._backgroundTaskDeps, original, { randomHex: () => "1a2b3c4d" });
      const end = Promise.withResolvers<BackgroundCommandEnd>();
      const tasks = registry.createBackgroundTasks({ outputDir, now: () => new Date(NOW), logger });
      const sink = tasks.adopt({ command: "echo", origin: "agent", ended: end.promise, stop() {} });
      sink.append("stdout", encoder.encode("first\n"));
      sink.append("stderr", encoder.encode("second\n"));
      end.resolve({ exitCode: 0, timedOut: false, aborted: false });
      await end.promise;
      expect(await tasks.output(sink.id)).toBe("first\nsecond\n[nax] exit code 0");
      expect(tasks.get(sink.id)?.state).toBe("succeeded");
    });
  });
  test("oversized mutable buffers are copied and truncated to the byte budget", async () => {
    const f = fixture();
    const chunk = new Uint8Array(registry.TASK_LOG_MAX_BYTES + 10).fill(120);
    f.sink.append("stdout", chunk);
    chunk.fill(121);
    await f.finish();
    const text = logs.get(PATH) ?? "";
    expect(text.startsWith("xxx")).toBe(true);
    expect(text.includes("y")).toBe(false);
    expect(text.endsWith(`${LIMIT_LINE}\n`)).toBe(true);
    expect(text.split(LIMIT_LINE)).toHaveLength(2);
    expect(f.tasks.get(ID)?.state).toBe("succeeded");
  });
  test("directory failures disable logging without losing the command", async () => {
    registry._backgroundTaskDeps.mkdir = () => {
      throw new Error("denied");
    };
    const appendLog = mock(async () => {});
    registry._backgroundTaskDeps.appendLog = appendLog;
    const f = fixture();
    f.append("x");
    await f.finish();
    expect(f.tasks.get(ID)?.state).toBe("succeeded");
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(appendLog).not.toHaveBeenCalled();
  });
  test("missing logs return empty output and unexpected read errors retain their cause", async () => {
    const f = fixture();
    registry._backgroundTaskDeps.readLog = async () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    };
    expect(await f.tasks.output(ID)).toBe("");
    const cause = new Error("denied");
    registry._backgroundTaskDeps.readLog = async () => {
      throw cause;
    };
    await expect(f.tasks.output(ID)).rejects.toMatchObject({
      code: "CHAT_TASK_READ_FAILED",
      context: { id: ID, cause },
    });
  });
  test("colliding ids cannot overwrite an existing task", () => {
    const f = fixture();
    expect(() => f.tasks.adopt({ command: "other", origin: "agent", ended: new Promise(() => {}), stop() {} })).toThrow(
      "[chat] could not allocate a background task id",
    );
    expect(f.tasks.get(ID)?.command).toBe("bun test");
    expect(f.tasks.list()).toHaveLength(1);
  });
  test("a timed-out zero exit fails", async () => {
    const f = fixture();
    await f.finish({ timedOut: true });
    expect(f.tasks.get(ID)?.state).toBe("failed");
  });
});
