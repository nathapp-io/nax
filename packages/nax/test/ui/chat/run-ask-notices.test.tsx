import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { assertDefined, cleanupTempDir, makeFakeClock, makeLogger, makeTempDir, mountChatPicker } from "@test/helpers";
import { cleanup } from "ink-testing-library";
import type { ChatHost } from "@/chat";
import type { ChatJobs } from "@/chat/jobs/job-runner";
import { jobAsksDir } from "@/chat/jobs/job-store";
import type { ChatJob } from "@/chat/jobs/job-types";
import { _runAsksDeps, type ChatRunAsks, createRunAsks } from "@/chat/jobs/run-asks";
import { RUN_ASK_POLL_MS, writeChatAsk } from "@/interaction/chat-ask-files";
import type { InteractionRequest } from "@/interaction/types";

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
  test("real registry keeps second ask when first is answered during delivery", async () => {
    const outputDir = makeTempDir("run-ask-ui-");
    const original = { ..._runAsksDeps };
    const clock = makeFakeClock();
    let scanned = Promise.resolve();
    Object.assign(_runAsksDeps, {
      setTimeout: (callback: () => void | Promise<void>, ms: number) =>
        clock.setTimeout(() => {
          scanned = Promise.resolve(callback());
        }, ms),
      clearTimeout: clock.clearTimeout,
    });
    const job: ChatJob = {
      schemaVersion: 1,
      id: "run-1a2b3c4d",
      kind: "run",
      target: "feature",
      argv: [],
      cwd: outputDir,
      pid: 1,
      startedAt: new Date(0).toISOString(),
      state: "running",
      logPath: "log",
      sessionId: "session",
      approvedAt: new Date(0).toISOString(),
      chainId: "chain-1",
    };
    const secret = new Uint8Array(32).fill(7);
    const dir = jobAsksDir(outputDir, job.id);
    mkdirSync(dir, { recursive: true });
    const registry = createRunAsks({
      outputDir,
      now: () => new Date(0),
      logger: makeLogger(),
      chains: { isActive: () => true },
      asks: { requestHostChoice: async () => "closed", requestHostQuestion: async () => null },
      jobs: { running: () => [job], get: () => job, askSecret: () => secret, onChange: () => () => {} },
    });
    try {
      const request: InteractionRequest = {
        id: "first",
        type: "confirm",
        featureName: "feature",
        stage: "cost",
        summary: "Proceed?",
        fallback: "abort",
        createdAt: 0,
      };
      const first = await writeChatAsk(dir, request, new Date(0), secret);
      await writeChatAsk(dir, { ...request, id: "second" }, new Date(0), secret);
      await clock.advance(RUN_ASK_POLL_MS);
      await scanned;
      // Use actual queue order (file keys, not request creation order).
      const notice = registry.peekNotice();
      const firstId = notice?.includes(first) ? `${job.id}/${first}` : undefined;
      const delivered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const send = mock<ChatHost["send"]>(async () => {
        if (send.mock.calls.length === 1) {
          // The notice includes the public ask id outside the untrusted block.
          const id = firstId ?? notice?.match(/run-1a2b3c4d\/[a-f0-9]{16}/)?.[0];
          if (!id) throw new Error("missing ask id");
          expect(await registry.answer(id, { answer: "approve", reason: "approved chain" })).toEqual({ ok: true });
          delivered.resolve();
          await release.promise;
        }
      });
      const ui = mountChatPicker({ runAsks: registry, send });
      await delivered.promise;
      const secondNotice = registry.peekNotice();
      assertDefined(secondNotice);
      await ui.settleAfter(() => release.resolve());
      expect(send.mock.calls[1]?.[0]).toBe(secondNotice);
      ui.ui.unmount();
    } finally {
      registry.dispose();
      Object.assign(_runAsksDeps, original);
      cleanupTempDir(outputDir);
    }
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
    await ui.submit("/mcp");
    expect(ui.send.mock.calls[1]?.[0]).toBe("run ask notice");
    await ui.finish(0);
    expect(ui.runAsks.takeNotice).toHaveBeenCalledTimes(1);
    await ui.finish(1);
  });
});
