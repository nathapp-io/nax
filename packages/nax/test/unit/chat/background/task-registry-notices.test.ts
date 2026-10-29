import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { BackgroundCommandEnd, BackgroundCommandHandle } from "@nathapp/nax-agent";
import { makeLogger } from "@test/helpers";
import { _backgroundTaskDeps, createBackgroundTasks } from "@/chat/background";
import { NaxError } from "@/errors";

const original = { ..._backgroundTaskDeps };
let sequence = 0;
beforeEach(() => {
  sequence = 0;
  Object.assign(_backgroundTaskDeps, {
    randomHex: () => (sequence++ === 0 ? "1a2b3c4d" : sequence.toString(16).padStart(8, "0")),
    mkdir: () => {},
    appendLog: async () => {},
    readLog: async () => "",
  });
});
afterEach(() => {
  Object.assign(_backgroundTaskDeps, original);
});

function fixture() {
  const logger = makeLogger();
  const tasks = createBackgroundTasks({ outputDir: "/o", now: () => new Date(0), logger });
  function command() {
    const end = Promise.withResolvers<BackgroundCommandEnd>();
    const stop = mock(() => {});
    const handle: BackgroundCommandHandle = { command: "bun test", origin: "agent", ended: end.promise, stop };
    const finish = async (value: Partial<BackgroundCommandEnd> = {}) => {
      end.resolve({ exitCode: 0, timedOut: false, aborted: false, ...value });
      await end.promise;
    };
    return { handle, stop, finish };
  }
  function adopt() {
    const call = command();
    return { ...call, id: tasks.adopt(call.handle).id };
  }
  return { tasks, command, adopt, logger };
}

describe("background task notices", () => {
  test("AC-1 aborted tasks do not queue notices", async () => {
    const f = fixture();
    await f.adopt().finish({ aborted: true });
    expect(f.tasks.peekNotice()).toBeUndefined();
  });
  test("AC-2 coalesces successful and failed task ids", async () => {
    const f = fixture();
    const a = f.adopt();
    const b = f.adopt();
    await a.finish();
    await b.finish({ exitCode: 2 });
    expect(f.tasks.peekNotice()).toContain(a.id);
    expect(f.tasks.peekNotice()).toContain(b.id);
  });
  test("AC-3 take returns the exact peeked coalesced text", async () => {
    const f = fixture();
    await f.adopt().finish();
    await f.adopt().finish({ exitCode: 2 });
    const notice = f.tasks.peekNotice();
    expect(notice).toBeDefined();
    expect(f.tasks.takeNotice()).toBe(notice);
  });
  test("AC-4 take consumes notices without repeating", async () => {
    const f = fixture();
    await f.adopt().finish();
    expect(f.tasks.takeNotice()).toBeDefined();
    expect(f.tasks.peekNotice()).toBeUndefined();
  });
  test("AC-5 endings after peek remain pending after take", async () => {
    const f = fixture();
    const a = f.adopt();
    const b = f.adopt();
    await a.finish();
    const notice = f.tasks.peekNotice();
    await b.finish();
    expect(f.tasks.peekNotice()).toBe(notice);
    expect(f.tasks.takeNotice()).toBe(notice);
    expect(f.tasks.peekNotice()).toContain(b.id);
    expect(f.tasks.peekNotice()).not.toContain(a.id);
  });
});

describe("background task shutdown", () => {
  test("AC-6 stop delegates to the running handle", () => {
    const f = fixture();
    const a = f.adopt();
    expect(a.id).toBe("bash-1a2b3c4d");
    expect(f.tasks.stop(a.id).id).toBe(a.id);
    expect(a.stop).toHaveBeenCalledTimes(1);
  });
  test("AC-7 stop rejects succeeded tasks with a typed error", async () => {
    const f = fixture();
    const a = f.adopt();
    await a.finish();
    expect(() => f.tasks.stop(a.id)).toThrow(NaxError);
    expect(() => f.tasks.stop(a.id)).toThrow(expect.objectContaining({ code: "CHAT_TASK_NOT_RUNNING" }));
    expect(a.stop).not.toHaveBeenCalled();
  });
  test("AC-8 stopAll stops every running handle, not ended handles", async () => {
    const f = fixture();
    const ended = f.adopt();
    await ended.finish();
    const a = f.adopt();
    const b = f.adopt();
    const closing = f.tasks.stopAll();
    expect(a.stop).toHaveBeenCalledTimes(1);
    expect(b.stop).toHaveBeenCalledTimes(1);
    expect(ended.stop).not.toHaveBeenCalled();
    await a.finish({ aborted: true });
    await b.finish({ aborted: true });
    await closing;
  });
  test("AC-9 stopAll waits for every ended promise", async () => {
    const f = fixture();
    const a = f.adopt();
    const b = f.adopt();
    const done = mock(() => {});
    const closing = f.tasks.stopAll().then(done);
    await a.finish();
    expect(done).not.toHaveBeenCalled();
    await b.finish();
    await closing;
    expect(done).toHaveBeenCalledTimes(1);
    expect(f.tasks.running()).toEqual([]);
  });
  test("AC-10 late adoption immediately stops the handle", async () => {
    const f = fixture();
    const closing = f.tasks.stopAll();
    const a = f.adopt();
    expect(a.stop).toHaveBeenCalledTimes(1);
    await a.finish();
    await closing;
  });
  test("AC-11 late adoption records stopped even on a zero exit", async () => {
    const f = fixture();
    await f.tasks.stopAll();
    const a = f.adopt();
    await a.finish();
    expect(f.tasks.get(a.id)?.state).toBe("stopped");
    expect(f.tasks.peekNotice()).toBeUndefined();
  });
});

