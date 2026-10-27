import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import { type ChatHost, type ChatHostState, createChatAskController } from "@/chat";
import type { ChatJobs } from "@/chat/jobs/job-runner";
import type { ChatJob } from "@/chat/jobs/job-types";
import { ChatApp } from "@/tui/chat";

const NOTICE = "[nax-jobs] job run-1 (run f1) ended: succeeded";
const SECOND = "[nax-jobs] job plan-2 (plan f2) ended: failed";
const STATE: ChatHostState = {
  sessionId: "jobs-session",
  mode: "guarded",
  model: "test-model",
  meta: {
    schemaVersion: 1,
    sessionId: "jobs-session",
    cwd: "/repo",
    mode: "ask",
    model: "test-model",
    bashApproval: "gated",
    title: null,
    createdAt: "now",
    updatedAt: null,
    costUsd: 0,
  },
};
const JOB: ChatJob = {
  schemaVersion: 1,
  id: "run-12345678",
  kind: "run",
  target: "f1",
  argv: [],
  cwd: "/repo",
  pid: 123,
  startedAt: "now",
  state: "running",
  logPath: "/log",
  sessionId: "jobs-session",
  approvedAt: "now",
};

afterEach(() => {
  cleanup();
  mock.restore();
});
const flush = (action: () => void = () => {}): Promise<void> =>
  Promise.resolve(
    act(async () => {
      action();
    }),
  );

