/**
 * US-014: what a send leaves behind — the rows it draws in the transcript, and the image
 * draft it empties.
 *
 * Every case drives the real screen through stdin and replaces only the attach seams
 * (`_imageAttachDeps`) and the mention expander (`_chatAppDeps.expandMentions`), so what is
 * asserted is what a user would see: the rows on the frame, what `host.send` was called
 * with, and which number the *next* ctrl+v hands out.
 *
 * The draft's numbering is what tells the reset apart. A draft that was not reset still
 * holds `[Image #1]`, so the next picture is `[Image #2]`; a draft that was reset starts
 * again at `[Image #1]`. Every "the draft was reset" case therefore ends on a ctrl+v and
 * reads the prompt row, rather than reaching for the hook's internals.
 *
 * One case rejects from `host.send`. The draft must be empty by then — the reset belongs to
 * the message reaching the host, not to the turn it starts finishing.
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ImageAttachment, SessionEvent } from "@nathapp/nax-agent";
import { assertDefined, firstCall } from "@test/helpers";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import { type ChatHost, type ChatHostState, type ChatSendOptions, createChatAskController } from "@/chat";
import { _chatAppDeps, ChatApp } from "@/tui/chat/ChatApp";
import { _imageAttachDeps } from "@/tui/chat/use-image-attach";

const CTRL_V = "\x16";
const RETURN = "\r";
const UP = "\x1b[A";
/** DEL: what the terminal sends for backspace, and what the line editor deletes before. */
const BACKSPACE = "\x7f";

/** The model the screen shows. */
const MODEL = "test-model";
const REPO_ROOT = "/repo";
/** A directory nothing exists in, so a mention listing has nothing to offer a case. */
const SCREEN_CWD = "/screen";
/** The code points one `[Image #1]` placeholder occupies. */
const PLACEHOLDER_CHARS = "[Image #1]".length;
/** The label a 2×3 PNG pasted from the clipboard earns, below a kibibyte of payload. */
const LABEL = "image 1 · png · 2×3 · 1 KB · clipboard";
/** What a case's turn rejection says, so the error row can be read off the frame. */
const TURN_FAILED = "turn failed";
/** The bytes a sniffer reads as a PNG: signature, then an IHDR carrying width and height. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const STATE: ChatHostState = {
  sessionId: "image-after-send-session",
  mode: "guarded",
  model: MODEL,
  meta: {
    schemaVersion: 1,
    sessionId: "image-after-send-session",
    cwd: REPO_ROOT,
    mode: "ask",
    model: MODEL,
    bashApproval: "gated",
    title: null,
    createdAt: "now",
    updatedAt: null,
    costUsd: 0,
  },
};

afterEach(() => {
  cleanup();
  mock.restore();
});

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

function u32be(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/** A PNG: signature, then an IHDR chunk carrying width and height. */
function png(width: number, height: number): Uint8Array {
  return new Uint8Array([
    ...PNG_SIGNATURE,
    0x00,
    0x00,
    0x00,
    0x0d, // IHDR chunk length (13)
    ...ascii("IHDR"),
    ...u32be(width),
    ...u32be(height),
    0x08,
    0x06,
    0x00,
    0x00,
    0x00, // bit depth, colour type, compression, filter, interlace
  ]);
}

/** One image as the expander hands it back: a mentioned file, attached by the real expander. */
function mentioned(source: string): ImageAttachment {
  return {
    mimeType: "image/png",
    data: Buffer.from(png(2, 3)).toString("base64"),
    width: 2,
    height: 3,
    source,
  };
}

interface HostOptions {
  /** The capability answer the host gives. */
  readonly accepts?: () => Promise<boolean>;
  /** Absent: the turn settles at once. Present: `host.send` rejects with it. */
  readonly reject?: Error;
}

/**
 * A host with one model and no catalog. `send` records every call, and either settles the
 * turn at once or rejects with the case's error.
 */
