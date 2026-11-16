/**
 * A destructive esc asks twice.
 *
 * The hook's own answers (AC-1..AC-5), the words the armed hints use (AC-6..AC-9), and the
 * screen's behaviour through the mounted `ChatApp` (AC-10..AC-22): one escape only offers the
 * stop, a second one inside the window takes it, and every layer that is not the turn or a
 * stopping question keeps its single escape.
 *
 * Nothing here sleeps. The window is read through `_chatKeyDeps.now` and its expiry is armed
 * through `_escConfirmDeps`, so a case moves the clock and runs the recorded callback itself.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { SessionEvent, SessionEventBody, TurnEndStatus } from "@nathapp/nax-agent";
import { assertDefined, mountChatPicker as mount } from "@test/helpers";
import { cleanup, render } from "ink-testing-library";
import { act, type ReactElement, useState } from "react";
import type { ChatHost } from "@/chat";
import { _escConfirmDeps, ESC_CONFIRM_MS, type EscConfirm, useEscConfirm } from "@/tui/chat/esc-confirm";
import { type EscLayer, escHintText } from "@/tui/chat/esc-layer";
import { _chatKeyDeps } from "@/tui/chat/useChatKeys";

/** The sequence a terminal sends for a lone esc, and the one ctrl-c sends. */
const ESCAPE = "\x1b";
const CTRL_C = "\x03";
/** The microtask rounds a drained queue needs to reach the next send's own body. */
const FLUSHES = 6;
/** The session the mounted fake host reports, and the id its own turn's events carry. */
const SESSION = "picker-session";
/** A question the chat session itself asked: closing it also stops the turn. */
const SESSION_QUESTION: SessionEventBody = {
  type: "question",
  requestId: "q1",
  text: "Proceed?",
  expiresAt: "later",
};
/** A tool approval, which esc denies on one press as it always has. */
const APPROVAL: SessionEventBody = {
  type: "approval_requested",
  requestId: "ask-1",
  tool: "Bash",
  command: "npm test",
  reason: "Run the tests",
  summary: "test",
  expiresAt: "later",
};

/** The deps as shipped, restored after every case so one case's stubs never leak. */
const REAL_NOW = _chatKeyDeps.now;
const REAL_ESC_DEPS = { ..._escConfirmDeps };

/** The clock `_chatKeyDeps.now` reports: only a case moves it. */
let nowMs = 0;
/** The armed windows the screen opened, drivable by hand instead of by waiting. */
let timers: RecordedTimers;

/** A timer seam the case drives itself: what was armed, and how to run it. */
interface RecordedTimers {
  /** Run every armed callback, as the window passing would. */
  run(): void;
  /** How many windows are still armed. */
  pending(): number;
}

function recordingTimers(): RecordedTimers {
  const armed = new Map<number, () => void>();
  let nextId = 0;
  _escConfirmDeps.setTimeout = (callback: () => void): ReturnType<typeof _escConfirmDeps.setTimeout> => {
    nextId += 1;
    armed.set(nextId, callback);
    return nextId;
  };
  _escConfirmDeps.clearTimeout = (handle: ReturnType<typeof _escConfirmDeps.setTimeout>): void => {
    armed.delete(Number(handle));
  };
  return {
    run: () => {
      const callbacks = [...armed.values()];
      armed.clear();
      act(() => {
        for (const callback of callbacks) callback();
      });
    },
    pending: () => armed.size,
  };
}

beforeEach(() => {
  nowMs = 0;
  _chatKeyDeps.now = () => nowMs;
  timers = recordingTimers();
});

afterEach(() => {
  cleanup();
  _chatKeyDeps.now = REAL_NOW;
  Object.assign(_escConfirmDeps, REAL_ESC_DEPS);
  mock.restore();
});

/** The hook mounted on a `turn` layer with a turn running, and its answers as they stand now. */
function confirmHarness(): {
  press(): boolean;
  armed(): boolean;
} {
  let latest: EscConfirm = { armed: false, press: () => false, reset: () => {} };
  function Root(): ReactElement {
    latest = useEscConfirm({ kind: "turn" }, true);
    return <></>;
  }
  render(<Root />);
  return {
    press: () => {
      let confirmed = false;
      act(() => {
        confirmed = latest.press();
      });
      return confirmed;
    },
    armed: () => latest.armed,
  };
}

