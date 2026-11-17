import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { BackgroundCommandEnd } from "@nathapp/nax-agent";
import { assertDefined, cleanupTempDir, makeLogger, makeTempDir, mountChatPicker } from "@test/helpers";
import { cleanup } from "ink-testing-library";
import type { ChatHost } from "@/chat";
import { _backgroundTaskDeps, createBackgroundTasks } from "@/chat/background";
import type { ChatJobs } from "@/chat/jobs/job-runner";
import { summarizeBackgroundNotice } from "@/prompts";
import { _slashCommandDeps } from "@/tui/chat/slash-commands";
import { steeredTaskNoticeLine, taskNoticeHeldLine } from "@/tui/chat/use-jobs";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  cleanup();
  for (const dispose of disposers.splice(0)) await dispose();
  mock.restore();
});
function mount(withJobs = false, taskNoticeTurns?: number, steer?: ChatHost["steer"]) {
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
    ...(steer === undefined ? {} : { steer }),
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

/** A recording steer stub; each call answers `accepted` with the promise `applied` builds. */
function acceptedSteer(applied: (call: number) => Promise<boolean>) {
  let calls = 0;
  return mock<NonNullable<ChatHost["steer"]>>(() => {
    calls += 1;
    return { status: "accepted", steerId: `steer-${calls}`, applied: applied(calls) };
  });
}

/** The summary of a queued notice, as the steered transcript row names it. */
function summaryOf(ui: ReturnType<typeof mount>): string {
  const notice = ui.tasks.peekNotice();
  assertDefined(notice, "queued notice");
  const summary = summarizeBackgroundNotice(notice);
  assertDefined(summary, "notice summary");
  return summary;
}

/** Two busy ticks — a typed character and a stream delta — that must not steer twice. */
async function busyTicks(ui: ReturnType<typeof mount>): Promise<void> {
  ui.press("x");
  ui.emit({ type: "text_delta", round: 1, text: "tick" });
  await ui.settle();
}

describe("a task notice steered into the running turn", () => {
  test("AC-1 steeredTaskNoticeLine names the summary and where it went", () => {
    expect(steeredTaskNoticeLine("1 background command ended · 1 succeeded")).toBe(
      "1 background command ended · 1 succeeded · sent into the running turn",
    );
  });

  test("AC-2/6 the head notice is handed to the running turn once", async () => {
    const applied = Promise.withResolvers<boolean>();
    const steer = acceptedSteer(() => applied.promise);
    const ui = mount(false, undefined, steer);
    await ui.submit("hello");
    const id = await ui.endTask();
    const notice = ui.tasks.peekNotice();
    assertDefined(notice, "queued notice");
    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer.mock.calls[0]?.[0]).toBe(notice);
    expect(notice).toContain(id);
    await busyTicks(ui);
    expect(steer).toHaveBeenCalledTimes(1);
    await ui.settleAfter(() => applied.resolve(true));
    await ui.settle();
    await ui.finishTurn(0);
  });

  test("the steer is invoked on the host that owns it", async () => {
    const steered: string[] = [];
    const steer = function (this: ChatHost | undefined, text: string) {
      // A detached call loses `this`, and the real host's `steer` reads its steering off it.
      if (this === undefined) throw new Error("steer was called without its host");
      steered.push(text);
      return { status: "no_turn" } as const;
    };
    const ui = mount(false, undefined, steer);
    await ui.submit("hello");
    await ui.endTask();
    expect(steered).toHaveLength(1);
    await ui.finishTurn(0);
    await ui.finishTurn(1);
  });

  test("AC-3/4/5 an applied steer acknowledges the task and draws one row, with no second send", async () => {
    const applied = Promise.withResolvers<boolean>();
    const steer = acceptedSteer(() => applied.promise);
    const ui = mount(false, undefined, steer);
    await ui.submit("hello");
    await ui.endTask();
    const summary = summaryOf(ui);
    await ui.settleAfter(() => applied.resolve(true));
    await ui.settle();
    expect(ui.take).toHaveBeenCalledTimes(1);
    expect(ui.rows().some((row) => row.includes(steeredTaskNoticeLine(summary)))).toBe(true);
    await ui.finishTurn(0);
    expect(ui.send.mock.calls.map(([text]) => text)).toEqual(["hello"]);
  });

  test("AC-19/20 a second task steered after the first is applied names only itself", async () => {
    const gates = [Promise.withResolvers<boolean>(), Promise.withResolvers<boolean>()];
    const steer = acceptedSteer((call) => {
      const gate = gates[call - 1];
      assertDefined(gate, "steer applied gate");
      return gate.promise;
    });
    const ui = mount(false, undefined, steer);
    await ui.submit("hello");
    const first = await ui.endTask();
    expect(steer).toHaveBeenCalledTimes(1);
    await ui.settleAfter(() => gates[0]?.resolve(true));
    await ui.settle();
    const second = await ui.endTask();
    expect(steer).toHaveBeenCalledTimes(2);
    expect(steer.mock.calls[1]?.[0]).toContain(second);
    expect(steer.mock.calls[1]?.[0]).not.toContain(first);
    await ui.settleAfter(() => gates[1]?.resolve(true));
    await ui.settle();
    await ui.finishTurn(0);
  });

  test("AC-23/24 a taskNoticeTurns of 0 still steers, and draws the steered row", async () => {
    const applied = Promise.withResolvers<boolean>();
    const steer = acceptedSteer(() => applied.promise);
    const ui = mount(false, 0, steer);
    await ui.submit("hello");
    const id = await ui.endTask();
    const notice = ui.tasks.peekNotice();
    assertDefined(notice, "queued notice");
    expect(steer).toHaveBeenCalledTimes(1);
    expect(steer.mock.calls[0]?.[0]).toContain(id);
    const summary = summaryOf(ui);
    await ui.settleAfter(() => applied.resolve(true));
    await ui.settle();
    expect(ui.rows().some((row) => row.includes(steeredTaskNoticeLine(summary)))).toBe(true);
    await ui.finishTurn(0);
    // A steer is not a turn: the setting still stops every task notice from starting one.
    expect(ui.send.mock.calls.map(([text]) => text)).toEqual(["hello"]);
  });

  test("AC-33/34/35 an idle notice turn is delivered once and never steers its own notice", async () => {
    const steer = acceptedSteer(() => Promise.withResolvers<boolean>().promise);
    const ui = mount(false, undefined, steer);
    const id = await ui.endTask();
    expect(ui.send).toHaveBeenCalledTimes(1);
    expect(ui.send.mock.calls[0]?.[0]).toContain(id);
    // The notice's own turn is running, and the head notice is the one it is delivering.
    await busyTicks(ui);
    expect(steer).not.toHaveBeenCalled();
    await ui.finishTurn(0);
    expect(steer).not.toHaveBeenCalled();
    expect(ui.take).toHaveBeenCalledTimes(1);
  });
});

