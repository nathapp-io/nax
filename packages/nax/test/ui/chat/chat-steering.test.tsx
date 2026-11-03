/**
 * US-004: ctrl+s steers the running turn, or interrupts it and sends the draft next.
 *
 * Typing while a turn runs used to be wasted: the text had to wait for the turn to end, and
 * there was no way to redirect a long turn short of cancelling it with escape and retyping.
 * ctrl+s hands the line to the turn instead. A brain that can steer takes it where it is — the
 * screen says so with a `steering · <text>` row until the turn shows whether it took it — and a
 * brain that cannot is interrupted, with the line waiting to be sent ahead of the queue.
 *
 * Everything here drives the real `ChatApp` through stdin and replaces nothing but the host, so
 * what is asserted is what a user would see and what the host was actually asked to do.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { AgentSession, SessionEvent, SessionMeta, SteerResult, TurnEndStatus } from "@nathapp/nax-agent";
import { assertDefined, makeLogger, makeNaxConfig } from "@test/helpers";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import {
  type ChatHost,
  type ChatHostState,
  type ChatSendOptions,
  createChatAskController,
  createChatHost,
  createChatStorage,
} from "@/chat";
import { ChatApp } from "@/tui/chat/ChatApp";
import { resolveChatTheme } from "@/tui/chat/theme";
import { _imageAttachDeps } from "@/tui/chat/use-image-attach";

const THEME = resolveChatTheme({ env: {}, colorLevel: 0 });
const RETURN = "\r";
/** ink reports ctrl+s as the letter `s` with the ctrl modifier. */
const CTRL_S = "\x13";
/** ink reports ctrl+v as the letter `v` with the ctrl modifier: the clipboard image's key. */
const CTRL_V = "\x16";

const MODEL = "test-model";
const ACP_MODEL = "acp:codex";
const REPO_ROOT = "/repo";
/** The notice a line carrying a picture gets instead of being steered or queued. */
const IMAGES_NOT_QUEUED = "images cannot be queued; send it after the turn ends";
/** What `/help` names after the built-in commands. */
const STEER_HINT = "ctrl+s  steer the running turn (or interrupt and send)";
/** The marker the screen draws in front of a steer the turn has not taken yet. */
const STEERING = "steering · ";

afterEach(() => {
  cleanup();
  mock.restore();
});

function stateOf(model: string): ChatHostState {
  return {
    sessionId: "steer-session",
    mode: "guarded",
    model,
    meta: {
      schemaVersion: 1,
      sessionId: "steer-session",
      cwd: REPO_ROOT,
      mode: "ask",
      model,
      bashApproval: "gated",
      title: null,
      createdAt: "now",
      updatedAt: null,
      costUsd: 0,
    },
  };
}

/** A PNG: signature, then an IHDR carrying width and height, which is all the sniffer reads. */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x02, 0x00, 0x00, 0x00, 0x03, 0x08, 0x06, 0x00, 0x00, 0x00,
]);

/** One `host.send` as it happened, with the listener that turn's events arrive on. */
interface Turn {
  readonly message: string;
  readonly onEvent: (event: SessionEvent) => void;
  /** Settle the send, so the screen's finally block runs. */
  finish(): Promise<void>;
  /** The turn ends with `status` — what the screen watches to decide what to send next. */
  end(status: TurnEndStatus): void;
}

interface ScreenOptions {
  readonly model?: string;
  /** The host's `steer`; absent builds a host that has none at all. */
  readonly steer?: (text: string) => SteerResult;
}

/**
 * A host that hands every send its own gate, so a case says exactly which turn ends and when.
 * `sends` records what the screen asked the host to send, in order.
 */