function fakeHost(options: HostOptions = {}) {
  const send = mock(async (_message: string, _onEvent: (event: SessionEvent) => void, _options?: ChatSendOptions) => {
    if (options.reject !== undefined) throw options.reject;
  });
  const host: ChatHost = {
    repoRoot: REPO_ROOT,
    models: [MODEL],
    asks: createChatAskController({ mode: "guarded", answer: () => {} }),
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
    ...(options.accepts === undefined ? {} : { acceptsImages: options.accepts }),
  };
  return { host, send };
}

/** The mounted screen, with its frame rows and the verbs a case drives it with. */
function mount(options: HostOptions = {}) {
  const readClipboard = spyOn(_imageAttachDeps, "readClipboard").mockResolvedValue({ kind: "none" });
  const readFile = spyOn(_imageAttachDeps, "readFile").mockResolvedValue(undefined);
  const { host, send } = fakeHost(options);
  const ui = render(<ChatApp host={host} cwd={SCREEN_CWD} />);
  /** The frame's rows as the terminal shows them: no escape codes, no trailing blanks. */
  const rows = (): string[] =>
    Bun.stripANSI(ui.lastFrame() ?? "")
      .split("\n")
      .map((row) => row.trimEnd());
  /** The whole frame, for a case that only cares whether a line is on it. */
  const frame = (): string => rows().join("\n");
  /**
   * The prompt's own text row: the **last** `> ` row on the frame, because a submitted line
   * also draws a `> ` row, in the transcript above the input.
   */
  const promptRow = (): string => {
    const row = rows()
      .filter((line) => line.startsWith("> "))
      .at(-1);
    assertDefined(row, "the prompt's text row");
    return row;
  };
  /** A keypress in its own act, for a key that does its work synchronously. */
  const press = (sequence: string): void => {
    act(() => {
      ui.stdin.write(sequence);
    });
  };
  /** Drain the microtasks a send's `await`s run, with no wall-clock wait. */
  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 5; turn++) {
      await Promise.resolve(
        act(async () => {
          await Promise.resolve();
        }),
      );
    }
  };
  /** A keypress whose effect lands after an `await` — a read, or a send's prepare step. */
  const pressAndSettle = async (sequence: string): Promise<void> => {
    await Promise.resolve(
      act(async () => {
        ui.stdin.write(sequence);
      }),
    );
    await settle();
  };
  /** A line typed one code point at a time, so no chunk counts as a paste. */
  const type = (text: string): void => {
    for (const char of text) press(char);
  };
  /** A line typed and returned, drained through the screen's own submit path. */
  const submit = async (text: string): Promise<void> => {
    type(text);
    await pressAndSettle(RETURN);
  };
  /** ctrl+v with the clipboard holding `bytes`. */
  const pasteImage = async (bytes: Uint8Array): Promise<void> => {
    readClipboard.mockResolvedValue({ kind: "image", bytes });
    await pressAndSettle(CTRL_V);
  };
  /** Delete the placeholder `[Image #1]` the prompt holds, leaving the text around it. */
  const deletePlaceholder = (): void => {
    for (let step = 0; step < PLACEHOLDER_CHARS; step++) press(BACKSPACE);
  };
  return {
    ...ui,
    send,
    rows,
    frame,
    promptRow,
    press,
    pressAndSettle,
    type,
    submit,
    pasteImage,
    deletePlaceholder,
    readClipboard,
    readFile,
  };
}

/** The nth `host.send` call, failing the test when the call never happened. */
function callAt(send: ReturnType<typeof fakeHost>["send"], index: number) {
  const call = send.mock.calls[index];
  assertDefined(call, `host.send call ${index}`);
  return call;
}

/** The images `host.send` was called with, or an empty list when the call carried none. */
function sentImages(send: ReturnType<typeof fakeHost>["send"]): readonly ImageAttachment[] {
  return firstCall(send, "host.send")[2]?.images ?? [];
}

describe("the rows a sent image leaves in the transcript", () => {
  test("AC-3 draws the user row and the image's note row", async () => {
    const ui = mount({ accepts: async () => true });
    await ui.pasteImage(png(2, 3));
    ui.type(" look");
    await ui.pressAndSettle(RETURN);
    expect(ui.send).toHaveBeenCalledTimes(1);
    const rows = ui.rows();
    const at = rows.indexOf("> [Image #1] look");
    expect(at).toBeGreaterThanOrEqual(0);
    const note = rows.slice(at + 1).find((row) => row !== "");
    assertDefined(note, "the image note row");
    expect(note).toContain(LABEL);
    expect(rows.filter((row) => row.includes(LABEL))).toHaveLength(1);
  });
});