describe("a task notice steer the turn did not take", () => {
  test("AC-7/8 an unsupported steer is asked once, then the ended turn sends the notice", async () => {
    const steer = mock<NonNullable<ChatHost["steer"]>>(() => ({ status: "unsupported" }));
    const ui = mount(false, undefined, steer);
    await ui.submit("hello");
    const id = await ui.endTask();
    expect(steer).toHaveBeenCalledTimes(1);
    await busyTicks(ui);
    expect(steer).toHaveBeenCalledTimes(1);
    expect(ui.tasks.peekNotice()).toBeDefined();
    await ui.finishTurn(0);
    expect(ui.send).toHaveBeenCalledTimes(2);
    expect(ui.send.mock.calls[1]?.[0]).toContain(id);
    await ui.finishTurn(1);
  });

  test("AC-16/17/18 a no_turn steer is asked once, keeps the notice queued, and the end sends it", async () => {
    const steer = mock<NonNullable<ChatHost["steer"]>>(() => ({ status: "no_turn" }));
    const ui = mount(false, undefined, steer);
    await ui.submit("hello");
    const id = await ui.endTask();
    expect(steer).toHaveBeenCalledTimes(1);
    await busyTicks(ui);
    expect(steer).toHaveBeenCalledTimes(1);
    expect(ui.tasks.peekNotice()).toBeDefined();
    await ui.finishTurn(0);
    expect(ui.send.mock.calls.map(([text]) => text)).toEqual(["hello", expect.stringContaining(id)]);
    await ui.finishTurn(1);
  });

  test("AC-9/10/11 an unapplied steer is refused, never retried, and sent after the turn", async () => {
    const applied = Promise.withResolvers<boolean>();
    const steer = acceptedSteer(() => applied.promise);
    const ui = mount(false, undefined, steer);
    await ui.submit("hello");
    const id = await ui.endTask();
    await ui.settleAfter(() => applied.resolve(false));
    await ui.settle();
    await busyTicks(ui);
    expect(steer).toHaveBeenCalledTimes(1);
    await ui.finishTurn(0);
    expect(ui.send.mock.calls.map(([text]) => text)).toEqual(["hello", expect.stringContaining(id)]);
    expect(ui.rows().some((row) => row.includes("sent into the running turn"))).toBe(false);
    await ui.finishTurn(1);
  });

  test("AC-12/13 an unsettled steer holds the notice until it settles, then idle sends it", async () => {
    const applied = Promise.withResolvers<boolean>();
    const steer = acceptedSteer(() => applied.promise);
    const ui = mount(false, undefined, steer);
    await ui.submit("hello");
    const id = await ui.endTask();
    await ui.finishTurn(0);
    expect(ui.send).toHaveBeenCalledTimes(1);
    await ui.settleAfter(() => applied.resolve(false));
    await ui.settle();
    expect(ui.send.mock.calls.map(([text]) => text)).toEqual(["hello", expect.stringContaining(id)]);
    await ui.finishTurn(1);
  });

  test("AC-14 a pending steer is not the guard's hold", async () => {
    const applied = Promise.withResolvers<boolean>();
    const steer = acceptedSteer(() => applied.promise);
    const ui = mount(false, 0, steer);
    await ui.submit("hello");
    await ui.endTask();
    await ui.finishTurn(0);
    expect(ui.rows().some((row) => row.includes(taskNoticeHeldLine(0)))).toBe(false);
    await ui.settleAfter(() => applied.resolve(false));
    await ui.settle();
  });

  test("AC-15 a job notice is still delivered while a task steer is pending", async () => {
    const steer = acceptedSteer(() => Promise.withResolvers<boolean>().promise);
    const ui = mount(true, undefined, steer);
    await ui.submit("hello");
    await ui.endTask();
    await ui.finishTurn(0);
    expect(ui.send).toHaveBeenCalledTimes(1);
    await ui.settleAfter(ui.queueJob);
    expect(ui.send.mock.calls.map(([text]) => text)).toEqual(["hello", "job notice"]);
    await ui.finishTurn(1);
  });

  test("AC-21/22 a steered notice is not a guard turn, so the next idle task is delivered", async () => {
    const applied = Promise.withResolvers<boolean>();
    const steer = acceptedSteer(() => applied.promise);
    const ui = mount(false, 1, steer);
    await ui.submit("hello");
    await ui.endTask();
    await ui.settleAfter(() => applied.resolve(true));
    await ui.settle();
    expect(ui.take).toHaveBeenCalledTimes(1);
    await ui.finishTurn(0);
    const second = await ui.endTask();
    expect(ui.send.mock.calls.map(([text]) => text)).toEqual(["hello", expect.stringContaining(second)]);
    expect(ui.rows().some((row) => row.includes(taskNoticeHeldLine(1)))).toBe(false);
    await ui.finishTurn(1);
  });

  test("AC-25 a throwing steer leaves the screen mounted", async () => {
    const steer = mock<NonNullable<ChatHost["steer"]>>(() => {
      throw new Error("no channel");
    });
    const ui = mount(false, undefined, steer);
    await ui.submit("hello");
    await ui.endTask();
    ui.press("zzdraft");
    await ui.settle();
    expect(ui.ui.lastFrame()).toContain("zzdraft");
    await ui.finishTurn(0);
    await ui.finishTurn(1);
  });

  test("AC-26/27/28 a throwing steer is asked once, keeps the notice, and the end sends it", async () => {
    const steer = mock<NonNullable<ChatHost["steer"]>>(() => {
      throw new Error("no channel");
    });
    const ui = mount(false, undefined, steer);
    await ui.submit("hello");
    const id = await ui.endTask();
    await busyTicks(ui);
    expect(steer).toHaveBeenCalledTimes(1);
    expect(ui.tasks.peekNotice()).toBeDefined();
    await ui.finishTurn(0);
    expect(ui.send.mock.calls.map(([text]) => text)).toEqual(["hello", expect.stringContaining(id)]);
    await ui.finishTurn(1);
  });

  test("AC-29/30/31 a rejecting applied is refused, never retried, and the end sends the notice", async () => {
    const applied = Promise.withResolvers<boolean>();
    const steer = acceptedSteer(() => applied.promise);
    const ui = mount(false, undefined, steer);
    await ui.submit("hello");
    const id = await ui.endTask();
    await ui.settleAfter(() => applied.reject(new Error("closed")));
    await ui.settle();
    expect(ui.tasks.peekNotice()).toBeDefined();
    await busyTicks(ui);
    expect(steer).toHaveBeenCalledTimes(1);
    await ui.finishTurn(0);
    expect(ui.send.mock.calls.map(([text]) => text)).toEqual(["hello", expect.stringContaining(id)]);
    await ui.finishTurn(1);
  });

  test("AC-32 without steer the notice keeps today's order after the turn", async () => {
    const ui = mount();
    await ui.submit("hello");
    const id = await ui.endTask();
    expect(ui.send.mock.calls.map(([text]) => text)).toEqual(["hello"]);
    await ui.finishTurn(0);
    expect(ui.send.mock.calls.map(([text]) => text)).toEqual(["hello", expect.stringContaining(id)]);
    await ui.finishTurn(1);
  });

  test("a refused steer leaves a marked output read able to retire the notice", async () => {
    const steer = mock<NonNullable<ChatHost["steer"]>>(() => ({ status: "unsupported" }));
    const ui = mount(false, undefined, steer);
    await ui.submit("hello");
    const id = await ui.endTask();
    expect(steer).toHaveBeenCalledTimes(1);
    // The agent reads the ended task through nax-tasks__output, still inside that turn.
    const read = ui.tasks.output(id, undefined, { markSeen: true });
    await ui.settle();
    await read;
    expect(ui.tasks.peekNotice()).toBeUndefined();
    await ui.finishTurn(0);
    // Nothing is left to deliver, so the ended turn starts no notice turn of its own.
    expect(ui.send.mock.calls.map(([text]) => text)).toEqual(["hello"]);
    expect(ui.take).not.toHaveBeenCalled();
  });
});

describe("a task notice the guard is holding", () => {
  test("a marked output read retires a held notice", async () => {
    const ui = mount(false, 0);
    const id = await ui.endTask();
    expect(ui.rows().some((row) => row.includes(taskNoticeHeldLine(0)))).toBe(true);
    await ui.tasks.output(id, undefined, { markSeen: true });
    expect(ui.tasks.peekNotice()).toBeUndefined();
  });
});