function steeringHost(options: ScreenOptions = {}) {
  const turns: Turn[] = [];
  const sends: string[] = [];
  let state = stateOf(options.model ?? MODEL);

  const send = mock(async (message: string, onEvent: (event: SessionEvent) => void, _options?: ChatSendOptions) => {
    sends.push(message);
    const gate = Promise.withResolvers<void>();
    const turn: Turn = {
      message,
      onEvent,
      async finish() {
        await Promise.resolve(
          act(async () => {
            gate.resolve();
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
  // A steer that never settles by itself: a case resolves `applied` when it means to.
  const steerFn = options.steer;
  const steer = steerFn === undefined ? undefined : mock((text: string) => steerFn(text));
  const cancel = mock(() => {});

  const host: ChatHost = {
    repoRoot: REPO_ROOT,
    models: [state.model],
    asks: createChatAskController({ mode: "guarded", answer: () => {} }),
    current: () => state,
    notice: () => undefined,
    send,
    acceptsImages: async () => true,
    start: async () => {},
    clear: async () => {},
    resume: async () => {},
    switchTo: async () => {},
    ...(steer === undefined ? {} : { steer }),
    cancel,
    listSessions: async () => [],
    close: async () => {},
  };
  return { host, send, sends, steer, cancel, turns, setState: (next: ChatHostState) => (state = next) };
}

/** The mounted screen, with the frame rows and the verbs a case drives it with. */
function mountScreen(options: ScreenOptions = {}) {
  const fake = steeringHost(options);
  const ui = render(<ChatApp host={fake.host} theme={THEME} />);
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
  /** The microtasks a send's or an `applied` promise's `await`s run, with no wall-clock wait. */
  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 5; turn++) {
      await Promise.resolve(
        act(async () => {
          await Promise.resolve();
        }),
      );
    }
  };
  /** A keypress whose effect lands after an `await` — a clipboard read, a slash command. */
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
  /** A line typed and steered: the key this story is about. */
  const steerWith = async (text: string): Promise<void> => {
    type(text);
    await pressAndSettle(CTRL_S);
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
  return { ...fake, ui, rows, frame, press, pressAndSettle, settle, type, submit, steerWith, current, endTurn };
}

/** The rows that carry the steering marker, in the order they are drawn. */
const steeringRows = (rows: readonly string[]): readonly string[] => rows.filter((row) => row.startsWith(STEERING));

/** The rows that carry the queue's muted marker, in the order they are drawn. */
const queuedRows = (rows: readonly string[]): readonly string[] => rows.filter((row) => row.startsWith("queued · "));

/** The prompt's own text row: the **last** marker row, because the transcript has them too. */
const promptRow = (rows: readonly string[]): string => {
  const row = rows.filter((line) => line.startsWith(">")).at(-1);
  assertDefined(row, "the prompt's text row");
  return row;
};

describe("ctrl+s on a brain that cannot steer", () => {
  test("AC-10 clears the prompt", async () => {
    const ui = mountScreen({ steer: () => ({ status: "unsupported" }) });
    await ui.submit("hello");
    await ui.steerWith("retry with x");
    expect(promptRow(ui.rows())).toBe(">");
  });

  test("AC-11 cancels the running turn once", async () => {
    const ui = mountScreen({ steer: () => ({ status: "unsupported" }) });
    await ui.submit("hello");
    await ui.steerWith("retry with x");
    expect(ui.cancel).toHaveBeenCalledTimes(1);
  });

  test("AC-12 sends the interrupted line before the queue once the turn ends cancelled", async () => {
    const ui = mountScreen({ steer: () => ({ status: "unsupported" }) });
    await ui.submit("hello");
    await ui.submit("q1");
    await ui.steerWith("retry");
    await ui.endTurn("cancelled");
    expect(ui.sends).toEqual(["hello", "retry"]);
  });

  test("AC-13 keeps the queue until the interrupted line's own turn ends", async () => {
    const ui = mountScreen({ steer: () => ({ status: "unsupported" }) });
    await ui.submit("hello");
    await ui.submit("q1");
    await ui.steerWith("retry");
    await ui.endTurn("cancelled");
    expect(queuedRows(ui.rows())).toEqual(["queued · q1"]);
    await ui.endTurn("completed");
    expect(ui.sends).toEqual(["hello", "retry", "q1"]);
  });

  test("AC-14 interrupts and sends the draft next when the host has no steer method", async () => {
    const ui = mountScreen();
    await ui.submit("hello");
    await ui.steerWith("retry");
    expect(ui.cancel).toHaveBeenCalledTimes(1);
    expect(promptRow(ui.rows())).toBe(">");
    await ui.endTurn("cancelled");
    expect(ui.sends).toEqual(["hello", "retry"]);
  });

  test("an unsupported steer draws no steering row", async () => {
    const ui = mountScreen({ steer: () => ({ status: "unsupported" }) });
    await ui.submit("hello");
    await ui.steerWith("retry");
    expect(steeringRows(ui.rows())).toEqual([]);
  });
});

describe("ctrl+s on a brain that steers", () => {
  /** A pending `applied` a case resolves by hand, and the host that hands it back. */
  function accepted() {
    const applied = Promise.withResolvers<boolean>();
    const steer = (text: string): SteerResult => ({
      status: "accepted",
      steerId: `s-${text}`,
      applied: applied.promise,
    });
    return { applied, ui: mountScreen({ steer }) };
  }

  test("AC-4 clears the prompt", async () => {
    const { ui } = accepted();
    await ui.submit("hello");
    await ui.steerWith("look at b.ts");
    expect(promptRow(ui.rows())).toBe(">");
  });

  test("AC-5 draws a steering row with the text", async () => {
    const { ui } = accepted();
    await ui.submit("hello");
    await ui.steerWith("look at b.ts");
    expect(steeringRows(ui.rows())).toEqual([`${STEERING}look at b.ts`]);
  });

  test("AC-6 the row goes when the turn applies the steer", async () => {
    const { applied, ui } = accepted();
    await ui.submit("hello");
    await ui.steerWith("look at b.ts");
    applied.resolve(true);
    await ui.settle();
    expect(steeringRows(ui.rows())).toEqual([]);
  });

  test("AC-7 an applied steer appends the user's own transcript row", async () => {
    const { applied, ui } = accepted();
    await ui.submit("hello");
    await ui.steerWith("look at b.ts");
    expect(ui.rows()).not.toContain("> look at b.ts");
    applied.resolve(true);
    await ui.settle();
    expect(ui.rows()).toContain("> look at b.ts");
  });

  test("AC-8 the row goes when the turn did not apply the steer", async () => {
    const { applied, ui } = accepted();
    await ui.submit("hello");
    await ui.steerWith("look at b.ts");
    applied.resolve(false);
    await ui.settle();
    expect(steeringRows(ui.rows())).toEqual([]);
  });

  test("AC-9 an unapplied steer goes to the front of the queue", async () => {
    const { applied, ui } = accepted();
    await ui.submit("hello");
    await ui.submit("q1");
    await ui.steerWith("look at b.ts");
    applied.resolve(false);
    await ui.settle();
    expect(queuedRows(ui.rows())).toEqual(["queued · look at b.ts", "queued · q1"]);
  });

  test("the steering row is drawn above the queue rows", async () => {
    const { ui } = accepted();
    await ui.submit("hello");
    await ui.submit("q1");
    await ui.steerWith("look at b.ts");
    const rows = ui.rows();
    const steering = rows.findIndex((row) => row.startsWith(`${STEERING}look at b.ts`));
    const queued = rows.findIndex((row) => row.startsWith("queued · q1"));
    expect(steering).toBeGreaterThanOrEqual(0);
    expect(queued).toBeGreaterThan(steering);
  });

  test("a steer the turn applies is not queued after it", async () => {
    const { applied, ui } = accepted();
    await ui.submit("hello");
    await ui.steerWith("look at b.ts");
    applied.resolve(true);
    await ui.settle();
    expect(queuedRows(ui.rows())).toEqual([]);
  });
});

describe("ctrl+s when there is nothing to steer", () => {
  test("AC-15 sends the draft as a turn when no turn is running", async () => {
    const ui = mountScreen({ steer: () => ({ status: "unsupported" }) });
    await ui.steerWith("hello");
    expect(ui.sends).toEqual(["hello"]);
    expect(ui.steer).not.toHaveBeenCalled();
    expect(ui.cancel).not.toHaveBeenCalled();
  });

  test("AC-16 an empty prompt calls neither steer, cancel nor send", async () => {
    const ui = mountScreen({ steer: () => ({ status: "accepted", steerId: "s", applied: Promise.resolve(true) }) });
    await ui.submit("hello");
    await ui.pressAndSettle(CTRL_S);
    expect(ui.steer).not.toHaveBeenCalled();
    expect(ui.cancel).not.toHaveBeenCalled();
    expect(ui.sends).toEqual(["hello"]);
  });

  test("AC-17 a slash line calls neither steer, cancel nor send", async () => {
    const ui = mountScreen({ steer: () => ({ status: "accepted", steerId: "s", applied: Promise.resolve(true) }) });
    await ui.submit("hello");
    await ui.steerWith("/help");
    expect(ui.steer).not.toHaveBeenCalled();
    expect(ui.cancel).not.toHaveBeenCalled();
    expect(ui.sends).toEqual(["hello"]);
  });
});

describe("ctrl+s on a draft that holds a picture", () => {
  /** A screen with `hello` running and a pasted picture in the prompt. */
  async function withImageInPrompt() {
    spyOn(_imageAttachDeps, "readClipboard").mockResolvedValue({ kind: "image", bytes: PNG });
    const ui = mountScreen({ steer: () => ({ status: "accepted", steerId: "s", applied: Promise.resolve(true) }) });
    await ui.submit("hello");
    await ui.pressAndSettle(CTRL_V);
    ui.type(" look");
    return ui;
  }

  test("AC-18 shows the images-cannot-be-queued notice", async () => {
    const ui = await withImageInPrompt();
    await ui.pressAndSettle(CTRL_S);
    expect(ui.frame()).toContain(IMAGES_NOT_QUEUED);
  });

  test("AC-19 calls neither steer nor cancel", async () => {
    const ui = await withImageInPrompt();
    await ui.pressAndSettle(CTRL_S);
    expect(ui.steer).not.toHaveBeenCalled();
    expect(ui.cancel).not.toHaveBeenCalled();
  });
});

describe("ctrl+s when the host throws", () => {
  /** A host whose steer rejects the key, the way a closed session does. */
  function throwing() {
    return mountScreen({
      steer: () => {
        throw new Error("session is closed");
      },
    });
  }

  test("AC-22 appends an error row carrying the message", async () => {
    const ui = throwing();
    await ui.submit("hello");
    await ui.steerWith("x");
    expect(ui.rows().some((row) => row.startsWith(`${THEME.glyphs.error} session is closed`))).toBe(true);
  });

  test("AC-23 keeps the draft", async () => {
    const ui = throwing();
    await ui.submit("hello");
    await ui.steerWith("x");
    expect(promptRow(ui.rows())).toBe("> x");
  });
});

describe("/help names ctrl+s", () => {
  /** The listing's own rows, in the order the transcript draws them. */
  const listingRows = (rows: readonly string[]): readonly string[] => rows.filter((row) => row.startsWith("/"));

  test.each([
    ["AC-20", MODEL],
    ["AC-21", ACP_MODEL],
  ])("%s ends with the ctrl+s line, after the built-in commands", async (_ac, model) => {
    const ui = mountScreen({ model });
    await ui.submit("/help");
    const rows = ui.rows();
    const hint = rows.findIndex((row) => row.trimEnd() === STEER_HINT);
    expect(hint).toBeGreaterThanOrEqual(0);
    // After the last built-in, and the last row of the listing.
    expect(listingRows(rows).at(-1)).toBe(LAST_BUILTIN);
    expect(rows.slice(hint + 1).filter((row) => row.startsWith("/"))).toEqual([]);
  });
});

/** The last built-in `/help` lists: the line the ctrl+s hint follows. */
const LAST_BUILTIN = "/quit  Quit nax chat";

/* ---------------------------------------------------------------------------------------
 * AC-3 mounts the real host: the key is only worth binding if it reaches the session.
 * ------------------------------------------------------------------------------------- */

/** A real `createChatHost` over a stub session, with a turn left running after `hi`. */
async function realHostWithStubSession() {
  const applied = Promise.withResolvers<boolean>();
  const steer = mock(
    (_text: string): SteerResult => ({ status: "accepted", steerId: "steer-1", applied: applied.promise }),
  );
  const gate = Promise.withResolvers<void>();
  const session: AgentSession = {
    id: "steer-session",
    backend: { kind: "native", capabilities: {} },
    lastTurn: undefined,
    async *send() {
      yield { sessionId: "steer-session", turnId: "t1", at: "now", metadata: {}, type: "turn_start" };
      await gate.promise;
    },
    answer: () => "accepted",
    cancel() {},
    close: async () => {},
    steer,
  };
  const meta: SessionMeta = stateOf(MODEL).meta;
  const host = createChatHost({
    config: makeNaxConfig(),
    cwd: REPO_ROOT,
    repoRoot: REPO_ROOT,
    chain: null,
    storage: createChatStorage({ pid: process.pid, now: () => new Date(), logger: makeLogger() }),
    now: () => new Date(),
    logger: makeLogger(),
    open: async () => ({ session, meta, release: async () => {} }),
  });
  await host.start({ mode: "guarded", model: MODEL });
  return { host, steer, release: () => gate.resolve() };
}

describe("ctrl+s over the real host", () => {
  test("AC-3 steers the open session once with the typed text", async () => {
    const real = await realHostWithStubSession();
    const ui = render(<ChatApp host={real.host} theme={THEME} />);
    try {
      act(() => {
        ui.stdin.write("hi");
      });
      await Promise.resolve(
        act(async () => {
          ui.stdin.write(RETURN);
        }),
      );
      act(() => {
        ui.stdin.write("x");
      });
      await Promise.resolve(
        act(async () => {
          ui.stdin.write(CTRL_S);
        }),
      );
      expect(real.steer).toHaveBeenCalledTimes(1);
      expect(real.steer).toHaveBeenCalledWith("x");
    } finally {
      real.release();
      await real.host.close();
    }
  });
});
