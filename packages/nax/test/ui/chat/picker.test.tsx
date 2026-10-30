/**
 * Picker — the framed list the chat screen shows in place of its input for `/model`,
 * `/mode` and `/resume` (US-027).
 *
 * Every frame here is the mounted screen's own output: a command is submitted with the
 * keys a terminal sends, the pointer is moved and a choice made with the same keys, and
 * what the picker asked the host to do is read off the typed fake host. The list rows are
 * read back through the frame's own columns — the rules that bound it, the pointer's two
 * columns, and the gap before a row's detail — so an assertion about a row's label is
 * about what the user sees, never about a handler's internals.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { createSessionStorage, LIST_PAGE_SIZE, type SessionMeta } from "@nathapp/nax-agent";
import {
  assertDefined,
  cleanupTempDir,
  pickerEntryRows as entryRows,
  pickerFrameOf as frameOf,
  pickerLabelOf as labelOf,
  makeLogger,
  makeNaxConfig,
  makeTempDir,
  mountChatPicker as mount,
  waitForCondition,
} from "@test/helpers";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import type { ChatHostDeps, ChatSessionRow } from "@/chat";
import { createChatHost } from "@/chat/chat-host";
import {
  _pickerDeps,
  type ChatPicker,
  type PickerModel,
  pickerLayout,
  pickerModel,
  pickerRows,
  useChatPicker,
} from "@/tui/chat/Picker";
import { plainText } from "@/tui/chat/styled-line";
import { resolveChatTheme } from "@/tui/chat/theme";

/** The sequences ink parses into the keys the picker owns. */
const ESCAPE = "\x1b";
const RETURN = "\r";
const DOWN = "\x1b[B";
const PAGE_UP = "\x1b[5~";
const END = "\x1b[F";
const SHIFT_TAB = "\x1b[Z";

/** The host's catalogue, in the order the model picker offers it. */
const MODELS = ["model-a", "model-b", "model-c"] as const;

/** A transcript of a hundred code lines, each named so a frame can say which it shows. */
const CODE_LINES = Array.from({ length: 100 }, (_unused, index) => `zz${String(index + 1).padStart(3, "0")}`);
const NEWEST_CODE_LINE = CODE_LINES[CODE_LINES.length - 1] ?? "";

/** The usage a scripted turn reports when it ends. */
const USAGE = { inputTokens: 0, outputTokens: 0 };

/** The placeholder an empty idle input draws: the screen's proof that the input is back. */
const INPUT_PLACEHOLDER = 'Try "explain how nax run picks a model" · / for commands';

/** The selection pointer locating the chosen entry in the frame. */
const POINTER = "❯";

const originalPickerNow = _pickerDeps.now;
afterEach(() => {
  cleanup();
  mock.restore();
  _pickerDeps.now = originalPickerNow;
});

