/**
 * The `@` picker in the chat input.
 *
 * Every frame here is the screen's own output: a query is typed, a row is chosen, and the
 * picker is dismissed with the key sequences a terminal sends, never by calling a handler. The
 * file list is a script (`_chatAppDeps.mentionFileIndex`) except in the cases that run the real
 * one with `git` faked, so the picker's own behaviour is what is under test.
 *
 * The prompt's text is read out of the raw frame with the inverse cursor cell removed: whether
 * a completion left a trailing space after the token — and where the caret landed — is part of
 * what the picker has to get right, and a trailing-trimmed row cannot say either.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { SessionEvent, SessionEventBody } from "@nathapp/nax-agent";
import { assertDefined } from "@test/helpers";
import chalk from "chalk";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import * as chat from "@/chat";
import {
  type ChatHost,
  type ChatHostState,
  type ChatSendOptions,
  createChatAskController,
  type MentionFileIndex,
  type MentionFileList,
  type MentionFileRow,
} from "@/chat";
import { _chatAppDeps, ChatApp } from "@/tui/chat/ChatApp";

/** The keys the picker owns, as ink parses the sequences a terminal sends. */
const RETURN = "\r";
const TAB = "\t";
const ESCAPE = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
/** Kill the prompt's line, so a case can type a fresh query over loaded rows. */
const CTRL_U = "\x15";

/** The line a failed or timed-out `git ls-files` draws in place of selectable rows. */
const NO_GIT_LINE = "no file list from git";
/** The two rows most cases load: one file the query keeps, one it drops. */
const GIT_ROWS: readonly MentionFileRow[] = [
  { path: "chat-host.ts", folder: false },
  { path: "cheap.txt", folder: false },
];
/** Full colour, so ink surrounds the inverse cursor cell with the SGR 7 / SGR 27 pair. */
const FULL_COLOR = 3;
/** The SGR pair ink writes around an inverse cell. */
const INVERSE_ON = "\u001b[7m";
const INVERSE_OFF = "\u001b[27m";

/** The line without its inverse spans: the cursor cell is drawn on top of the text, not part of it. */
function withoutCursorCell(line: string): string {
  let text = line;
  for (let start = text.indexOf(INVERSE_ON); start >= 0; start = text.indexOf(INVERSE_ON)) {
    const end = text.indexOf(INVERSE_OFF, start);
    const tail = end < 0 ? "" : text.slice(end + INVERSE_OFF.length);
    text = `${text.slice(0, start)}${tail}`;
  }
  return text;
}
/** The question card a case can raise on the host. */
const APPROVAL: SessionEventBody = {
  type: "approval_requested",
  requestId: "ask-1",
  tool: "Bash",
  command: "npm test",
  reason: "Run the tests",
  summary: "test",
  expiresAt: "later",
};