describe("shutdown edge cases", () => {
  test("explicit stop remains stopped on successful exit and never notifies", async () => {
    const f = fixture();
    const a = f.adopt();
    expect(f.tasks.stop(a.id).state).toBe("stopped");
    await a.finish();
    expect(f.tasks.get(a.id)?.state).toBe("stopped");
    expect(f.tasks.peekNotice()).toBeUndefined();
    expect(() => f.tasks.stop("unknown")).toThrow(NaxError);
  });
  test("shutdown drains late adoptions and repeated shutdown calls", async () => {
    const f = fixture();
    const a = f.adopt();
    const done = mock(() => {});
    const closing = f.tasks.stopAll().then(done);
    const b = f.adopt();
    const again = f.tasks.stopAll();
    await a.finish();
    expect(done).not.toHaveBeenCalled();
    expect(a.stop).toHaveBeenCalledTimes(1);
    await b.finish();
    await Promise.all([closing, again]);
    expect(done).toHaveBeenCalledTimes(1);
    expect(b.stop).toHaveBeenCalledTimes(1);
  });
  test("listener failures warn without interrupting lifecycle or later listeners", async () => {
    const f = fixture();
    const cause = new Error("listener failed");
    f.tasks.onChange(() => {
      throw cause;
    });
    const listener = mock(() => {});
    f.tasks.onChange(listener);
    const a = f.adopt();
    await a.finish();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(f.logger.warn).toHaveBeenCalledTimes(2);
    expect(f.tasks.peekNotice()).toContain(a.id);
  });
});

describe("foreground tracking", () => {
  test("AC-12 moves the newest registration and restores the older one on unregister", () => {
    const { tasks } = fixture();
    const first = mock(() => {});
    const last = mock(() => {});
    tasks.foreground({ command: "first", moveToBackground: first });
    const unregister = tasks.foreground({ command: "last", moveToBackground: last });
    tasks.moveForeground();
    expect(last).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    unregister();
    tasks.moveForeground();
    expect(first).toHaveBeenCalledTimes(1);
  });
  test("AC-13 moving a registered foreground call returns true", () => {
    const { tasks } = fixture();
    tasks.foreground({ command: "test", moveToBackground() {} });
    expect(tasks.moveForeground()).toBe(true);
  });
  test("AC-14 moving without a registration returns false", () => {
    expect(fixture().tasks.moveForeground()).toBe(false);
  });
  test("AC-15 a registration marks the foreground active", () => {
    const { tasks } = fixture();
    tasks.foreground({ command: "test", moveToBackground() {} });
    expect(tasks.hasForeground()).toBe(true);
  });
  test("AC-16 unregister clears foreground activity", () => {
    const { tasks } = fixture();
    tasks.foreground({ command: "test", moveToBackground() {} })();
    expect(tasks.hasForeground()).toBe(false);
  });
});

describe("background lifecycle subscriptions", () => {
  test("AC-17 adoption emits and listener unsubscribe works", () => {
    const f = fixture();
    const listener = mock(() => {});
    const unsubscribe = f.tasks.onChange(listener);
    f.adopt();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    f.adopt();
    expect(listener).toHaveBeenCalledTimes(1);
  });
  test("AC-18 task completion emits with terminal state visible", async () => {
    const f = fixture();
    const a = f.adopt();
    const observed: string[] = [];
    const listener = mock(() => {
      observed.push(f.tasks.get(a.id)?.state ?? "missing");
    });
    f.tasks.onChange(listener);
    await a.finish();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(observed).toEqual(["succeeded"]);
  });
  test("AC-19 foreground registration emits", () => {
    const { tasks } = fixture();
    const listener = mock(() => {});
    tasks.onChange(listener);
    tasks.foreground({ command: "test", moveToBackground() {} });
    expect(listener).toHaveBeenCalledTimes(1);
  });
  test("AC-20 foreground unregister emits only once", () => {
    const { tasks } = fixture();
    const unregister = tasks.foreground({ command: "test", moveToBackground() {} });
    const listener = mock(() => {});
    tasks.onChange(listener);
    unregister();
    unregister();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
