/**
 * US-005: the choice card inside `AskCard` — the structured question set drawn as a budgeted
 * interactive card, and its answers submitted through the chat ask controller.
 *
 * The controller is real and its `answer` callback is observed directly: the card is the one
 * place a key becomes an answer, so what reaches the session is what these cases assert. The
 * asks are raised the way the session raises them, so the model is built by `askCardModel` and
 * the answers travel back for the assessor's own labels — never for the drawn copy.
 */
import { afterEach, describe, expect, type Mock, mock, test } from "bun:test";
import { AgentSessionError, type AnswerReply, type ChoiceQuestion, formatChoiceAnswers } from "@nathapp/nax-agent";
import { withTimerSpy } from "@test/helpers";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import { type ChatPendingAsk, createChatAskController } from "@/chat";
import { _askCardDeps, AskCard, COUNTDOWN_TICK_MS } from "@/tui/chat/AskCard";
import { askCardModel } from "@/tui/chat/ask-card";
import { EMPTY_DRAFT } from "@/tui/chat/ChatInput";
import { resolveChatTheme } from "@/tui/chat/theme";
import { frameHarness } from "./frame-harness";

afterEach(cleanup);

/** Colour off: every drawn row is the plain characters. */
const THEME = resolveChatTheme({ env: {}, colorLevel: 0 });
/** An instant the ask is raised at; the card reads no clock of its own here. */
const AT = "2026-01-01T00:00:00.000Z";
/** An expiry that does not parse, so no countdown tick is armed during a case. */
const EXPIRES_AT = "later";
/** The sequences ink parses into the keys the choice card owns. */
const RETURN = "\r";
const ESCAPE = "\x1b";
const DOWN = "\x1b[B";
const SPACE = " ";

type ChatQuestion = Extract<ChatPendingAsk, { type: "question" }>;

/** One choice question as the shared contract carries it. */
function question(overrides: Partial<ChoiceQuestion> = {}): ChoiceQuestion {
  return {
    header: "Runner",
    question: "Which runner?",
    options: [{ label: "bun" }, { label: "vitest" }],
    multiSelect: false,
    allowOther: true,
    required: true,
    ...overrides,
  };
}

/** One question ask, as the session raises it: `questions` makes it a choice ask. */
function askEvent(questions?: readonly ChoiceQuestion[]): ChatQuestion {
  return {
    type: "question",
    sessionId: "s1",
    turnId: "t1",
    at: AT,
    metadata: {},
    requestId: "q1",
    text: "Which runner?",
    expiresAt: EXPIRES_AT,
    ...(questions === undefined ? {} : { questions }),
  };
}

/** What a mounted card offers a case: the rows it draws, and the keys it takes. */
interface Mounted {
  readonly frame: () => string;
  readonly type: (sequence: string) => void;
  readonly answer: Mock<(id: string, reply: AnswerReply) => void>;
  readonly dismiss: Mock<() => void>;
}

/** Mount `AskCard` over a real controller whose `answer` callback is observed. */
function mount(event: ChatQuestion, width = 80, budget = 40): Mounted {
  const answer = mock((_id: string, _reply: AnswerReply) => {});
  const controller = createChatAskController({ mode: "guarded", answer });
  controller.handle(event);
  const ask = controller.pending()[0];
  if (ask === undefined) throw new Error("the ask was not queued");
  const dismiss = mock(() => {});
  const view = render(
    <AskCard
      ask={ask}
      model={askCardModel(ask, { canRemember: false, entries: [] })}
      controller={controller}
      width={width}
      budget={budget}
      theme={THEME}
      answer={EMPTY_DRAFT}
      onAnswerChange={() => {}}
      onDismiss={dismiss}
    />,
  );
  return {
    frame: () =>
      (view.lastFrame() ?? "")
        .split("\n")
        .map((row) => Bun.stripANSI(row).trimEnd())
        .join("\n"),
    type: (sequence: string) =>
      act(() => {
        view.stdin.write(sequence);
      }),
    answer,
    dismiss,
  };
}

