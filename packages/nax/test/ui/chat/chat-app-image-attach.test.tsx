/**
 * Attaching images in the mounted chat screen: a clipboard image on ctrl+v, a pasted image
 * file's path, and the draft effects that make them safe across an `await` — the newest
 * cursor, an ordered queue of attaches, and a paste that is never lost.
 *
 * Every case drives the real screen through stdin and replaces only `_imageAttachDeps`, so
 * what is asserted is what a user would see: a notice row, a placeholder in the prompt, or
 * the pasted chunk put back as text.
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import type { SessionEvent, SessionEventBody } from "@nathapp/nax-agent";
import { assertDefined, cleanupTempDir, makeTempDir } from "@test/helpers";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import {
  type ChatAskController,
  type ChatHost,
  type ChatHostState,
  type ChatSendOptions,
  createChatAskController,
} from "@/chat";
import { ChatApp } from "@/tui/chat/ChatApp";
import type { ClipboardImage } from "@/tui/chat/clipboard-image";
import { _imageAttachDeps } from "@/tui/chat/use-image-attach";

const CTRL_V = "\x16";
/** A fixed instant, so an ask card's countdown never reads the wall clock as "expired". */
const AT = "2026-01-01T00:00:00.000Z";
const EXPIRES_AT = "2026-01-01T00:10:00.000Z";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** The most raw bytes whose base64 form still fits the per-image limit (5,242,880 chars). */
const LARGEST_ACCEPTED_BYTES = 3_932_160;
/** The reader's cap: one byte past the accepted size, so an oversized file still refuses. */
const READ_CAP_BYTES = 3_932_161;

