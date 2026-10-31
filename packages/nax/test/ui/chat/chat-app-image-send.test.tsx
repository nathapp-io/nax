/**
 * US-013: sending images from the mounted chat screen.
 *
 * Every case drives the real screen through stdin and replaces only the attach seams
 * (`_imageAttachDeps`) and the mention expander (`_chatAppDeps.expandMentions`), so what is
 * asserted is what a user would see: what `host.send` was called with, which notice row
 * appeared, and where the text went back to when a send was refused.
 *
 * The capability cases hand the fake host an `acceptsImages` that answers what the case
 * wants — true, false, a rejection, or no accessor at all — because the screen must treat all
 * four as a plain yes/no answer and never let a failed probe become an error row.
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ImageAttachment, SessionEvent } from "@nathapp/nax-agent";
import { assertDefined, firstCall } from "@test/helpers";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import {
  type ChatHost,
  type ChatHostState,
  type ChatSendOptions,
  createChatAskController,
  type ExpandedMentions,
} from "@/chat";
import { _chatAppDeps, ChatApp } from "@/tui/chat/ChatApp";
import { _imageAttachDeps } from "@/tui/chat/use-image-attach";

const CTRL_V = "\x16";
const RETURN = "\r";
const LEFT = "\x1b[D";
/** DEL: what the terminal sends for backspace, and what the line editor deletes before. */
const BACKSPACE = "\x7f";

/** The model the notices name back. */
const MODEL = "test-model";
const REPO_ROOT = "/repo";
/** A directory nothing exists in, so a mention listing has nothing to offer a case. */
const SCREEN_CWD = "/screen";
/** The model sentence every refusal on a text-only brain opens with. */
const CANNOT_READ = `${MODEL} cannot read images; switch model (/model) or remove the image`;
const SLASH_REFUSAL = "images can only be sent with a plain message";
const NOT_SENT = "images not sent: Image count exceeds the limit of 10 images per message";
/** The count limit the attach hook refuses an eleventh image with, once the draft is full. */
const TOO_MANY = "image not attached: at most 10 images per message";
/** The error glyph, so "a notice, not an error row" can be asserted on the frame. */
const ERROR_GLYPH = "✗";
/** What a refusal names a line it could not put back into a prompt the user has since edited. */
const DROPPED = "not sent: ";

/** The code points one `[Image #N]` placeholder occupies. */
const PLACEHOLDER_CHARS = "[Image #1]".length;
/** The bytes a sniffer reads as a PNG: signature, then an IHDR carrying width and height. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const STATE: ChatHostState = {
  sessionId: "image-send-session",
  mode: "guarded",
  model: MODEL,
  meta: {
    schemaVersion: 1,
    sessionId: "image-send-session",
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
  /** The capability answer the host gives; absent leaves the host without the accessor. */
  readonly accepts?: () => Promise<boolean>;
}

/**
 * A host with one model and no catalog. `send` records every call and never settles, so the
 * screen sees a turn in flight exactly as a real one does; `switchTo` counts its calls, so a
 * refused slash line can be shown to have run nothing.
 */
function fakeHost(options: HostOptions = {}) {
  const gate = Promise.withResolvers<void>();
  const send = mock(async (_message: string, _onEvent: (event: SessionEvent) => void, _options?: ChatSendOptions) => {
    await gate.promise;
  });
  const switches = { count: 0 };
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
    switchTo: async () => {
      switches.count += 1;
    },
    cancel: () => {},
    listSessions: async () => [],
    close: async () => {},
    ...(options.accepts === undefined ? {} : { acceptsImages: options.accepts }),
  };
  return { host, send, switches };
}

/** The mounted screen, with its frame rows and the verbs a case drives it with. */
function mount(options: HostOptions = {}) {
  const readClipboard = spyOn(_imageAttachDeps, "readClipboard").mockResolvedValue({ kind: "none" });
  const readFile = spyOn(_imageAttachDeps, "readFile").mockResolvedValue(undefined);
  const { host, send, switches } = fakeHost(options);
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
  return {
    ...ui,
    send,
    switches,
    rows,
    frame,
    promptRow,
    press,
    pressAndSettle,
    settle,
    type,
    submit,
    pasteImage,
    readClipboard,
    readFile,
  };
}

/** The images `host.send` was called with, or an empty list when the call carried none. */
function sentImages(send: ReturnType<typeof fakeHost>["send"]): readonly ImageAttachment[] {
  const options = firstCall(send, "host.send")[2];
  return options?.images ?? [];
}