describe("choice question card submission", () => {
  test("AC-13: down then return answers the second option with the original labels", () => {
    const questions = [question({ options: [{ label: "bun" }, { label: "vitest" }] })];
    const card = mount(askEvent(questions));
    expect(card.frame()).toContain("Which runner?");
    card.type(DOWN);
    card.type(RETURN);
    const answers = [{ selected: [1] }];
    expect(card.answer.mock.calls).toEqual([["q1", { text: formatChoiceAnswers(questions, answers), answers }]]);
  });

  test("AC-14: space, down, space, return answers a multi-select question with both rows", () => {
    const questions = [question({ multiSelect: true })];
    const card = mount(askEvent(questions));
    card.type(SPACE);
    card.type(DOWN);
    card.type(SPACE);
    card.type(RETURN);
    const answers = [{ selected: [0, 1] }];
    expect(card.answer.mock.calls).toEqual([["q1", { text: formatChoiceAnswers(questions, answers), answers }]]);
  });

  test("AC-15: an invalid answer is logged and the card stays open", () => {
    const card = mount(askEvent([question()]));
    card.answer.mockImplementation(() => {
      throw new AgentSessionError("no request was issued", "AGENT_SESSION_INVALID_ANSWER", { requestId: "q1" });
    });
    expect(() => card.type(RETURN)).not.toThrow();
    expect(card.answer).toHaveBeenCalledTimes(1);
    expect(card.frame()).toContain("Which runner?");
    expect(card.frame()).toContain("1. bun");
  });

  test("an unexpected submit failure is logged and rethrown rather than swallowed", () => {
    const card = mount(askEvent([question()]));
    card.answer.mockImplementation(() => {
      throw new Error("the watcher is gone");
    });
    expect(() => card.type(RETURN)).toThrow("the watcher is gone");
  });

  test("AC-16: escape dismisses the card without answering it", () => {
    const card = mount(askEvent([question()]));
    card.type(ESCAPE);
    expect(card.dismiss).toHaveBeenCalledTimes(1);
    expect(card.answer).not.toHaveBeenCalled();
  });

  test("AC-17: a question without questions keeps the text box and answers through it", () => {
    const card = mount(askEvent());
    expect(card.frame()).toContain("type your answer");
    card.type("yes");
    card.type(RETURN);
    expect(card.answer.mock.calls).toEqual([["q1", { text: "yes" }]]);
  });

  test("two questions answer through the review step, in question order", () => {
    const questions = [
      question({ header: "Runner", options: [{ label: "bun" }, { label: "vitest" }] }),
      question({ header: "Scope", question: "Which scope?", options: [{ label: "unit" }, { label: "e2e" }] }),
    ];
    const card = mount(askEvent(questions));
    card.type("1");
    card.type("1");
    // The last question answered opens the review step rather than submitting.
    expect(card.frame()).toContain("Scope");
    expect(card.answer).not.toHaveBeenCalled();
    card.type(RETURN);
    const answers = [{ selected: [0] }, { selected: [0] }];
    expect(card.answer.mock.calls).toEqual([["q1", { text: formatChoiceAnswers(questions, answers), answers }]]);
  });

  test("the Other... row takes a typed answer and sends it as the question's other", () => {
    const questions = [question({ allowOther: true })];
    const card = mount(askEvent(questions));
    card.type(DOWN);
    card.type(DOWN);
    card.type(RETURN);
    card.type("neither of those");
    card.type(RETURN);
    const answers = [{ selected: [], other: "neither of those" }];
    expect(card.answer.mock.calls).toEqual([["q1", { text: formatChoiceAnswers(questions, answers), answers }]]);
  });
});