const STATE: ChatHostState = {
  sessionId: "picker-session",
  mode: "guarded",
  model: "test-model",
  meta: {
    schemaVersion: 1,
    sessionId: "picker-session",
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

/** One file list row; a path ending in "/" is a folder, as `listMentionFiles` reports it. */
function row(path: string): MentionFileRow {
  return { path, folder: path.endsWith("/") };
}

/** A fixed answer for the picker's index. */
function listed(rows: readonly MentionFileRow[], git = true): () => Promise<MentionFileList> {
  return () => Promise.resolve({ git, rows });
}

/** The file list's deps as they were before a case replaced them. */
const originalFileDeps = { ...chat._mentionFilesDeps };
const originalChalkLevel = chalk.level;
// Colour on for every case: the cursor cell is drawn as an inverse span, and the caret's
// position — inside the line, or past the space a completion added — is one of the assertions.
beforeEach(() => {
  chalk.level = FULL_COLOR;
});
afterEach(() => {
  cleanup();
  mock.restore();
  chalk.level = originalChalkLevel;
  Object.assign(chat._mentionFilesDeps, originalFileDeps);
});

/**
 * A host with one model and no catalog. `send` records every call and never settles, so the
 * screen sees a turn in flight exactly as a real one does.
 */
function fakeHost(repoRoot = "/repo") {
  const gate = Promise.withResolvers<void>();
  const send = mock(async (_message: string, _onEvent: (event: SessionEvent) => void, _options?: ChatSendOptions) => {
    await gate.promise;
  });
  const cancel = mock(() => {});
  const asks = createChatAskController({ mode: "guarded", answer: () => {} });
  const host: ChatHost = {
    repoRoot,
    models: ["test-model"],
    asks,
    current: () => STATE,
    notice: () => undefined,
    send,
    cancel,
    start: async () => {},
    clear: async () => {},
    resume: async () => {},
    switchTo: async () => {},
    listSessions: async () => [],
    close: async () => {},
  };
  return { host, send, cancel, asks };
}

/** The picker's file list, answered by a script rather than by `git ls-files`. */
function scriptIndex(answer: () => Promise<MentionFileList>) {
  const get = mock(answer);
  const index: MentionFileIndex = { get };
  const factory = spyOn(_chatAppDeps, "mentionFileIndex").mockReturnValue(index);
  return { get, factory };
}

/**
 * The mounted screen, with its frame and the verbs a case types with. The mention expander is
 * spied to return its input throughout: this file is about the picker, never about expansion.
 */
function mount(options: { cwd?: string; repoRoot?: string } = {}) {
  spyOn(_chatAppDeps, "expandMentions").mockImplementation(async (text: string) => ({ message: text, records: [] }));
  const fake = fakeHost(options.repoRoot);
  const ui = render(<ChatApp host={fake.host} cwd={options.cwd} />);
  /** The frame's rows as the terminal shows them: no escape codes, no trailing blanks. */
  const rows = (): string[] =>
    Bun.stripANSI(ui.lastFrame() ?? "")
      .split("\n")
      .map((line) => line.trimEnd());
  const frame = (): string => rows().join("\n");
  /** The prompt's own text, cursor cell removed — the trailing space it wrote is part of it. */
  const promptText = (): string => {
    const line = (ui.lastFrame() ?? "").split("\n").find((candidate) => candidate.startsWith("> "));
    assertDefined(line, "the prompt's row");
    return withoutCursorCell(line);
  };
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
  /** Let a pending file listing and the render it schedules land. */
  const settle = async (): Promise<void> => {
    await Promise.resolve(
      act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      }),
    );
  };
  /** Return on its own, for a line already typed, drained through the screen's submit path. */
  const returnNow = async (): Promise<void> => {
    await Promise.resolve(
      act(async () => {
        ui.stdin.write(RETURN);
        await Promise.resolve();
      }),
    );
  };
  /** Type a line and return it, drained through the screen's own submit path. */
  const submit = async (text: string): Promise<void> => {
    for (const char of text) press(char);
    await returnNow();
  };
  const ask = (body: SessionEventBody = APPROVAL): void => {
    act(() => {
      fake.asks.handle({ sessionId: STATE.sessionId, turnId: "t1", at: "now", metadata: {}, ...body });
    });
  };
  return { ...fake, ui, rows, frame, promptText, press, pressAll, type, settle, returnNow, submit, ask };
}

describe("the picker opens on a mention query", () => {
  test("AC-2 a typed mention shows the matching file under the prompt", async () => {
    scriptIndex(listed(GIT_ROWS));
    const ui = mount();
    ui.type("see @chh");
    await ui.settle();
    const rows = ui.rows();
    const prompt = rows.indexOf("> see @chh");
    expect(prompt).toBeGreaterThanOrEqual(0);
    expect(rows.indexOf("❯ chat-host.ts")).toBeGreaterThan(prompt);
    expect(rows.some((line) => line.includes("cheap.txt"))).toBe(false);
  });

  test("AC-3 the screen builds one index, for its own cwd", async () => {
    const { factory } = scriptIndex(listed(GIT_ROWS));
    const ui = mount({ cwd: "/repo/pkg", repoRoot: "/repo" });
    ui.type("see @chh");
    await ui.settle();
    ui.type("a");
    await ui.settle();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith("/repo/pkg");
  });

  test("AC-4 the index is asked for its files once the @ is typed", async () => {
    const { get } = scriptIndex(listed(GIT_ROWS));
    const ui = mount();
    ui.type("see ");
    await ui.settle();
    expect(get).not.toHaveBeenCalled();
    ui.type("@");
    await ui.settle();
    expect(get).toHaveBeenCalled();
  });

  test("a listing that has not answered yet draws nothing", async () => {
    scriptIndex(() => new Promise<MentionFileList>(() => {}));
    const ui = mount();
    ui.type("see @chh");
    await ui.settle();
    expect(ui.frame()).not.toContain("chat-host.ts");
    expect(ui.rows()).toContain("> see @chh");
  });
});