describe("sending a message that carries an image", () => {
  test("AC-1 a clipboard image travels with the text and the event callback", async () => {
    const ui = mount({ accepts: async () => true });
    await ui.pasteImage(png(2, 3));
    ui.type(" look");
    await ui.pressAndSettle(RETURN);
    expect(ui.send).toHaveBeenCalledTimes(1);
    const [message, onEvent] = firstCall(ui.send, "host.send");
    expect(message).toBe("[Image #1] look");
    expect(typeof onEvent).toBe("function");
    const images = sentImages(ui.send);
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ mimeType: "image/png", source: "clipboard", width: 2, height: 3 });
  });

  test("AC-2 a pasted path's image keeps the path as its source", async () => {
    const ui = mount({ accepts: async () => true });
    ui.readFile.mockResolvedValue(png(2, 3));
    await ui.pressAndSettle("/tmp/shot.png");
    expect(ui.readFile).toHaveBeenCalledWith("/tmp/shot.png");
    await ui.pressAndSettle(RETURN);
    const images = sentImages(ui.send);
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ mimeType: "image/png", source: "/tmp/shot.png" });
  });

  test("AC-4 the surviving placeholder's own image is the one that travels", async () => {
    const ui = mount({ accepts: async () => true });
    await ui.pasteImage(png(2, 3));
    await ui.pasteImage(png(2, 4));
    expect(ui.promptRow()).toBe("> [Image #1][Image #2]");
    for (let step = 0; step < PLACEHOLDER_CHARS; step++) ui.press(LEFT);
    for (let step = 0; step < PLACEHOLDER_CHARS; step++) ui.press(BACKSPACE);
    expect(ui.promptRow()).toBe("> [Image #2]");
    await ui.pressAndSettle(RETURN);
    const [message] = firstCall(ui.send, "host.send");
    expect(message).toBe("[Image #1]");
    const images = sentImages(ui.send);
    expect(images).toHaveLength(1);
    // The second attachment, which the deleted placeholder was renumbered away from.
    expect(images[0]?.height).toBe(4);
  });
});

describe("a message with no image keeps today's send", () => {
  test("AC-3 'hello' reaches host.send with the text and the callback only", async () => {
    const ui = mount({ accepts: async () => true });
    await ui.submit("hello");
    expect(ui.send).toHaveBeenCalledWith("hello", expect.any(Function));
    expect(firstCall(ui.send, "host.send")).toHaveLength(2);
  });
});

describe("a brain that cannot read images", () => {
  test("AC-5 says so, keeps the draft and sends nothing", async () => {
    const ui = mount({ accepts: async () => false });
    await ui.pasteImage(png(2, 3));
    ui.type(" look");
    await ui.pressAndSettle(RETURN);
    expect(ui.frame()).toContain(CANNOT_READ);
    expect(ui.send).not.toHaveBeenCalled();
  });

  test("AC-7 a host with no capability accessor refuses with the same notice", async () => {
    const ui = mount();
    await ui.pasteImage(png(2, 3));
    ui.type(" look");
    await ui.pressAndSettle(RETURN);
    expect(ui.frame()).toContain(CANNOT_READ);
    expect(ui.send).not.toHaveBeenCalled();
  });

  test("AC-10 a rejecting capability is a notice, not an error row", async () => {
    const ui = mount({
      accepts: async () => {
        throw new Error("capability probe failed");
      },
    });
    await ui.pasteImage(png(2, 3));
    ui.type(" look");
    await ui.pressAndSettle(RETURN);
    expect(ui.frame()).toContain(CANNOT_READ);
    expect(ui.frame()).not.toContain(ERROR_GLYPH);
    expect(ui.promptRow()).toBe("> [Image #1] look");
    expect(ui.send).not.toHaveBeenCalled();
  });
});

