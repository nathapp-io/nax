import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { BackgroundCommandEnd } from "@nathapp/nax-agent";
import { assertDefined, cleanupTempDir, makeLogger, makeTempDir, mountChatPicker } from "@test/helpers";
import { cleanup } from "ink-testing-library";
import type { ChatHost } from "@/chat";
import { _backgroundTaskDeps, createBackgroundTasks } from "@/chat/background";
import type { ChatJobs } from "@/chat/jobs/job-runner";
import { _slashCommandDeps } from "@/tui/chat/slash-commands";
import { taskNoticeHeldLine } from "@/tui/chat/use-jobs";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  cleanup();
  for (const dispose of disposers.splice(0)) await dispose();
  mock.restore();
});
function mount(withJobs = false, taskNoticeTurns?: number) {
  const dir = makeTempDir("task-notices-");
  const tasks = createBackgroundTasks({ outputDir: dir, now: () => new Date(), logger: makeLogger() });
  disposers.push(async () => {
    await tasks.stopAll();
    cleanupTempDir(dir);
  });
  const gates: Array<ReturnType<typeof Promise.withResolvers<void>>> = [];
  const order: string[] = [];
  const send = mock<ChatHost["send"]>(async (text) => {
    order.push(`send:${text}`);
    const gate = Promise.withResolvers<void>();
    gates.push(gate);
    await gate.promise;
  });
  const originalTake = tasks.takeNotice.bind(tasks);
  const take = spyOn(tasks, "takeNotice").mockImplementation(() => {
    order.push("take");
    return originalTake();
  });
  const jobNotices: string[] = [];
  const listeners = new Set<() => void>();
  const jobs: ChatJobs = {
    list: () => [],
    running: () => [],
    owned: () => [],
    get: () => undefined,
    start: async () => {
      throw new Error("unused");
    },
    cancel: async () => {
      throw new Error("unused");
    },
    canCancel: async () => ({ ok: true }),
    attach: async () => {},
    logTail: async () => "",
    dispose() {},
    peekNotice: () => jobNotices[0],
    takeNotice: () => jobNotices.shift(),
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const ui = mountChatPicker({
    tasks,
    send,
    ...(withJobs ? { jobs } : {}),
    ...(taskNoticeTurns === undefined ? {} : { taskNoticeTurns }),
  });
  async function endTask() {
    const end = Promise.withResolvers<BackgroundCommandEnd>();
    let id = "";
    await ui.settleAfter(() => {
      id = tasks.adopt({
        command: "bun dev",
        origin: "agent",
        ended: end.promise,
        stop() {
          end.resolve({ exitCode: 143, timedOut: false, aborted: true });
        },
      }).id;
      end.resolve({ exitCode: 0, timedOut: false, aborted: false });
    });
    // Wait for the registry's log flush and completion event, not a keypress.
    await ui.settleAfter(() => {});
    return id;
  }
  return {
    ...ui,
    tasks,
    send,
    take,
    order,
    endTask,
    finishTurn: (index: number) => ui.settleAfter(() => gates[index]?.resolve()),
    queueJob: () => {
      jobNotices.push("job notice");
      for (const listener of listeners) listener();
    },
  };
}

describe("background task notices", () => {
  test("AC-10/11 idle tasks without jobs deliver before acknowledgement", async () => {
    const ui = mount();
    const id = await ui.endTask();
    expect(ui.send).toHaveBeenCalledTimes(1);
    expect(ui.send.mock.calls[0]?.[0]).toContain(id);
    const notice = ui.tasks.peekNotice();
    assertDefined(notice, "pending task notice");
    expect(ui.send.mock.calls[0]?.[0]).toBe(notice);
    expect(ui.take).not.toHaveBeenCalled();
    await ui.finishTurn(0);
    expect(ui.take).toHaveBeenCalledTimes(1);
    expect(ui.order[0]).toStartWith("send:");
    expect(ui.order[1]).toBe("take");
  });
  test("AC-12 waits for a running user turn", async () => {
    const ui = mount();
    await ui.submit("hello");
    await ui.endTask();
    expect(ui.send.mock.calls.map(([text]) => text)).toEqual(["hello"]);
    await ui.finishTurn(0);
    expect(ui.send).toHaveBeenCalledTimes(2);
    await ui.finishTurn(1);
  });
  test("AC-13 jobs have priority over queued tasks", async () => {
    const ui = mount(true);
    await ui.submit("hello");
    await ui.endTask();
    await ui.settleAfter(ui.queueJob);
    await ui.finishTurn(0);
    expect(ui.send.mock.calls[1]?.[0]).toBe("job notice");
    await ui.finishTurn(1);
    expect(ui.send.mock.calls[2]?.[0]).toContain("bash-");
    await ui.finishTurn(2);
  });
  test.each(["continue", "/feature demo"])("AC-14/15 user message %s resets the task guard", async (message) => {
    spyOn(_slashCommandDeps, "readText").mockResolvedValue("feature spec");
    const ui = mount();
    for (let i = 0; i < 3; i++) {
      await ui.endTask();
      await ui.finishTurn(i);
    }
    await ui.endTask();
    expect(ui.send).toHaveBeenCalledTimes(3);
    expect(ui.tasks.peekNotice()).toBeDefined();
    await ui.submit(message);
    expect(ui.send.mock.calls[3]?.[0]).toContain(message === "continue" ? "continue" : "feature spec");
    expect(ui.send).toHaveBeenCalledTimes(4);
    await ui.finishTurn(3);
    expect(ui.send).toHaveBeenCalledTimes(5);
    await ui.finishTurn(4);
  });
  test("job notice turns neither count toward nor reset the task guard", async () => {
    const ui = mount(true);
    await ui.endTask();
    await ui.finishTurn(0);
    await ui.settleAfter(ui.queueJob);
    await ui.finishTurn(1);
    await ui.endTask();
    await ui.finishTurn(2);
    await ui.endTask();
    await ui.finishTurn(3);
    expect(ui.send).toHaveBeenCalledTimes(4);
    await ui.settleAfter(ui.queueJob);
    await ui.finishTurn(4);
    await ui.endTask();
    expect(ui.send).toHaveBeenCalledTimes(5);
    expect(ui.tasks.peekNotice()).toBeDefined();
  });
  test("a task notice held by the guard is announced once in the transcript (#2816)", async () => {
    const ui = mount();
    for (let i = 0; i < 3; i++) {
      await ui.endTask();
      await ui.finishTurn(i);
    }
    await ui.endTask();
    await ui.endTask();
    expect(ui.send).toHaveBeenCalledTimes(3);
    const held = taskNoticeHeldLine(3);
    expect(ui.rows().filter((row) => row.includes(held))).toHaveLength(1);
  });
  test("the host's taskNoticeTurns sets the guard (#2816)", async () => {
    const ui = mount(false, 5);
    for (let i = 0; i < 4; i++) {
      await ui.endTask();
      await ui.finishTurn(i);
    }
    expect(ui.send).toHaveBeenCalledTimes(4);
    expect(ui.rows().some((row) => row.includes(taskNoticeHeldLine(5)))).toBe(false);
  });
  test("a taskNoticeTurns of 0 never wakes the agent but still announces the held notice", async () => {
    const ui = mount(false, 0);
    await ui.endTask();
    expect(ui.send).not.toHaveBeenCalled();
    expect(ui.rows().some((row) => row.includes(taskNoticeHeldLine(0)))).toBe(true);
  });
  test("a rejected task notice stays queued without using a guard turn", async () => {
    const ui = mount();
    ui.send.mockImplementationOnce(async () => {
      throw new Error("unavailable");
    });
    await ui.endTask();
    expect(ui.take).not.toHaveBeenCalled();
    expect(ui.tasks.peekNotice()).toBeDefined();
    await ui.submit("/mcp");
    await ui.finishTurn(0);
    expect(ui.take).toHaveBeenCalledTimes(1);
  });
  test.each([true, false])("AC-16/17 /jobs opens the picker with the task row (jobs=%s)", async (withJobs) => {
    const ui = mount(withJobs);
    spyOn(_backgroundTaskDeps, "randomHex").mockReturnValue("1a2b3c4d");
    const end = Promise.withResolvers<BackgroundCommandEnd>();
    ui.tasks.adopt({
      command: "bun dev",
      origin: "agent",
      ended: end.promise,
      stop() {
        end.resolve({ exitCode: 143, timedOut: false, aborted: true });
      },
    });
    await ui.submit("/jobs");
    const frame = ui.ui.lastFrame() ?? "";
    expect(frame).toContain("Jobs and tasks · enter output · ctrl+x stop");
    expect(frame).toContain("bash bun dev");
    expect(frame).toMatch(/bash bun dev\s+running/);
    expect(ui.ui.lastFrame()).not.toContain("jobs are not available in this session");
  });
  test("AC-19 /jobs preserves unavailable response with neither capability", async () => {
    const ui = mountChatPicker();
    await ui.submit("/jobs");
    expect(ui.ui.lastFrame()).toContain("jobs are not available in this session");
  });
});

describe("background notices in the transcript", () => {
  const COLLAPSED_ROW = "1 background command ended · 1 succeeded (ctrl+o to show)";

  test("AC-8 an idle task's notice is delivered whole and drawn as one collapsed row", async () => {
    const ui = mount();
    await ui.endTask();
    const sent = ui.send.mock.calls[0]?.[0];
    assertDefined(sent, "delivered notice");
    // The model still receives every line of the notice; only the transcript row differs.
    expect(ui.tasks.peekNotice() ?? "").toBe(sent);
    expect(sent).toContain("[nax-tasks] background command");
    const frame = ui.ui.lastFrame() ?? "";
    expect(frame).toContain(COLLAPSED_ROW);
    expect(frame).not.toContain("[nax-tasks]");
    await ui.finishTurn(0);
  });

  test("AC-9 ctrl+o reveals the notice's own line", async () => {
    const ui = mount();
    await ui.endTask();
    await ui.finishTurn(0);
    expect(ui.ui.lastFrame()).not.toContain("[nax-tasks] background command");
    ui.press("\x0f");
    await ui.settle();
    expect(ui.ui.lastFrame()).toContain("[nax-tasks] background command");
  });
});
