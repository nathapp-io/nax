import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { BackgroundCommandEnd } from "@nathapp/nax-agent";
import { assertDefined, cleanupTempDir, makeLogger, makeTempDir, mountChatPicker } from "@test/helpers";
import { cleanup } from "ink-testing-library";
import type { ChatHost } from "@/chat";
import { _backgroundTaskDeps, createBackgroundTasks } from "@/chat/background";
import type { ChatJobs } from "@/chat/jobs/job-runner";
import { _slashCommandDeps } from "@/tui/chat/slash-commands";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  cleanup();
  for (const dispose of disposers.splice(0)) await dispose();
  mock.restore();
});
function mount(withJobs = false) {
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
  const ui = mountChatPicker({ tasks, send, ...(withJobs ? { jobs } : {}) });
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
  test("a rejected task notice stays queued without using a guard turn", async () => {
    const ui = mount();
    ui.send.mockImplementationOnce(async () => {
      throw new Error("unavailable");
    });
    await ui.endTask();
    expect(ui.take).not.toHaveBeenCalled();
    expect(ui.tasks.peekNotice()).toBeDefined();
    await ui.submit("/jobs");
    await ui.finishTurn(0);
    expect(ui.take).toHaveBeenCalledTimes(1);
  });
  test.each([true, false])("AC-16/17 /jobs lists tasks (jobs=%s)", async (withJobs) => {
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
    expect(ui.ui.lastFrame()).toContain("bash-1a2b3c4d running bun dev");
    expect(ui.ui.lastFrame()).not.toContain("jobs are not available in this session");
  });
  test("AC-19 /jobs preserves unavailable response with neither capability", async () => {
    const ui = mountChatPicker();
    await ui.submit("/jobs");
    expect(ui.ui.lastFrame()).toContain("jobs are not available in this session");
  });
});
