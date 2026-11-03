/**
 * US-003: the chat screen's message queue.
 *
 * A busy plain return used to be dropped. Here the same keystroke is held instead: the input
 * hands the line to its owner (`onQueue`), the owner draws it above the input, and the next
 * completed turn sends exactly one of them through the typed-return path.
 *
 * The screen cases drive the real `ChatApp` through stdin and replace nothing but the host,
 * so what is asserted is what a user would see: the row that appeared, what `host.send`
 * received and in which order, and where a queue went when its turn did not complete.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { SessionEvent, TurnEndStatus } from "@nathapp/nax-agent";
import { assertDefined } from "@test/helpers";
import { cleanup, render } from "ink-testing-library";
import { act, type ReactElement, useState } from "react";
import { type ChatHost, type ChatHostState, type ChatSendOptions, createChatAskController } from "@/chat";
import { _chatAppDeps, ChatApp } from "@/tui/chat/ChatApp";
import { ChatInput, EMPTY_DRAFT, type InputDraft } from "@/tui/chat/ChatInput";
import { resolveChatTheme } from "@/tui/chat/theme";
import { _imageAttachDeps } from "@/tui/chat/use-image-attach";

const THEME = resolveChatTheme({ env: {}, colorLevel: 0 });
const RETURN = "\r";
/** ink parses the up arrow into the prompt's history key. */
const UP = "\x1b[A";
/** ink reports ctrl+t as the letter `t` with the ctrl modifier. */
const CTRL_T = "\x14";
/** ink reports ctrl+v as the letter `v` with the ctrl modifier: the clipboard image's key. */
const CTRL_V = "\x16";

const MODEL = "test-model";
const REPO_ROOT = "/repo";
/** The notice a slash line gets while a turn runs. */
const TURN_BUSY_NOTICE = "wait for the turn to finish (Ctrl-C to interrupt)";
/** The notice a line carrying a picture gets instead of being queued. */
const IMAGES_NOT_QUEUED = "images cannot be queued; send it after the turn ends";

