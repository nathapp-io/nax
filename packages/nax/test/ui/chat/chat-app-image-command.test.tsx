/**
 * US-011: the `/image [path]` builtin, driven through the mounted chat screen.
 *
 * The command itself reads nothing: `runSlashCommand` answers with an `attach` outcome and
 * the screen hands that to the attach hook, which is why every case here replaces
 * `_imageAttachDeps` and then asserts what the user sees — a placeholder in the prompt, a
 * notice row, or an untouched draft. A line is typed a code point at a time, so no chunk
 * counts as a paste and `onPaste` never answers the line instead of the command.
 *
 * The two menu regressions the builtin causes (the sixteen-row window and the navigation
 * target that `/image` must not move) are pinned next door, in
 * `test/ui/chat/slash-menu.test.tsx`, where the menu's own window arithmetic lives.
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { resolve } from "node:path";
import type { SessionEvent } from "@nathapp/nax-agent";
import { assertDefined } from "@test/helpers";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import { type ChatHost, type ChatHostState, createChatAskController } from "@/chat";
import { ChatApp } from "@/tui/chat/ChatApp";
import type { ClipboardImage } from "@/tui/chat/clipboard-image";
import { _imageAttachDeps } from "@/tui/chat/use-image-attach";

const RETURN = "\r";
/** ctrl+u kills the line before the cursor: how a case empties the prompt between commands. */
const CTRL_U = "\x15";
/** The screen's own directory, so a relative `/image` path has something to resolve against. */
const SCREEN_CWD = "/screen";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const STATE: ChatHostState = {
  sessionId: "image-command-session",
  mode: "guarded",
  model: "test-model",
  meta: {
    schemaVersion: 1,
    sessionId: "image-command-session",
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

/** What `/image` says when the clipboard holds no picture at all. */
const NO_IMAGE_ON_THE_CLIPBOARD = "no image on the clipboard";

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

/** Bytes a sniffer refuses: what a mistyped name, or a `.png` full of text, reads as. */
const NOT_AN_IMAGE = new TextEncoder().encode("hello");

/** A host whose `send` records every call and never settles until `finishTurn` resolves it. */
function makeHost(): { host: ChatHost; finishTurn: () => Promise<void> } {
  const gate = Promise.withResolvers<void>();
  const send = mock(async (_message: string, _onEvent: (event: SessionEvent) => void) => {
    await gate.promise;
  });
  const host: ChatHost = {
    repoRoot: "/repo",
    models: [STATE.model],
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
  };
  const finishTurn = async (): Promise<void> => {
    await Promise.resolve(
      act(async () => {
        gate.resolve();
      }),
    );
  };
  return { host, finishTurn };
}

/**
 * The mounted screen. Both attach reads are stubbed before the first key, so no case here can
 * spawn `osascript`, `wl-paste` or `xclip`; a case that cares sets what its read resolves.
 */
function mount(options: { cwd?: string } = {}) {
  const readClipboard = spyOn(_imageAttachDeps, "readClipboard").mockResolvedValue({ kind: "none" });
  const readFile = spyOn(_imageAttachDeps, "readFile").mockResolvedValue(undefined);
  const { host, finishTurn } = makeHost();
  const ui = render(<ChatApp host={host} cwd={options.cwd} />);
  const send = host.send;
  /** The frame's rows as the terminal shows them: no escape codes, no trailing blanks. */
  const rows = (): string[] =>
    Bun.stripANSI(ui.lastFrame() ?? "")
      .split("\n")
      .map((row) => row.trimEnd());
  /** The whole frame, for a case that only cares whether a line is on it. */
  const frame = (): string => rows().join("\n");
  /**
   * The prompt's own text row. It is the **last** `> ` row on the frame, because a submitted
   * line also draws a `> ` row — in the transcript, above the input.
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
  /** Drain the microtasks a command's reads run, with no wall-clock wait. */
  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 5; turn++) {
      await Promise.resolve(
        act(async () => {
          await Promise.resolve();
        }),
      );
    }
  };
  /** A line typed one code point at a time, so no chunk reaches `onPaste` as a paste. */
  const type = (text: string): void => {
    for (const char of text) press(char);
  };
  /** A line typed and returned, drained through the screen's own submit path. */
  const submit = async (text: string): Promise<void> => {
    type(text);
    await Promise.resolve(
      act(async () => {
        ui.stdin.write(RETURN);
      }),
    );
    await settle();
  };
  return {
    ...ui,
    host,
    send,
    rows,
    frame,
    promptRow,
    press,
    type,
    submit,
    finish: finishTurn,
    readClipboard,
    readFile,
  };
}