describe("Picker — model and mode", () => {
  test("US-006 AC-16 navigates to the twentieth host model", async () => {
    const models = Array.from({ length: 20 }, (_, index) => `p/model-${index + 1}`);
    const ui = mount({ models, current: { model: models[0] } });
    await ui.submit("/model");
    for (let index = 0; index < 19; index++) ui.press(DOWN);
    const entries = entryRows(frameOf(ui.rows(), "Switch model").inside);
    expect(entries.find((row) => row.startsWith(POINTER))).toContain("p/model-20");
    ui.press(RETURN);
    await ui.settle();
    expect(ui.switchTo).toHaveBeenCalledWith({ model: "p/model-20" });
  });
  test("AC-1 /model opens a framed Switch model list with a row per host model", async () => {
    const ui = mount();
    await ui.submit("/model");
    const frame = frameOf(ui.rows(), "Switch model");
    expect(frame.top).toMatch(/^─+$/);
    expect(frame.bottom).toMatch(/^─+$/);
    expect(entryRows(frame.inside).map(labelOf)).toEqual([...MODELS]);
  });

  test("AC-2 the current model's row shows (current)", async () => {
    const ui = mount();
    await ui.submit("/model");
    const entries = entryRows(frameOf(ui.rows(), "Switch model").inside);
    const marked = entries.filter((row) => row.includes("(current)"));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain(MODELS[0]);
    expect(marked[0]?.endsWith("(current)")).toBe(true);
  });

  test("AC-3 downArrow then return switches to the second model", async () => {
    const ui = mount();
    await ui.submit("/model");
    ui.press(DOWN);
    ui.press(RETURN);
    await ui.settle();
    expect(ui.switchTo).toHaveBeenCalledWith({ model: MODELS[1] });
  });

  test("AC-4 the choice closes the picker and shows the input again", async () => {
    const ui = mount();
    await ui.submit("/model");
    expect(ui.rows()).toContain("Switch model");
    ui.press(DOWN);
    ui.press(RETURN);
    await ui.settle();
    expect(ui.rows()).not.toContain("Switch model");
    expect(ui.rows().join("\n")).toContain(INPUT_PLACEHOLDER);
  });

  test("AC-5 escape closes the picker without switching anything", async () => {
    const ui = mount();
    await ui.submit("/model");
    expect(ui.rows()).toContain("Switch model");
    ui.press(ESCAPE);
    await ui.settle();
    expect(ui.switchTo).not.toHaveBeenCalled();
    expect(ui.rows()).not.toContain("Switch model");
    expect(ui.rows().join("\n")).toContain(INPUT_PLACEHOLDER);
  });

  test("AC-6 /mode opens Permission mode with the guarded and full rows first", async () => {
    const ui = mount();
    await ui.submit("/mode");
    const frame = frameOf(ui.rows(), "Permission mode");
    expect(frame.top).toMatch(/^─+$/);
    expect(entryRows(frame.inside).map(labelOf).slice(0, 2)).toEqual(["guarded", "full"]);
  });

  test("AC-7 the guarded row is the current one", async () => {
    const ui = mount();
    await ui.submit("/mode");
    const entries = entryRows(frameOf(ui.rows(), "Permission mode").inside);
    const guarded = entries.find((row) => labelOf(row) === "guarded") ?? "";
    const full = entries.find((row) => labelOf(row) === "full") ?? "";
    expect(guarded).toContain("(current)");
    expect(full).not.toContain("(current)");
  });

  test("AC-8 choosing full switches the permission mode", async () => {
    const ui = mount();
    await ui.submit("/mode");
    ui.press(DOWN);
    ui.press(RETURN);
    await ui.settle();
    expect(ui.switchTo).toHaveBeenCalledWith({ mode: "full" });
  });
});

const FILTER_MODELS = ["anthropic/claude-x", "openai/gpt-y"];
const FILTER_THEME = resolveChatTheme({ env: {}, colorLevel: 0 });
const filterModel = (query = "", kind: PickerModel["kind"] = "model") =>
  pickerModel({ kind, query, models: FILTER_MODELS, currentModel: FILTER_MODELS[0] ?? "", currentMode: "guarded" });
const filterLayout = (query: string) =>
  pickerLayout(filterModel(query), { width: 80, budget: 20, theme: FILTER_THEME });

describe("US-007 pure model and layout", () => {
  test("AC-1 case-insensitive substring filters model values", () => {
    expect(filterModel("GPT").entries.map((entry) => entry.value)).toEqual(["openai/gpt-y"]);
  });
  test("AC-2 empty and absent queries retain every model", () => {
    expect(filterModel().entries.map((entry) => entry.value)).toEqual(FILTER_MODELS);
    expect(
      pickerModel({ kind: "model", models: FILTER_MODELS, currentModel: "", currentMode: "guarded" }).entries,
    ).toHaveLength(2);
  });
  test("AC-3 carries the query", () => {
    expect(filterModel("GPT").query).toBe("GPT");
    expect(filterModel().query).toBe("");
  });
  test("AC-4 mode ignores query", () => {
    expect(filterModel("zzz", "mode").entries.map((entry) => entry.value)).toEqual(["guarded", "full"]);
    expect(filterModel("zzz", "mode").query).toBeUndefined();
  });
  test("AC-5 equal three-entry fixtures reserve one extra model row", () => {
    const fixture: PickerModel = {
      kind: "mode",
      title: "fixture",
      entries: ["a", "b", "c"].map((value) => ({ value, label: value })),
    };
    expect(pickerRows({ ...fixture, kind: "model" }, 20)).toBe(pickerRows(fixture, 20) + 1);
  });
  test.each([
    ["", "type to filter"],
    ["gp", "Filter: gp"],
  ])("AC-6 AC-7 query %s sits directly under title", (query, text) => {
    const layout = filterLayout(query);
    expect(layout.lines[1]?.map((span) => span.text).join("")).toBe("Switch model");
    expect(layout.lines[2]?.map((span) => span.text).join("")).toBe(text);
    expect(layout.rows).toBe(pickerRows(filterModel(query), 20));
    if (query === "") expect(layout.lines[2]?.[0]?.color).toBe("muted");
  });
  test("AC-8 empty matches draw a muted note", () => {
    const layout = filterLayout("zzz");
    const note = layout.lines.find((line) => plainText(line) === "no models match");
    expect(note?.[0]?.color).toBe("muted");
    expect(filterModel("zzz").entries).toEqual([]);
  });
});

