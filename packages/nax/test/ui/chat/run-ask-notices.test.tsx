import { afterEach, describe, expect, mock, test } from "bun:test";
import { mountChatPicker } from "@test/helpers";
import { cleanup } from "ink-testing-library";
import type { ChatHost } from "@/chat";
import type { ChatJobs } from "@/chat/jobs/job-runner";
import type { ChatRunAsks } from "@/chat/jobs/run-asks";

afterEach(() => {
  cleanup();
});
function mount() {
  const notices: string[] = [];
  const notes: string[] = [];
  const jobNotices: string[] = [];
  const listeners = new Set<() => void>();
  const onChange = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const runAsks: ChatRunAsks = {
    peekNotice: () => notices[0],
    takeNotice: mock(() => notices.shift()),
    takeNotes: () => notes.splice(0),
    answer: async () => ({ ok: true }),
    noteUserTurn: mock(() => {}),
    onChange,
    dispose() {},
  };
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
    onChange,
  };
  const gates: Array<ReturnType<typeof Promise.withResolvers<void>>> = [];
  const send = mock<ChatHost["send"]>(async () => {
    const gate = Promise.withResolvers<void>();
    gates.push(gate);
    await gate.promise;
  });
  const ui = mountChatPicker({ runAsks, jobs, send });
  return {
    ...ui,
    runAsks,
    send,
    queue: () => {
      notices.push("run ask notice");
      jobNotices.push("job notice");
      for (const listener of listeners) listener();
    },
    note: () => {
      notes.push("[run-1] agent answered approve: within budget");
      for (const listener of listeners) listener();
    },
    finish: (i: number) => ui.settleAfter(() => gates[i]?.resolve()),
  };
}
describe("run ask notices in ChatApp", () => {
  test("AC-10/11 idle ask wins over jobs and is consumed only after delivery", async () => {
    const ui = mount();
    await ui.settleAfter(ui.queue);
    expect(ui.send.mock.calls[0]?.[0]).toBe("run ask notice");
    expect(ui.runAsks.takeNotice).not.toHaveBeenCalled();
    await ui.finish(0);
    expect(ui.runAsks.takeNotice).toHaveBeenCalledTimes(1);
    expect(ui.send.mock.calls[1]?.[0]).toBe("job notice");
    await ui.finish(1);
  });
  test("AC-12 appends outcome as read-only notice, not an agent turn", async () => {
    const ui = mount();
    await ui.settleAfter(ui.note);
    expect(ui.ui.lastFrame()).toContain("agent answered approve: within budget");
    expect(ui.send).not.toHaveBeenCalled();
    expect(ui.runAsks.takeNotes()).toEqual([]);
  });
  test("AC-13 user turn resets agent streak", async () => {
    const ui = mount();
    await ui.submit("hello");
    expect(ui.runAsks.noteUserTurn).toHaveBeenCalledTimes(1);
    await ui.finish(0);
  });
  test("failed delivery retains ask and does not reset agent streak", async () => {
    const ui = mount();
    ui.send.mockRejectedValueOnce(new Error("unavailable"));
    await ui.settleAfter(ui.queue);
    expect(ui.runAsks.peekNotice()).toBe("run ask notice");
    expect(ui.runAsks.takeNotice).not.toHaveBeenCalled();
    expect(ui.runAsks.noteUserTurn).not.toHaveBeenCalled();
    await ui.submit("/jobs");
    expect(ui.send.mock.calls[1]?.[0]).toBe("run ask notice");
    await ui.finish(0);
    expect(ui.runAsks.takeNotice).toHaveBeenCalledTimes(1);
    await ui.finish(1);
  });
});