describe("useEscConfirm", () => {
  test("AC-1 press() once returns false", () => {
    expect(confirmHarness().press()).toBe(false);
  });

  test("AC-2 after one press() the hook is armed", () => {
    const confirm = confirmHarness();
    confirm.press();
    expect(confirm.armed()).toBe(true);
  });

  test("AC-3 a second press 1,999 ms later confirms", () => {
    const confirm = confirmHarness();
    confirm.press();
    nowMs = 1_999;
    expect(confirm.press()).toBe(true);
  });

  test("AC-4 a press 2,000 ms later does not confirm, and neither does one after the window", () => {
    const boundary = confirmHarness();
    boundary.press();
    nowMs = ESC_CONFIRM_MS;
    expect(boundary.press()).toBe(false);

    nowMs = 0;
    const late = confirmHarness();
    late.press();
    nowMs = ESC_CONFIRM_MS + 1;
    expect(late.press()).toBe(false);
  });

  test("AC-5 a press 2,000 ms after the first leaves the hook armed", () => {
    const confirm = confirmHarness();
    confirm.press();
    nowMs = ESC_CONFIRM_MS;
    confirm.press();
    expect(confirm.armed()).toBe(true);
  });

  test("the window's expiry disarms the hook", () => {
    const confirm = confirmHarness();
    confirm.press();
    expect(timers.pending()).toBe(1);
    timers.run();
    expect(confirm.armed()).toBe(false);
    expect(timers.pending()).toBe(0);
  });

  test("the press that confirms clears the arm and its window", () => {
    const confirm = confirmHarness();
    confirm.press();
    expect(confirm.press()).toBe(true);
    expect(confirm.armed()).toBe(false);
    expect(timers.pending()).toBe(0);
  });

  test("a new turn of the same layer does not inherit the last turn's arm", () => {
    const setters: { running?: (value: boolean) => void } = {};
    let latest: EscConfirm = { armed: false, press: () => false, reset: () => {} };
    function Root(): ReactElement {
      const [running, setRunning] = useState(true);
      setters.running = setRunning;
      latest = useEscConfirm({ kind: "turn" }, running);
      return <></>;
    }
    render(<Root />);
    act(() => {
      latest.press();
    });
    expect(latest.armed).toBe(true);
    act(() => {
      setters.running?.(false);
    });
    expect(latest.armed).toBe(false);
    act(() => {
      setters.running?.(true);
    });
    nowMs = 10;
    act(() => {
      latest.press();
    });
    expect(latest.armed).toBe(true);
  });

  test("the arm does not carry to a different esc layer", () => {
    const setters: { layer?: (next: EscLayer) => void } = {};
    let latest: EscConfirm = { armed: false, press: () => false, reset: () => {} };
    function Root(): ReactElement {
      const [layer, setLayer] = useState<EscLayer>({ kind: "turn" });
      setters.layer = setLayer;
      latest = useEscConfirm(layer, true);
      return <></>;
    }
    render(<Root />);
    act(() => {
      latest.press();
    });
    expect(latest.armed).toBe(true);
    act(() => {
      setters.layer?.({ kind: "question", stops: true });
    });
    expect(latest.armed).toBe(false);
  });
});

describe("escHintText with an armed esc", () => {
  test("AC-6 an armed turn offers the second escape", () => {
    expect(escHintText({ kind: "turn" }, true)).toBe("esc again to interrupt");
  });

  test("AC-7 an armed stopping question offers the second escape", () => {
    expect(escHintText({ kind: "question", stops: true }, true)).toBe("esc again to close and stop");
  });

  test("AC-8 an unarmed stopping question keeps its single escape", () => {
    expect(escHintText({ kind: "question", stops: true }, false)).toBe("esc to close and stop");
  });

  test("AC-9 an unarmed turn has no hint of its own", () => {
    expect(escHintText({ kind: "turn" }, false)).toBeUndefined();
  });

  test("an arm changes no other layer's hint", () => {
    expect(escHintText({ kind: "question", stops: false }, true)).toBe("esc to close");
    expect(escHintText({ kind: "approval" }, true)).toBe("esc to deny");
    expect(escHintText({ kind: "choice" }, true)).toBe("esc to cancel");
    expect(escHintText({ kind: "picker", picker: "jobs" }, true)).toBe("esc to close jobs");
    expect(escHintText({ kind: "menu" }, true)).toBe("esc to close menu");
    expect(escHintText({ kind: "none" }, true)).toBeUndefined();
  });
});

/**
 * The mounted screen, the esc effects in the order they ran, and its own frame readers. The
 * host is the shared `mountChatPicker` fake; its `declineQuestion` is spied rather than
 * replaced, so the card really settles, and `host.cancel` is a mock written here so the two
 * effects' order is the order the screen made them in.
 */
