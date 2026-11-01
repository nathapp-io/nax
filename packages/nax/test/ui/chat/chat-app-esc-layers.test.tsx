/**
 * Esc in the chat screen, and the hints that name it.
 *
 * The footer and the working line promise what esc does; the key handlers do it. Both read
 * `topEscLayer` for the frame being drawn, so every case here writes a real escape sequence
 * into stdin and asserts the hint and the effect together — an ask card, a picker, a menu, a
 * bare running turn, and the host question a run ask or a job raises, which must never stop
 * the chat turn.
 *
 * The host is the shared `mountChatPicker` fake, so every screen action is a mock a case can
 * count. The ask controller's `declineQuestion` is spied rather than replaced, so the card
 * really settles, and `host.cancel` is a mock written here so the two effects' order is the
 * order the screen made them in.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { SessionEventBody } from "@nathapp/nax-agent";
import { assertDefined, mountChatPicker as mount } from "@test/helpers";
import { cleanup } from "ink-testing-library";
import { act } from "react";
import type { MentionFileList } from "@/chat";
import type { ChatJobs } from "@/chat/jobs/job-runner";
import { _chatAppDeps } from "@/tui/chat/ChatApp";
import { NO_FILE_LIST_LINE } from "@/tui/chat/MentionMenu";

/** The sequence a terminal sends for a lone esc. */
const ESCAPE = "\x1b";
/** ink reports ctrl+g as the letter with the ctrl modifier. */
const CTRL_G = "\x07";
/** The session the fake host reports, and the id its own turn's events carry. */
const SESSION = "picker-session";
/** What an empty answer box offers: the question card's guidance is its input's placeholder. */
const ANSWER_HINT = "type your answer · enter to send";
/** A question the chat session itself asked. */
const SESSION_QUESTION: SessionEventBody = {
  type: "question",
  requestId: "q1",
  text: "Proceed?",
  expiresAt: "later",
};
/** A tool approval, which esc denies as it always has. */
const APPROVAL: SessionEventBody = {
  type: "approval_requested",
  requestId: "ask-1",
  tool: "Bash",
  command: "npm test",
  reason: "Run the tests",
  summary: "test",
  expiresAt: "later",
};

afterEach(() => {
  cleanup();
  mock.restore();
});

/** A jobs port the picker opens over: nothing recorded, nothing running. */
function fakeJobs(): ChatJobs {
  const unused = () => Promise.reject(new Error("unused"));
  return {
    start: unused,
    list: () => [],
    get: () => undefined,
    running: () => [],
    owned: () => [],
    cancel: unused,
    canCancel: unused,
    attach: async () => {},
    logTail: async () => "",
    peekNotice: () => undefined,
    takeNotice: () => undefined,
    onChange: () => () => {},
    dispose: () => {},
  };
}

/** A file list git could not produce: the picker draws its diagnostic line and claims no key. */
const NO_GIT_LIST: MentionFileList = { git: false, rows: [] };

/**
 * The mounted screen, its frame, and the esc effects in the order they ran. `order` holds one
 * entry per effect — `decline:<id>` from the ask controller, `cancel` from the host — so a
 * case can say both that an effect happened once and that the decline came first.
 */
function screen(options: { jobs?: boolean; gitless?: boolean } = {}) {
  if (options.gitless === true) {
    spyOn(_chatAppDeps, "mentionFileIndex").mockReturnValue({ get: () => Promise.resolve(NO_GIT_LIST) });
  }
  const ui = mount(options.jobs === true ? { jobs: fakeJobs() } : {});
  const order: string[] = [];
  const declineQuestion = ui.host.asks.declineQuestion.bind(ui.host.asks);
  spyOn(ui.host.asks, "declineQuestion").mockImplementation((requestId: string) => {
    order.push(`decline:${requestId}`);
    declineQuestion(requestId);
  });
  ui.host.cancel = mock(() => {
    order.push("cancel");
  });
  /** One session event on the screen's own ask controller, as the host routes them. */
  const raise = (body: SessionEventBody): void => {
    act(() => {
      ui.host.asks.handle({ sessionId: SESSION, turnId: "t1", at: "now", metadata: {}, ...body });
    });
  };
  /** A host question — a run ask's or a job's — and the request id its card was opened with. */
  const askHost = (text: string): string => {
    act(() => {
      void ui.host.asks.requestHostQuestion({ text });
    });
    const requestId = ui.host.asks.pending()[0]?.requestId;
    assertDefined(requestId, "the open host question");
    return requestId;
  };
  /** The whole frame as one string, and its footer row on its own. */
  const frame = (): string => ui.rows().join("\n");
  const footer = (): string => ui.rows().at(-1) ?? "";
  /** The working line's row: the only one whose detail names the turn's tokens. */
  const working = (): string => ui.rows().find((row) => row.includes("tokens")) ?? "";
  /** Type without submitting, one keypress per frame. */
  const typeOnly = (text: string): void => {
    for (const char of text) ui.press(char);
  };
  return { ...ui, order, raise, askHost, frame, footer, working, typeOnly };
}

