/**
 * SlashMenu — the filtered command list the chat screen draws under its input.
 *
 * Every frame here is the screen's own output: the menu is opened, moved, completed and run
 * with the key sequences a terminal sends, never by calling a handler, so each assertion is
 * about what the user sees and what the host was asked to do. The host is typed and fake, and
 * the screen reports its size through a `resize` event because `ink-testing-library`'s stream
 * carries no rows until one is defined.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { SessionEvent, SessionEventBody } from "@nathapp/nax-agent";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import { type ChatHost, type ChatHostState, createChatAskController } from "@/chat";
import { buildResourceCatalog, type ResourcePackage } from "@/resources";
import { ChatApp } from "@/tui/chat";
import { SLASH_MENU_MAX_ROWS } from "@/tui/chat/slash-menu";

/** The keys the menu owns, as ink parses the sequences a terminal sends. */
const ESCAPE = "\x1b";
const RETURN = "\r";
const TAB = "\t";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const SHIFT_UP = "\x1b[1;2A";
const PAGE_UP = "\x1b[5~";
const CTRL_U = "\x15";

/** What the footer offers when the input's clear is armed. */
const CLEAR_HINT = "esc again to clear";

/** The rows a description makes recognisable, so a "no rows" assertion cannot be vacuous. */
const HELP_ROW = "/help  Show commands and skills";
const RESUME_ROW = "/resume  Resume a saved session";
const FEATURE_ROW = "/feature  Load a feature spec into the conversation";

/** The built-ins a thirteen-match frame has to leave out: everything past the eighth row. */
const BEYOND_THE_WINDOW = [
  "/skills  List skills",
  "/plugins  List plugins and what they provide",
  "/mcp  List MCP servers",
  "/agents  List agents",
  "/quit  Quit nax chat",
] as const;