describe("/image reads the clipboard when it is given no path", () => {
  test("AC-3 a clipboard image lands in the prompt and nothing is sent", async () => {
    const ui = mount();
    ui.readClipboard.mockResolvedValue({ kind: "image", bytes: png(2, 3) } satisfies ClipboardImage);
    await ui.submit("/image");
    expect(ui.readClipboard).toHaveBeenCalledTimes(1);
    expect(ui.readFile).not.toHaveBeenCalled();
    expect(ui.promptRow()).toBe("> [Image #1]");
    expect(ui.send).not.toHaveBeenCalled();
  });

  test("AC-8 an empty clipboard notices and leaves the image draft as it was", async () => {
    const ui = mount();
    ui.readFile.mockResolvedValue(png(2, 3));
    await ui.submit("/image shots/a.png");
    expect(ui.promptRow()).toBe("> [Image #1]");
    // Empty the prompt without touching the draft: the placeholder goes, the image it names does not.
    ui.press(CTRL_U);
    expect(ui.promptRow()).not.toContain("[Image #");
    ui.readClipboard.mockResolvedValue({ kind: "none" } satisfies ClipboardImage);
    await ui.submit("/image");
    expect(ui.frame()).toContain(NO_IMAGE_ON_THE_CLIPBOARD);
    expect(ui.frame()).not.toContain("[Image #2]");
    // The draft survived: the next attach is numbered on from the one already held.
    await ui.submit("/image shots/b.png");
    expect(ui.promptRow()).toBe("> [Image #2]");
  });
});

describe("/image reads the file it is given", () => {
  test("AC-4 a relative path is resolved against the screen's cwd and attached", async () => {
    const ui = mount({ cwd: SCREEN_CWD });
    ui.readFile.mockResolvedValue(png(2, 3));
    await ui.submit("/image shots/a.png");
    expect(ui.readFile).toHaveBeenCalledTimes(1);
    expect(ui.readFile).toHaveBeenCalledWith(resolve(SCREEN_CWD, "shots/a.png"));
    expect(ui.readClipboard).not.toHaveBeenCalled();
    expect(ui.promptRow()).toBe("> [Image #1]");
    expect(ui.send).not.toHaveBeenCalled();
  });

  test("AC-5 a file that is not there is named in a notice and inserts nothing", async () => {
    const ui = mount();
    ui.readFile.mockResolvedValue(undefined);
    await ui.submit("/image missing.png");
    expect(ui.frame()).toContain("image not found: missing.png");
    expect(ui.frame()).not.toContain("[Image #");
    // A path the user typed on purpose is never put back as text, unlike a lost paste.
    expect(ui.promptRow()).not.toContain("missing.png");
  });

  test("AC-6 a file that holds no image is refused, not typed back", async () => {
    const ui = mount();
    ui.readFile.mockResolvedValue(NOT_AN_IMAGE);
    await ui.submit("/image notes.png");
    expect(ui.frame()).toContain("image not attached: not a PNG, JPEG, GIF or WebP image");
    expect(ui.frame()).not.toContain("image not found");
    expect(ui.frame()).not.toContain("[Image #");
    expect(ui.promptRow()).not.toContain("notes.png");
  });
});

describe("/image in the command surfaces", () => {
  test("AC-7 /help lists the image command directly after /plugins", async () => {
    const ui = mount();
    await ui.submit("/help");
    ui.press("\u001b[5~");
    expect(ui.frame()).toContain(
      "/plugins  List plugins and what they provide\n/image  Attach an image to the next message",
    );
  });

  test("AC-9 a running turn keeps /image away from the clipboard and the disk", async () => {
    const ui = mount();
    await ui.submit("hello");
    expect(ui.send).toHaveBeenCalledTimes(1);
    await ui.submit("/image shots/a.png");
    expect(ui.frame()).toContain("wait for the turn to finish (Ctrl-C to interrupt)");
    expect(ui.readClipboard).not.toHaveBeenCalled();
    expect(ui.readFile).not.toHaveBeenCalled();
    expect(ui.send).toHaveBeenCalledTimes(1);
    // The guard waits, it does not reject: the same line reads the clipboard once the turn ends.
    ui.readClipboard.mockResolvedValue({ kind: "image", bytes: png(2, 3) } satisfies ClipboardImage);
    await ui.finish();
    await ui.submit("/image");
    expect(ui.readClipboard).toHaveBeenCalledTimes(1);
    expect(ui.promptRow()).toBe("> [Image #1]");
  });
});
