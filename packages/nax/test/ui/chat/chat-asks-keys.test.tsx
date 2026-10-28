import { afterEach, describe, expect, mock, test } from "bun:test";
import { type AgentSession, createSessionStorage, type SessionEvent, type SessionEventBody } from "@nathapp/nax-agent";
import { cleanupTempDir, makeLogger, makeNaxConfig, makeTempDir } from "@test/helpers";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import { type ChatHost, type ChatHostState, createChatAskController, createChatHost } from "@/chat";
import { ChatApp } from "@/tui/chat";
import { _chatKeyDeps } from "@/tui/chat/useChatKeys";

const originalNow = _chatKeyDeps.now;
afterEach(() => {
  cleanup();
  _chatKeyDeps.now = originalNow;
});

const approval: SessionEventBody = {
  type: "approval_requested",
  requestId: "ask-1",
  tool: "Bash",
  command: "npm test",
  reason: "Run the tests",
  summary: "test",
  expiresAt: "later",
};
const end: SessionEventBody = {
  type: "turn_end",
  status: "completed",
  output: "",
  costUsd: 0,
  usage: { inputTokens: 0, outputTokens: 0 },
};
function mount(sandbox?: ChatHostState["sandbox"]) {
  let state: ChatHostState = {
    sessionId: "abcdefgh-1234",
    mode: "guarded",
    model: "model",
    sandbox,
    meta: {
      schemaVersion: 1,
      sessionId: "abcdefgh-1234",
      cwd: "/repo",
      mode: "ask",
      model: "model",
      bashApproval: "gated",
      title: null,
      createdAt: "now",
      updatedAt: null,
    },
  };
  const event = (body: SessionEventBody): SessionEvent => ({
    sessionId: state.sessionId,
    turnId: "t1",
    at: "now",
    metadata: {},
    ...body,
  });
  const asks = createChatAskController({ mode: "guarded", answer: () => {} });
  const resolve = mock(asks.resolve.bind(asks));
  asks.resolve = resolve;
  const answer = mock(asks.answerQuestion.bind(asks));
  asks.answerQuestion = answer;
  const gate = Promise.withResolvers<void>();
  let listener: (event: SessionEvent) => void = () => {};
  const send = mock(async (_text: string, onEvent: typeof listener) => {
    listener = onEvent;
    await gate.promise;
  });
  const switchTo = mock<ChatHost["switchTo"]>(async ({ mode }) => {
    state = { ...state, mode: mode ?? state.mode };
  });
  const close = mock(async () => {});
  const cancel = mock(() => {});
  const host: ChatHost = {
    repoRoot: "/repo",
    models: ["model"],
    asks,
    current: () => state,
    notice: () => undefined,
    send,
    switchTo,
    close,
    cancel,
    start: async () => {},
    resume: async () => {},
    clear: async () => {},
    listSessions: async () => [],
  };
  const ui = render(<ChatApp host={host} />);
  const type = (text: string) =>
    act(() => {
      ui.stdin.write(text);
    });
  const start = () => {
    type("hello");
    type("\r");
  };
  const pending = (body: SessionEventBody = approval) => act(() => asks.handle(event(body)));
  const finish = () =>
    Promise.resolve(
      act(async () => {
        listener(event(end));
        gate.resolve();
      }),
    );
  return { ...ui, host, type, start, pending, finish, resolve, answer, send, switchTo, close, cancel };
}
const flush = () => Promise.resolve(act(async () => {}));