const STATE: ChatHostState = {
  sessionId: "queue-session",
  mode: "guarded",
  model: MODEL,
  meta: {
    schemaVersion: 1,
    sessionId: "queue-session",
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

/** A PNG: signature, then an IHDR carrying width and height, which is all the sniffer reads. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x02, 0x00, 0x00, 0x00, 0x03, 0x08, 0x06, 0x00, 0x00, 0x00,
]);

/* ---------------------------------------------------------------------------------------
 * The input's own contract: what a busy plain return does with and without `onQueue`.
 * ------------------------------------------------------------------------------------- */

interface InputOptions {
  readonly busy?: boolean;
  /** The owner's claim on a busy return; absent leaves the input on its own busy rule. */
  readonly onQueue?: (text: string) => boolean;
}

/** The input under an owner that keeps the draft, exactly as the chat screen does. */
function mountInput(options: InputOptions = {}) {
  const drafts: InputDraft[] = [];
  const onSubmit = mock((_text: string) => {});

  function Owner(): ReactElement {
    const [draft, setDraft] = useState<InputDraft>(EMPTY_DRAFT);
    return (
      <ChatInput
        draft={draft}
        onDraftChange={(next) => {
          drafts.push(next);
          setDraft(next);
        }}
        onSubmit={onSubmit}
        width={40}
        theme={THEME}
        busy={options.busy}
        onQueue={options.onQueue}
      />
    );
  }

  const ui = render(<Owner />);
  const press = (sequence: string): void => {
    act(() => {
      ui.stdin.write(sequence);
    });
  };
  return {
    ui,
    drafts,
    onSubmit,
    press,
    /** The draft's text as the owner last saw it: the placeholder case never writes one. */
    text: (): string => drafts.at(-1)?.editor.text ?? "",
  };
}

describe("ChatInput onQueue", () => {
  test("AC-23 a busy plain return hands the line to onQueue", () => {
    const onQueue = mock((_text: string) => true);
    const input = mountInput({ busy: true, onQueue });
    for (const char of "next please") input.press(char);
    input.press(RETURN);
    expect(onQueue).toHaveBeenCalledTimes(1);
    expect(onQueue).toHaveBeenCalledWith("next please");
  });

  test("AC-24 the draft clears once onQueue takes the line, and nothing is submitted", () => {
    const input = mountInput({ busy: true, onQueue: () => true });
    for (const char of "next please") input.press(char);
    input.press(RETURN);
    expect(input.text()).toBe("");
    expect(input.onSubmit).not.toHaveBeenCalled();
  });

  test("AC-25 the draft stays when onQueue declines the line", () => {
    const input = mountInput({ busy: true, onQueue: () => false });
    for (const char of "next please") input.press(char);
    input.press(RETURN);
    expect(input.text()).toBe("next please");
    expect(input.onSubmit).not.toHaveBeenCalled();
  });

  test("AC-26 the draft stays on a busy return when no onQueue is given", () => {
    const input = mountInput({ busy: true });
    for (const char of "next please") input.press(char);
    input.press(RETURN);
    expect(input.text()).toBe("next please");
    expect(input.onSubmit).not.toHaveBeenCalled();
  });

  test("a slash line is submitted, never queued, while busy", () => {
    const onQueue = mock((_text: string) => true);
    const input = mountInput({ busy: true, onQueue });
    for (const char of "/help") input.press(char);
    input.press(RETURN);
    expect(onQueue).not.toHaveBeenCalled();
    expect(input.onSubmit).toHaveBeenCalledWith("/help");
  });

  test("an idle return is submitted rather than queued", () => {
    const onQueue = mock((_text: string) => true);
    const input = mountInput({ onQueue });
    for (const char of "hello") input.press(char);
    input.press(RETURN);
    expect(onQueue).not.toHaveBeenCalled();
    expect(input.onSubmit).toHaveBeenCalledWith("hello");
  });
});

/* ---------------------------------------------------------------------------------------
 * The screen: queueing a busy return, drawing it, and draining it after the turn.
 * ------------------------------------------------------------------------------------- */

/** One `host.send` as it happened, with the listener that turn's events arrive on. */
interface Turn {
  readonly message: string;
  readonly onEvent: (event: SessionEvent) => void;
  /** Settle the send: `failed` rejects it the way a host whose turn threw does. */
  finish(options?: { readonly failed?: boolean }): Promise<void>;
  /** The turn ends with `status` — what the screen watches to decide whether to drain. */
  end(status: TurnEndStatus): void;
}

/**
 * A host that hands every send its own gate, so a case says exactly which turn ends, when,
 * and how. `order` records the calls a case must see in sequence — a queued model switch has
 * to be applied before the message it precedes is sent.
 */
function queueHost() {
  const turns: Turn[] = [];
  const order: string[] = [];
  let state: ChatHostState = STATE;

  const send = mock(async (message: string, onEvent: (event: SessionEvent) => void, _options?: ChatSendOptions) => {
    order.push(`send:${message}`);
    const gate = Promise.withResolvers<void>();
    const turn: Turn = {
      message,
      onEvent,
      async finish(options) {
        await Promise.resolve(
          act(async () => {
            if (options?.failed === true) gate.reject(new Error("send failed"));
            else gate.resolve();
            for (let flush = 0; flush < 5; flush++) await Promise.resolve();
          }),
        );
      },
      end(status) {
        onEvent({
          sessionId: state.sessionId,
          turnId: `t${turns.length}`,
          at: "now",
          metadata: {},
          type: "turn_end",
          status,
          output: "",
          usage: { inputTokens: 0, outputTokens: 0 },
          costUsd: 0,
        });
      },
    };
    turns.push(turn);
    await gate.promise;
  });

  const switchTo = mock(async (input: { mode?: string; model?: string }) => {
    order.push(`switchTo:${input.model ?? input.mode ?? ""}`);
  });

  const host: ChatHost = {
    repoRoot: REPO_ROOT,
    models: [MODEL],
    asks: createChatAskController({ mode: "guarded", answer: () => {} }),
    current: () => state,
    notice: () => undefined,
    send,
    start: async () => {},
    clear: async () => {},
    resume: async () => {},
    switchTo,
    cancel: () => {},
    listSessions: async () => [],
    close: async () => {},
  };
  return { host, send, switchTo, order, turns, setState: (next: ChatHostState) => (state = next) };
}

/** The mounted screen, with the frame rows and the verbs a case drives it with. */
function mountScreen() {
  const fake = queueHost();
  const ui = render(<ChatApp host={fake.host} />);
  /** The frame's rows as the terminal shows them: no escape codes, no trailing blanks. */
  const rows = (): string[] =>
    Bun.stripANSI(ui.lastFrame() ?? "")
      .split("\n")
      .map((row) => row.trimEnd());
  const frame = (): string => rows().join("\n");
  /** A keypress in its own act, for a key that does its work synchronously. */
  const press = (sequence: string): void => {
    act(() => {
      ui.stdin.write(sequence);
    });
  };
  /** The microtasks a send's `await`s run, with no wall-clock wait. */
  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 5; turn++) {
      await Promise.resolve(
        act(async () => {
          await Promise.resolve();
        }),
      );
    }
  };
  /** A keypress whose effect lands after an `await` — a clipboard read, a prepare step. */
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
  /** The turn the screen is running right now: the newest send, asserted to exist. */
  const current = (): Turn => {
    const turn = fake.turns.at(-1);
    assertDefined(turn, "the turn the screen is running");
    return turn;
  };
  /** End the running turn with `status` and let the send settle. */
  const endTurn = async (status: TurnEndStatus): Promise<void> => {
    const turn = current();
    act(() => turn.end(status));
    await turn.finish();
    await settle();
  };
  return { ...fake, ui, rows, frame, press, pressAndSettle, settle, type, submit, current, endTurn };
}