describe("US-007 hook query state", () => {
  test("AC-9 AC-10 filters and resets on cancel and reopen", () => {
    const { host } = mount({ models: FILTER_MODELS });
    let picker: ChatPicker | undefined;
    function Harness() {
      picker = useChatPicker({
        host,
        runControl: async (task) => {
          await task();
          return true;
        },
        onError: () => {},
        show: () => {},
      });
      return null;
    }
    render(<Harness />);
    const current = (): ChatPicker => {
      assertDefined(picker, "hook result");
      return picker;
    };
    act(() => current().open("model"));
    act(() => current().setQuery("gp"));
    expect(current().model?.entries.map((entry) => entry.value)).toEqual(["openai/gpt-y"]);
    act(() => current().cancel());
    expect(current().model).toBeUndefined();
    act(() => current().open("model"));
    expect(current().model?.query).toBe("");
    expect(current().model?.entries).toHaveLength(2);
  });
});

describe("US-007 mounted query seam", () => {
  const open = async () => {
    const ui = mount({ models: FILTER_MODELS });
    await ui.submit("/model");
    return ui;
  };
  const entries = (ui: ReturnType<typeof mount>) => entryRows(frameOf(ui.rows(), "Switch model").inside);
  test("AC-11 typing gpt leaves exactly the matching entry", async () => {
    const ui = await open();
    ui.press("gpt");
    expect(entries(ui).map(labelOf)).toEqual(["openai/gpt-y"]);
    expect(ui.rows()).toHaveLength(23);
  });
  test("AC-12 backspace removes the last query character", async () => {
    const ui = await open();
    ui.press("gpt");
    ui.press("\x7f");
    expect(ui.rows()).toContain("Filter: gp");
  });
  test("AC-13 return chooses the filtered entry", async () => {
    const ui = await open();
    ui.press("gpt");
    ui.press(RETURN);
    await ui.settle();
    expect(ui.switchTo).toHaveBeenCalledWith({ model: "openai/gpt-y" });
  });
  test.each([
    ["", ["gpt", RETURN], "openai/gpt-y"],
    ["", ["zzz", RETURN], undefined],
    ["gpt", ["\x7f", "\x7f", "\x7f", RETURN], "anthropic/claude-x"],
    ["", ["claude", DOWN, RETURN], "anthropic/claude-x"],
  ] as const)("batched query and return use latest matches from '%s': %j", async (initial, keys, expected) => {
    const ui = await open();
    if (initial !== "") ui.press(initial);
    act(() => {
      for (const key of keys) ui.ui.stdin.write(key);
    });
    await ui.settle();
    if (expected === undefined) {
      expect(ui.switchTo).not.toHaveBeenCalled();
      expect(ui.rows()).toContain("no models match");
      expect(ui.rows()).toContain("Switch model");
    } else {
      expect(ui.switchTo).toHaveBeenCalledTimes(1);
      expect(ui.switchTo).toHaveBeenCalledWith({ model: expected });
    }
  });
  test("AC-14 query change resets the pointer", async () => {
    const ui = await open();
    ui.press(DOWN);
    ui.press("a");
    expect(entries(ui)[0]?.startsWith(POINTER)).toBe(true);
    expect(ui.rows()).toContain("Filter: a");
  });
  test("AC-15 no matches keeps picker open and return does nothing", async () => {
    const ui = await open();
    ui.press("zzz");
    ui.press(RETURN);
    await ui.settle();
    expect(entries(ui)).toEqual([]);
    expect(ui.rows()).toContain("no models match");
    expect(ui.rows()).toContain("Switch model");
    expect(ui.switchTo).not.toHaveBeenCalled();
  });
  test("AC-16 escape cancels a filtered picker", async () => {
    const ui = await open();
    ui.press("gpt");
    expect(ui.rows()).toContain("Filter: gpt");
    ui.press(ESCAPE);
    await ui.settle();
    expect(ui.rows()).not.toContain("Switch model");
    expect(ui.switchTo).not.toHaveBeenCalled();
  });
  test("AC-17 typing leaves the chat draft unchanged", async () => {
    const ui = await open();
    ui.press("gpt");
    expect(ui.rows()).toContain("Filter: gpt");
    ui.press(ESCAPE);
    expect(ui.rows().join("\n")).toContain(INPUT_PLACEHOLDER);
    expect(ui.rows().join("\n")).not.toContain("gpt");
  });
  test("AC-18 ctrl-modified letters leave the query unchanged", async () => {
    const ui = await open();
    ui.press("gp");
    ui.press("\x14");
    expect(ui.rows()).toContain("Filter: gp");
  });
  test("batched pointer moves and return choose the latest row", async () => {
    const ui = await open();
    act(() => {
      ui.ui.stdin.write(DOWN);
      ui.ui.stdin.write(RETURN);
    });
    await ui.settle();
    expect(ui.switchTo).toHaveBeenCalledWith({ model: "openai/gpt-y" });
  });
  test("mode and resume do not take typed queries", async () => {
    const ui = mount({ sessions: async () => [session()] });
    await ui.submit("/mode");
    ui.press("zzz");
    expect(entryRows(frameOf(ui.rows(), "Permission mode").inside).map(labelOf)).toEqual(["guarded", "full"]);
    ui.press(ESCAPE);
    await ui.submit("/resume");
    await ui.settle();
    ui.press("zzz");
    expect(resumeRows(ui).map(labelOf)).toEqual(["first session"]);
    expect(ui.rows().join("\n")).not.toContain("Filter:");
  });
  test("delete removes a whole grapheme and empty deletion is harmless", async () => {
    const ui = await open();
    ui.press("gp👩‍💻");
    ui.press("\x1b[3~");
    expect(ui.rows()).toContain("Filter: gp");
    ui.press("\x7f");
    ui.press("\x7f");
    ui.press("\x7f");
    expect(ui.rows()).toContain("type to filter");
  });
});

