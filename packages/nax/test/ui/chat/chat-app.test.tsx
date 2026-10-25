import { afterEach, describe, expect, mock, test } from "bun:test";
import type { SessionEvent, SessionEventBody } from "@nathapp/nax-agent";
import { Box } from "ink";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import type { ChatHost, ChatHostState } from "@/chat";
import { _renderChatDeps, ChatApp, renderChat } from "@/tui/chat";

const originalRender = _renderChatDeps.render;
afterEach(() => {
  cleanup();
  _renderChatDeps.render = originalRender;
  mock.restore();
});

function fakeHost(overrides: Partial<ChatHostState> = {}, notice?: string) {
  let state: ChatHostState = {
    sessionId: "abcdefgh-1234",
    mode: "guarded",
    model: "test-model",
    meta: {
      schemaVersion: 1,
      sessionId: "abcdefgh-1234",
      cwd: "/repo",
      mode: "ask",
      model: "test-model",
      bashApproval: "gated",
      title: null,
      createdAt: "now",
      updatedAt: null,
      costUsd: 0,
    },
    ...overrides,
  };
  let onEvent: (event: SessionEvent) => void = () => {};
  const gate = Promise.withResolvers<void>();
  const send = mock(async (_message: string, listener: (event: SessionEvent) => void) => {
    onEvent = listener;
    await gate.promise;
  });
  const host: ChatHost = {
    repoRoot: "/repo",
    models: ["test-model"],
    asks: {
      pending: () => [],
      canRemember: () => false,
      resolve: () => {},
      setMode: () => {},
      reset: () => {},
      handle: () => {},
      answerQuestion: () => {},
      onChange: () => () => {},
    },
    current: () => state,
    notice: () => notice,
    send,
    start: async () => {},
    clear: async () => {},
    resume: async () => {},
    switchTo: async () => {},
    cancel: () => {},
    listSessions: async () => [],
    close: async () => {},
  };
  return {
    host,
    send,
    finish: () => gate.resolve(),
    setState: (next: ChatHostState) => {
      state = next;
    },
    emit: (body: SessionEventBody) =>
      onEvent({ sessionId: state.sessionId, turnId: "t1", at: "now", metadata: {}, ...body }),
  };
}

function mount(overrides: Partial<ChatHostState> = {}, notice?: string) {
  const fake = fakeHost(overrides, notice);
  const ui = render(<ChatApp host={fake.host} />);
  const type = (text: string) =>
    act(() => {
      ui.stdin.write(text);
    });
  const start = () => {
    type("hello");
    type("\r");
  };
  const emit = (body: SessionEventBody) => act(() => fake.emit(body));
  return { ...fake, ...ui, type, start, emit };
}
const errored: SessionEventBody = {
  type: "turn_end",
  status: "errored",
  output: "",
  usage: { inputTokens: 0, outputTokens: 0 },
  costUsd: 0,
  error: { code: "X", message: "turn broke" },
};