function mount() {
  const listeners = new Set<() => void>();
  const notices: string[] = [];
  let running: readonly ChatJob[] = [JOB];
  let beforePeek: (() => void) | undefined;
  const order: string[] = [];
  const gates: Array<ReturnType<typeof Promise.withResolvers<void>>> = [];
  const switchGate = Promise.withResolvers<void>();
  const send = mock<ChatHost["send"]>(async (text) => {
    order.push(`send:${text}`);
    const gate = Promise.withResolvers<void>();
    gates.push(gate);
    await gate.promise;
  });
  const takeNotice = mock(() => {
    order.push("take");
    return notices.shift();
  });
  const jobs: ChatJobs = {
    running: () => running,
    list: () => running,
    owned: () => running,
    get: () => undefined,
    start: async () => JOB,
    cancel: async () => JOB,
    canCancel: async () => ({ ok: true }),
    attach: async () => {},
    logTail: async () => "",
    dispose: () => {},
    peekNotice: () => {
      const callback = beforePeek;
      beforePeek = undefined;
      callback?.();
      return notices[0];
    },
    takeNotice,
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const asks = createChatAskController({ mode: "guarded", answer: () => {} });
  const host: ChatHost = {
    repoRoot: "/repo",
    models: [STATE.model],
    asks,
    jobs,
    current: () => STATE,
    notice: () => undefined,
    send,
    cancel: () => {},
    start: async () => {},
    close: async () => {},
    clear: async () => {},
    resume: async () => {},
    switchTo: async () => switchGate.promise,
    listSessions: async () => [],
  };
  const ui = render(<ChatApp host={host} />);
  const press = (text: string): void =>
    act(() => {
      ui.stdin.write(text);
    });
  const start = (): void => {
    press("hello");
    press("\r");
  };
  const emit = (...texts: string[]): Promise<void> =>
    flush(() => {
      notices.push(...texts);
      for (const listener of listeners) listener();
    });
  return {
    ...ui,
    host,
    send,
    takeNotice,
    order,
    notices,
    start,
    press,
    emit,
    listeners,
    finish: (index: number) => flush(() => gates[index]?.resolve()),
    finishSwitch: () => flush(() => switchGate.resolve()),
    raceSend: () => {
      beforePeek = start;
    },
    stopJobs: () =>
      flush(() => {
        running = [];
        for (const listener of listeners) listener();
      }),
  };
}

describe("ChatApp jobs", () => {
  test("US-014 AC-8 renders running jobs and subscribes to changes", async () => {
    const ui = mount();
    expect(ui.lastFrame()?.split("\n").at(-1)).toContain("run f1");
    await ui.stopJobs();
    expect(ui.lastFrame()?.split("\n").at(-1)).not.toContain("run f1");
    ui.unmount();
    expect(ui.listeners.size).toBe(0);
  });
  test("US-014 AC-9 AC-10 sends an idle notice before acknowledging it", async () => {
    const ui = mount();
    await ui.emit(NOTICE);
    expect(ui.send).toHaveBeenCalledTimes(1);
    expect(ui.send).toHaveBeenCalledWith(NOTICE, expect.any(Function));
    await ui.finish(0);
    expect(ui.takeNotice).toHaveBeenCalledTimes(1);
    expect(ui.order).toEqual([`send:${NOTICE}`, "take"]);
  });
  test("US-014 AC-11 waits for the entire running turn", async () => {
    const ui = mount();
    ui.start();
    await ui.emit(NOTICE);
    expect(ui.send.mock.calls.map(([text]) => text)).toEqual(["hello"]);
    expect(ui.takeNotice).not.toHaveBeenCalled();
    await ui.finish(0);
    expect(ui.send.mock.calls.map(([text]) => text)).toEqual(["hello", NOTICE]);
    await ui.finish(1);
    expect(ui.takeNotice).toHaveBeenCalledTimes(1);
  });
  test("US-014 AC-12 waits until the ask card resolves", async () => {
    const ui = mount();
    let approval: Promise<unknown> | undefined;
    await flush(() => {
      approval = ui.host.asks.requestHostApproval({ tool: "nax-jobs__run", summary: "run f1", reason: "billed" });
    });
    expect(ui.host.asks.pending()).toHaveLength(1);
    await ui.emit(NOTICE);
    expect(ui.send).not.toHaveBeenCalled();
    await flush(() => {
      for (const ask of ui.host.asks.pending()) ui.host.asks.resolve(ask.requestId, "deny");
    });
    await approval;
    expect(ui.host.asks.pending()).toHaveLength(0);
    expect(ui.send).toHaveBeenCalledWith(NOTICE, expect.any(Function));
    await ui.finish(0);
  });
  test("US-014 AC-13 AC-14 does not send or take while mode switching", async () => {
    const ui = mount();
    ui.press("\x1b[Z");
    await ui.emit(NOTICE);
    expect(ui.send).not.toHaveBeenCalled();
    expect(ui.takeNotice).not.toHaveBeenCalled();
    await ui.finishSwitch();
    expect(ui.send).toHaveBeenCalledWith(NOTICE, expect.any(Function));
    await ui.finish(0);
  });
  test("US-014 AC-15 delivers two notices FIFO in separate non-overlapping turns", async () => {
    const ui = mount();
    await ui.emit(NOTICE, SECOND);
    await ui.emit();
    expect(ui.send.mock.calls.map(([text]) => text)).toEqual([NOTICE]);
    await ui.finish(0);
    expect(ui.send.mock.calls.map(([text]) => text)).toEqual([NOTICE, SECOND]);
    await ui.finish(1);
    expect(ui.order).toEqual([`send:${NOTICE}`, "take", `send:${SECOND}`, "take"]);
    expect(ui.notices).toEqual([]);
  });
  test("US-014 AC-16 AC-17 retains a notice when a send wins the idle-render race", async () => {
    const ui = mount();
    // Start a user send after the idle snapshot, exactly when the hook peeks the queue.
    ui.raceSend();
    await ui.emit(NOTICE);
    expect(ui.send.mock.calls.map(([text]) => text)).toEqual(["hello"]);
    expect(ui.takeNotice).not.toHaveBeenCalled();
    expect(ui.notices).toEqual([NOTICE]);
    await ui.finish(0);
    expect(ui.send.mock.calls.map(([text]) => text)).toEqual(["hello", NOTICE]);
    await ui.finish(1);
    expect(ui.takeNotice).toHaveBeenCalledTimes(1);
  });
});
