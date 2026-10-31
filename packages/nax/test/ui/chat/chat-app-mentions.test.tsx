/**
 * The send path's mention expansion: a typed message with a mention or a pasted mention
 * trailer goes through `_chatAppDeps.expandMentions` once, the expanded text is what the
 * brain receives as `host.send`'s message, and the typed text stays the send's title and
 * the submit history's entry. What nax expanded renders as the user's own words followed by
 * one row per attachment, so a live turn shows what the stored history replays.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { SessionEvent } from "@nathapp/nax-agent";
import { assertDefined } from "@test/helpers";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import * as chat from "@/chat";
import {
  type ChatHost,
  type ChatHostState,
  type ChatSendOptions,
  type ExpandedMentions,
  formatMentionMessage,
  type MentionRecord,
  parseMentionMessage,
} from "@/chat";
import { _chatAppDeps, ChatApp } from "@/tui/chat/ChatApp";

const RETURN = "\r";
const UP = "\x1b[A";
/** What the user typed in the expansion cases; the title and the history entry it keeps. */
const TYPED = "see @a.ts";
/** What the expander answers those cases with, so the expansion is visible in the frame. */
const EXPANDED = "EXPANDED";
/** A mention of a two-line file, as the expander records it. */
const ATTACHED_A: MentionRecord = { path: "a.ts", status: "attached", note: "2 lines", body: "x\ny\n" };
/** A message that carries a mention trailer but no `@`: pasted, not typed. */
const PASTED = "x </nax-mentions y";
/** No records: an expansion that found nothing still travels as the message it returned. */
const NO_RECORDS: ExpandedMentions = { message: EXPANDED, records: [] };
/** The row the expanded message renders as, so the AC's own words can be asserted. */
const ATTACHED_ROW = "attached @a.ts · 2 lines";

