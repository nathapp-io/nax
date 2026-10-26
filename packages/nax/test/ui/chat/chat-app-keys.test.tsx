import { afterEach, describe, expect, mock, test } from "bun:test";
import type { SessionEvent, SessionEventBody } from "@nathapp/nax-agent";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import { type ChatHost, type ChatHostState, createChatAskController } from "@/chat";
import { ChatApp } from "@/tui/chat";
import { _chatKeyDeps } from "@/tui/chat/useChatKeys";

/**
 * The screen's keys, observed through the mounted `ChatApp`: what an escape interrupts, what
 * ctrl+o expands, where the viewport's keys land and what the footer offers once each is
 * pressed. Every frame here is the screen's own output — no handler is called directly.
 */

const originalNow = _chatKeyDeps.now;
afterEach(() => {
  cleanup();
  _chatKeyDeps.now = originalNow;
  mock.restore();
});

/** The sequences ink parses into the keys the screen owns. */
const ESCAPE = "\x1b";
const CTRL_C = "\x03";
const CTRL_O = "\x0f";
const RETURN = "\r";
const LEFT = "\x1b[D";
const UP = "\x1b[A";
const SHIFT_UP = "\x1b[1;2A";
const SHIFT_DOWN = "\x1b[1;2B";
const PAGE_UP = "\x1b[5~";
const END = "\x1b[F";

/** What the footer offers, as the screen draws it. */
const QUIT_HINT = "press ctrl-c again to quit";
const CLEAR_HINT = "esc again to clear";
const EXPANDED_HINT = "ctrl+o to collapse";
const COLLAPSED_HINT = "+2 lines (ctrl+o to expand)";

/** The five lines a scripted Bash result reports; the card shows three of them collapsed. */
const BASH_LINES = ["alpha", "bravo", "charlie", "delta", "echo"] as const;

/** A hundred transcript lines, each one named so the frame can say which it is showing. */
const CODE_LINES = Array.from({ length: 100 }, (_unused, index) => `zz${String(index + 1).padStart(3, "0")}`);
const NEWEST_CODE_LINE = CODE_LINES[CODE_LINES.length - 1] ?? "";