function screen(options: { send?: ChatHost["send"] } = {}) {
  const ui = mount(options.send === undefined ? {} : { send: options.send });
  const order: string[] = [];
  const decline = ui.host.asks.declineQuestion.bind(ui.host.asks);
  spyOn(ui.host.asks, "declineQuestion").mockImplementation((requestId: string) => {
    order.push(`decline:${requestId}`);
    decline(requestId);
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
  const footer = (): string => ui.rows().at(-1) ?? "";
  /** Two escapes in one input batch: no render between them, as a terminal can deliver them. */
  const escapeTwice = (): void => {
    act(() => {
      ui.ui.stdin.write(ESCAPE);
      ui.ui.stdin.write(ESCAPE);
    });
  };
  return {
    ...ui,
    order,
    raise,
    askHost,
    footer,
    escapeTwice,
    cancels: () => order.filter((entry) => entry === "cancel").length,
  };
}

/** A running turn: the fake's own send stays open until `finish()`. */
async function runningTurn() {
  const ui = screen();
  await ui.submit("work");
  return ui;
}

describe("esc on a running turn", () => {
  test("AC-10 one escape does not cancel", async () => {
    const ui = await runningTurn();
    ui.press(ESCAPE);
    expect(ui.cancels()).toBe(0);
  });

  test("AC-11 one escape makes the footer offer the second one", async () => {
    const ui = await runningTurn();
    ui.press(ESCAPE);
    expect(ui.footer()).toContain("esc again to interrupt");
  });

  test("AC-12 two escapes in one batch cancel exactly once", async () => {
    const ui = await runningTurn();
    ui.escapeTwice();
    expect(ui.cancels()).toBe(1);
  });

  test("AC-13 two escapes 2,000 ms apart cancel nothing", async () => {
    const ui = await runningTurn();
    ui.press(ESCAPE);
    nowMs = ESC_CONFIRM_MS;
    ui.press(ESCAPE);
    expect(ui.cancels()).toBe(0);
  });

  test("AC-20 one ctrl+c still cancels on its first press", async () => {
    const ui = await runningTurn();
    ui.press(CTRL_C);
    expect(ui.cancels()).toBe(1);
  });

  test("AC-21 the armed window's expiry returns the footer to esc to interrupt", async () => {
    const ui = await runningTurn();
    ui.press(ESCAPE);
    expect(ui.footer()).toContain("esc again to interrupt");
    timers.run();
    expect(ui.footer()).toContain("esc to interrupt");
    expect(ui.footer()).not.toContain("esc again");
  });
});

describe("esc on a question the session asked during a turn", () => {
  /** A running turn with the session's own question card over it. */
  async function askedTurn() {
    const ui = await runningTurn();
    ui.raise(SESSION_QUESTION);
    expect(ui.rows().join("\n")).toContain("Proceed?");
    return ui;
  }

  test("AC-14 one escape neither declines the question nor cancels", async () => {
    const ui = await askedTurn();
    ui.press(ESCAPE);
    expect(ui.order).toEqual([]);
    expect(ui.host.asks.pending()).toHaveLength(1);
  });

  test("AC-15 one escape makes the footer offer esc again to close and stop", async () => {
    const ui = await askedTurn();
    ui.press(ESCAPE);
    expect(ui.footer()).toContain("esc again to close and stop");
  });

  test("AC-16 a second escape inside the window declines and then cancels", async () => {
    const ui = await askedTurn();
    ui.press(ESCAPE);
    ui.press(ESCAPE);
    expect(ui.order).toEqual(["decline:q1", "cancel"]);
    expect(ui.rows().join("\n")).not.toContain("Proceed?");
  });
});

describe("esc on a layer that keeps its single press", () => {
  test("AC-17 an approval card is denied by one escape", () => {
    const ui = screen();
    ui.raise(APPROVAL);
    const resolve = spyOn(ui.host.asks, "resolve");
    ui.press(ESCAPE);
    expect(resolve).toHaveBeenCalledWith("ask-1", "deny");
  });

  test("AC-18 a question the host asked during a turn is declined by one escape", async () => {
    const ui = await runningTurn();
    const requestId = ui.askHost("Use that feature?");
    ui.press(ESCAPE);
    expect(ui.order).toEqual([`decline:${requestId}`]);
    expect(ui.host.asks.pending()).toHaveLength(0);
  });

  test("AC-19 that host question's escape does not stop the turn", async () => {
    const ui = await runningTurn();
    ui.askHost("Use that feature?");
    ui.press(ESCAPE);
    expect(ui.cancels()).toBe(0);
  });
});

describe("an armed turn that has ended", () => {
  /** A screen whose every send opens its own gate, so a turn ends only when the case says so. */
  function scriptedScreen() {
    const gates: ReturnType<typeof Promise.withResolvers<void>>[] = [];
    const send: ChatHost["send"] = async () => {
      const gate = Promise.withResolvers<void>();
      gates.push(gate);
      await gate.promise;
    };
    const ui = screen({ send });
    /** End the turn the last send opened. */
    const endTurn = (): Promise<void> =>
      Promise.resolve(
        act(async () => {
          gates.at(-1)?.resolve();
        }),
      );
    return { ...ui, endTurn };
  }

  test("AC-22 a new turn within the window does not inherit the arm", async () => {
    const ui = scriptedScreen();
    await ui.submit("work");
    ui.press(ESCAPE);
    expect(ui.footer()).toContain("esc again to interrupt");
    await ui.endTurn();
    nowMs = 10;
    await ui.submit("again");
    ui.press(ESCAPE);
    expect(ui.cancels()).toBe(0);
    expect(ui.footer()).toContain("esc again to interrupt");
  });
});

/** A turn's own end event: what the screen reads to decide what the queue does next. */
function turnEnd(status: TurnEndStatus): SessionEventBody {
  return { type: "turn_end", status, output: "", usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0 };
}

describe("a queued line that starts the next turn", () => {
  /**
   * A screen whose every send opens its own gate and keeps its own listener, so a case can end
   * one turn — with a `turn_end` the queue reads — and watch the line it drained start the next.
   */
  function queuedScreen() {
    const gates: ReturnType<typeof Promise.withResolvers<void>>[] = [];
    const listeners: ((event: SessionEvent) => void)[] = [];
    const send: ChatHost["send"] = async (_message, listener) => {
      listeners.push(listener);
      const gate = Promise.withResolvers<void>();
      gates.push(gate);
      await gate.promise;
    };
    const ui = screen({ send: mock(send) });
    /** End the turn the send at `index` opened, then let the drain and the next send settle. */
    const endAndDrain = async (index: number): Promise<void> => {
      const listener = listeners[index];
      assertDefined(listener, `the listener of send ${index}`);
      act(() => {
        listener({ sessionId: SESSION, turnId: `t${index}`, at: "now", metadata: {}, ...turnEnd("completed") });
      });
      await Promise.resolve(
        act(async () => {
          gates[index]?.resolve();
        }),
      );
      // The drain submits the queued line from the turn's own `finally`; a few rounds of
      // microtasks carry it to the next send's body without waiting on anything.
      for (let round = 0; round < FLUSHES; round += 1) {
        await Promise.resolve(
          act(async () => {
            await Promise.resolve();
          }),
        );
      }
    };
    return { ...ui, endAndDrain };
  }

  test("B2 the turn a drained queued line starts does not inherit the last turn's arm", async () => {
    const ui = queuedScreen();
    await ui.submit("work");
    await ui.submit("queued next");
    ui.press(ESCAPE);
    expect(ui.footer()).toContain("esc again to interrupt");
    await ui.endAndDrain(0);
    // The queued line is the second send: nothing drew an idle frame between the two turns.
    expect(ui.host.send).toHaveBeenCalledTimes(2);
    expect(ui.footer()).not.toContain("esc again");
    ui.press(ESCAPE);
    expect(ui.cancels()).toBe(0);
    expect(ui.footer()).toContain("esc again to interrupt");
    ui.press(ESCAPE);
    expect(ui.cancels()).toBe(1);
  });
});

describe("a stopping question replaced by another", () => {
  test("B3 the replacement question does not inherit the arm of the question it replaced", async () => {
    const ui = await runningTurn();
    ui.raise(SESSION_QUESTION);
    ui.raise({ ...SESSION_QUESTION, requestId: "q2", text: "Also proceed?" });
    ui.press(ESCAPE);
    expect(ui.footer()).toContain("esc again to close and stop");
    // q1 is answered elsewhere, so q2 is the card the next escape would act on.
    act(() => {
      ui.host.asks.answerQuestion("q1", "yes");
    });
    expect(ui.rows().join("\n")).toContain("Also proceed?");
    ui.press(ESCAPE);
    expect(ui.order).toEqual([]);
    expect(ui.host.asks.pending()).toHaveLength(1);
    expect(ui.footer()).toContain("esc again to close and stop");
    ui.press(ESCAPE);
    expect(ui.order).toEqual(["decline:q2", "cancel"]);
  });
});
