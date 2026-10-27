import { afterEach, describe, expect, mock, test } from "bun:test";
import type { CommandRunResult, SessionEvent, SessionEventBody } from "@nathapp/nax-agent";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import { type ChatHost, type ChatHostState, type ChatMcpState, createChatAskController } from "@/chat";
import { buildResourceCatalog, type ResourcePackage } from "@/resources";
import { ChatApp, type ChatTheme, resolveChatTheme } from "@/tui/chat";
import { _clipboardDeps, osc52 } from "@/tui/chat/clipboard";
import type { MouseEvents } from "@/tui/chat/mouse-input";
import { fakeMouse } from "./mouse";

/**
 * The mounted screen, as the acceptance criteria observe it: the frame's rows, the events a
 * scripted turn replays through `host.send`, and the terminal size the stream reports.
 */
afterEach(() => {
  cleanup();
  mock.restore();
});

const STATE: ChatHostState = {
  sessionId: "layout-session",
  mode: "guarded",
  model: "test-model",
  meta: {
    schemaVersion: 1,
    sessionId: "layout-session",
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

const SANDBOX_WARNING = "sandbox unavailable: commands run outside the sandbox";
/** The rows the fixed regions claim: header (3), the input's two rules and one text row, and the footer. */
const FIXED_ROWS_WITHOUT_VIEWPORT = 3 + 3 + 1;

interface MountOptions {
  readonly mouse?: MouseEvents;
  readonly state?: Partial<ChatHostState>;
  readonly mcp?: ChatMcpState;
  readonly catalog?: ChatHost["catalog"];
  readonly runCommand?: ChatHost["runCommand"];
  /** The theme the screen draws with; absent means the screen's own colourless default. */
  readonly theme?: ChatTheme;
}

function fakeHost(options: MountOptions = {}) {
  let state: ChatHostState = { ...STATE, ...options.state };
  let onEvent: (event: SessionEvent) => void = () => {};
  const gate = Promise.withResolvers<void>();
  const send = mock<ChatHost["send"]>(async (_message: string, listener: (event: SessionEvent) => void) => {
    onEvent = listener;
    await gate.promise;
  });
  const close = mock(async () => {});
  const cancel = mock(() => {});
  const host: ChatHost = {
    repoRoot: "/repo",
    models: [STATE.model],
    asks: createChatAskController({ mode: "guarded", answer: () => {} }),
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
    ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
    ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
    ...(options.runCommand === undefined ? {} : { runCommand: options.runCommand }),
  };
  return {
    host,
    send,
    close,
    cancel,
    setState: (next: ChatHostState) => {
      state = next;
    },
    event: (body: SessionEventBody, metadata: Readonly<Record<string, string>> = {}): SessionEvent => ({
      sessionId: state.sessionId,
      turnId: "t1",
      at: "now",
      metadata,
      ...body,
    }),
    emit: (body: SessionEventBody, metadata: Readonly<Record<string, string>> = {}) =>
      onEvent({ sessionId: state.sessionId, turnId: "t1", at: "now", metadata, ...body }),
    finish: () => gate.resolve(),
  };
}

function mount(options: MountOptions = {}) {
  const fake = fakeHost(options);
  const ui = render(
    <ChatApp
      host={fake.host}
      mouse={options.mouse}
      {...(options.theme === undefined ? {} : { theme: options.theme })}
    />,
  );
  const rows = () => (ui.lastFrame() ?? "").split("\n");
  const type = (text: string) =>
    act(() => {
      ui.stdin.write(text);
    });
  const line = async (text: string) => {
    type(text);
    await Promise.resolve(
      act(async () => {
        ui.stdin.write("\r");
      }),
    );
  };
  const start = async () => {
    await Promise.resolve(
      act(async () => {
        type("hello");
        ui.stdin.write("\r");
      }),
    );
  };
  const emit = (body: SessionEventBody, metadata: Readonly<Record<string, string>> = {}) =>
    act(() => {
      fake.emit(body, metadata);
    });
  /** Raise a pending ask on the host, the way the turn's event stream does. */
  const ask = (body: SessionEventBody) =>
    act(() => {
      fake.host.asks.handle(fake.event(body));
    });
  /**
   * Report a terminal size on the harness stream and redraw. `ink-testing-library`'s stdout
   * has a fixed `columns` of 100 and no `rows` until one is defined, so the screen sees the
   * size only after the `resize` event it listens for.
   */
  const resize = async (columns: number, terminalRows?: number) => {
    Object.defineProperty(ui.stdout, "columns", { value: columns, configurable: true });
    if (terminalRows !== undefined) {
      Object.defineProperty(ui.stdout, "rows", { value: terminalRows, configurable: true });
    }
    await Promise.resolve(
      act(async () => {
        ui.stdout.emit("resize");
      }),
    );
  };
  const settle = () =>
    Promise.resolve(
      act(async () => {
        fake.finish();
      }),
    );
  return { ...fake, ...ui, rows, type, line, start, emit, ask, resize, settle };
}

/** The one row of the frame matching `match`, or undefined when the frame has none. */
function rowMatching(rows: readonly string[], match: RegExp): string | undefined {
  return rows.find((row) => match.test(row));
}

const harness = async (options: MountOptions = {}) => {
  const ui = mount(options);
  await ui.resize(80, 30);
  return ui;
};

describe("ChatApp full-screen layout", () => {
  test("AC-1 a 30-row terminal renders a frame of 29 rows", async () => {
    const ui = await harness();
    expect(ui.rows()).toHaveLength(29);
  });

  test("AC-2 the frame opens with the product and version in the header", async () => {
    const ui = await harness();
    expect(ui.rows()[0]).toStartWith("✻ nax chat");
  });

  test("AC-3 the frame closes with the mode in the footer", async () => {
    const ui = await harness();
    expect(ui.rows().at(-1)).toContain("⏵ guarded");
    expect(ui.rows()).toHaveLength(29);
  });

  test("AC-4 a stream with no rows renders the 23 usable rows of the default", () => {
    const ui = mount();
    expect(ui.rows()).toHaveLength(23);
  });

  test("AC-5 a 5-row terminal does not throw and keeps the footer", async () => {
    const ui = mount();
    await ui.resize(80, 5);
    expect(ui.rows()).toContainEqual(expect.stringContaining("⏵ guarded"));
  });

  test("AC-7 the welcome banner counts a host with no catalog or MCP as zero", () => {
    const ui = mount();
    expect(rowMatching(ui.rows(), /skills 0 · commands 0 · mcp 0 \(0 connected\) · agents 0/)).toBeDefined();
  });

  test("AC-8 a sent message is a user transcript row", async () => {
    const ui = await harness();
    await ui.start();
    expect(ui.rows()).toContain("> hello");
  });

  test("AC-9 a bold reply renders without its markdown markers", async () => {
    const ui = await harness();
    await ui.start();
    ui.emit({ type: "text_delta", round: 1, text: "**done**" });
    expect(ui.rows()).toContain("⏺ done");
  });

  test("AC-10 a fenced code block renders its code side glyph", async () => {
    const ui = await harness();
    await ui.start();
    ui.emit({ type: "text_delta", round: 1, text: "```ts\nconst x = 1;\n```" });
    expect(rowMatching(ui.rows(), /│ const x = 1;/)).toBeDefined();
  });

  test("AC-11 an ok Edit renders its summary", async () => {
    const ui = await harness();
    await ui.start();
    ui.emit({
      type: "tool_call",
      callId: "c1",
      name: "Edit",
      input: { path: "x.ts", old_string: "a", new_string: "b" },
    });
    ui.emit({ type: "tool_result", callId: "c1", isError: false, preview: "" });
    expect(rowMatching(ui.rows(), /Updated x\.ts/)).toBeDefined();
  });

  test("AC-12 a running turn shows the working line", async () => {
    const ui = await harness();
    await ui.start();
    ui.emit({ type: "turn_start" });
    ui.emit({ type: "thinking_delta", round: 1, text: "hmm" });
    expect(rowMatching(ui.rows(), /Thinking…/)).toBeDefined();
    expect(ui.rows()).toHaveLength(29);
  });

  test("AC-13 a running turn offers the interrupt in the footer", async () => {
    const ui = await harness();
    await ui.start();
    ui.emit({ type: "turn_start" });
    expect(ui.rows().at(-1)).toContain("esc to interrupt");
  });

  test("AC-14 the working line goes away when the turn ends", async () => {
    const ui = await harness();
    await ui.start();
    ui.emit({ type: "turn_start" });
    expect(rowMatching(ui.rows(), /Thinking…/)).toBeDefined();
    ui.emit({
      type: "turn_end",
      status: "completed",
      output: "",
      costUsd: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(rowMatching(ui.rows(), /Thinking…/)).toBeUndefined();
  });

  test("AC-15 the footer meters the turn's share of the context window", async () => {
    const ui = await harness({ state: { contextWindow: 200000 } });
    await ui.start();
    ui.emit({ type: "usage", round: 1, inputTokens: 36000, outputTokens: 0, costUsd: 0 });
    expect(ui.rows().at(-1)).toContain("18% ctx");
  });

  test("AC-16 a nested tool call renders under its agent card", async () => {
    const ui = await harness();
    await ui.start();
    ui.emit({ type: "tool_call", callId: "a1", name: "nax-agents__run", input: { agent: "explorer", task: "scan" } });
    ui.emit({ type: "tool_call", callId: "c1", name: "Read", input: { path: "src/a.ts" } }, { subagentTask: "scan" });
    const rows = ui.rows();
    const parent = rows.findIndex((row) => row.includes("⏺ Agent("));
    expect(parent).toBeGreaterThanOrEqual(0);
    const child = rows.findIndex((row, index) => index > parent && /^\s+\S*\s*Read\(src\/a\.ts\)/.test(row));
    expect(child).toBeGreaterThan(parent);
  });

  test("AC-17 entering full mode without a sandbox warns in the transcript", async () => {
    const ui = await harness({
      state: { mode: "full", sandbox: { kind: "unavailable", backend: "srt", reason: "missing" } },
    });
    expect(ui.rows()).toContain(`⚠ ${SANDBOX_WARNING}`);
  });

  test("AC-18 a rejected send renders an error entry", async () => {
    const ui = await harness();
    ui.send.mockRejectedValueOnce(new Error("boom"));
    await ui.start();
    expect(ui.rows()).toContain("✗ boom");
  });
});

describe("ChatApp slash command entries", () => {
  const mcp: ChatMcpState = {
    servers: [{ id: "docs", source: "user", transport: "stdio", locked: true }],
    diagnostics: [],
    events: () => [],
    withheld: () => [],
  };

  test("AC-19 /mcp renders a titled listing above its text", async () => {
    const ui = await harness({ mcp });
    await ui.line("/mcp");
    const rows = ui.rows();
    const title = rows.findIndex((row) => row.trimEnd() === "MCP servers");
    const body = rows.findIndex((row) => row.includes("docs  user  stdio  not connected"));
    expect(title).toBeGreaterThanOrEqual(0);
    expect(body).toBeGreaterThan(title);
  });

  test("AC-20 /cost renders the rounded spend under a Cost title", async () => {
    const ui = await harness({ state: { meta: { ...STATE.meta, costUsd: 1.235 } } });
    await ui.line("/cost");
    const rows = ui.rows();
    const title = rows.findIndex((row) => row.trimEnd() === "Cost");
    expect(title).toBeGreaterThanOrEqual(0);
    expect(rows[title + 1]).toStartWith("$1.24");
  });

  test("AC-21 an unknown mode is a notice, not a listing", async () => {
    const ui = await harness();
    await ui.line("/mode bogus");
    expect(ui.rows()).toContain("※ unknown mode bogus; expected full or guarded");
  });

  test("AC-22 /clear returns the screen to the welcome banner alone", async () => {
    const ui = await harness();
    await ui.start();
    expect(ui.rows()).toContain("> hello");
    await ui.settle();
    await ui.line("/clear");
    const rows = ui.rows();
    expect(rowMatching(rows, /skills 0 · commands 0 · mcp 0 \(0 connected\) · agents 0/)).toBeDefined();
    expect(rows).not.toContain("> hello");
  });

  test("AC-24 a failed command shell expansion never sends the turn", async () => {
    const origin = { kind: "nax-plugin", plugin: "kit" } as const;
    const pkg: ResourcePackage = {
      id: "kit",
      root: "/kit",
      origin,
      agents: [],
      mcpServers: [],
      hooks: [],
      diagnostics: [],
      skills: [],
      commands: [
        {
          kind: "command",
          name: "status-cmd",
          qualifiedName: "kit:status-cmd",
          template: "Status: !`git status`",
          origin,
          path: "/kit/status-cmd.md",
        },
      ],
    };
    const runCommand = mock(async (): Promise<CommandRunResult> => ({ isError: true, content: "denied" }));
    const ui = await harness({ catalog: buildResourceCatalog([pkg]), runCommand });
    await ui.line("/status-cmd");
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(ui.send).not.toHaveBeenCalled();
    expect(rowMatching(ui.rows(), /command \/status-cmd not sent: !`git status` failed: denied/)).toBeDefined();
  });
});

describe("ChatApp degenerate terminals", () => {
  test("AC-23 a terminal smaller than the fixed regions still reserves one viewport row", async () => {
    const ui = mount();
    await ui.resize(80, 5);
    await ui.start();
    // Three header rows, the single viewport row, then the input's three rows and the footer.
    expect(ui.rows()).toHaveLength(FIXED_ROWS_WITHOUT_VIEWPORT + 1);
    // The one row the viewport got is the newest transcript line.
    expect(ui.rows()).toContain("> hello");
    expect(ui.rows().at(-1)).toContain("⏵ guarded");
  });
});

describe("ChatApp draft and theme robustness", () => {
  test("F1 a draft wider than the terminal keeps the frame at the terminal's rows", async () => {
    const ui = await harness();
    ui.type("x".repeat(120));
    expect(ui.rows()).toHaveLength(29);
    // The wrapped draft is drawn, not clipped: the last text row carries its tail.
    expect(ui.rows().at(-3)?.endsWith("xxx")).toBe(true);
  });

  test("F1 a draft that wraps at word boundaries keeps the frame at the terminal's rows", async () => {
    const ui = mount();
    await ui.resize(40, 30);
    ui.type("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu");
    expect(ui.rows()).toHaveLength(29);
    // The input's bottom rule sits directly above the footer: no filler row from a mis-measure.
    expect(ui.rows().at(-2)).toMatch(/^─+$/);
  });

  test("F1 a draft exactly as wide as the terminal keeps both of the input's rules", async () => {
    const ui = await harness();
    // 78 columns of text fill the row behind the `> ` marker, so the cursor cell is the 81st
    // column: the input reserves the wrapped row instead of losing a rule to it.
    ui.type("w".repeat(78));
    expect(ui.rows()).toHaveLength(29);
    // The row holding the cursor reserves the cell, so the draft's last character wraps.
    expect(ui.rows()).toContainEqual(expect.stringMatching(/^> w{77}$/));
    expect(ui.rows()).toContain("  w");
    // The header's rule and the input's two rules all survive.
    expect(ui.rows().filter((row) => /^─+$/.test(row))).toHaveLength(3);
  });

  test("F1 a draft taller than the input's window scrolls instead of growing the frame", async () => {
    const ui = await harness();
    ui.type("v".repeat(2400));
    expect(ui.rows()).toHaveLength(29);
    // The window follows the cursor, so the draft's newest columns are on screen.
    expect(ui.lastFrame()).toContain("vvvv");
    expect(ui.rows().at(-1)).toContain("⏵ guarded");
    expect(ui.rows().filter((row) => /^─+$/.test(row))).toHaveLength(3);
  });

  test("F1 a draft of trailing spaces keeps both of the input's rules", async () => {
    const ui = await harness();
    // The spaces are content: the row is 205 columns wide and wraps into three, whether or
    // not the characters at the wrap points are visible.
    ui.type(`hello${" ".repeat(200)}`);
    expect(ui.rows()).toHaveLength(29);
    expect(ui.rows().filter((row) => /^─+$/.test(row))).toHaveLength(3);
  });

  test("F1 a tall draft on a short terminal keeps the frame at the terminal's rows", async () => {
    const ui = mount();
    await ui.resize(80, 12);
    ui.type("v".repeat(2400));
    expect(ui.rows()).toHaveLength(11);
    expect(ui.rows().at(-1)).toContain("⏵ guarded");
  });

  test("F1 a narrow terminal keeps its rows with a draft many times its width", async () => {
    const ui = mount();
    await ui.resize(28, 30);
    ui.type("y".repeat(300));
    expect(ui.rows()).toHaveLength(29);
    // The window follows the cursor: the newest row is the tail of the draft.
    expect(ui.rows().slice(0, -2)).toContainEqual(expect.stringContaining("y"));
  });

  test("F1 a long draft still submits what was typed", async () => {
    const ui = await harness();
    const draft = "z".repeat(200);
    ui.type(draft);
    await Promise.resolve(
      act(async () => {
        ui.stdin.write("\r");
      }),
    );
    expect(ui.send).toHaveBeenCalledWith(draft, expect.any(Function));
  });

  test("F2 the ASCII theme's glyphs reach the header, the transcript and the footer", async () => {
    const ui = await harness({ theme: resolveChatTheme({ env: { NAX_ASCII: "1" }, colorLevel: 0 }) });
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("* nax chat");
    expect(frame).toContain("> guarded");
    expect(frame).not.toContain("✻");
    expect(frame).not.toContain("⏵");
    expect(frame).not.toContain("─");
  });

  test("F3 a send that rejects after turn_start stops the turn", async () => {
    const ui = await harness();
    ui.send.mockImplementationOnce(async (_message, listener) => {
      listener(ui.event({ type: "turn_start" }));
      throw new Error("boom");
    });
    await ui.start();
    expect(ui.rows()).toContain("✗ boom");
    expect(rowMatching(ui.rows(), /Thinking…/)).toBeUndefined();
    expect(ui.rows().at(-1)).toContain("shift+tab to cycle");
  });
});

describe("ChatApp steady overlays", () => {
  test("steady AC-7 a model picker keeps one terminal row free", async () => {
    const ui = await harness();
    await ui.line("/model");
    expect(ui.rows()).toContain("Switch model");
    expect(ui.rows()).toHaveLength(29);
    expect(ui.rows().at(-1)).toContain("⏵ guarded");
  });

  test("steady AC-8 a slash menu keeps one terminal row free", async () => {
    const ui = await harness();
    ui.type("/");
    expect(ui.lastFrame()).toContain("Show commands and skills");
    expect(ui.rows()).toHaveLength(29);
    expect(ui.rows().at(-1)).toContain("⏵ guarded");
  });
});

describe("ChatApp pending ask layout", () => {
  const longAsk: SessionEventBody = {
    type: "approval_requested",
    requestId: "ask-1",
    tool: "Bash",
    command: "npm run build:production --with-a-very-long-flag",
    summary: "build",
    reason: "the release build has to verify the packaged artifact",
    expiresAt: "later",
  };

  test("F4 a wrapped approval keeps its command suffix, reason and options", async () => {
    const ui = mount();
    await ui.resize(40, 30);
    ui.ask(longAsk);
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("long-flag");
    expect(frame).toContain("packaged artifact");
    expect(frame).toContain("1. Yes");
    expect(frame).toContain("No, tell nax what to do instead");
  });

  test("F4 a wrapped approval keeps the frame at the terminal's rows", async () => {
    const ui = mount();
    await ui.resize(40, 30);
    ui.ask(longAsk);
    expect(ui.rows()).toHaveLength(29);
    expect(ui.rows().at(-1)).toContain("⏵ guarded");
  });

  test("steady AC-6 an oversized approval keeps one terminal row free", async () => {
    const ui = await harness();
    ui.ask({ ...longAsk, command: Array.from({ length: 60 }, (_, index) => `cmd ${index}`).join("\n") });
    expect(ui.lastFrame()).toContain("Bash command");
    expect(rowMatching(ui.rows(), /^… \d+ more lines$/)).toBeDefined();
    expect(ui.rows()).toHaveLength(29);
    expect(ui.rows().at(-1)).toContain("⏵ guarded");
  });

  const screenSwitch = "\u001b[?1049l";
  const windowTitle = "\u001b]0;pwn\u0007";

  test("F5 an approval's command cannot leave the alternate screen", async () => {
    const ui = await harness();
    ui.ask({ ...longAsk, command: `npm test${screenSwitch}` });
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("npm test");
    expect(frame).not.toContain(screenSwitch);
    expect(frame).not.toContain("[?1049l");
    expect(ui.rows()).toHaveLength(29);
  });

  test("F5 an approval's reason cannot leave the alternate screen", async () => {
    const ui = await harness();
    ui.ask({ ...longAsk, reason: `Run the tests${windowTitle}${screenSwitch}` });
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("Run the tests");
    expect(frame).not.toContain(windowTitle);
    expect(frame).not.toContain(screenSwitch);
  });

  test("F5 a question's text cannot leave the alternate screen", async () => {
    const ui = await harness();
    ui.ask({ type: "question", requestId: "q1", text: `Proceed?${screenSwitch}`, expiresAt: "later" });
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("Proceed?");
    expect(frame).not.toContain(screenSwitch);
    expect(ui.rows()).toHaveLength(29);
  });

  test("F5 a typed answer cannot leave the alternate screen", async () => {
    const ui = await harness();
    ui.ask({ type: "question", requestId: "q1", text: "Proceed?", expiresAt: "later" });
    ui.type(`done${screenSwitch}`);
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("done");
    expect(frame).not.toContain(screenSwitch);
    expect(ui.rows()).toHaveLength(29);
  });

  test("F6 an approval keeps a two-line command on its own rows", () => {
    const ui = mount();
    ui.ask({ ...longAsk, command: "npm test\nbun test --watch", reason: "Run the tests" });
    const rows = ui.rows();
    expect(rows).toHaveLength(23);
    expect(rows).toContain("Bash command");
    expect(rows).toContain("   npm test");
    expect(rows).toContain("   bun test --watch");
    expect(rows).toContain("❯ 1. Yes");
    expect(rows).toContain("  2. Yes, and don't ask again for this in this session");
    expect(rows.at(-1)).toContain("⏵ guarded");
  });

  test("F6 a multi-row question answer keeps the frame at the terminal's rows", async () => {
    const ui = await harness();
    ui.ask({ type: "question", requestId: "q1", text: "Proceed?", expiresAt: "later" });
    expect(ui.rows()).toHaveLength(29);
    ui.type("one\ntwo\nthree");
    const rows = ui.rows();
    expect(rows).toHaveLength(29);
    expect(rows).toContain("> one");
    expect(rows).toContain("  two");
    expect(rows).toContain("  three");
    // The header's rule, the card's own two, and the two the answer's input is framed by.
    expect(rows.filter((row) => /^─+$/.test(row))).toHaveLength(5);
    expect(rows.at(-1)).toContain("⏵ guarded");
  });

  test("F6 a question answer longer than the width wraps without growing the frame", async () => {
    const ui = mount();
    await ui.resize(40, 30);
    ui.ask({ type: "question", requestId: "q1", text: "Proceed?", expiresAt: "later" });
    ui.type("y".repeat(200));
    expect(ui.rows()).toHaveLength(29);
    expect(ui.rows().at(-1)).toContain("⏵ guarded");
  });

  test("F2 a tall answer on a short terminal keeps every row the card reserved", async () => {
    const ui = await harness();
    ui.ask({ type: "question", requestId: "q1", text: "Proceed?", expiresAt: "later" });
    ui.type(Array.from({ length: 12 }, (_, index) => `row ${index}`).join("\n"));
    const rows = ui.rows();
    expect(rows).toHaveLength(29);
    // The card is drawn whole: its last row — the frame's bottom rule — sits directly above
    // the footer. A box measured with one cap and drawn with another leaves a gap here.
    expect(rows.at(-2)).toMatch(/^─+$/);
    expect(rows.at(-1)).toContain("⏵ guarded");
  });

  test("F6 an oversized ask is windowed, keeping its answer box and the frame's rows", async () => {
    const ui = await harness();
    const text = Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n");
    ui.ask({ type: "question", requestId: "q1", text, expiresAt: "later" });
    const rows = ui.rows();
    expect(rows).toHaveLength(29);
    // The card's head is kept from the top — its title and the question's first lines — and
    // the elision row names what did not fit above the answer box.
    expect(rows).toContain("nax asks");
    expect(rows).toContain("line 0");
    expect(rowMatching(rows, /^… \d+ more lines$/)).toBeDefined();
    // The answer box is the one thing a short screen must never drop.
    expect(rows.some((row) => row.startsWith("> "))).toBe(true);
    expect(rows.at(-1)).toContain("⏵ guarded");
  });
});

test("US003 AC-15 ChatApp forwards wheel events to its transcript viewport", async () => {
  const mouse = fakeMouse();
  const ui = await harness({ mouse: mouse.events });
  await ui.start();
  ui.emit({ type: "text_delta", round: 1, text: Array.from({ length: 50 }, (_, i) => `row-${i}`).join("\n\n") });
  await ui.settle();
  const before = ui.rows().slice(3, -4);
  const older = "  row-38";
  expect(before).not.toContain(older);
  act(() => mouse.emit("wheelUp"));
  expect(ui.rows().slice(3, -4)).not.toEqual(before);
  expect(ui.rows()).toContain(older);
});

describe("US005 ChatApp clipboard", () => {
  const original = { ..._clipboardDeps };
  afterEach(() => Object.assign(_clipboardDeps, original));
  async function copyScreen() {
    const mouse = fakeMouse();
    const writes = mock((_text: string) => {});
    _clipboardDeps.write = writes;
    _clipboardDeps.platform = "linux";
    const ui = mount({ mouse: mouse.events });
    // One viewport row directly below the three header rows.
    await ui.resize(80, 8);
    await ui.start();
    expect(ui.rows()[3]).toBe("> hello");
    const event = (kind: "press" | "drag" | "release", x: number) =>
      act(() => mouse.emit(kind, { button: "left", x, y: 4 }));
    const drag = async () => {
      event("press", 3);
      event("drag", 7);
      await Promise.resolve(
        act(async () => {
          event("release", 7);
        }),
      );
    };
    return { ui, writes, event, drag };
  }
  test("AC-4 click makes no copy or footer hint", async () => {
    const { ui, writes, event } = await copyScreen();
    expect(ui.rows().at(-1)).not.toContain("copied");
    event("press", 3);
    event("release", 3);
    expect(writes).not.toHaveBeenCalled();
    expect(ui.rows().at(-1)).not.toContain("copied");
  });
  test.each(["key", "press"])("AC-10/11/12/13 copies absolute cells and clears hint on %s", async (next) => {
    const { ui, writes, event, drag } = await copyScreen();
    await drag();
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes).toHaveBeenCalledWith(osc52("hello"));
    expect(ui.rows().at(-1)).toContain("copied 5 chars");
    if (next === "key") ui.type("a");
    else event("press", 3);
    expect(ui.rows().at(-1)).not.toContain("copied");
  });
  test.each(["reject", "non-zero"])("AC-14 copied hint survives darwin spawnCopy %s", async (failure) => {
    const { ui, writes, drag } = await copyScreen();
    _clipboardDeps.platform = "darwin";
    _clipboardDeps.spawnCopy = mock(async () => {
      if (failure === "reject") throw new Error("pbcopy unavailable");
      return 1;
    });
    await drag();
    expect(_clipboardDeps.spawnCopy).toHaveBeenCalledTimes(1);
    expect(_clipboardDeps.spawnCopy).toHaveBeenCalledWith("hello");
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes).toHaveBeenCalledWith(osc52("hello"));
    expect(ui.rows().at(-1)).toContain("copied 5 chars");
  });
});