const STATE: ChatHostState = {
  sessionId: "menu-session",
  mode: "guarded",
  model: "menu-model",
  meta: {
    schemaVersion: 1,
    sessionId: "menu-session",
    cwd: "/repo",
    mode: "ask",
    model: "menu-model",
    bashApproval: "gated",
    title: null,
    createdAt: "now",
    updatedAt: null,
    costUsd: 1.236,
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

/** A transcript of a hundred code lines, each named so a frame can say which it shows. */
const CODE_LINES = Array.from({ length: 100 }, (_unused, index) => `zz${String(index + 1).padStart(3, "0")}`);
const NEWEST_CODE_LINE = CODE_LINES[CODE_LINES.length - 1] ?? "";

/** A catalogue holding one skill named `skill` — the built-in `skills` prefixes it. */
function skillCatalog(): ChatHost["catalog"] {
  const origin = { kind: "nax-plugin", plugin: "kit" } as const;
  const pkg: ResourcePackage = {
    id: "kit",
    root: "/kit",
    origin,
    agents: [],
    mcpServers: [],
    hooks: [],
    diagnostics: [],
    commands: [],
    skills: [
      {
        kind: "skill",
        name: "skill",
        qualifiedName: "kit:skill",
        description: "literal",
        body: "!`echo x`",
        baseDir: "/kit/skill",
        path: "/kit/skill/SKILL.md",
        modelInvocable: true,
        origin,
      },
    ],
  };
  return buildResourceCatalog([pkg]);
}

/** A mounted screen over a typed fake host; `send` stays open until `settle()`. */
function mount(options: { readonly catalog?: ChatHost["catalog"] } = {}) {
  let onEvent: (event: SessionEvent) => void = () => {};
  const gate = Promise.withResolvers<void>();
  const send = mock<ChatHost["send"]>(async (_message: string, listener: (event: SessionEvent) => void) => {
    onEvent = listener;
    await gate.promise;
  });
  const host: ChatHost = {
    repoRoot: "/repo",
    ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
    models: [STATE.model],
    asks: createChatAskController({ mode: "guarded", answer: () => {} }),
    current: () => STATE,
    notice: () => undefined,
    send,
    cancel: mock(() => {}),
    close: mock(async () => {}),
    start: async () => {},
    clear: async () => {},
    resume: mock(async (_input: { id?: string }) => {}),
    switchTo: async () => {},
    listSessions: async () => [],
  };
  const ui = render(<ChatApp host={host} />);
  /** The frame's rows as the terminal shows them: no escape codes, no trailing blanks. */
  const rows = (): string[] =>
    Bun.stripANSI(ui.lastFrame() ?? "")
      .split("\n")
      .map((row) => row.trimEnd());
  const lastFrame = (): string => rows().join("\n");
  const footer = (): string => rows().at(-1) ?? "";
  const press = (sequence: string): void => {
    act(() => {
      ui.stdin.write(sequence);
    });
  };
  /** Several keypresses delivered before the owner can re-render — one React batch. */
  const pressAll = (...sequences: readonly string[]): void => {
    act(() => {
      for (const sequence of sequences) ui.stdin.write(sequence);
    });
  };
  /** One keypress per frame, the way a terminal delivers typing. */
  const type = (text: string): void => {
    for (const char of text) press(char);
  };
  /** A message typed and returned, drained through the screen's own submit path. */
  const submit = async (text: string): Promise<void> => {
    await Promise.resolve(
      act(async () => {
        ui.stdin.write(text);
        ui.stdin.write(RETURN);
      }),
    );
  };
  /** Return on its own, for a line already in the input. */
  const submitTyped = async (): Promise<void> => {
    await Promise.resolve(
      act(async () => {
        ui.stdin.write(RETURN);
      }),
    );
    await Promise.resolve(
      act(async () => {
        await Promise.resolve();
      }),
    );
  };
  /** Resolve the turn's stream, so the screen sees the turn end. */
  const settle = async (): Promise<void> => {
    await Promise.resolve(
      act(async () => {
        gate.resolve();
      }),
    );
  };
  /** Drain the microtasks an async command path runs before the next frame is read. */
  const flush = async (): Promise<void> => {
    await Promise.resolve(
      act(async () => {
        await Promise.resolve();
      }),
    );
  };
  const emit = (body: SessionEventBody): void => {
    act(() => {
      onEvent({ sessionId: STATE.sessionId, turnId: "t1", at: "now", metadata: {}, ...body });
    });
  };
  const ask = (body: SessionEventBody = approval): void => {
    act(() => {
      host.asks.handle({ sessionId: STATE.sessionId, turnId: "t1", at: "now", metadata: {}, ...body });
    });
  };
  const resize = async (columns: number, terminalRows: number): Promise<void> => {
    await Promise.resolve(
      act(async () => {
        Object.defineProperty(ui.stdout, "columns", { value: columns, configurable: true });
        Object.defineProperty(ui.stdout, "rows", { value: terminalRows, configurable: true });
        ui.stdout.emit("resize");
      }),
    );
  };
  return {
    ui,
    host,
    send,
    rows,
    lastFrame,
    footer,
    press,
    pressAll,
    type,
    submit,
    submitTyped,
    settle,
    flush,
    emit,
    ask,
    resize,
  };
}

/** A screen on an 80x30 terminal — the size every case here is drawn at. */
async function screen(options: { readonly catalog?: ChatHost["catalog"] } = {}) {
  const ui = mount(options);
  await ui.resize(80, 30);
  return ui;
}

afterEach(() => {
  cleanup();
  mock.restore();
});

describe("SlashMenu opening and selection", () => {
  test("AC-1 typing / shows the menu with the built-ins under the input", async () => {
    const ui = await screen();
    ui.type("/");
    const rows = ui.rows();
    expect(rows).toContain(`❯ ${HELP_ROW}`);
    expect(rows.indexOf("> /")).toBeLessThan(rows.indexOf(`❯ ${HELP_ROW}`));
  });

  test("AC-2 typing /re puts the pointer on the first match", async () => {
    const ui = await screen();
    ui.type("/re");
    expect(ui.rows()).toContain(`❯ ${RESUME_ROW}`);
    expect(ui.rows().some((row) => row.startsWith("❯ /feature"))).toBe(false);
  });

  test("AC-3 downArrow moves the pointer to the second match", async () => {
    const ui = await screen();
    ui.type("/re");
    ui.press(DOWN);
    expect(ui.rows()).toContain(`❯ ${FEATURE_ROW}`);
  });

  test("AC-4 downArrow on the last match leaves the pointer there", async () => {
    const ui = await screen();
    ui.type("/re");
    ui.press(DOWN);
    ui.press(DOWN);
    expect(ui.rows()).toContain(`❯ ${FEATURE_ROW}`);
  });
});

describe("SlashMenu completion and dismissal", () => {
  test("AC-5 tab completes the selected name and leaves a space for its arguments", async () => {
    const ui = await screen();
    ui.type("/re");
    ui.press(TAB);
    expect(ui.rows()).toContain("> /resume");
    ui.type("abc");
    await ui.submitTyped();
    expect(ui.host.resume).toHaveBeenCalledWith({ id: "abc" });
  });

  test("AC-6 the menu is closed after that tab", async () => {
    const ui = await screen();
    ui.type("/re");
    expect(ui.lastFrame()).toContain(RESUME_ROW);
    ui.press(TAB);
    expect(ui.lastFrame()).not.toContain(RESUME_ROW);
  });

  test("AC-7 return on the selected match runs it and sends nothing", async () => {
    const ui = await screen();
    ui.type("/co");
    expect(ui.rows()).toContain(`❯ /cost  Show session cost`);
    await ui.submitTyped();
    expect(ui.send).not.toHaveBeenCalled();
    expect(ui.rows()).toContain("Cost");
  });

  test("AC-8 escape closes the menu and keeps the typed query", async () => {
    const ui = await screen();
    ui.type("/re");
    ui.press(ESCAPE);
    expect(ui.lastFrame()).not.toContain(RESUME_ROW);
    expect(ui.rows()).toContain("> /re");
  });

  test("AC-9 typing after that escape opens the menu again", async () => {
    const ui = await screen();
    ui.type("/re");
    ui.press(ESCAPE);
    ui.type("s");
    expect(ui.rows()).toContain(`❯ ${RESUME_ROW}`);
  });
});

describe("SlashMenu window", () => {
  test("AC-10 thirteen matches draw eight rows", async () => {
    const ui = await screen();
    ui.type("/");
    expect(ui.lastFrame()).toContain(HELP_ROW);
    for (const row of BEYOND_THE_WINDOW) expect(ui.lastFrame()).not.toContain(row);
  });

  test("AC-11 nine downArrows keep the selection inside the frame", async () => {
    const ui = await screen();
    ui.type("/");
    for (let index = 0; index < 9; index++) ui.press(DOWN);
    expect(ui.rows()).toContain("❯ /plugins  List plugins and what they provide");
    expect(ui.lastFrame()).not.toContain(HELP_ROW);
  });
});

describe("SlashMenu suppression", () => {
  test("AC-12 a query with no match draws no rows", async () => {
    const ui = await screen();
    ui.type("/");
    expect(ui.rows()).toContain(`❯ ${HELP_ROW}`);
    ui.type("zzz");
    expect(ui.lastFrame()).not.toContain(HELP_ROW);
    expect(ui.rows()).toContain("> /zzz");
  });

  test("AC-13 a query with whitespace draws no rows", async () => {
    const ui = await screen();
    ui.type("/mode");
    expect(ui.rows()).toContain("❯ /mode  Switch permission mode");
    ui.type(" full");
    expect(ui.lastFrame()).not.toContain("/mode  Switch permission mode");
    expect(ui.rows()).toContain("> /mode full");
  });

  test("AC-14 typing while an ask is pending opens no menu", async () => {
    const ui = await screen();
    ui.ask();
    expect(ui.lastFrame()).toContain("Bash command");
    ui.type("/re");
    expect(ui.lastFrame()).not.toContain(RESUME_ROW);
  });

  test("F3 an ask arriving while the menu is open hides it", async () => {
    const ui = await screen();
    ui.type("/re");
    expect(ui.lastFrame()).toContain(RESUME_ROW);
    ui.ask();
    expect(ui.lastFrame()).not.toContain(RESUME_ROW);
  });
});

describe("SlashMenu ranking and key ownership", () => {
  test("AC-15 a skill named skill ranks above the built-in skills", async () => {
    const ui = await screen({ catalog: skillCatalog() });
    ui.type("/skill");
    expect(ui.rows()).toContain("❯ /skill  (skill) literal");
    await ui.submitTyped();
    expect(ui.send).toHaveBeenCalledTimes(1);
    expect(ui.send.mock.calls[0]?.[0]).toContain("!`echo x`");
    expect(ui.rows()).not.toContain("Skills");
  });

  test("AC-16 escape with the menu open does not arm the input's clear", async () => {
    const ui = await screen();
    ui.type("/re");
    ui.press(ESCAPE);
    expect(ui.footer()).not.toContain(CLEAR_HINT);
    expect(ui.rows()).toContain("> /re");
  });

  test("AC-17 pageUp with the menu open scrolls the transcript", async () => {
    const ui = await screen();
    await ui.submit("hello");
    await ui.settle();
    ui.emit({ type: "text_delta", round: 1, text: `\`\`\`ts\n${CODE_LINES.join("\n")}\n\`\`\`` });
    expect(ui.lastFrame()).toContain(NEWEST_CODE_LINE);
    ui.type("/re");
    expect(ui.lastFrame()).toContain(RESUME_ROW);
    ui.press(PAGE_UP);
    expect(ui.lastFrame()).not.toContain(NEWEST_CODE_LINE);
  });

  test("F1 the menu's arrows do not browse the input's history", async () => {
    const ui = await screen();
    await ui.submit("hello");
    await ui.settle();
    ui.type("/re");
    ui.press(UP);
    expect(ui.rows()).toContain(`❯ ${RESUME_ROW}`);
    // The submitted line stays where it landed — in the transcript, not back in the prompt.
    expect(ui.rows().filter((row) => row === "> hello")).toHaveLength(1);
    expect(ui.rows()).toContain("> /re");
  });

  test("F2 shift+up with the menu open scrolls the transcript", async () => {
    const ui = await screen();
    await ui.submit("hello");
    await ui.settle();
    ui.emit({ type: "text_delta", round: 1, text: `\`\`\`ts\n${CODE_LINES.join("\n")}\n\`\`\`` });
    ui.type("/re");
    for (let index = 0; index < 3; index++) ui.press(SHIFT_UP);
    expect(ui.lastFrame()).not.toContain(NEWEST_CODE_LINE);
    expect(ui.rows()).toContain("> /re");
  });

  test("F4 escape with the menu open does not interrupt a running turn", async () => {
    const ui = await screen();
    await ui.submit("hello");
    ui.emit({ type: "turn_start" });
    ui.type("/re");
    ui.press(ESCAPE);
    expect(ui.host.cancel).not.toHaveBeenCalled();
  });
});

describe("SlashMenu keys delivered in one batch", () => {
  test("F5 two downArrows in one batch move the pointer twice", async () => {
    const ui = await screen();
    ui.type("/");
    ui.pressAll(DOWN, DOWN);
    // The third match, not the second: a handler that reads the last render's pointer moves once.
    expect(ui.rows()).toContain("❯ /model  Switch model");
  });

  test("F6 downArrow then return in one batch run the row the pointer moved to", async () => {
    const ui = await screen();
    ui.type("/re");
    expect(ui.rows()).toContain(`❯ ${RESUME_ROW}`);
    ui.pressAll(DOWN, RETURN);
    await ui.flush();
    expect(ui.host.resume).not.toHaveBeenCalled();
    expect(ui.lastFrame()).toContain("usage: /feature <name> [message]");
  });

  test("F7 tab and the next character in one batch keep the completion", async () => {
    const ui = await screen();
    ui.type("/re");
    ui.pressAll(TAB, "x");
    expect(ui.rows()).toContain("> /resume x");
  });

  test("F9 tab, its argument and return in one batch submit the completed line", async () => {
    const ui = await screen();
    ui.type("/re");
    expect(ui.rows()).toContain(`❯ ${RESUME_ROW}`);
    ui.pressAll(TAB, "abc", RETURN);
    await ui.flush();
    // The return belongs to the prompt once tab has rewritten it: /resume abc runs, and the
    // argument-less picker the menu's stale selection would have opened never appears.
    expect(ui.host.resume).toHaveBeenCalledWith({ id: "abc" });
    expect(ui.lastFrame()).not.toContain("Resume a session");
  });

  test("F10 escape then return in one batch submit the prompt the escape kept", async () => {
    const ui = await screen();
    ui.type("/co");
    expect(ui.rows()).toContain("❯ /cost  Show session cost");
    ui.pressAll(ESCAPE, RETURN);
    await ui.flush();
    // The escape put the menu away, so the return is the prompt's: the line goes to the
    // commands as typed rather than running the row the menu still had selected.
    expect(ui.rows()).toContain("※ unknown command /co");
    expect(ui.lastFrame()).not.toContain("Cost");
  });

  test("F14 a query typed and returned in one batch still runs the command", async () => {
    const ui = await screen();
    // The menu a `/` query opens is not mounted yet when the return that follows it in the
    // same batch arrives: the key is the input's, and losing it would drop the line.
    ui.pressAll("/cost", RETURN);
    await ui.flush();
    expect(ui.rows()).toContain("Cost");
  });
});

describe("SlashMenu on a short terminal", () => {
  /** An 80x12 terminal: what the fixed regions need, plus a viewport row and a little slack. */
  const SHORT_ROWS = 12;

  async function shortScreen() {
    const ui = mount();
    await ui.resize(80, SHORT_ROWS);
    return ui;
  }

  test("F11 the open menu never pushes the frame past the terminal's rows", async () => {
    const ui = await shortScreen();
    ui.type("/");
    const rows = ui.rows();
    expect(rows).toHaveLength(SHORT_ROWS - 1);
    // The fixed regions are still the first and last rows, and the prompt is still drawn.
    expect(rows[0]).toStartWith("✻ nax chat");
    expect(rows.at(-1)).toContain("⏵ guarded");
    expect(rows).toContain("> /");
  });

  test("F12 a short terminal shows fewer menu rows, not a taller frame", async () => {
    const ui = await shortScreen();
    ui.type("/");
    const rows = ui.rows();
    const drawn = rows.filter((row) => row.startsWith("❯ ") || /^ {2}\//.test(row));
    expect(drawn.length).toBeLessThan(SLASH_MENU_MAX_ROWS);
    expect(drawn.length).toBeGreaterThan(0);
    expect(rows).toHaveLength(SHORT_ROWS - 1);
  });

  test("F13 moving the pointer keeps the selection inside the shortened window", async () => {
    const ui = await shortScreen();
    ui.type("/");
    for (let index = 0; index < 5; index++) ui.press(DOWN);
    const rows = ui.rows();
    expect(rows).toHaveLength(SHORT_ROWS - 1);
    expect(rows).toContain("❯ /clear  Clear the conversation");
  });

  /** An 80x9 terminal: the input's own frame and one viewport row leave the menu no rows. */
  const NO_MENU_ROOM_ROWS = 9;

  async function zeroRowScreen() {
    const ui = mount();
    await ui.resize(80, NO_MENU_ROOM_ROWS);
    return ui;
  }

  test("F15 a terminal with no rows for the menu leaves return to the input", async () => {
    const ui = await zeroRowScreen();
    ui.type("/co");
    // The menu the query would open has no row to draw in, so nothing of it is on screen...
    expect(ui.lastFrame()).not.toContain("Show session cost");
    expect(ui.rows()).toHaveLength(NO_MENU_ROOM_ROWS - 1);
    // ...and the return is the prompt's: the line runs as typed. A menu nobody can see must
    // not own the key, or the return would run a row the user never saw.
    await ui.submitTyped();
    expect(ui.rows()).toContain("※ unknown command /co");
    expect(ui.lastFrame()).not.toContain("Cost");
  });

  test("F16 the arrows browse the prompt's history when the menu has no rows", async () => {
    const ui = await zeroRowScreen();
    await ui.submit("hello");
    await ui.settle();
    ui.type("/co");
    // The prompt is the third row from the bottom: the footer, the input's closing rule, then
    // the text row the input draws between its two rules.
    const prompt = (): string => ui.rows().at(-3) ?? "";
    expect(prompt()).toBe("> /co");
    // Up is the input's again, so it walks the history rather than moving an invisible pointer.
    ui.press(UP);
    expect(prompt()).toBe("> hello");
  });
});

describe("SlashMenu submission bookkeeping", () => {
  test("F8 a clear armed before a menu run does not survive it", async () => {
    const ui = await screen();
    ui.type("draft");
    ui.press(ESCAPE);
    expect(ui.footer()).toContain(CLEAR_HINT);
    // Empty the prompt so a slash query can be typed, then run one from the menu.
    ui.press(CTRL_U);
    ui.type("/co");
    await ui.submitTyped();
    ui.type("new");
    expect(ui.footer()).not.toContain(CLEAR_HINT);
    // One escape arms a fresh clear; it must not delete the draft the arm predates.
    ui.press(ESCAPE);
    expect(ui.rows()).toContain("> new");
  });
});
