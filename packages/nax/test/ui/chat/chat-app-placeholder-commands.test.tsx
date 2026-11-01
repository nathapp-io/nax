/**
 * US-005: a slash command typed after the placeholders of the pictures a message already holds.
 *
 * After `/image red.png` the prompt holds `[Image #1]`, so `/image green.png` typed after it is
 * no longer a line that starts with `/`: it would be sent to the model as text. The screen
 * splits such a line — the leading placeholders stay in the prompt with the image draft
 * untouched, and the slash line after them runs as if it had been typed on its own.
 *
 * Every case drives the mounted screen through stdin and replaces only the attach seams
 * (`_imageAttachDeps`), so what is asserted is what a user would see: the prompt's own text,
 * the notice row, and what `host.send`, `host.switchTo` and `host.close` were called with.
 * A line is typed a code point at a time, so no chunk counts as a paste and `onPaste` never
 * answers the line instead of the command.
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { resolve } from "node:path";
import type { ImageAttachment, SessionEvent } from "@nathapp/nax-agent";
import { assertDefined, firstCall } from "@test/helpers";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import { type ChatHost, type ChatHostState, type ChatSendOptions, createChatAskController } from "@/chat";
import { ChatApp } from "@/tui/chat/ChatApp";
import { _imageAttachDeps } from "@/tui/chat/use-image-attach";

const RETURN = "\r";
/** The model the screen starts on; `/model other-model` is what AC-8 switches away from. */
const MODEL = "test-model";
const REPO_ROOT = "/repo";
/** The screen's own directory, so a relative `/image` path has something to resolve against. */
const SCREEN_CWD = "/screen";
/** What a slash line with a picture still attached is told. */
const IMAGES_PLAIN_ONLY = "images can only be sent with a plain message";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const STATE: ChatHostState = {
  sessionId: "placeholder-commands-session",
  mode: "guarded",
  model: MODEL,
  meta: {
    schemaVersion: 1,
    sessionId: "placeholder-commands-session",
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

/**
 * A host that records every verb it is given. `send` settles at once, so a case ends with the
 * turn finished rather than still in flight; `acceptsImages` says yes, because a send that
 * carries a picture asks before it travels.
 */
function fakeHost() {
  const send = mock(
    async (_message: string, _onEvent: (event: SessionEvent) => void, _options?: ChatSendOptions) => {},
  );
  const switchTo = mock(async (_input: { mode?: string; model?: string }) => {});
  const close = mock(async () => {});
  const host: ChatHost = {
    repoRoot: REPO_ROOT,
    models: [MODEL, "other-model"],
    asks: createChatAskController({ mode: "guarded", answer: () => {} }),
    current: () => STATE,
    notice: () => undefined,
    send,
    start: async () => {},
    clear: async () => {},
    resume: async () => {},
    switchTo,
    acceptsImages: async () => true,
    cancel: () => {},
    listSessions: async () => [],
    close,
  };
  return { host, send, switchTo, close };
}

/** The mounted screen, its frame rows, and the verbs a case drives it with. */
function mount() {
  const readClipboard = spyOn(_imageAttachDeps, "readClipboard").mockResolvedValue({ kind: "none" });
  const readFile = spyOn(_imageAttachDeps, "readFile").mockResolvedValue(undefined);
  const { host, send, switchTo, close } = fakeHost();
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
   * also draws a `> ` row — in the transcript, above the input.
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
  /** One attached picture named `name`, leaving the prompt holding its placeholder. */
  const attach = async (name: string): Promise<void> => {
    readFile.mockResolvedValue(png(2, 3));
    await submit(`/image ${name}`);
  };
  return {
    ...ui,
    send,
    switchTo,
    close,
    rows,
    frame,
    promptRow,
    press,
    type,
    submit,
    attach,
    readClipboard,
    readFile,
  };
}

/** The images `host.send` was called with, or an empty list when the call carried none. */
function sentImages(send: ReturnType<typeof fakeHost>["send"]): readonly ImageAttachment[] {
  const options = firstCall(send, "host.send")[2];
  return options?.images ?? [];
}

describe("a slash line typed after the placeholders of attached images", () => {
  test("AC-7 /image after an attached picture attaches a second one and sends nothing", async () => {
    const ui = mount();
    await ui.attach("red.png");
    expect(ui.promptRow()).toBe("> [Image #1]");

    await ui.submit("/image green.png");

    // The first picture never left the prompt, so the second lands beside it.
    expect(ui.promptRow()).toBe("> [Image #1][Image #2]");
    expect(ui.send).not.toHaveBeenCalled();
    expect(ui.readFile).toHaveBeenCalledTimes(2);
    expect(ui.readFile.mock.calls.map((call) => call[0])).toEqual([
      resolve(SCREEN_CWD, "red.png"),
      resolve(SCREEN_CWD, "green.png"),
    ]);
  });

  test("AC-8 /model switches the model, and the picture stays for the next message", async () => {
    const ui = mount();
    await ui.attach("red.png");
    // The prompt holds `[Image #1]`; a space makes the line the one AC-8 submits.
    ui.press(" ");

    await ui.submit("/model other-model");

    expect(ui.switchTo).toHaveBeenCalledTimes(1);
    expect(ui.switchTo).toHaveBeenCalledWith({ model: "other-model" });
    expect(ui.send).not.toHaveBeenCalled();
    // The placeholders came back, so the message after the command carries the picture.
    expect(ui.promptRow()).toBe("> [Image #1]");

    await ui.submit("describe");

    const [message, onEvent] = firstCall(ui.send, "host.send");
    expect(message).toBe("[Image #1] describe");
    expect(typeof onEvent).toBe("function");
    expect(sentImages(ui.send)).toHaveLength(1);
  });

  test("AC-9 a placeholder inside the command line runs nothing and puts the whole line back", async () => {
    const ui = mount();
    await ui.attach("red.png");
    ui.press(" ");

    await ui.submit("/model x [Image #1]");

    expect(ui.frame()).toContain(IMAGES_PLAIN_ONLY);
    expect(ui.switchTo).not.toHaveBeenCalled();
    expect(ui.send).not.toHaveBeenCalled();
    // The line it was typed as, placeholders and all — not just the part before the command.
    expect(ui.promptRow()).toBe("> [Image #1] /model x [Image #1]");
  });

  test("AC-10 /quit after a placeholder closes the chat, and the picture is not sent", async () => {
    const ui = mount();
    await ui.attach("red.png");
    ui.press(" ");

    await ui.submit("/quit");

    expect(ui.close).toHaveBeenCalledTimes(1);
    expect(ui.send).not.toHaveBeenCalled();
  });
});