describe("chat asks and keys", () => {
  test.each(["pending ask", "mid-turn"] as const)("quits cleanly with the real host: %s", async (scenario) => {
    const dir = makeTempDir("chat-quit-");
    const turn = Promise.withResolvers<void>();
    const teardown = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const session: AgentSession = {
      id: "quit-session",
      backend: { kind: "native", capabilities: {} },
      lastTurn: undefined,
      async *send() {
        const base = { sessionId: "quit-session", turnId: "t1", at: new Date().toISOString(), metadata: {} };
        yield { ...base, type: "turn_start" };
        if (scenario === "pending ask") yield { ...base, ...approval };
        started.resolve();
        await turn.promise;
        yield { ...base, ...end };
      },
      answer: () => "accepted",
      cancel: () => turn.resolve(),
      close: async () => {
        turn.resolve();
        await teardown.promise;
      },
    };
    const unlock = mock(async () => {});
    const release = mock(async (options?: { readonly retainLock?: boolean }) => {
      if (!options?.retainLock) await unlock();
    });
    const host = createChatHost({
      config: makeNaxConfig({ outputDir: dir }),
      cwd: dir,
      repoRoot: dir,
      chain: null,
      storage: createSessionStorage({ dir, pid: process.pid, now: () => new Date(), logger: makeLogger() }),
      now: () => new Date(),
      logger: makeLogger(),
      open: async () => ({
        session,
        meta: {
          schemaVersion: 1,
          sessionId: session.id,
          cwd: dir,
          mode: "ask",
          model: "model",
          bashApproval: "gated",
          title: null,
          createdAt: new Date().toISOString(),
          updatedAt: null,
        },
        release,
      }),
    });
    try {
      await host.start({ mode: "guarded", model: "model" });
      const ui = render(<ChatApp host={host} />);
      act(() => {
        ui.stdin.write("hello");
      });
      await Promise.resolve(
        act(async () => {
          ui.stdin.write("\r");
          await started.promise;
        }),
      );
      if (scenario === "pending ask") expect(ui.lastFrame()).toContain("Run the tests");
      await Promise.resolve(
        act(async () => {
          if (scenario === "pending ask") {
            ui.stdin.write("\x03");
            ui.stdin.write("\x03");
          } else {
            ui.stdin.write("/quit");
            ui.stdin.write("\r");
          }
        }),
      );
      // Teardown is deliberately blocked while ask/turn updates rerender the shell.
      expect(ui.lastFrame()).toContain("model · guarded");
      expect(ui.frames.join("\n")).not.toContain("CHAT_HOST_CLOSED");
      expect(release).not.toHaveBeenCalled();
      await Promise.resolve(
        act(async () => {
          teardown.resolve();
          await host.close();
        }),
      );
      await flush();
      expect(release.mock.calls).toEqual([[{ retainLock: true }], []]);
      expect(unlock).toHaveBeenCalledTimes(1);
      expect(ui.stdin.listenerCount("readable")).toBe(0);
    } finally {
      turn.resolve();
      teardown.resolve();
      cleanup();
      await host.close();
      cleanupTempDir(dir);
    }
  });
  test("AC-1 renders Bash command and reason", () => {
    const ui = mount();
    ui.pending();
    expect(ui.lastFrame()).toContain("Bash");
    expect(ui.lastFrame()).toContain("npm test");
    expect(ui.lastFrame()).toContain("Run the tests");
  });
  test.each([
    ["AC-2", "a", "allow_once"],
    ["AC-3", "s", "allow_session"],
    ["AC-5", "d", "deny"],
  ] as const)("%s resolves approval", (_ac, key, choice) => {
    const ui = mount();
    ui.pending();
    if (key === "s") expect(ui.lastFrame()).toContain("Yes, and don't ask again for this in this session");
    ui.type(key);
    expect(ui.resolve).toHaveBeenCalledWith("ask-1", choice);
    expect(ui.lastFrame()).not.toContain("Run the tests");
    ui.type("\r");
    expect(ui.send).not.toHaveBeenCalled();
  });
  test("AC-4 hides and ignores disabled session memory", () => {
    const ui = mount();
    ui.pending({ ...approval, unsandboxed: true });
    expect(ui.lastFrame()).toContain("npm test");
    expect(ui.lastFrame()).not.toContain("Yes, and don't ask again for this in this session");
    ui.type("s");
    expect(ui.resolve).not.toHaveBeenCalled();
    ui.type("a");
    expect(ui.resolve).toHaveBeenCalledWith("ask-1", "allow_once");
  });
  test("AC-6 labels unsandboxed commands", () => {
    const ui = mount();
    ui.pending({ ...approval, unsandboxed: true });
    expect(ui.lastFrame()).toContain("outside the sandbox");
  });
  test("AC-7 renders a question and submits typed answer exclusively", () => {
    const ui = mount();
    ui.pending({ type: "question", requestId: "q1", text: "Proceed?", expiresAt: "later" });
    expect(ui.lastFrame()).toContain("Proceed?");
    ui.type("yes");
    ui.type("\r");
    expect(ui.answer).toHaveBeenCalledWith("q1", "yes");
    expect(ui.send).not.toHaveBeenCalled();
    expect(ui.lastFrame()).not.toContain("Proceed?");
  });
  test("AC-8 Shift-Tab switches between turns", async () => {
    const ui = mount();
    ui.type("\x1b[Z");
    await flush();
    expect(ui.switchTo).toHaveBeenCalledWith({ mode: "full" });
  });
  test("AC-9 refreshes status after switch", async () => {
    const ui = mount();
    ui.type("\x1b[Z");
    await flush();
    expect(ui.lastFrame()).toContain("model · full");
  });
  test("AC-10 and AC-11 defer mode switch until turn_end", async () => {
    const ui = mount();
    ui.start();
    ui.type("\x1b[Z");
    expect(ui.switchTo).not.toHaveBeenCalled();
    await ui.finish();
    expect(ui.switchTo).toHaveBeenCalledTimes(1);
    expect(ui.switchTo).toHaveBeenCalledWith({ mode: "full" });
  });
  test("AC-12 warns on every entry into unavailable full mode", async () => {
    const ui = mount({ kind: "unavailable", backend: "srt", reason: "missing" });
    for (let i = 0; i < 3; i++) {
      ui.type("\x1b[Z");
      await flush();
    }
    expect(ui.lastFrame()?.split("sandbox unavailable: commands run outside the sandbox")).toHaveLength(3);
  });
  test("AC-13 Ctrl-C during a turn cancels but does not close", () => {
    const ui = mount();
    ui.start();
    ui.type("c");
    expect(ui.cancel).not.toHaveBeenCalled();
    ui.type("\x03");
    expect(ui.cancel).toHaveBeenCalledTimes(1);
    expect(ui.close).not.toHaveBeenCalled();
  });
  test("AC-14 second Ctrl-C closes and exits", async () => {
    let now = 0;
    _chatKeyDeps.now = () => now;
    const ui = mount();
    ui.start();
    ui.type("\x03");
    expect(ui.stdin.listenerCount("readable")).toBeGreaterThan(0);
    now = 2_000;
    ui.type("\x03");
    await flush();
    expect(ui.close).toHaveBeenCalledTimes(1);
    expect(ui.stdin.listenerCount("readable")).toBe(0);
    const frames = ui.frames.length;
    ui.type("ignored");
    await flush();
    expect(ui.frames).toHaveLength(frames);
  });
  test("AC-15 Ctrl-C between turns closes and exits", async () => {
    const ui = mount();
    expect(ui.stdin.listenerCount("readable")).toBeGreaterThan(0);
    ui.type("\x03");
    await flush();
    expect(ui.close).toHaveBeenCalledTimes(1);
    expect(ui.stdin.listenerCount("readable")).toBe(0);
    const frames = ui.frames.length;
    ui.type("ignored");
    await flush();
    expect(ui.frames).toHaveLength(frames);
  });
  test("does not answer asks while close is pending", async () => {
    const ui = mount();
    ui.pending();
    const gate = Promise.withResolvers<void>();
    ui.close.mockImplementationOnce(() => gate.promise);
    ui.type("\x03");
    ui.type("a");
    expect(ui.resolve).not.toHaveBeenCalled();
    await Promise.resolve(
      act(async () => {
        gate.resolve();
      }),
    );
  });
  test("Ctrl-C beyond two seconds cancels again instead of closing", () => {
    let now = 0;
    _chatKeyDeps.now = () => now;
    const ui = mount();
    ui.start();
    ui.type("\x03");
    now = 2_001;
    ui.type("\x03");
    expect(ui.cancel).toHaveBeenCalledTimes(2);
    expect(ui.close).not.toHaveBeenCalled();
  });
  test("preserves the message draft and resets each question answer", () => {
    const ui = mount();
    ui.type("draft");
    ui.pending({ type: "question", requestId: "q1", text: "First?", expiresAt: "later" });
    ui.pending({ type: "question", requestId: "q2", text: "Second?", expiresAt: "later" });
    ui.type("yex");
    ui.type("\x7f");
    ui.type("s");
    ui.type("\r");
    expect(ui.answer).toHaveBeenLastCalledWith("q1", "yes");
    expect(ui.lastFrame()).toContain("Second?");
    ui.type("no");
    ui.type("\r");
    expect(ui.answer).toHaveBeenLastCalledWith("q2", "no");
    ui.type("\r");
    expect(ui.send).toHaveBeenCalledWith("draft", expect.any(Function));
  });
  test("finishes an in-flight switch before closing its new session", async () => {
    const ui = mount();
    const gate = Promise.withResolvers<void>();
    ui.switchTo.mockImplementationOnce(() => gate.promise);
    ui.type("\x1b[Z");
    ui.type("\x03");
    expect(ui.close).not.toHaveBeenCalled();
    await Promise.resolve(
      act(async () => {
        gate.resolve();
      }),
    );
    expect(ui.close).toHaveBeenCalledTimes(1);
    expect(ui.stdin.listenerCount("readable")).toBe(0);
  });
  test("surfaces failed switches and permits retry", async () => {
    const ui = mount();
    ui.switchTo.mockRejectedValueOnce(new Error("switch failed"));
    ui.type("\x1b[Z");
    await flush();
    expect(ui.lastFrame()).toContain("switch failed");
    expect(ui.lastFrame()).toContain("model · guarded");
    ui.type("\x1b[Z");
    await flush();
    expect(ui.lastFrame()).toContain("model · full");
  });
  test("surfaces failed close without exiting and permits retry", async () => {
    const ui = mount();
    ui.close.mockRejectedValueOnce(new Error("close failed"));
    ui.type("\x03");
    await flush();
    expect(ui.lastFrame()).toContain("close failed");
    expect(ui.stdin.listenerCount("readable")).toBeGreaterThan(0);
    ui.type("\x03");
    await flush();
    expect(ui.close).toHaveBeenCalledTimes(2);
    expect(ui.stdin.listenerCount("readable")).toBe(0);
  });
  test("two queued cycles return to guarded without switching early", async () => {
    const ui = mount();
    ui.start();
    ui.type("\x1b[Z");
    ui.type("\x1b[Z");
    expect(ui.switchTo).not.toHaveBeenCalled();
    await ui.finish();
    expect(ui.switchTo).toHaveBeenCalledWith({ mode: "guarded" });
  });
  test("Ctrl+approval letters never resolve an ask", () => {
    const ui = mount();
    ui.pending();
    for (const key of ["\x01", "\x13", "\x04"]) ui.type(key);
    expect(ui.resolve).not.toHaveBeenCalled();
    ui.type("d");
    expect(ui.resolve).toHaveBeenCalledWith("ask-1", "deny");
  });
});