describe("chat shell", () => {
  test("AC-1 renderChat renders with Ctrl-C exit disabled and unmounts", () => {
    const renderSpy = mock<typeof originalRender>((node) => {
      const ui = render(<Box flexDirection="column">{node}</Box>);
      return { rerender: ui.rerender, unmount: ui.unmount, waitUntilExit: async () => {}, cleanup, clear: () => {} };
    });
    _renderChatDeps.render = renderSpy;
    const view = renderChat({ host: fakeHost().host });
    expect(renderSpy.mock.calls[0]?.[1]).toEqual({ exitOnCtrlC: false });
    expect(() => view.unmount()).not.toThrow();
  });
  test("AC-2 sends hello", () => {
    const ui = mount();
    ui.start();
    expect(ui.send).toHaveBeenCalledWith("hello", expect.any(Function));
  });
  test("AC-3 Alt-Enter inserts a newline", () => {
    const ui = mount();
    ui.type("a");
    ui.type("\x1b\r");
    ui.type("b");
    ui.type("\r");
    expect(ui.send).toHaveBeenCalledWith("a\nb", expect.any(Function));
  });
  test("AC-4 keeps draft and ignores Enter during a turn", () => {
    const ui = mount();
    ui.start();
    ui.type("draft");
    ui.type("\r");
    expect(ui.send).toHaveBeenCalledTimes(1);
    expect(ui.lastFrame()).toContain("> draft");
  });
  test("AC-5 joins streamed assistant deltas", () => {
    const ui = mount();
    ui.start();
    ui.emit({ type: "text_delta", round: 1, text: "Hel" });
    ui.emit({ type: "text_delta", round: 1, text: "lo" });
    expect(ui.lastFrame()).toContain("Hello");
  });
  test.each([
    ["AC-6", false, "ok"],
    ["AC-7", true, "error"],
  ] as const)("%s correlates tool results", (_ac, isError, label) => {
    const ui = mount();
    ui.start();
    ui.emit({ type: "tool_call", callId: "c1", name: "Read", input: { path: "src/a.ts" } });
    ui.emit({ type: "tool_result", callId: "c1", isError, preview: "ignored preview" });
    expect(ui.lastFrame()).toContain(`Read src/a.ts [${label}]`);
    expect(ui.lastFrame()?.split("Read src/a.ts")).toHaveLength(2);
  });
  test("AC-8 shows Bash command", () => {
    const ui = mount();
    ui.start();
    ui.emit({ type: "tool_call", callId: "c1", name: "Bash", input: { command: "bun run build" } });
    expect(ui.lastFrame()).toContain("Bash bun run build");
  });
  test("AC-9 collapses private thinking", () => {
    const ui = mount();
    ui.start();
    ui.emit({ type: "thinking_delta", round: 1, text: "secret" });
    ui.emit({ type: "thinking_delta", round: 1, text: "more secret" });
    expect(ui.lastFrame()?.split("thinking...")).toHaveLength(2);
    expect(ui.lastFrame()).not.toContain("secret");
  });
  test("AC-10 shows model and mode", () => {
    expect(mount().lastFrame()).toContain("test-model | guarded");
  });
  test("AC-11 shows shortened id and initial spend", () => {
    expect(mount().lastFrame()).toContain("abcdefgh | $0.00");
  });
  test.each([
    ["AC-12", { kind: "available", backend: "srt", network: "open" }, "on"],
    ["AC-13", { kind: "unavailable", backend: "srt", reason: "missing" }, "unavailable"],
    ["AC-14", undefined, "off"],
    ["disabled sandbox", { kind: "disabled" }, "off"],
  ] as const)("%s shows sandbox state", (_ac, sandbox, label) => {
    expect(mount({ sandbox }).lastFrame()).toContain(`sandbox ${label}`);
  });
  test("AC-15 renders resume notice", async () => {
    const notice = "The last turn was interrupted. Send a message to continue it.";
    const ui = mount({}, notice);
    await Promise.resolve(act(async () => {}));
    expect(ui.lastFrame()).toContain(notice);
  });
  test("AC-16 warns once in full mode without a sandbox", () => {
    const ui = mount({ mode: "full", sandbox: { kind: "unavailable", backend: "srt", reason: "missing" } });
    ui.start();
    ui.emit({ type: "text_delta", round: 1, text: "text" });
    expect(ui.lastFrame()?.split("sandbox unavailable: commands run outside the sandbox")).toHaveLength(2);
  });
  test("AC-17 shows terminal error code and message", () => {
    const ui = mount();
    ui.start();
    ui.emit(errored);
    expect(ui.lastFrame()).toContain("X: turn broke");
  });
  test("AC-18 allows another message after an errored turn completes", async () => {
    const ui = mount();
    ui.start();
    ui.emit(errored);
    await Promise.resolve(
      act(async () => {
        ui.finish();
      }),
    );
    ui.type("next");
    ui.type("\r");
    expect(ui.send).toHaveBeenLastCalledWith("next", expect.any(Function));
  });
  test("refreshes spend and retains a busy draft when send settles", async () => {
    const ui = mount();
    ui.start();
    ui.type("draft");
    ui.type("\r");
    const state = ui.host.current();
    ui.setState({ ...state, meta: { ...state.meta, costUsd: 1.236 } });
    await Promise.resolve(
      act(async () => {
        ui.finish();
      }),
    );
    expect(ui.lastFrame()).toContain("$1.24");
    expect(ui.lastFrame()).toContain("> draft");
    ui.type("\r");
    expect(ui.send).toHaveBeenLastCalledWith("draft", expect.any(Function));
  });
  test("warns on every transition into full but not on ordinary rerenders", async () => {
    const ui = mount({ sandbox: { kind: "unavailable", backend: "srt", reason: "missing" } });
    const warning = "sandbox unavailable: commands run outside the sandbox";
    expect(ui.lastFrame()).not.toContain(warning);
    for (const mode of ["full", "guarded", "full"] as const) {
      ui.setState({ ...ui.host.current(), mode });
      await Promise.resolve(
        act(async () => {
          ui.rerender(<ChatApp host={ui.host} />);
        }),
      );
    }
    expect(ui.lastFrame()?.split(warning)).toHaveLength(3);
    await Promise.resolve(
      act(async () => {
        ui.rerender(<ChatApp host={ui.host} />);
      }),
    );
    expect(ui.lastFrame()?.split(warning)).toHaveLength(3);
  });
  test.each(["Read", "Write", "Edit", "Delete", "Bash"])("limits %s detail to a single 60-character line", (name) => {
    const ui = mount();
    ui.start();
    const detail = `first\n${"x".repeat(80)}`;
    ui.emit({ type: "tool_call", callId: "c1", name, input: { path: detail, command: detail } });
    expect(ui.lastFrame()).toContain(`${name} first ${"x".repeat(54)}`);
    expect(ui.lastFrame()).not.toContain("x".repeat(55));
  });
  test("ignores unknown tool detail and unrelated results", () => {
    const ui = mount();
    ui.start();
    ui.emit({ type: "tool_call", callId: "c1", name: "Git", input: { command: "private" } });
    ui.emit({ type: "tool_result", callId: "missing", isError: true, preview: "private" });
    expect(ui.lastFrame()).toContain("Git");
    expect(ui.lastFrame()).not.toContain("private");
    expect(ui.lastFrame()).not.toContain("[error]");
  });
  test("ignores blank sends and global key combinations, and supports deleting input", () => {
    const ui = mount();
    ui.type("\r");
    expect(ui.send).not.toHaveBeenCalled();
    ui.type("\x03");
    ui.type("\t");
    ui.type("ab");
    ui.type("\x7f");
    ui.type("\r");
    expect(ui.send).toHaveBeenCalledWith("a", expect.any(Function));
  });
  test("AC-19 survives rejected host.send", async () => {
    const ui = mount();
    ui.send.mockRejectedValueOnce(new Error("send failed"));
    await Promise.resolve(
      act(async () => {
        ui.start();
      }),
    );
    expect(ui.lastFrame()).toContain("send failed");
    ui.type("next");
    ui.type("\r");
    expect(ui.send).toHaveBeenLastCalledWith("next", expect.any(Function));
  });
});