describe("applying a row", () => {
  test("AC-5 return completes the selected file and leaves the caret past its space", async () => {
    scriptIndex(listed(GIT_ROWS));
    const ui = mount();
    ui.type("see @chh");
    await ui.settle();
    ui.press(RETURN);
    expect(ui.promptText()).toBe("> see @chat-host.ts ");
  });

  test("AC-6 that return does not submit the message", async () => {
    scriptIndex(listed(GIT_ROWS));
    const ui = mount();
    ui.type("see @chh");
    await ui.settle();
    ui.press(RETURN);
    expect(ui.send).not.toHaveBeenCalled();
  });

  test("AC-7 tab completes the selected file the same way", async () => {
    scriptIndex(listed(GIT_ROWS));
    const ui = mount();
    ui.type("see @chh");
    await ui.settle();
    ui.press(TAB);
    expect(ui.promptText()).toBe("> see @chat-host.ts ");
  });

  test("AC-8 tab drills into a folder and keeps the picker on its contents", async () => {
    scriptIndex(listed([row("src/"), row("src/a.ts")]));
    const ui = mount();
    ui.type("@sr");
    await ui.settle();
    ui.press(TAB);
    expect(ui.promptText()).toBe("> @src/");
    expect(ui.rows()).toContain("❯ src/a.ts");
  });

  test("AC-9 down then return chooses the second row", async () => {
    scriptIndex(listed([row("a.ts"), row("b.ts")]));
    const ui = mount();
    ui.type("@");
    await ui.settle();
    ui.press(DOWN);
    ui.press(RETURN);
    expect(ui.promptText()).toBe("> @b.ts ");
  });

  test("up on the first row keeps the pointer there", async () => {
    scriptIndex(listed([row("a.ts"), row("b.ts")]));
    const ui = mount();
    ui.type("@");
    await ui.settle();
    ui.press(UP);
    await ui.returnNow();
    expect(ui.promptText()).toBe("> @a.ts ");
  });
});

describe("dismissing the picker", () => {
  test("AC-10 escape closes the picker and leaves the prompt alone", async () => {
    scriptIndex(listed([row("chat-host.ts")]));
    const ui = mount();
    ui.type("see @ch");
    await ui.settle();
    expect(ui.rows()).toContain("❯ chat-host.ts");
    ui.press(ESCAPE);
    expect(ui.rows()).not.toContain("❯ chat-host.ts");
    expect(ui.rows()).toContain("> see @ch");
  });

  test("AC-11 typing on after that escape opens the picker again", async () => {
    scriptIndex(listed([row("chat-host.ts")]));
    const ui = mount();
    ui.type("see @ch");
    await ui.settle();
    ui.press(ESCAPE);
    ui.type("t");
    await ui.settle();
    expect(ui.rows()).toContain("❯ chat-host.ts");
  });

  test("AC-12 escape with the picker open does not interrupt the running turn", async () => {
    scriptIndex(listed(GIT_ROWS));
    const ui = mount();
    await ui.submit("hello");
    ui.type("see @chh");
    await ui.settle();
    expect(ui.rows()).toContain("❯ chat-host.ts");
    ui.press(ESCAPE);
    expect(ui.rows()).not.toContain("❯ chat-host.ts");
    expect(ui.cancel).not.toHaveBeenCalled();
  });
});