describe("a send empties the image draft", () => {
  test("AC-1 a message whose placeholder was deleted sends no image", async () => {
    const ui = mount({ accepts: async () => true });
    await ui.pasteImage(png(2, 3));
    expect(ui.promptRow()).toBe("> [Image #1]");
    ui.deletePlaceholder();
    expect(ui.promptRow()).not.toContain("[Image #1]");
    ui.type("hello");
    expect(ui.promptRow()).toBe("> hello");
    await ui.pressAndSettle(RETURN);
    expect(ui.send).toHaveBeenCalledTimes(1);
    const call = firstCall(ui.send, "host.send");
    expect(call[0]).toBe("hello");
    // The two-argument call: no images, no options at all.
    expect(call).toHaveLength(2);
    expect(call[2]).toBeUndefined();
  });

  test("AC-4 the next ctrl+v starts again at [Image #1]", async () => {
    const ui = mount({ accepts: async () => true });
    await ui.pasteImage(png(2, 3));
    ui.type(" look");
    await ui.pressAndSettle(RETURN);
    expect(ui.send).toHaveBeenCalledTimes(1);
    expect(sentImages(ui.send)).toHaveLength(1);
    await ui.pasteImage(png(2, 4));
    expect(ui.promptRow()).toBe("> [Image #1]");
  });

  test("AC-6 a send with no image in it still resets the draft", async () => {
    const ui = mount({ accepts: async () => true });
    await ui.pasteImage(png(2, 3));
    ui.deletePlaceholder();
    await ui.submit("hello");
    expect(ui.send).toHaveBeenCalledTimes(1);
    expect(sentImages(ui.send)).toEqual([]);
    await ui.pasteImage(png(2, 4));
    expect(ui.promptRow()).toBe("> [Image #1]");
  });

  test("AC-7 a rejecting send still resets the draft it consumed", async () => {
    const ui = mount({ accepts: async () => true, reject: new Error(TURN_FAILED) });
    await ui.pasteImage(png(2, 3));
    ui.type(" look");
    await ui.pressAndSettle(RETURN);
    expect(ui.send).toHaveBeenCalledTimes(1);
    expect(ui.frame()).toContain(TURN_FAILED);
    await ui.pasteImage(png(2, 4));
    expect(ui.promptRow()).toBe("> [Image #1]");
  });
});

describe("history keeps text only", () => {
  test("AC-5 up recalls the sent line as text, and sending it carries no image", async () => {
    const ui = mount({ accepts: async () => true });
    await ui.pasteImage(png(2, 3));
    ui.type(" look");
    await ui.pressAndSettle(RETURN);
    expect(ui.send).toHaveBeenCalledTimes(1);
    ui.press(UP);
    expect(ui.promptRow()).toBe("> [Image #1] look");
    await ui.pressAndSettle(RETURN);
    expect(ui.send).toHaveBeenCalledTimes(2);
    const recalled = callAt(ui.send, 1);
    expect(recalled[0]).toBe("[Image #1] look");
    expect(recalled).toHaveLength(2);
    expect(recalled[2]).toBeUndefined();
  });
});

describe("a mentioned image travels with the expanded message", () => {
  test("AC-2 sends the expander's message with the images it returned", async () => {
    const expanded = "EXPANDED";
    const shot = mentioned("shot.png");
    const expand = spyOn(_chatAppDeps, "expandMentions").mockResolvedValue({
      message: expanded,
      records: [],
      images: [shot],
    });
    const ui = mount({ accepts: async () => true });
    await ui.submit("see @shot.png");
    expect(expand).toHaveBeenCalledTimes(1);
    const [message, _onEvent, options] = firstCall(ui.send, "host.send");
    expect(message).toBe(expanded);
    expect(options?.title).toBe("see @shot.png");
    expect(options?.images).toEqual([shot]);
  });
});