describe("choice question card countdown", () => {
  test("the countdown arms one tick through the card's clock seam and clears it on unmount", async () => {
    const original = { ..._askCardDeps };
    const arm = mock((callback: () => void, delayMs: number) => original.setTimeout(callback, delayMs));
    _askCardDeps.setTimeout = arm;
    try {
      const expiresAt = new Date(Date.now() + 5_000).toISOString();
      const spy = await withTimerSpy(async () => {
        mount({ ...askEvent([question()]), expiresAt });
        cleanup();
      });
      // One tick, a second long, armed through the seam both cards share.
      expect(arm.mock.calls.map((call) => call[1])).toEqual([COUNTDOWN_TICK_MS]);
      expect(spy.armed).toHaveLength(1);
      expect(spy.leaked).toEqual([]);
    } finally {
      Object.assign(_askCardDeps, original);
    }
  });
});

describe("choice question card in the chat screen", () => {
  test("the screen draws the choice card where the answer box would be", () => {
    const screen = frameHarness();
    screen.ask({
      type: "question",
      requestId: "q1",
      text: "Which runner?",
      prompt: "pick one",
      expiresAt: "later",
      questions: [
        question({ header: "Runner" }),
        question({ header: "Scope", question: "Which scope?", options: [{ label: "unit" }, { label: "e2e" }] }),
      ],
    });
    const frame = (screen.ui.lastFrame() ?? "").split("\n").map((row) => Bun.stripANSI(row).trimEnd());
    const drawn = frame.join("\n");
    expect(drawn).toContain("[Runner]");
    expect(drawn).toContain("[Submit]");
    expect(drawn).toContain("Which runner?");
    expect(drawn).toContain("1. bun");
    expect(drawn).toContain("expires in");
    // The framed question card's answer box is what a choice ask replaces.
    expect(drawn).not.toContain("type your answer");
    // And it is drawn inside the rows the frame allocated for it, not one row more.
    expect(frame.length).toBeLessThanOrEqual(24);
  });
});

describe("choice question card drawing", () => {
  test("draws the tab strip, the question and its options in the rows it was given", () => {
    const two = [
      question({ header: "Runner" }),
      question({ header: "Scope", question: "Which scope?", options: [{ label: "unit" }, { label: "e2e" }] }),
    ];
    const card = mount(askEvent(two));
    const frame = card.frame();
    expect(frame).toContain("[Runner]");
    expect(frame).toContain("[Scope]");
    expect(frame).toContain("[Submit]");
    expect(frame).toContain("Which runner?");
    expect(frame).toContain("1. bun");
    expect(frame).toContain("Other...");
    expect(frame).toContain("expires in");
  });

  test("the right arrow shows the second question's tab", () => {
    const two = [
      question({ header: "Runner" }),
      question({ header: "Scope", question: "Which scope?", options: [{ label: "unit" }, { label: "e2e" }] }),
    ];
    const card = mount(askEvent(two));
    card.type("\x1b[C");
    expect(card.frame()).toContain("Which scope?");
    expect(card.frame()).toContain("1. unit");
  });

  test("a host choice ask is still drawn by its own card", () => {
    const answer = mock((_id: string, _reply: AnswerReply) => {});
    const controller = createChatAskController({ mode: "guarded", answer, approvalTimeoutMs: 600_000 });
    void controller.requestHostChoice({
      tool: "nax-close",
      summary: "Quit?",
      reason: "Tasks are running",
      fallback: "stay",
      choices: [
        { id: "stop", label: "Quit and stop them" },
        { id: "stay", label: "Stay in chat" },
      ],
    });
    const ask = controller.pending()[0];
    if (ask === undefined) throw new Error("the host choice was not queued");
    const view = render(
      <AskCard
        ask={ask}
        model={askCardModel(ask, { canRemember: false, entries: [] })}
        controller={controller}
        width={80}
        budget={40}
        theme={THEME}
        answer={EMPTY_DRAFT}
        onAnswerChange={() => {}}
      />,
    );
    expect(view.lastFrame() ?? "").toContain("1. Quit and stop them");
    controller.reset();
  });
});