/** The instant every relative time in this block is measured against. */
const NOW_MS = Date.parse("2026-01-01T12:00:00.000Z");

/** One saved session, as the storage layer reports it. */
function session(overrides: Partial<ChatSessionRow> = {}): ChatSessionRow {
  return {
    sessionId: "11111111-aaaa",
    title: "first session",
    updatedAt: "2026-01-01T11:55:00.000Z",
    ...overrides,
  };
}

/** A `listSessions()` a case settles: `loading…` is observed before it resolves. */
function pendingSessions() {
  const gate = Promise.withResolvers<readonly ChatSessionRow[]>();
  return {
    sessions: () => gate.promise,
    resolve: (rows: readonly ChatSessionRow[]) => gate.resolve(rows),
    reject: (error: Error) => gate.reject(error),
  };
}

/** The rows of an open resume picker. */
function resumeRows(ui: ReturnType<typeof mount>): string[] {
  return entryRows(frameOf(ui.rows(), "Resume a session").inside);
}

describe("Picker — resume", () => {
  test("AC-9 /resume shows loading… until listSessions resolves", async () => {
    const pending = pendingSessions();
    const ui = mount({ sessions: pending.sessions });
    await ui.submit("/resume");
    expect(ui.rows()).toContain("Resume a session");
    expect(ui.rows().join("\n")).toContain("loading…");
    await ui.settleAfter(() => pending.resolve([session()]));
    expect(ui.rows().join("\n")).not.toContain("loading…");
  });

  test("AC-10 a settled list shows each session's title and its relative time", async () => {
    _pickerDeps.now = () => NOW_MS;
    const rows: readonly ChatSessionRow[] = [
      session(),
      session({
        sessionId: "22222222-bbbb",
        title: '<skill name="superpowers:brainstorming" location="/a',
        updatedAt: "2026-01-01T09:00:00.000Z",
      }),
    ];
    const ui = mount({ sessions: async () => rows });
    await ui.submit("/resume");
    await ui.settle();
    const drawn = resumeRows(ui);
    expect(drawn[0]).toContain("first session");
    expect(drawn[0]).toContain("5 min ago");
    expect(drawn[1]).toContain("/superpowers:brainstorming");
    expect(drawn[1]).toContain("3 h ago");
  });

  test("AC-11 a session without a title is untitled and its id's first eight characters", async () => {
    const ui = mount({ sessions: async () => [session({ sessionId: "abcdef1234", title: null, updatedAt: null })] });
    await ui.submit("/resume");
    await ui.settle();
    const drawn = resumeRows(ui);
    expect(drawn[0]).toContain("untitled abcdef12");
    expect(drawn[0]).not.toContain("abcdef1234");
  });

  test("AC-12 a session another process holds says in use (pid 4242)", async () => {
    const ui = mount({ sessions: async () => [session({ sessionId: "abcdef1234", heldByPid: 4242 })] });
    await ui.submit("/resume");
    await ui.settle();
    expect(resumeRows(ui)[0]).toContain("in use (pid 4242)");
  });

  test("AC-13 AC-14 return on a held session warns and leaves the picker open", async () => {
    const ui = mount({ sessions: async () => [session({ sessionId: "abcdef1234", heldByPid: 4242 })] });
    await ui.submit("/resume");
    await ui.settle();
    ui.press(RETURN);
    await ui.settle();
    expect(ui.rows().join("\n")).toContain("⚠ session abcdef1234 is in use by pid 4242");
    expect(ui.rows()).toContain("Resume a session");
    expect(ui.resume).not.toHaveBeenCalled();
  });

  test("AC-15 return on a free session resumes that row's id", async () => {
    const rows: readonly ChatSessionRow[] = [session(), session({ sessionId: "22222222-bbbb", title: "second" })];
    const ui = mount({ sessions: async () => rows });
    await ui.submit("/resume");
    await ui.settle();
    ui.press(DOWN);
    ui.press(RETURN);
    await ui.settle();
    expect(ui.resume).toHaveBeenCalledWith({ id: "22222222-bbbb" });
  });

  test("AC-16 a list with no sessions shows no saved sessions", async () => {
    const ui = mount({ sessions: async () => [] });
    await ui.submit("/resume");
    await ui.settle();
    expect(ui.rows()).toContain("Resume a session");
    expect(ui.rows().join("\n")).toContain("no saved sessions");
  });
});