/** The rows that carry the queue's muted marker. */
const queuedRows = (rows: readonly string[]): readonly string[] => rows.filter((row) => row.includes("queued · "));

/** The prompt's own text row: the **last** marker row, because the transcript has them too. */
const promptRow = (rows: readonly string[]): string => {
  const row = rows.filter((line) => line.startsWith(">")).at(-1);
  assertDefined(row, "the prompt's text row");
  return row;
};

describe("queueing a busy return", () => {
  test("AC-6 typing while a turn runs and pressing return clears the prompt", async () => {
    const ui = mountScreen();
    await ui.submit("hello");
    await ui.submit("next please");
    expect(promptRow(ui.rows())).toBe(">");
    expect(queuedRows(ui.rows())).toEqual(["queued · next please"]);
  });

  test("AC-7 the queued line is drawn above the input", async () => {
    const ui = mountScreen();
    await ui.submit("hello");
    await ui.submit("next please");
    const rows = ui.rows();
    const queued = rows.findIndex((row) => row.includes("queued · next please"));
    const prompt = rows.indexOf(promptRow(rows), queued);
    expect(queued).toBeGreaterThanOrEqual(0);
    expect(prompt).toBeGreaterThan(queued);
  });

  test("AC-8 a slash line while busy shows the turn-busy notice", async () => {
    const ui = mountScreen();
    await ui.submit("hello");
    await ui.submit("/help");
    expect(ui.frame()).toContain(TURN_BUSY_NOTICE);
  });

  test("AC-9 a slash line while busy draws no queued row", async () => {
    const ui = mountScreen();
    await ui.submit("hello");
    await ui.submit("/help");
    expect(queuedRows(ui.rows())).toEqual([]);
  });

  test("AC-27 a busy return queues without sending before the running turn settles", async () => {
    const ui = mountScreen();
    await ui.submit("hello");
    await ui.submit("next please");
    expect(ui.send).toHaveBeenCalledTimes(1);
    expect(ui.send).toHaveBeenCalledWith("hello", expect.any(Function));
  });

  test("AC-18 five queued messages draw three rows and a +2 more row", async () => {
    const ui = mountScreen();
    await ui.submit("hello");
    for (const text of ["m1", "m2", "m3", "m4", "m5"]) await ui.submit(text);
    const rows = ui.rows();
    expect(rows.filter((row) => row.startsWith("queued · "))).toHaveLength(3);
    expect(rows.filter((row) => row.trimEnd() === "+2 more")).toHaveLength(1);
  });
});

describe("draining the queue after a completed turn", () => {
  /** A screen with `hello` running and `lines` queued behind it. */
  async function withQueued(lines: readonly string[]) {
    const ui = mountScreen();
    await ui.submit("hello");
    for (const line of lines) await ui.submit(line);
    return ui;
  }

  test("AC-10 a completed turn sends the message queued first", async () => {
    const ui = await withQueued(["first", "second"]);
    await ui.endTurn("completed");
    expect(ui.send).toHaveBeenCalledTimes(2);
    expect(ui.send).toHaveBeenLastCalledWith("first", expect.any(Function));
  });

  test("AC-11 the turn after it sends the message queued behind the first", async () => {
    const ui = await withQueued(["first", "second"]);
    await ui.endTurn("completed");
    await ui.endTurn("completed");
    expect(ui.send).toHaveBeenCalledTimes(3);
    expect(ui.send).toHaveBeenLastCalledWith("second", expect.any(Function));
  });

  test("AC-12 the drained message appends its own user row", async () => {
    const ui = await withQueued(["first"]);
    expect(ui.rows()).not.toContain("> first");
    await ui.endTurn("completed");
    expect(ui.rows()).toContain("> first");
  });

  test("AC-13 a queued mention is sent expanded, exactly as a typed one", async () => {
    const expand = spyOn(_chatAppDeps, "expandMentions").mockResolvedValue({ message: "EXPANDED", records: [] });
    const ui = await withQueued(["see @a.ts"]);
    expect(expand).not.toHaveBeenCalled();
    await ui.endTurn("completed");
    expect(expand).toHaveBeenCalledWith("see @a.ts", { cwd: REPO_ROOT, repoRoot: REPO_ROOT });
    expect(ui.send).toHaveBeenLastCalledWith("EXPANDED", expect.any(Function), { title: "see @a.ts" });
  });

  test("AC-19 a queued model switch is applied before the queued message is sent", async () => {
    const ui = await withQueued(["first"]);
    ui.press(CTRL_T);
    await ui.endTurn("completed");
    const switched = ui.order.findIndex((entry) => entry.startsWith("switchTo:"));
    expect(switched).toBeGreaterThan(ui.order.indexOf("send:hello"));
    expect(ui.order.indexOf("send:first")).toBeGreaterThan(switched);
  });

  test("the drained message joins the prompt's history, so up recalls it", async () => {
    const ui = await withQueued(["first"]);
    await ui.endTurn("completed");
    expect(promptRow(ui.rows())).toBe(">");
    ui.press(UP);
    expect(promptRow(ui.rows())).toBe("> first");
  });
});