const STATE: ChatHostState = {
  sessionId: "mentions-session",
  mode: "guarded",
  model: "test-model",
  meta: {
    schemaVersion: 1,
    sessionId: "mentions-session",
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

/** The expander's deps, as they were before a case replaced them. */
const originalExpandDeps = { ...chat._mentionExpandDeps };
afterEach(() => {
  cleanup();
  mock.restore();
  Object.assign(chat._mentionExpandDeps, originalExpandDeps);
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
  const host: ChatHost = {
    repoRoot,
    models: ["test-model"],
    asks: {
      pending: () => [],
      canRemember: () => false,
      requestHostApproval: async () => "deny",
      requestHostChoice: async (card) => card.fallback,
      requestHostQuestion: async () => null,
      resolveChoice: () => {},
      resolve: () => {},
      setMode: () => {},
      reset: () => {},
      handle: () => {},
      answerQuestion: () => {},
      onChange: () => () => {},
    },
    current: () => STATE,
    notice: () => undefined,
    send,
    start: async () => {},
    clear: async () => {},
    resume: async () => {},
    switchTo: async () => {},
    cancel: () => {},
    listSessions: async () => [],
    close: async () => {},
  };
  return { host, send };
}

/** The mounted screen, with its frame rows and the two verbs a case types with. */
function mount(options: { cwd?: string; repoRoot?: string } = {}) {
  const fake = fakeHost(options.repoRoot);
  const ui = render(<ChatApp host={fake.host} cwd={options.cwd} />);
  /** The frame's rows as the terminal shows them: no escape codes, no trailing blanks. */
  const rows = (): string[] =>
    Bun.stripANSI(ui.lastFrame() ?? "")
      .split("\n")
      .map((row) => row.trimEnd());
  /** One keypress, in its own act, so the frame read afterwards is the frame it produced. */
  const press = (sequence: string): void =>
    act(() => {
      ui.stdin.write(sequence);
    });
  /** A line typed a keypress at a time, then the return that submits it. */
  const submit = async (text: string): Promise<void> => {
    for (const char of text) press(char);
    await Promise.resolve(
      act(async () => {
        ui.stdin.write(RETURN);
      }),
    );
  };
  return { ...fake, ui, rows, press, submit };
}

/** The deps the real expander reads: `/repo/a.ts` holds "x\n", and nothing is git-ignored. */
function fakeRepoWithOneFile(): void {
  chat._mentionExpandDeps.realpath = async (path) => {
    if (path === "/repo" || path === "/repo/a.ts") return path;
    throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
  };
  chat._mentionExpandDeps.stat = async () => ({ isDirectory: false, size: 2 });
  chat._mentionExpandDeps.readBytes = async () => new TextEncoder().encode("x\n");
  chat._mentionExpandDeps.git = async () => ({ stdout: "", exitCode: 1, timedOut: false });
}

describe("sending an expanded message", () => {
  test("AC-1 expands a mention-triggering message once, against the cwd and the host's repo root", async () => {
    const expand = spyOn(_chatAppDeps, "expandMentions").mockResolvedValue(NO_RECORDS);
    const ui = mount({ cwd: "/repo/pkg", repoRoot: "/repo" });
    await ui.submit(TYPED);
    expect(expand).toHaveBeenCalledTimes(1);
    expect(expand).toHaveBeenCalledWith(TYPED, { cwd: "/repo/pkg", repoRoot: "/repo" });
  });

  test("AC-2 sends the expanded message with the typed text as its title", async () => {
    spyOn(_chatAppDeps, "expandMentions").mockResolvedValue(NO_RECORDS);
    const ui = mount({ cwd: "/repo/pkg", repoRoot: "/repo" });
    await ui.submit(TYPED);
    expect(ui.send).toHaveBeenCalledWith(EXPANDED, expect.any(Function), { title: TYPED });
  });

  test("AC-3 a message with no mention keeps the plain two-argument send", async () => {
    const ui = mount();
    await ui.submit("hello");
    expect(ui.send).toHaveBeenCalledWith("hello", expect.any(Function));
    expect(ui.send.mock.calls[0]).toHaveLength(2);
  });

  test("AC-4 a message with no mention is not expanded", async () => {
    const expand = spyOn(_chatAppDeps, "expandMentions").mockResolvedValue(NO_RECORDS);
    const ui = mount();
    await ui.submit("hello");
    expect(expand).not.toHaveBeenCalled();
  });

  test("AC-5 a slash command is never expanded", async () => {
    const expand = spyOn(_chatAppDeps, "expandMentions").mockResolvedValue(NO_RECORDS);
    const ui = mount();
    await ui.submit("/help @a.ts");
    expect(expand).not.toHaveBeenCalled();
  });

  test("AC-6 a pasted mention trailer is expanded even without an @", async () => {
    const expand = spyOn(_chatAppDeps, "expandMentions").mockResolvedValue(NO_RECORDS);
    const ui = mount();
    await ui.submit(PASTED);
    expect(expand).toHaveBeenCalledTimes(1);
    expect(expand).toHaveBeenCalledWith(PASTED, { cwd: "/repo", repoRoot: "/repo" });
  });
});

describe("rendering an expanded message", () => {
  /** The expander's answer for `TYPED`: the envelope the real one builds. */
  function expandToEnvelope() {
    const message = formatMentionMessage(TYPED, [ATTACHED_A]);
    return spyOn(_chatAppDeps, "expandMentions").mockResolvedValue({ message, records: [ATTACHED_A] });
  }

  test("AC-7 the transcript shows the typed text, not the envelope", async () => {
    const expand = expandToEnvelope();
    const ui = mount();
    await ui.submit(TYPED);
    expect(expand).toHaveBeenCalledWith(TYPED, { cwd: "/repo", repoRoot: "/repo" });
    const row = ui.rows().find((line) => line.endsWith(TYPED));
    assertDefined(row, "the user's message row");
    expect(row).toBe(`> ${TYPED}`);
    expect(ui.rows().join("\n")).not.toContain("</nax-mentions");
  });

  test("AC-8 the row under it names the attachment and its note", async () => {
    expandToEnvelope();
    const ui = mount();
    await ui.submit(TYPED);
    const rows = ui.rows();
    const at = rows.indexOf(`> ${TYPED}`);
    expect(at).toBeGreaterThanOrEqual(0);
    const next = rows.slice(at + 1).find((line) => line !== "");
    assertDefined(next, "the attachment row");
    expect(next).toContain(ATTACHED_ROW);
  });

  test("AC-9 up recalls the typed text, never the expanded message", async () => {
    spyOn(_chatAppDeps, "expandMentions").mockResolvedValue(NO_RECORDS);
    const ui = mount();
    await ui.submit(TYPED);
    expect(ui.rows().filter((row) => row === `> ${EXPANDED}`)).toHaveLength(1);
    ui.press(UP);
    const rows = ui.rows();
    expect(rows.filter((row) => row === `> ${TYPED}`)).toHaveLength(1);
    expect(rows.filter((row) => row === `> ${EXPANDED}`)).toHaveLength(1);
  });
});

describe("the default expander", () => {
  test("AC-10 sends the expanded envelope the real expander builds", async () => {
    fakeRepoWithOneFile();
    const ui = mount({ cwd: "/repo", repoRoot: "/repo" });
    await ui.submit(TYPED);
    const sent = ui.send.mock.calls[0]?.[0];
    assertDefined(sent, "the message host.send received");
    expect(parseMentionMessage(sent)).toEqual({
      text: TYPED,
      records: [{ path: "a.ts", status: "attached", note: "1 lines", body: "x\n" }],
    });
  });
});
