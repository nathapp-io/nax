/**
 * AskCard — the framed approval and question card that replaces the chat input while the
 * session waits for an answer.
 *
 * The standalone cases mount the card alone over a controller whose `resolve` and
 * `answerQuestion` are observed directly: the card is the one place a key becomes a
 * decision, so what it calls is what the screen does. The countdown runs on
 * `_askCardDeps`'s clock, which each countdown case replaces with a virtual one, so a
 * second of waiting costs no wall-clock.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { SessionEvent, SessionEventBody } from "@nathapp/nax-agent";
import { makeFakeClock } from "@test/helpers";
import chalk from "chalk";
import { cleanup, render } from "ink-testing-library";
import { act, type ReactElement, useState } from "react";
import type { AskChoice } from "@/chat";
import {
  type ChatApproval,
  type ChatAskController,
  type ChatHost,
  type ChatHostState,
  type ChatPendingAsk,
  createChatAskController,
} from "@/chat";
import { _askCardDeps, AskCard, askCardLayout, countdownLabel } from "@/tui/chat/AskCard";
import { askCardModel } from "@/tui/chat/ask-card";
import { ChatApp } from "@/tui/chat/ChatApp";
import { EMPTY_DRAFT, type InputDraft } from "@/tui/chat/ChatInput";
import { type ChatTheme, resolveChatTheme } from "@/tui/chat/theme";
import type { TranscriptEntry } from "@/tui/chat/transcript-model";

/** Colour off: every row the frame carries is the plain characters. */
const THEME = resolveChatTheme({ env: {}, colorLevel: 0 });
/** Truecolour, so a token's own hex reaches the frame as the SGR ink writes for it. */
const FULL_COLOR = resolveChatTheme({ env: {}, colorLevel: 3 });
/** The SGR that closes a foreground colour, which ink writes after the coloured text. */
const COLOR_OFF = "\u001b[39m";
/** Wide enough that no option or title wraps: the rows are read as whole strings. */
const WIDTH = 80;
/** More rows than a card needs, so nothing is withheld in these cases. */
const BUDGET = 40;

/** The sequences ink parses into the keys the card owns. */
const RETURN = "\r";
const ESCAPE = "\x1b";
const DOWN = "\x1b[B";
const UP = "\x1b[A";
/** Shift+arrow: the transcript viewport's key, in every state. */
const SHIFT_DOWN = "\x1b[1;2B";
const CTRL_A = "\x01";

/** One instant every fixture is raised at; the model reads no clock. */
const AT = "2026-01-01T00:00:00.000Z";
/** An expiry the default fixtures carry; a countdown case overrides it on the virtual clock. */
const EXPIRES_AT = "2026-01-01T00:10:00.000Z";

/** A transcript with nothing in it: the shape an ask raised outside a tool call has. */
const NO_ENTRIES: readonly TranscriptEntry[] = [];

const originalDeps = { ..._askCardDeps };
const originalChalkLevel = chalk.level;
afterEach(() => {
  cleanup();
  Object.assign(_askCardDeps, originalDeps);
  chalk.level = originalChalkLevel;
});

/** The SGR code that opens `hex` as a foreground colour — what ink writes for a theme token. */
function sgr(hex: string | undefined): string {
  const channels = [1, 3, 5].map((at) => Number.parseInt((hex ?? "").slice(at, at + 2), 16));
  return `\u001b[38;2;${channels.join(";")}m`;
}