describe("surfaces that outrank the picker", () => {
  test("AC-13 a slash query shows the slash menu and no picker", async () => {
    scriptIndex(listed(GIT_ROWS));
    const ui = mount();
    ui.type("/he");
    await ui.settle();
    expect(ui.rows().some((line) => line.startsWith("❯ /help"))).toBe(true);
    expect(ui.frame()).not.toContain("chat-host.ts");
  });

  test("AC-14 an ask card pending keeps the picker closed", async () => {
    scriptIndex(listed(GIT_ROWS));
    const ui = mount();
    ui.ask();
    expect(ui.frame()).toContain("Bash command");
    ui.type("@");
    await ui.settle();
    expect(ui.frame()).not.toContain("chat-host.ts");
  });
});

describe("no file list from git", () => {
  test("AC-15 a failed listing draws its own line instead of rows", async () => {
    scriptIndex(listed([], false));
    const ui = mount();
    ui.type("@");
    await ui.settle();
    expect(ui.rows()).toContain(NO_GIT_LINE);
  });

  test("AC-16 return in that state still sends", async () => {
    scriptIndex(listed([], false));
    const ui = mount();
    ui.type("@");
    await ui.settle();
    expect(ui.rows()).toContain(NO_GIT_LINE);
    await ui.returnNow();
    expect(ui.send).toHaveBeenCalled();
  });

  test.each([
    ["a failed listing", { stdout: "", exitCode: 128 }],
    ["a killed listing", { stdout: "", exitCode: -1 }],
  ])("AC-22 the real index draws the line for %s", async (_label, answer) => {
    chat._mentionFilesDeps.git = async () => answer;
    const ui = mount();
    ui.type("@");
    await ui.settle();
    expect(ui.rows()).toContain(NO_GIT_LINE);
    expect(ui.rows().some((line) => line.startsWith("❯ "))).toBe(false);
  });

  test("AC-21 the real default index feeds the picker from git's own listing", async () => {
    chat._mentionFilesDeps.git = async () => ({ stdout: "chat-host.ts\0", exitCode: 0 });
    const ui = mount();
    ui.type("@chh");
    await ui.settle();
    expect(ui.rows()).toContain("❯ chat-host.ts");
  });
});

describe("queries with nothing to offer", () => {
  test("AC-17 a word no row matches leaves the return to the prompt", async () => {
    scriptIndex(listed([row("a.ts")]));
    const ui = mount();
    ui.type("thanks @bob");
    await ui.settle();
    expect(ui.rows().some((line) => line.includes("a.ts"))).toBe(false);
    await ui.returnNow();
    expect(ui.send).toHaveBeenCalled();
  });

  test("AC-18 a listing that never settles leaves the return to the prompt", async () => {
    const { get } = scriptIndex(() => new Promise<MentionFileList>(() => {}));
    const ui = mount();
    ui.type("see @a");
    await ui.settle();
    // The index was asked and has not answered, so the row the answer would carry is not drawn.
    expect(get).toHaveBeenCalled();
    expect(ui.rows()).not.toContain("❯ a.ts");
    await ui.returnNow();
    expect(ui.send).toHaveBeenCalled();
  });
});

describe("rows already loaded", () => {
  /** A screen whose rows are loaded, its prompt then emptied — the state a batch arrives in. */
  async function loadedRows() {
    scriptIndex(listed([row("src/"), row("src/a.ts")]));
    const ui = mount();
    ui.type("@");
    await ui.settle();
    expect(ui.rows()).toContain("❯ src/");
    ui.press(CTRL_U);
    expect(ui.rows()).not.toContain("❯ src/");
    return ui;
  }

  test("AC-19 a query, a tab and a return in one batch complete the file", async () => {
    const ui = await loadedRows();
    ui.pressAll("@sr", TAB, RETURN);
    await ui.settle();
    expect(ui.promptText()).toBe("> @src/a.ts ");
  });

  test("AC-20 that batch sends nothing", async () => {
    const ui = await loadedRows();
    ui.pressAll("@sr", TAB, RETURN);
    await ui.settle();
    expect(ui.send).not.toHaveBeenCalled();
  });
});