describe("a refused send puts the line back", () => {
  test("AC-6 the text returns with the cursor at its end, and return sends it once the brain reads images", async () => {
    let accepts = false;
    const ui = mount({ accepts: async () => accepts });
    await ui.pasteImage(png(2, 3));
    ui.type(" look");
    await ui.pressAndSettle(RETURN);
    expect(ui.frame()).toContain(CANNOT_READ);
    expect(ui.send).not.toHaveBeenCalled();
    expect(ui.promptRow()).toBe("> [Image #1] look");
    // The caret sits after the last character: a typed one lands there.
    ui.press("!");
    expect(ui.promptRow()).toBe("> [Image #1] look!");
    ui.press(BACKSPACE);
    expect(ui.promptRow()).toBe("> [Image #1] look");
    accepts = true;
    await ui.pressAndSettle(RETURN);
    const [message] = firstCall(ui.send, "host.send");
    expect(message).toBe("[Image #1] look");
    expect(sentImages(ui.send)).toHaveLength(1);
  });

  test("AC-8 a slash line with a present image runs nothing and comes back", async () => {
    const ui = mount({ accepts: async () => true });
    ui.type("/model ");
    await ui.pasteImage(png(2, 3));
    expect(ui.promptRow()).toBe("> /model [Image #1]");
    await ui.pressAndSettle(RETURN);
    expect(ui.frame()).toContain(SLASH_REFUSAL);
    expect(ui.switches.count).toBe(0);
    expect(ui.send).not.toHaveBeenCalled();
    expect(ui.promptRow()).toBe("> /model [Image #1]");
  });

  test("B2 a refusal that lands after an edit keeps the newer prompt and names the line it dropped", async () => {
    // The capability probe holds the send mid-preparation: the prompt stays live while it runs.
    const capability = Promise.withResolvers<boolean>();
    let accepts = capability.promise;
    const ui = mount({ accepts: () => accepts });
    await ui.pasteImage(png(2, 3));
    ui.type(" look");
    await ui.pressAndSettle(RETURN);
    expect(ui.send).not.toHaveBeenCalled();
    // While the probe is out, the user starts the next message and attaches a picture to it.
    ui.type("next ");
    await ui.pasteImage(png(2, 4));
    expect(ui.promptRow()).toBe("> next [Image #2]");
    capability.resolve(false);
    await ui.settle();
    expect(ui.send).not.toHaveBeenCalled();
    expect(ui.frame()).toContain(CANNOT_READ);
    // The newer draft survives: the refused line never overwrites it.
    expect(ui.promptRow()).toBe("> next [Image #2]");
    // And the line the refusal could not put back is named rather than silently dropped.
    expect(ui.frame()).toContain(`${DROPPED}[Image #1] look`);
    // The draft still holds both pictures: the newer one travels once the brain reads images.
    accepts = Promise.resolve(true);
    await ui.pressAndSettle(RETURN);
    const [message] = firstCall(ui.send, "host.send");
    expect(message).toBe("next [Image #1]");
    const images = sentImages(ui.send);
    expect(images).toHaveLength(1);
    expect(images[0]?.height).toBe(4);
  });

  test("AC-9 eleven images across the draft and the mentions are refused by the validator's reason", async () => {
    const ui = mount({ accepts: async () => true });
    for (let image = 0; image < 10; image++) await ui.pasteImage(png(2, 3));
    ui.type(" @a.png");
    const expand = spyOn(_chatAppDeps, "expandMentions").mockResolvedValue({
      message: "EXPANDED",
      records: [],
      images: [mentioned("a.png")],
    });
    await ui.pressAndSettle(RETURN);
    expect(expand).toHaveBeenCalledTimes(1);
    expect(ui.frame()).toContain(NOT_SENT);
    expect(ui.send).not.toHaveBeenCalled();
    // The line came back with its placeholders: returning again is refused the same way.
    await ui.pressAndSettle(RETURN);
    expect(ui.frame().split(NOT_SENT)).toHaveLength(3);
    expect(ui.send).not.toHaveBeenCalled();
    // And the draft still holds them: an eleventh image is refused by the count limit.
    await ui.pasteImage(png(2, 3));
    expect(ui.frame()).toContain(TOO_MANY);
  });
});

describe("mentions on a brain that reads images", () => {
  const TEXT = "see @a.png";
  const EXPANDED: ExpandedMentions = { message: "EXPANDED", records: [] };

  test("AC-11 a brain that reads images expands with images: true", async () => {
    const expand = spyOn(_chatAppDeps, "expandMentions").mockResolvedValue(EXPANDED);
    const ui = mount({ accepts: async () => true });
    await ui.submit(TEXT);
    expect(expand).toHaveBeenCalledTimes(1);
    expect(expand.mock.calls[0]?.[0]).toBe(TEXT);
    expect(expand.mock.calls[0]?.[1]).toEqual({ cwd: SCREEN_CWD, repoRoot: REPO_ROOT, images: true });
  });

  test("AC-11 a brain that cannot read images expands with the where it always got", async () => {
    const expand = spyOn(_chatAppDeps, "expandMentions").mockResolvedValue(EXPANDED);
    const ui = mount({ accepts: async () => false });
    await ui.submit(TEXT);
    expect(expand).toHaveBeenCalledTimes(1);
    const where = firstCall(expand, "expandMentions")[1];
    expect(where).toEqual({ cwd: SCREEN_CWD, repoRoot: REPO_ROOT });
    expect(Object.keys(where)).toEqual(["cwd", "repoRoot"]);
    expect(firstCall(ui.send, "host.send")[0]).toBe(EXPANDED.message);
  });

  test("AC-11 a host with no capability accessor expands with the where it always got", async () => {
    const expand = spyOn(_chatAppDeps, "expandMentions").mockResolvedValue(EXPANDED);
    const ui = mount();
    await ui.submit(TEXT);
    expect(expand).toHaveBeenCalledTimes(1);
    const where = firstCall(expand, "expandMentions")[1];
    expect(where).toEqual({ cwd: SCREEN_CWD, repoRoot: REPO_ROOT });
    expect(Object.keys(where)).toEqual(["cwd", "repoRoot"]);
  });
});