describe("Picker — failures and the keys it leaves alone", () => {
  test("AC-17 a rejected listSessions closes the picker and shows the error", async () => {
    const pending = pendingSessions();
    const ui = mount({ sessions: pending.sessions });
    await ui.submit("/resume");
    expect(ui.rows().join("\n")).toContain("loading…");
    await ui.settleAfter(() => pending.reject(new Error("disk")));
    expect(ui.rows()).not.toContain("Resume a session");
    expect(ui.rows().join("\n")).toContain("✗ disk");
  });

  test("AC-18 AC-19 a rejected switchTo shows the error and brings the input back", async () => {
    const ui = mount({
      switchTo: async () => {
        throw new Error("nope");
      },
    });
    await ui.submit("/model");
    ui.press(RETURN);
    await ui.settle();
    expect(ui.rows().join("\n")).toContain("✗ nope");
    expect(ui.rows()).not.toContain("Switch model");
    expect(ui.rows().join("\n")).toContain(INPUT_PLACEHOLDER);
  });

  test("AC-20 AC-21 a rejected resume shows the error and brings the input back", async () => {
    const ui = mount({
      sessions: async () => [session()],
      resume: async () => {
        throw new Error("locked");
      },
    });
    await ui.submit("/resume");
    await ui.settle();
    ui.press(RETURN);
    await ui.settle();
    expect(ui.rows().join("\n")).toContain("✗ locked");
    expect(ui.rows()).not.toContain("Resume a session");
    expect(ui.rows().join("\n")).toContain(INPUT_PLACEHOLDER);
  });

  test("pageUp does not scroll the transcript while a picker is open", async () => {
    const ui = mount();
    await ui.submit("hello");
    ui.emit({ type: "text_delta", round: 1, text: `\`\`\`ts\n${CODE_LINES.join("\n")}\n\`\`\`` });
    // The key works while the transcript owns it: the newest line leaves the window.
    ui.press(PAGE_UP);
    expect(ui.rows().join("\n")).not.toContain(NEWEST_CODE_LINE);
    ui.press(END);
    expect(ui.rows().join("\n")).toContain(NEWEST_CODE_LINE);
    ui.emit({ type: "turn_end", status: "completed", output: "", costUsd: 0, usage: USAGE });
    await ui.finish();
    await ui.submit("/model");
    expect(ui.rows()).toContain("Switch model");
    // The picker owns the keys, so the viewport no longer sees pageUp.
    ui.press(PAGE_UP);
    expect(ui.rows().join("\n")).toContain(NEWEST_CODE_LINE);
  });

  test("shift+tab still cycles the permission mode while a picker is open", async () => {
    const ui = mount();
    await ui.submit("/model");
    ui.press(SHIFT_TAB);
    await ui.settle();
    expect(ui.switchTo).toHaveBeenCalledWith({ mode: "full" });
    expect(ui.rows()).toContain("Switch model");
  });
});