const STATE: ChatHostState = {
  sessionId: "keys-session",
  mode: "guarded",
  model: "test-model",
  meta: {
    schemaVersion: 1,
    sessionId: "keys-session",
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

const approval: SessionEventBody = {
  type: "approval_requested",
  requestId: "ask-1",
  tool: "Bash",
  command: "npm test",
  reason: "Run the tests",
  summary: "test",
  expiresAt: "later",
};

/**
 * The mounted screen over a typed fake host. `send` installs the listener the scripted turn
 * replays through and stays open until `settle()` — what a real turn does — so the screen
 * sees a turn in flight. Verbs run inside `act`, so a frame read after one is the frame the
 * key produced.
 */
function mount() {
  const state = STATE;
  let onEvent: (event: SessionEvent) => void = () => {};
  const gate = Promise.withResolvers<void>();
  const send = mock<ChatHost["send"]>(async (_message: string, listener: (event: SessionEvent) => void) => {
    onEvent = listener;
    await gate.promise;
  });
  const cancel = mock(() => {});
  const close = mock(async () => {});
  const asks = createChatAskController({ mode: "guarded", answer: () => {} });
  const host: ChatHost = {
    repoRoot: "/repo",
    models: [state.model],
    asks,
    current: () => state,
    notice: () => undefined,
    send,
    cancel,
    close,
    start: async () => {},
    clear: async () => {},
    resume: async () => {},
    switchTo: async () => {},
    listSessions: async () => [],
  };
  const ui = render(<ChatApp host={host} />);
  const event = (body: SessionEventBody): SessionEvent => ({
    sessionId: state.sessionId,
    turnId: "t1",
    at: "now",
    metadata: {},
    ...body,
  });
  const rows = (): string[] => (ui.lastFrame() ?? "").split("\n");
  const footer = (): string => rows().at(-1) ?? "";
  const press = (sequence: string): void =>
    act(() => {
      ui.stdin.write(sequence);
    });
  /** One keypress per frame, the way a terminal delivers typing. */
  const type = (text: string): void => {
    for (const char of text) press(char);
  };
  const settle = (): Promise<void> =>
    Promise.resolve(
      act(async () => {
        gate.resolve();
      }),
    );
  const submit = (text: string): Promise<void> =>
    Promise.resolve(
      act(async () => {
        ui.stdin.write(text);
        ui.stdin.write(RETURN);
      }),
    );
  /** Return on its own, for a case that typed its draft a keypress at a time. */
  const submitTyped = (): Promise<void> =>
    Promise.resolve(
      act(async () => {
        ui.stdin.write(RETURN);
      }),
    );
  const emit = (body: SessionEventBody): void =>
    act(() => {
      onEvent(event(body));
    });
  const ask = (body: SessionEventBody = approval): void =>
    act(() => {
      asks.handle(event(body));
    });
  /**
   * Report a terminal size on the harness stream and redraw. `ink-testing-library`'s stdout
   * has a fixed `columns` of 100 and no `rows` until one is defined, so the screen sees the
   * size only after the `resize` event it listens for.
   */
  const resize = (columns: number, terminalRows?: number): Promise<void> =>
    Promise.resolve(
      act(async () => {
        Object.defineProperty(ui.stdout, "columns", { value: columns, configurable: true });
        if (terminalRows !== undefined) {
          Object.defineProperty(ui.stdout, "rows", { value: terminalRows, configurable: true });
        }
        ui.stdout.emit("resize");
      }),
    );
  const lastFrame = (): string => ui.lastFrame() ?? "";
  return {
    ui,
    host,
    send,
    cancel,
    close,
    rows,
    footer,
    lastFrame,
    press,
    type,
    settle,
    submit,
    submitTyped,
    emit,
    ask,
    resize,
  };
}

/** A mounted screen on a 30-row terminal, started with the message `hello`. */
async function started() {
  const screen = mount();
  await screen.resize(80, 30);
  await screen.submit("hello");
  return screen;
}

describe("ChatApp interruption", () => {
  test("AC-1 escape while a scripted turn runs calls host.cancel once", async () => {
    const ui = await started();
    ui.emit({ type: "turn_start" });
    ui.press(ESCAPE);
    expect(ui.cancel).toHaveBeenCalledTimes(1);
  });

  test("AC-2 escape during a turn does not close the session", async () => {
    const ui = await started();
    ui.emit({ type: "turn_start" });
    ui.press(ESCAPE);
    expect(ui.close).not.toHaveBeenCalled();
  });

  test("AC-3 escape while no turn runs does not cancel", async () => {
    const ui = mount();
    await ui.resize(80, 30);
    ui.press(ESCAPE);
    expect(ui.cancel).not.toHaveBeenCalled();
  });

  test("AC-4 escape while an ask is pending does not cancel", async () => {
    const ui = await started();
    ui.emit({ type: "turn_start" });
    ui.ask();
    ui.press(ESCAPE);
    expect(ui.cancel).not.toHaveBeenCalled();
  });
});

describe("ChatApp transcript expansion", () => {
  /** A screen holding one finished Bash card with five result lines. */
  async function bashCard() {
    const ui = await started();
    await ui.settle();
    ui.emit({ type: "tool_call", callId: "c1", name: "Bash", input: { command: "run it" } });
    ui.emit({ type: "tool_result", callId: "c1", isError: false, preview: BASH_LINES.join("\n") });
    return ui;
  }

  test("AC-5 a collapsed Bash card advertises the two lines ctrl+o would reveal", async () => {
    const ui = await bashCard();
    expect(ui.lastFrame()).toContain(COLLAPSED_HINT);
  });

  test("AC-6 ctrl+o expands the card to every result line", async () => {
    const ui = await bashCard();
    ui.press(CTRL_O);
    for (const line of BASH_LINES) expect(ui.lastFrame()).toContain(line);
  });

  test("AC-7 ctrl+o makes the footer offer the way back to collapsed", async () => {
    const ui = await bashCard();
    ui.press(CTRL_O);
    expect(ui.footer()).toContain(EXPANDED_HINT);
  });

  test("AC-8 a second ctrl+o collapses the card again", async () => {
    const ui = await bashCard();
    ui.press(CTRL_O);
    ui.press(CTRL_O);
    expect(ui.lastFrame()).toContain(COLLAPSED_HINT);
  });
});

describe("ChatApp transcript navigation", () => {
  /** A screen whose transcript holds a hundred lines, scrolled to the newest one. */
  async function longTranscript() {
    const ui = await started();
    await ui.settle();
    ui.emit({ type: "text_delta", round: 1, text: `\`\`\`ts\n${CODE_LINES.join("\n")}\n\`\`\`` });
    return ui;
  }

  test("AC-9 pageUp scrolls the newest line out of the frame", async () => {
    const ui = await longTranscript();
    expect(ui.lastFrame()).toContain(NEWEST_CODE_LINE);
    ui.press(PAGE_UP);
    expect(ui.lastFrame()).not.toContain(NEWEST_CODE_LINE);
  });

  test("AC-10 end brings the newest line back", async () => {
    const ui = await longTranscript();
    ui.press(PAGE_UP);
    ui.press(END);
    expect(ui.lastFrame()).toContain(NEWEST_CODE_LINE);
  });

  test("AC-11 sending a message after a pageUp shows the newest line", async () => {
    const ui = await longTranscript();
    ui.press(PAGE_UP);
    expect(ui.lastFrame()).not.toContain(NEWEST_CODE_LINE);
    await ui.submit("again");
    expect(ui.send).toHaveBeenCalledTimes(2);
    expect(ui.lastFrame()).toContain("> again");
  });
});

describe("ChatApp footer and input keys", () => {
  test("AC-12 escape on a non-empty idle input arms the clear", async () => {
    const ui = mount();
    await ui.resize(80, 30);
    ui.type("draft");
    ui.press(ESCAPE);
    expect(ui.footer()).toContain(CLEAR_HINT);
  });

  test("AC-13 one ctrl-c during a turn arms the quit hint", async () => {
    _chatKeyDeps.now = () => 0;
    const ui = await started();
    ui.emit({ type: "turn_start" });
    ui.press(CTRL_C);
    expect(ui.cancel).toHaveBeenCalledTimes(1);
    expect(ui.footer()).toContain(QUIT_HINT);
  });

  test("AC-14 the input reports what was typed around a cursor move", async () => {
    const ui = mount();
    await ui.resize(80, 30);
    ui.type("ab");
    ui.press(LEFT);
    ui.press("X");
    await ui.submitTyped();
    expect(ui.send).toHaveBeenCalledWith("aXb", expect.any(Function));
  });

  test("AC-15 a resize to 60 columns redraws the header rule 60 glyphs long", async () => {
    const ui = mount();
    await ui.resize(80, 30);
    const rule = (glyph: string): string => glyph.repeat(60);
    expect(ui.rows()).not.toContain(rule("─"));
    await ui.resize(60);
    expect(ui.rows()).toContain(rule("─"));
  });
});

describe("ChatApp ctrl-c semantics", () => {
  test("AC-16 the first ctrl-c of a running turn still cancels exactly once", async () => {
    _chatKeyDeps.now = () => 0;
    const ui = await started();
    ui.emit({ type: "turn_start" });
    ui.press(CTRL_C);
    expect(ui.cancel).toHaveBeenCalledTimes(1);
    expect(ui.close).not.toHaveBeenCalled();
  });

  test("AC-17 a second ctrl-c inside the window closes the screen", async () => {
    let now = 0;
    _chatKeyDeps.now = () => now;
    const ui = await started();
    ui.emit({ type: "turn_start" });
    ui.press(CTRL_C);
    now = 1_000;
    ui.press(CTRL_C);
    await Promise.resolve(act(async () => {}));
    expect(ui.close).toHaveBeenCalledTimes(1);
  });

  test("F1 escape during teardown does not cancel the closed session again", async () => {
    let now = 0;
    _chatKeyDeps.now = () => now;
    const ui = await started();
    ui.emit({ type: "turn_start" });
    const teardown = Promise.withResolvers<void>();
    ui.close.mockImplementationOnce(() => teardown.promise);
    ui.press(CTRL_C);
    now = 1_000;
    ui.press(CTRL_C);
    // `close()` drains an in-flight control action before it closes the host.
    await Promise.resolve(act(async () => {}));
    expect(ui.close).toHaveBeenCalledTimes(1);
    expect(ui.cancel).toHaveBeenCalledTimes(1);
    // The host has marked itself closed and is draining: a late escape must not reach it.
    ui.press(ESCAPE);
    expect(ui.cancel).toHaveBeenCalledTimes(1);
    await Promise.resolve(
      act(async () => {
        teardown.resolve();
      }),
    );
  });
});

describe("ChatApp shifted arrows", () => {
  /** How many tool cards the transcript of the scrolled case holds. */
  const CARDS = 60;
  const NEWEST_CARD = `cmd${CARDS}`;

  /** A screen whose transcript holds a hundred-odd lines and whose draft is half typed. */
  async function scrolledScreen() {
    const ui = await started();
    await ui.settle();
    for (let index = 0; index < CARDS; index++) {
      ui.emit({ type: "tool_call", callId: `c${index}`, name: "Bash", input: { command: `cmd${index + 1}` } });
    }
    ui.type("my draft");
    return ui;
  }

  test("F2 shift+up scrolls the transcript and keeps the draft", async () => {
    const ui = await scrolledScreen();
    expect(ui.lastFrame()).toContain(NEWEST_CARD);
    expect(ui.lastFrame()).toContain("> my draft");
    ui.press(SHIFT_UP);
    expect(ui.lastFrame()).not.toContain(NEWEST_CARD);
    expect(ui.lastFrame()).toContain("> my draft");
    await ui.submitTyped();
    expect(ui.send).toHaveBeenLastCalledWith("my draft", expect.any(Function));
  });

  test("F2 shift+down keeps the draft and the bare arrows still browse history", async () => {
    const ui = await scrolledScreen();
    ui.press(SHIFT_DOWN);
    expect(ui.lastFrame()).toContain("> my draft");
    ui.press(UP);
    await ui.submitTyped();
    expect(ui.send).toHaveBeenLastCalledWith("hello", expect.any(Function));
  });
});