/** One approval as the session raises it: a Bash ask that wants to run the tests. */
function approval(overrides: Partial<ChatApproval> = {}): ChatApproval {
  return {
    type: "approval_requested",
    sessionId: "s1",
    turnId: "t1",
    at: AT,
    metadata: {},
    requestId: "ask-1",
    tool: "Bash",
    command: "npm test",
    summary: "Run the tests",
    reason: "nax needs to run the tests",
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

type ChatQuestion = Extract<ChatPendingAsk, { type: "question" }>;

/** One question as the session raises it: the card asks rather than offers. */
function question(overrides: Partial<ChatQuestion> = {}): ChatQuestion {
  return {
    type: "question",
    sessionId: "s1",
    turnId: "t1",
    at: AT,
    metadata: {},
    requestId: "q1",
    text: "which package?",
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

/**
 * The card's controller, with the two calls the card makes observed: `pending` is never
 * consulted (the screen owns which ask is showing) and the rest are inert.
 */
function fakeController(canRemember: boolean) {
  const resolve = mock((_requestId: string, _choice: AskChoice) => {});
  const answerQuestion = mock((_requestId: string, _text: string) => {});
  const controller: ChatAskController = {
    handle: () => {},
    pending: () => [],
    resolve,
    canRemember: () => canRemember,
    answerQuestion,
    setMode: () => {},
    reset: () => {},
    onChange: () => () => {},
  };
  return { controller, resolve, answerQuestion };
}

interface MountOptions {
  readonly canRemember?: boolean;
  readonly entries?: readonly TranscriptEntry[];
  readonly budget?: number;
  /** Absent: the colourless theme, whose rows are the plain characters. */
  readonly theme?: ChatTheme;
}

/**
 * The card under a small owner, exactly as the screen frames it: the owner keeps the
 * question's `InputDraft`, so a typed answer reaches the card the way it will in `ChatApp`.
 */
function mountCard(ask: ChatPendingAsk, options: MountOptions = {}) {
  const canRemember = options.canRemember ?? true;
  const { controller, resolve, answerQuestion } = fakeController(canRemember);
  const onDeclined = mock(() => {});
  function Harness(): ReactElement {
    const [answer, setAnswer] = useState<InputDraft>(EMPTY_DRAFT);
    const model = askCardModel(ask, { canRemember, entries: options.entries ?? NO_ENTRIES });
    return (
      <AskCard
        ask={ask}
        model={model}
        controller={controller}
        width={WIDTH}
        budget={options.budget ?? BUDGET}
        theme={options.theme ?? THEME}
        answer={answer}
        onAnswerChange={setAnswer}
        onDeclined={onDeclined}
      />
    );
  }
  const ui = render(<Harness />);
  return {
    ...ui,
    resolve,
    answerQuestion,
    onDeclined,
    type: (text: string) =>
      act(() => {
        ui.stdin.write(text);
      }),
    /** Every drawn row, escape codes and trailing padding removed. */
    rows: () => (ui.lastFrame() ?? "").split("\n").map((row) => Bun.stripANSI(row).trimEnd()),
    frame: () =>
      (ui.lastFrame() ?? "")
        .split("\n")
        .map((row) => Bun.stripANSI(row).trimEnd())
        .join("\n"),
  };
}

/** The card's whole clock: the countdown's `now` and the timer that re-renders it. */
function fakeClock() {
  const clock = makeFakeClock();
  _askCardDeps.now = clock.now;
  _askCardDeps.setTimeout = (callback, delayMs) => clock.setTimeout(callback, delayMs);
  _askCardDeps.clearTimeout = (handle) => clock.clearTimeout(Number(handle));
  return clock;
}

/** Move the card's clock forward, letting the countdown's tick fire inside React's scope. */
function advance(clock: ReturnType<typeof fakeClock>, ms: number): Promise<void> {
  return Promise.resolve(
    act(async () => {
      await clock.advance(ms);
    }),
  );
}

describe("AskCard options and keys", () => {
  test("AC-1 shows the first option behind the selection pointer", () => {
    const card = mountCard(approval());
    expect(card.frame()).toContain("❯ 1. Yes");
  });

  test("AC-2 downArrow then return chooses the session option", () => {
    const card = mountCard(approval());
    card.type(DOWN);
    card.type(RETURN);
    expect(card.resolve).toHaveBeenCalledWith("ask-1", "allow_session");
  });

  test("AC-3 the number key chooses its own option", () => {
    const card = mountCard(approval());
    card.type("1");
    expect(card.resolve).toHaveBeenCalledWith("ask-1", "allow_once");
  });

  test("AC-4 escape chooses No", () => {
    const card = mountCard(approval());
    card.type(ESCAPE);
    expect(card.resolve).toHaveBeenCalledWith("ask-1", "deny");
  });

  test("AC-4 escape reports the decline, so the screen can hint what to do instead", () => {
    const card = mountCard(approval());
    card.type(ESCAPE);
    expect(card.onDeclined).toHaveBeenCalledTimes(1);
  });

  test("AC-5 key a allows once", () => {
    const card = mountCard(approval());
    card.type("a");
    expect(card.resolve).toHaveBeenCalledWith("ask-1", "allow_once");
  });

  test("AC-5 key d denies", () => {
    const card = mountCard(approval());
    card.type("d");
    expect(card.resolve).toHaveBeenCalledWith("ask-1", "deny");
  });

  test("AC-6 key s allows for the session when remembering is allowed", () => {
    const card = mountCard(approval());
    card.type("s");
    expect(card.resolve).toHaveBeenCalledWith("ask-1", "allow_session");
  });

  test("AC-7 key s resolves nothing when remembering is not allowed", () => {
    const card = mountCard(approval(), { canRemember: false });
    expect(card.frame()).not.toContain("don't ask again");
    card.type("s");
    expect(card.resolve).not.toHaveBeenCalled();
  });

  test("AC-8 a ctrl letter resolves nothing", () => {
    const card = mountCard(approval());
    card.type(CTRL_A);
    expect(card.resolve).not.toHaveBeenCalled();
  });

  test("up and down stay inside the option list", () => {
    const card = mountCard(approval());
    card.type(UP);
    card.type(RETURN);
    expect(card.resolve).toHaveBeenCalledWith("ask-1", "allow_once");
  });

  test("a shifted arrow leaves the selection to the viewport", () => {
    const card = mountCard(approval());
    card.type(SHIFT_DOWN);
    card.type(RETURN);
    expect(card.resolve).toHaveBeenCalledWith("ask-1", "allow_once");
  });

  test("a number key beyond the list resolves nothing", () => {
    const card = mountCard(approval(), { canRemember: false });
    card.type("3");
    expect(card.resolve).not.toHaveBeenCalled();
  });
});

describe("AskCard countdown", () => {
  test("AC-9 counts the whole time left to the ask's expiry", () => {
    const clock = fakeClock();
    const expiresAt = new Date(clock.now() + 9 * 60_000 + 41_000).toISOString();
    const card = mountCard(approval({ expiresAt }));
    expect(card.frame()).toContain("expires in 9:41");
  });

  test("AC-10 under a minute it shows the seconds left in the warning colour", () => {
    const clock = fakeClock();
    const expiresAt = new Date(clock.now() + 48_000).toISOString();
    const card = mountCard(approval({ expiresAt }));
    expect(card.frame()).toContain("expires in 0:48");
    expect(countdownLabel(expiresAt, clock.now()).color).toBe("warning");
  });

  test("AC-10 over a minute it stays muted", () => {
    const clock = fakeClock();
    const expiresAt = new Date(clock.now() + 581_000).toISOString();
    expect(countdownLabel(expiresAt, clock.now()).color).toBe("muted");
  });

  test("AC-10 the warning colour is what the last minute is drawn in", () => {
    chalk.level = 3;
    const clock = fakeClock();
    const expiresAt = new Date(clock.now() + 48_000).toISOString();
    const card = mountCard(approval({ expiresAt }), { theme: FULL_COLOR });
    // The raw frame, not `rows()`: the colour is the SGR around the row, not the row's text.
    const countdown = (card.lastFrame() ?? "").split("\n").find((row) => row.includes("expires in"));
    expect(countdown).toBe(`${sgr(FULL_COLOR.colors.warning)}expires in 0:48${COLOR_OFF}`);
  });

  test("a countdown over a minute is drawn in the muted colour", () => {
    chalk.level = 3;
    const clock = fakeClock();
    const expiresAt = new Date(clock.now() + 581_000).toISOString();
    const card = mountCard(approval({ expiresAt }), { theme: FULL_COLOR });
    const countdown = (card.lastFrame() ?? "").split("\n").find((row) => row.includes("expires in"));
    expect(countdown).toBe(`${sgr(FULL_COLOR.colors.muted)}expires in 9:41${COLOR_OFF}`);
  });

  test("AC-11 a second later the card has counted down", async () => {
    const clock = fakeClock();
    const expiresAt = new Date(clock.now() + 48_000).toISOString();
    const card = mountCard(approval({ expiresAt }));
    expect(card.frame()).toContain("expires in 0:48");
    await advance(clock, 1_000);
    expect(card.frame()).toContain("expires in 0:47");
  });

  test("an expiry that does not parse counts as no time left", () => {
    expect(countdownLabel("later", 0).text).toBe("expires in 0:00");
  });
});

describe("AskCard measurement", () => {
  /** The rows the screen would reserve for `ask`, measured with the card's own layout. */
  function measuredRows(ask: ChatPendingAsk, canRemember: boolean, budget: number): number {
    const model = askCardModel(ask, { canRemember, entries: NO_ENTRIES });
    return askCardLayout(model, {
      width: WIDTH,
      budget,
      theme: THEME,
      answer: EMPTY_DRAFT,
      expiresAt: ask.expiresAt,
    }).rows;
  }

  test("draws exactly the rows it measured", () => {
    const ask = approval();
    const card = mountCard(ask);
    expect(card.rows()).toHaveLength(measuredRows(ask, true, BUDGET));
  });

  test("draws exactly the rows it measured for a question, its box included", () => {
    const ask = question();
    const card = mountCard(ask);
    expect(card.rows()).toHaveLength(measuredRows(ask, false, BUDGET));
  });

  test("withholds the middle of a tall card and names what it dropped", () => {
    const ask = approval({ reason: Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n") });
    const card = mountCard(ask, { budget: 10 });
    expect(card.rows()).toHaveLength(measuredRows(ask, true, 10));
    expect(card.frame()).toContain("more lines");
    expect(card.frame()).toContain("1. Yes");
    expect(card.frame()).toContain("expires in");
  });
});

describe("AskCard question", () => {
  test("AC-12 titles the card nax asks", () => {
    const card = mountCard(question());
    expect(card.frame()).toContain("nax asks");
  });

  test("AC-13 return submits the typed answer for its request", () => {
    const card = mountCard(question());
    card.type("yes");
    card.type(RETURN);
    expect(card.answerQuestion).toHaveBeenCalledWith("q1", "yes");
  });
});

describe("AskCard in the chat screen", () => {
  /**
   * The mounted screen over the same typed fake host the chat screen's other tests use: what
   * a keypress does to the pending ask, and what the bottom region shows afterwards.
   */
  function mountScreen() {
    const state: ChatHostState = {
      sessionId: "abcdefgh-1234",
      mode: "guarded",
      model: "model",
      meta: {
        schemaVersion: 1,
        sessionId: "abcdefgh-1234",
        cwd: "/repo",
        mode: "ask",
        model: "model",
        bashApproval: "gated",
        title: null,
        createdAt: "now",
        updatedAt: null,
      },
    };
    const event = (body: SessionEventBody): SessionEvent => ({
      sessionId: state.sessionId,
      turnId: "t1",
      at: "now",
      metadata: {},
      ...body,
    });
    const asks = createChatAskController({ mode: "guarded", answer: () => {} });
    const resolve = mock(asks.resolve.bind(asks));
    asks.resolve = resolve;
    const answer = mock(asks.answerQuestion.bind(asks));
    asks.answerQuestion = answer;
    const gate = Promise.withResolvers<void>();
    let listener: (event: SessionEvent) => void = () => {};
    const send = mock(async (_text: string, onEvent: typeof listener) => {
      listener = onEvent;
      await gate.promise;
    });
    const cancel = mock(() => {});
    const host: ChatHost = {
      repoRoot: "/repo",
      models: ["model"],
      asks,
      current: () => state,
      notice: () => undefined,
      send,
      switchTo: async () => {},
      close: async () => {},
      cancel,
      start: async () => {},
      resume: async () => {},
      clear: async () => {},
      listSessions: async () => [],
    };
    const ui = render(<ChatApp host={host} />);
    const press = (sequence: string): void => {
      act(() => {
        ui.stdin.write(sequence);
      });
    };
    return {
      ...ui,
      resolve,
      answer,
      send,
      cancel,
      press,
      frame: () =>
        (ui.lastFrame() ?? "")
          .split("\n")
          .map((row) => Bun.stripANSI(row).trimEnd())
          .join("\n"),
      /** One ask as the session raises it, and the re-render it causes. */
      ask: (body: SessionEventBody): void => {
        act(() => {
          asks.handle(event(body));
        });
      },
      /** Return in whichever input the bottom region is showing. */
      submit: (text = ""): Promise<void> =>
        Promise.resolve(
          act(async () => {
            ui.stdin.write(text);
            ui.stdin.write(RETURN);
          }),
        ),
      /** The scripted turn settles, leaving the screen idle again. */
      finish: (): Promise<void> =>
        Promise.resolve(
          act(async () => {
            listener(
              event({
                type: "turn_end",
                status: "completed",
                output: "",
                costUsd: 0,
                usage: { inputTokens: 0, outputTokens: 0 },
              }),
            );
            gate.resolve();
          }),
        ),
    };
  }

  const approvalBody: SessionEventBody = {
    type: "approval_requested",
    requestId: "ask-1",
    tool: "Bash",
    command: "npm test",
    reason: "Run the tests",
    summary: "test",
    expiresAt: "later",
  };
  const questionBody: SessionEventBody = {
    type: "question",
    requestId: "q1",
    text: "Proceed?",
    expiresAt: "later",
  };

  test("AC-14 a question card's input starts empty even with a chat draft typed", () => {
    const screen = mountScreen();
    screen.press("draft");
    screen.ask(questionBody);
    expect(screen.frame()).toContain("nax asks");
    expect(screen.frame()).not.toContain("draft");
  });

  test("AC-15 after answering, return in the chat input sends the draft", async () => {
    const screen = mountScreen();
    screen.press("draft");
    screen.ask(questionBody);
    await screen.submit("yes");
    expect(screen.answer).toHaveBeenCalledWith("q1", "yes");
    await screen.submit();
    expect(screen.send).toHaveBeenCalledWith("draft", expect.any(Function));
  });

  test("AC-16 a pending Bash approval shows the card's title", () => {
    const screen = mountScreen();
    screen.ask(approvalBody);
    expect(screen.frame()).toContain("Bash command");
  });

  test("AC-17 choosing No frees the input with a hint what to do instead", () => {
    const screen = mountScreen();
    screen.ask(approvalBody);
    screen.press(ESCAPE);
    expect(screen.resolve).toHaveBeenCalledWith("ask-1", "deny");
    expect(screen.frame()).toContain("tell nax what to do instead");
  });

  test("AC-18 the next submit leaves the hint behind", async () => {
    const screen = mountScreen();
    screen.ask(approvalBody);
    screen.press(ESCAPE);
    await screen.submit("hello");
    await screen.finish();
    expect(screen.frame()).not.toContain("tell nax what to do instead");
    expect(screen.frame()).toContain("Try");
  });

  test("AC-19 a draft typed before an ask is still there to send after it", async () => {
    const screen = mountScreen();
    screen.press("draft");
    screen.ask(approvalBody);
    screen.press("a");
    expect(screen.frame()).toContain("draft");
    await screen.submit();
    expect(screen.send).toHaveBeenCalledWith("draft", expect.any(Function));
  });

  test("AC-20 escape while an approval is pending interrupts nothing", async () => {
    const screen = mountScreen();
    await screen.submit("hello");
    screen.ask(approvalBody);
    screen.press(ESCAPE);
    expect(screen.resolve).toHaveBeenCalledWith("ask-1", "deny");
    expect(screen.cancel).not.toHaveBeenCalled();
  });
});