/** The store's pages, and a session index that is only reachable past the first of them. */
const STORED_SESSIONS = LIST_PAGE_SIZE + 6;
const PAGE_TWO_INDEX = LIST_PAGE_SIZE + 2;
/** How long the store's pages may take to reach the frame, which is read off disk. */
const SETTLE_MS = 5_000;
/** One minute between two stored sessions: the store's newest-first order is this file's order. */
const MINUTE_MS = 60_000;
/** The instant every stored session is written and measured at. */
const STORED_AT = Date.parse("2026-10-01T00:00:00.000Z");

/** The id the store sorts at `index`, named so a frame can say which row it is showing. */
function storedSessionId(index: number): string {
  return `zz${String(index).padStart(3, "0")}-session`;
}

/** One stored session's metadata: newest first, no title, this file's model. */
function storedMeta(storeDir: string, index: number): SessionMeta {
  const updatedAt = new Date(STORED_AT - index * MINUTE_MS).toISOString();
  return {
    schemaVersion: 1,
    sessionId: storedSessionId(index),
    cwd: storeDir,
    mode: "ask",
    model: "test-model",
    bashApproval: "gated",
    title: `title ${index}`,
    createdAt: updatedAt,
    updatedAt,
  };
}

describe("Picker — a session past the store's first page", () => {
  let storeDir: string;
  let host: ReturnType<typeof createChatHost> | undefined;
  let screen: ReturnType<typeof mount> | undefined;
  /** Every id an open was asked for: the resume the picker performed, and nothing else. */
  const opened: (string | undefined)[] = [];

  beforeEach(async () => {
    opened.length = 0;
    storeDir = makeTempDir("chat-picker-pages-");
    const storage = createSessionStorage({
      dir: join(storeDir, "sessions"),
      pid: process.pid,
      now: () => new Date(STORED_AT),
      logger: makeLogger(),
      isAlive: () => true,
    });
    for (let index = 0; index < STORED_SESSIONS; index += 1) await storage.writeMeta(storedMeta(storeDir, index));
    /** The opener is the assertion's ear: the host's own resume, not a mock of the picker. */
    const open: ChatHostDeps["open"] = async (request) => {
      opened.push(request.resumeId);
      const meta: SessionMeta = {
        ...storedMeta(storeDir, 0),
        sessionId: request.resumeId ?? "started-session",
        title: null,
        mode: "ask",
      };
      return {
        meta,
        release: async () => {},
        session: {
          id: meta.sessionId,
          backend: { kind: "native", capabilities: {} },
          async *send() {},
          answer: () => "unknown",
          cancel: () => {},
          close: async () => {},
          lastTurn: undefined,
        },
      };
    };
    host = createChatHost({
      config: makeNaxConfig({ outputDir: join(storeDir, "output") }),
      cwd: storeDir,
      repoRoot: storeDir,
      storage,
      chain: null,
      now: () => new Date(STORED_AT),
      logger: makeLogger(),
      open,
    });
    await host.start({ mode: "guarded", model: "test-model" });
    screen = mount({ host });
  });

  afterEach(async () => {
    await host?.close();
    cleanupTempDir(storeDir);
  });

  test("a row on the store's second page can be chosen and resumed", async () => {
    const ui = screen;
    assertDefined(ui, "the mounted chat screen");
    const target = `title ${PAGE_TWO_INDEX}`;
    const pointerOn = (label: string): boolean => ui.rows().some((row) => row.startsWith(`${POINTER} ${label}`));
    await ui.submit("/resume");
    // The store is read off disk, a page at a time: the list is drawn when the read settles.
    await waitForCondition(() => !ui.rows().join("\n").includes("loading…"), SETTLE_MS);
    await ui.settle();
    expect(ui.rows()).toContain("Resume a session");
    // The row to choose is past the store's first page: a first page alone never reaches it.
    for (let step = 0; step <= STORED_SESSIONS && !pointerOn(target); step += 1) ui.press(DOWN);
    expect(pointerOn(target)).toBe(true);
    ui.press(RETURN);
    await ui.settle();
    expect(opened).toContain(storedSessionId(PAGE_TWO_INDEX));
  });
});
