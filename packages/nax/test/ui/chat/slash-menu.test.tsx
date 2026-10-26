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

/** The keys the menu owns, as ink parses the sequences a terminal sends. */
const ESCAPE = "\x1b";
const RETURN = "\r";
const TAB = "\t";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const SHIFT_UP = "\x1b[1;2A";
const PAGE_UP = "\x1b[5~";

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
  return { ui, host, send, rows, lastFrame, footer, press, type, submit, submitTyped, settle, emit, ask, resize };
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