describe("esc on an ask card", () => {
  test("AC-1 declines a session question and stops the turn it was asked during", async () => {
    const ui = screen();
    await ui.submit("work");
    ui.raise(SESSION_QUESTION);
    expect(ui.frame()).toContain("Proceed?");
    ui.press(ESCAPE);
    expect(ui.order).toEqual(["decline:q1", "cancel"]);
    expect(ui.frame()).not.toContain("Proceed?");
  });

  test("AC-2 declines a host question with no turn running and stops nothing", () => {
    const ui = screen();
    const requestId = ui.askHost("Use that feature?");
    ui.press(ESCAPE);
    expect(ui.order).toEqual([`decline:${requestId}`]);
    expect(ui.host.asks.pending()).toHaveLength(0);
  });

  test("AC-3 a host question during a turn reads esc to close and never stops the turn", async () => {
    const ui = screen();
    await ui.submit("work");
    const requestId = ui.askHost("Use that feature?");
    expect(ui.footer()).toContain("esc to close");
    expect(ui.footer()).not.toContain("esc to close and stop");
    ui.press(ESCAPE);
    expect(ui.order).toEqual([`decline:${requestId}`]);
  });

  test("AC-6 esc with a typed answer declines instead of arming the clear", () => {
    const ui = screen();
    ui.raise(SESSION_QUESTION);
    const answer = spyOn(ui.host.asks, "answerQuestion");
    ui.typeOnly("yes");
    ui.press(ESCAPE);
    expect(ui.order).toEqual(["decline:q1"]);
    expect(answer).not.toHaveBeenCalled();
    expect(ui.frame()).not.toContain("Proceed?");
  });

  test("AC-7 an empty question card's input row offers the answer hint", () => {
    const ui = screen();
    ui.raise(SESSION_QUESTION);
    expect(ui.rows()).toContain(`> ${ANSWER_HINT}`);
  });

  test("AC-11 an approval card reads esc to deny and denies as today", () => {
    const ui = screen();
    ui.raise(APPROVAL);
    const resolve = spyOn(ui.host.asks, "resolve");
    expect(ui.footer()).toContain("esc to deny");
    ui.press(ESCAPE);
    expect(resolve).toHaveBeenCalledWith("ask-1", "deny");
  });

  test("AC-5 a choice card reads esc to cancel and takes its fallback", () => {
    const ui = screen();
    const resolveChoice = spyOn(ui.host.asks, "resolveChoice");
    act(() => {
      void ui.host.asks.requestHostChoice({
        tool: "Deploy",
        summary: "pick a target",
        reason: "one is needed",
        choices: [
          { id: "prod", label: "prod" },
          { id: "staging", label: "staging" },
        ],
        fallback: "staging",
      });
    });
    const requestId = ui.host.asks.pending()[0]?.requestId;
    assertDefined(requestId, "the open choice card");
    expect(ui.footer()).toContain("esc to cancel");
    ui.press(ESCAPE);
    expect(resolveChoice).toHaveBeenCalledWith(requestId, "staging");
  });
});

describe("the esc hint on a question card", () => {
  test("AC-8 a question during a turn takes esc to interrupt's place in the footer", async () => {
    const ui = screen();
    await ui.submit("work");
    expect(ui.footer()).toContain("esc to interrupt");
    ui.raise(SESSION_QUESTION);
    expect(ui.footer()).toContain("esc to close and stop");
    expect(ui.footer()).not.toContain("esc to interrupt");
  });

  test("AC-9 the working line names the same action, in place of esc to interrupt", async () => {
    const ui = screen();
    await ui.submit("work");
    // The working line is drawn from the turn's own status, so the stream has to have started.
    ui.emit({ type: "turn_start" });
    expect(ui.working()).toContain("esc to interrupt)");
    ui.raise(SESSION_QUESTION);
    expect(ui.working()).toMatch(/esc to close and stop\)$/);
    expect(ui.working()).not.toContain("esc to interrupt)");
  });

  test("AC-10 a question with no turn running reads esc to close", () => {
    const ui = screen();
    ui.raise(SESSION_QUESTION);
    expect(ui.footer()).toContain("esc to close");
    expect(ui.footer()).not.toContain("esc to close and stop");
  });
});

describe("the esc hint on a picker or a menu", () => {
  test("AC-12 the jobs picker names itself in the footer, and esc closes it", async () => {
    const ui = screen({ jobs: true });
    ui.press(CTRL_G);
    await ui.settle();
    expect(ui.footer()).toContain("esc to close jobs");
    ui.press(ESCAPE);
    await ui.settle();
    expect(ui.footer()).not.toContain("esc to close jobs");
  });

  test("AC-13 the model picker names itself in the footer", async () => {
    const ui = screen();
    await ui.submit("/model");
    expect(ui.rows()).toContain("Switch model");
    expect(ui.footer()).toContain("esc to close model picker");
  });

  test("AC-14 the slash menu names itself in the footer", () => {
    const ui = screen();
    ui.typeOnly("/mo");
    expect(ui.footer()).toContain("esc to close menu");
  });
});

describe("esc on the turn itself", () => {
  test("AC-15 a bare running turn keeps esc to interrupt and is cancelled once", async () => {
    const ui = screen();
    await ui.submit("work");
    expect(ui.footer()).toContain("esc to interrupt");
    ui.press(ESCAPE);
    expect(ui.order).toEqual(["cancel"]);
  });

  test("AC-4 a no-git mention line does not keep esc from the turn", async () => {
    const ui = screen({ gitless: true });
    await ui.submit("work");
    ui.typeOnly("see @");
    await ui.settle();
    expect(ui.rows()).toContain(NO_FILE_LIST_LINE);
    expect(ui.footer()).toContain("esc to interrupt");
    ui.press(ESCAPE);
    expect(ui.order).toEqual(["cancel"]);
  });

  test("AC-16 esc with the jobs picker open closes it and leaves the turn alone", async () => {
    const ui = screen({ jobs: true });
    await ui.submit("work");
    ui.press(CTRL_G);
    await ui.settle();
    expect(ui.footer()).toContain("esc to close jobs");
    ui.press(ESCAPE);
    await ui.settle();
    expect(ui.order).toEqual([]);
    expect(ui.footer()).not.toContain("esc to close jobs");
    expect(ui.footer()).toContain("esc to interrupt");
  });
});