const STATE: ChatHostState = {
  sessionId: "images-session",
  mode: "guarded",
  model: "test-model",
  meta: {
    schemaVersion: 1,
    sessionId: "images-session",
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

const APPROVAL: SessionEventBody = {
  type: "approval_requested",
  requestId: "ask-1",
  tool: "Bash",
  command: "npm test",
  reason: "nax needs to run the tests",
  summary: "Run the tests",
  expiresAt: EXPIRES_AT,
};

/** The reader as it was before a case replaced it: the default `readFile` under test. */
const DEFAULT_READ_FILE = _imageAttachDeps.readFile;

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

/**
 * A PNG: signature, then an IHDR chunk carrying width and height. `totalBytes` pads the tail
 * with zeros, so a header can be read at a given file size.
 */
function png(width: number, height: number, totalBytes = 0): Uint8Array {
  const header = [
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
  ];
  const bytes = new Uint8Array(Math.max(totalBytes, header.length));
  bytes.set(header);
  return bytes;
}

/** Bytes a sniffer refuses: plain text, which is what a mistyped extension reads as. */
const NOT_AN_IMAGE = new TextEncoder().encode("hello");

/**
 * A host with one model and no catalog. `send` records every call and never settles, so the
 * screen sees a turn in flight exactly as a real one does.
 */
function fakeHost(asks: ChatAskController, repoRoot = "/repo"): ChatHost {
  const gate = Promise.withResolvers<void>();
  const send = mock(async (_message: string, _onEvent: (event: SessionEvent) => void, _options?: ChatSendOptions) => {
    await gate.promise;
  });
  return {
    repoRoot,
    models: ["test-model"],
    asks,
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
}

/** The mounted screen, with its frame rows and the verbs a case drives it with. */
function mount(options: { cwd?: string; ask?: SessionEventBody } = {}) {
  const asks = createChatAskController({ mode: "guarded", answer: () => {} });
  if (options.ask !== undefined) {
    asks.handle({ sessionId: STATE.sessionId, turnId: "t1", at: AT, metadata: {}, ...options.ask });
  }
  const ui = render(<ChatApp host={fakeHost(asks, options.cwd)} cwd={options.cwd} />);
  /** The frame's rows as the terminal shows them: no escape codes, no trailing blanks. */
  const rows = (): string[] =>
    Bun.stripANSI(ui.lastFrame() ?? "")
      .split("\n")
      .map((row) => row.trimEnd());
  /** The whole frame, for a case that only cares whether a line is on it. */
  const frame = (): string => rows().join("\n");
  /** One keypress in its own act, for a key that does its work synchronously. */
  const press = (sequence: string): void => {
    act(() => {
      ui.stdin.write(sequence);
    });
  };
  /** A keypress whose effect lands after an `await` — a clipboard or file read. */
  const pressAndSettle = (sequence: string): Promise<void> =>
    Promise.resolve(
      act(async () => {
        ui.stdin.write(sequence);
      }),
    );
  /** A line typed one code point at a time, so no chunk counts as a paste. */
  const type = (text: string): void => {
    for (const char of text) press(char);
  };
  return { ...ui, asks, rows, frame, press, pressAndSettle, type };
}

/** The input's own first text row, behind its `> ` marker. */
function promptRow(rows: readonly string[]): string {
  const row = rows.find((line) => line.startsWith("> "));
  assertDefined(row, "the prompt's first row");
  return row;
}

describe("ctrl+v reads an image from the clipboard", () => {
  test("AC-1 shows [Image #1] for a 2×3 PNG on the clipboard", async () => {
    const readClipboard = spyOn(_imageAttachDeps, "readClipboard").mockResolvedValue({
      kind: "image",
      bytes: png(2, 3),
    });
    const ui = mount();
    await ui.pressAndSettle(CTRL_V);
    expect(readClipboard).toHaveBeenCalledTimes(1);
    expect(promptRow(ui.rows())).toBe("> [Image #1]");
  });

  test("AC-2 a second ctrl+v puts [Image #2] at the cursor after typing ' and '", async () => {
    spyOn(_imageAttachDeps, "readClipboard").mockResolvedValue({ kind: "image", bytes: png(2, 3) });
    const ui = mount();
    await ui.pressAndSettle(CTRL_V);
    ui.type(" and ");
    await ui.pressAndSettle(CTRL_V);
    expect(promptRow(ui.rows())).toBe("> [Image #1] and [Image #2]");
  });

  test("AC-3 an empty clipboard notices and leaves the prompt empty", async () => {
    spyOn(_imageAttachDeps, "readClipboard").mockResolvedValue({ kind: "none" });
    const ui = mount();
    await ui.pressAndSettle(CTRL_V);
    expect(ui.frame()).toContain("no image on the clipboard");
    expect(ui.frame()).not.toContain("[Image #");
  });

  test("AC-4 an unsupported platform points at /image <path>", async () => {
    spyOn(_imageAttachDeps, "readClipboard").mockResolvedValue({ kind: "unsupported" });
    const ui = mount();
    await ui.pressAndSettle(CTRL_V);
    expect(ui.frame()).toContain("pasting images needs macOS or Linux; use /image <path>");
  });

  test("AC-5 a failed read names the reason", async () => {
    spyOn(_imageAttachDeps, "readClipboard").mockResolvedValue({
      kind: "failed",
      reason: "xclip is not installed",
    });
    const ui = mount();
    await ui.pressAndSettle(CTRL_V);
    expect(ui.frame()).toContain("could not read the clipboard: xclip is not installed");
  });

  test("AC-6 clipboard bytes that are not an image refuse and insert no placeholder", async () => {
    spyOn(_imageAttachDeps, "readClipboard").mockResolvedValue({ kind: "image", bytes: NOT_AN_IMAGE });
    const ui = mount();
    await ui.pressAndSettle(CTRL_V);
    expect(ui.frame()).toContain("image not attached: not a PNG, JPEG, GIF or WebP image");
    expect(ui.frame()).not.toContain("[Image #");
  });

  test("AC-7 an eleventh ctrl+v refuses on the count limit and attaches nothing", async () => {
    spyOn(_imageAttachDeps, "readClipboard").mockResolvedValue({ kind: "image", bytes: png(2, 3) });
    const ui = mount();
    for (let image = 0; image < 10; image++) await ui.pressAndSettle(CTRL_V);
    expect(ui.frame()).toContain("[Image #9]");
    await ui.pressAndSettle(CTRL_V);
    expect(ui.frame()).toContain("image not attached: at most 10 images per message");
    expect(ui.frame()).not.toContain("[Image #11]");
  });

  test("AC-8 an ask card on screen keeps ctrl+v away from the clipboard", async () => {
    const readClipboard = spyOn(_imageAttachDeps, "readClipboard").mockResolvedValue({
      kind: "image",
      bytes: png(2, 3),
    });
    const ui = mount({ ask: APPROVAL });
    expect(ui.frame()).toContain("Bash command");
    await ui.pressAndSettle(CTRL_V);
    expect(readClipboard).not.toHaveBeenCalled();
  });
});

describe("a pasted image file's path", () => {
  test("AC-9 attaches the file and shows no path", async () => {
    const readFile = spyOn(_imageAttachDeps, "readFile").mockResolvedValue(png(2, 3));
    const ui = mount();
    await ui.pressAndSettle("/tmp/shot.png");
    expect(readFile).toHaveBeenCalledWith("/tmp/shot.png");
    expect(promptRow(ui.rows())).toBe("> [Image #1]");
    expect(ui.frame()).not.toContain("shot.png");
  });

  test("AC-10 a file that is not there puts the chunk back as text", async () => {
    const readFile = spyOn(_imageAttachDeps, "readFile").mockResolvedValue(undefined);
    const ui = mount();
    await ui.pressAndSettle("/tmp/shot.png");
    expect(readFile).toHaveBeenCalledWith("/tmp/shot.png");
    expect(promptRow(ui.rows())).toBe("> /tmp/shot.png");
    expect(ui.frame()).not.toContain("image not");
  });

  test("AC-11 a file that is not an image puts the chunk back as text and notices nothing", async () => {
    const readFile = spyOn(_imageAttachDeps, "readFile").mockResolvedValue(NOT_AN_IMAGE);
    const ui = mount();
    await ui.pressAndSettle("/tmp/shot.png");
    expect(readFile).toHaveBeenCalledWith("/tmp/shot.png");
    expect(promptRow(ui.rows())).toBe("> /tmp/shot.png");
    expect(ui.frame()).not.toContain("image not attached");
  });

  test("AC-12 an oversized file is refused by its size and nothing is inserted", async () => {
    spyOn(_imageAttachDeps, "readFile").mockResolvedValue(png(2, 3, READ_CAP_BYTES));
    const ui = mount();
    await ui.pressAndSettle("/tmp/big.png");
    expect(ui.frame()).toContain("image not attached: image is larger than 3.75 MiB");
    expect(ui.frame()).not.toContain("big.png");
    expect(ui.frame()).not.toContain("[Image #");
  });

  test("AC-13 a chunk that is not a path is typed and never read", async () => {
    const readFile = spyOn(_imageAttachDeps, "readFile").mockResolvedValue(png(2, 3));
    const ui = mount();
    await ui.pressAndSettle("hello world");
    expect(readFile).not.toHaveBeenCalled();
    expect(promptRow(ui.rows())).toBe("> hello world");
  });
});

describe("attaches wait their turn", () => {
  test("AC-14 typing during a pending read survives, and the placeholder lands at the newest cursor", async () => {
    const pending = Promise.withResolvers<ClipboardImage>();
    spyOn(_imageAttachDeps, "readClipboard").mockReturnValue(pending.promise);
    const ui = mount();
    await ui.pressAndSettle(CTRL_V);
    ui.type("ab");
    expect(promptRow(ui.rows())).toBe("> ab");
    await Promise.resolve(
      act(async () => {
        pending.resolve({ kind: "image", bytes: png(2, 3) });
      }),
    );
    expect(promptRow(ui.rows())).toBe("> ab[Image #1]");
  });

  test("AC-15 a second ctrl+v reads only after the first resolved, and its placeholder follows", async () => {
    const first = Promise.withResolvers<ClipboardImage>();
    const readClipboard = spyOn(_imageAttachDeps, "readClipboard")
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue({ kind: "image", bytes: png(2, 3) });
    const ui = mount();
    await ui.pressAndSettle(CTRL_V);
    await ui.pressAndSettle(CTRL_V);
    expect(readClipboard).toHaveBeenCalledTimes(1);
    expect(ui.frame()).not.toContain("[Image #");
    await Promise.resolve(
      act(async () => {
        first.resolve({ kind: "image", bytes: png(2, 3) });
      }),
    );
    expect(readClipboard).toHaveBeenCalledTimes(2);
    expect(promptRow(ui.rows())).toBe("> [Image #1][Image #2]");
  });
});

describe("the default file reader", () => {
  test("AC-16 reads at most 3,932,161 bytes, and nothing from a missing path or a directory", async () => {
    const dir = makeTempDir("image-attach-");
    try {
      const big = join(dir, "big.png");
      await Bun.write(big, new Uint8Array(4_000_000));
      const bytes = await DEFAULT_READ_FILE(big);
      assertDefined(bytes, "the truncated read");
      expect(bytes.length).toBe(READ_CAP_BYTES);
      expect(await DEFAULT_READ_FILE(join(dir, "missing.png"))).toBeUndefined();
      expect(await DEFAULT_READ_FILE(dir)).toBeUndefined();
    } finally {
      cleanupTempDir(dir);
    }
  });
});

describe("refusals", () => {
  const reasons = ["clipboard read timed out", "boom"];
  test.each(reasons)("AC-17 a failed read reasoning %s notices without touching the draft", async (reason) => {
    spyOn(_imageAttachDeps, "readClipboard").mockResolvedValue({ kind: "failed", reason });
    const ui = mount();
    await ui.pressAndSettle(CTRL_V);
    expect(ui.frame()).toContain(`could not read the clipboard: ${reason}`);
    expect(ui.frame()).not.toContain("[Image #");
  });

  test("AC-17 a clipboard read that throws is noticed, not thrown at the screen", async () => {
    spyOn(_imageAttachDeps, "readClipboard").mockRejectedValue(new Error("spawn failed"));
    const ui = mount();
    await ui.pressAndSettle(CTRL_V);
    expect(ui.frame()).toContain("image not attached: spawn failed");
    expect(ui.frame()).not.toContain("[Image #");
  });

  test("AC-18 an image over 8000 px on a side is refused and the draft is unchanged", async () => {
    const readClipboard = spyOn(_imageAttachDeps, "readClipboard").mockResolvedValue({
      kind: "image",
      bytes: png(2, 3),
    });
    const ui = mount();
    await ui.pressAndSettle(CTRL_V);
    readClipboard.mockResolvedValue({ kind: "image", bytes: png(8001, 2) });
    await ui.pressAndSettle(CTRL_V);
    expect(ui.frame()).toContain("image not attached: image is larger than 8000 px on a side");
    expect(promptRow(ui.rows())).toBe("> [Image #1]");
  });

  test("AC-19 attaching past the total 20 MB budget is refused and the draft is unchanged", async () => {
    const big = png(2, 3, LARGEST_ACCEPTED_BYTES);
    spyOn(_imageAttachDeps, "readClipboard").mockResolvedValue({ kind: "image", bytes: big });
    const ui = mount();
    for (let image = 0; image < 4; image++) await ui.pressAndSettle(CTRL_V);
    expect(ui.frame()).toContain("[Image #4]");
    const before = promptRow(ui.rows());
    await ui.pressAndSettle(CTRL_V);
    expect(ui.frame()).toContain("image not attached: images in one message must total at most 20 MB");
    expect(promptRow(ui.rows())).toBe(before);
    expect(ui.frame()).not.toContain("[Image #5]");
  });
});