describe("a turn that does not complete", () => {
  /** A screen with `hello` running, `lines` queued, and `draft` typed into the prompt since. */
  async function withQueuedAndDraft(lines: readonly string[], draft: string) {
    const ui = mountScreen();
    await ui.submit("hello");
    for (const line of lines) await ui.submit(line);
    ui.type(draft);
    return ui;
  }

  test("AC-14 a cancelled turn sends nothing more", async () => {
    const ui = await withQueuedAndDraft(["first", "second"], "draft");
    await ui.endTurn("cancelled");
    expect(ui.send).toHaveBeenCalledTimes(1);
  });

  test("AC-15 a cancelled turn puts the queue back above the draft", async () => {
    const ui = await withQueuedAndDraft(["first", "second"], "draft");
    await ui.endTurn("cancelled");
    expect(ui.frame()).toContain("> first\n  second\n  draft");
  });

  test("AC-16 an errored turn sends nothing more", async () => {
    const ui = await withQueuedAndDraft(["first"], "");
    await ui.endTurn("errored");
    expect(ui.send).toHaveBeenCalledTimes(1);
  });

  test("AC-17 an errored turn puts the queue back into the prompt", async () => {
    const ui = await withQueuedAndDraft(["first"], "");
    await ui.endTurn("errored");
    expect(ui.frame().split("> first")).toHaveLength(2);
  });

  test("a timed-out turn is restored like a cancelled one", async () => {
    const ui = await withQueuedAndDraft(["first"], "");
    await ui.endTurn("timed_out");
    expect(ui.send).toHaveBeenCalledTimes(1);
    expect(ui.frame()).toContain("> first");
  });

  test("a send that rejects is restored like a cancelled turn", async () => {
    const ui = await withQueuedAndDraft(["first"], "");
    const turn = ui.current();
    act(() => turn.end("cancelled"));
    await turn.finish({ failed: true });
    await ui.settle();
    expect(ui.send).toHaveBeenCalledTimes(1);
    expect(ui.frame()).toContain("> first");
  });

  test("a stream that ends without a turn_end is restored, not treated as completed", async () => {
    const ui = await withQueuedAndDraft(["first"], "");
    await ui.current().finish();
    await ui.settle();
    expect(ui.send).toHaveBeenCalledTimes(1);
    expect(ui.frame()).toContain("> first");
  });

  test("the restored queue is empty, so a later turn does not send it again", async () => {
    const ui = await withQueuedAndDraft(["first", "second"], "");
    await ui.endTurn("cancelled");
    expect(queuedRows(ui.rows())).toEqual([]);
  });
});

describe("a queued line that carries a picture", () => {
  /** A screen with `hello` running and a pasted picture in the prompt. */
  async function withImageInPrompt() {
    spyOn(_imageAttachDeps, "readClipboard").mockResolvedValue({ kind: "image", bytes: PNG });
    const ui = mountScreen();
    await ui.submit("hello");
    await ui.pressAndSettle(CTRL_V);
    ui.type(" look");
    return ui;
  }

  test("AC-20 return shows the images-cannot-be-queued notice", async () => {
    const ui = await withImageInPrompt();
    await ui.pressAndSettle(RETURN);
    expect(ui.frame()).toContain(IMAGES_NOT_QUEUED);
  });

  test("AC-21 return queues nothing", async () => {
    const ui = await withImageInPrompt();
    await ui.pressAndSettle(RETURN);
    expect(queuedRows(ui.rows())).toEqual([]);
  });

  test("AC-22 return keeps the draft, picture included", async () => {
    const ui = await withImageInPrompt();
    await ui.pressAndSettle(RETURN);
    expect(ui.rows()).toContain("> [Image #1] look");
  });
});
