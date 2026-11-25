/**
 * US-005: ctrl+s sends the oldest queued message now.
 *
 * A line typed during a turn waits in the queue, drawn as a muted `queued · <text>` row, and
 * nothing could send one before the turn ended. ctrl+s on an empty prompt now takes the oldest
 * queued line off the queue and hands it to the running turn exactly as a typed line is handed
 * over: steered where the turn is when the brain accepts a steer, and otherwise interrupt-and-
 * send. The typed draft keeps its priority, a slash line is untouched, and a line already
 * waiting to interrupt the turn leaves the queue where it is — it drains behind that send.
 *
 * The host is the shared `mountChatPicker` fake, so every screen action is a mock a case can
 * count; `steer` and `cancel` are written here because the queued gesture is what the cases are
 * about. Each case drives the real screen through stdin, so what is asserted is what a user
 * would see and what the host was actually asked to do.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { SessionEventBody, SteerResult, TurnEndStatus } from "@nathapp/nax-agent";
import { mountChatPicker as mount } from "@test/helpers";
import { cleanup } from "ink-testing-library";

/** ink reports ctrl+s as the letter `s` with the ctrl modifier. */
const CTRL_S = "\x13";
/** The marker the screen draws in front of a queued message. */
const QUEUED = "queued · ";
/** The marker the screen draws in front of a steer the turn has not taken yet. */
const STEERING = "steering · ";
/** The gesture the footer offers while a line waits in the queue. */
const QUEUED_GESTURE = "up to edit queued · ctrl+s to send now";
/** The microtask rounds a settle needs to reach the end of a send's `finally`. */
const FLUSHES = 6;

afterEach(() => {
  cleanup();
  mock.restore();
});

/** The rows that carry the queue's muted marker, in the order they are drawn. */
const queuedRows = (rows: readonly string[]): readonly string[] => rows.filter((row) => row.startsWith(QUEUED));

/** The rows that carry the steering marker, in the order they are drawn. */
const steeringRows = (rows: readonly string[]): readonly string[] => rows.filter((row) => row.startsWith(STEERING));

/** A turn's own end event: what the screen watches to decide what to send next. */
function turnEnd(status: TurnEndStatus): SessionEventBody {
  return {
    type: "turn_end",
    status,
    output: "",
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsd: 0,
  };
}

interface ScreenOptions {
  /** The host's `steer`; absent builds a host with no `steer` method at all. */
  readonly steer?: (text: string) => SteerResult;
}

/**
 * The mounted screen over the shared fake host, with `steer` and `cancel` mocks written here so
 * a case can count the calls the queued gesture made, and the verbs it drives the screen with.
 */
function screen(options: ScreenOptions = {}) {
  const ui = mount();
  if (options.steer !== undefined) {
    const answer = options.steer;
    ui.host.steer = mock((text: string) => answer(text));
  }
  ui.host.cancel = mock(() => {});
  /** A line typed into the prompt without submitting it. */
  const type = (text: string): void => {
    for (const char of text) ui.press(char);
  };
  /** The frame's rows as the terminal shows them, refreshed for this read. */
  const rows = (): string[] => ui.rows();
  /** The footer's own row: the last one on the frame. */
  const footerRow = (): string => rows().at(-1) ?? "";
  /** Let the microtasks a send's `finally` runs settle, so the drain has finished. */
  const flush = async (): Promise<void> => {
    for (let round = 0; round < FLUSHES; round++) await ui.settle();
  };
  /** End the running turn with `status`, then let its send settle and the drain that follows. */
  const endTurn = async (status: TurnEndStatus = "cancelled"): Promise<void> => {
    ui.emit(turnEnd(status));
    await ui.finish();
    await flush();
  };
  /** ctrl+s, in its own act: the key does its work synchronously. */
  const steerNow = (): void => ui.press(CTRL_S);
  return { ...ui, rows, footerRow, type, flush, endTurn, steerNow };
}

/** A brain that accepts a steer and holds its `applied` promise for the case to settle. */
function accepting() {
  const applied = Promise.withResolvers<boolean>();
  return {
    applied,
    steer: (text: string): SteerResult => ({ status: "accepted", steerId: `steer-${text}`, applied: applied.promise }),
  };
}

describe("ctrl+s on an empty prompt with a queued line", () => {
  test("AC-1 steers the oldest queued line", async () => {
    const ui = screen({ steer: accepting().steer });
    await ui.submit("hello");
    await ui.submit("next please");
    ui.steerNow();
    expect(ui.host.steer).toHaveBeenCalledTimes(1);
    expect(ui.host.steer).toHaveBeenCalledWith("next please");
  });

  test("AC-2 draws the line as a steer, not as a queued row", async () => {
    const ui = screen({ steer: accepting().steer });
    await ui.submit("hello");
    await ui.submit("next please");
    ui.steerNow();
    const rows = ui.rows();
    expect(queuedRows(rows)).toEqual([]);
    expect(steeringRows(rows)).toEqual([`${STEERING}next please`]);
  });

  test("AC-3 takes the oldest of two queued lines", async () => {
    const ui = screen({ steer: accepting().steer });
    await ui.submit("hello");
    await ui.submit("one");
    await ui.submit("two");
    ui.steerNow();
    expect(ui.host.steer).toHaveBeenCalledTimes(1);
    expect(ui.host.steer).toHaveBeenCalledWith("one");
  });

  test("AC-4 leaves the line behind it queued", async () => {
    const ui = screen({ steer: accepting().steer });
    await ui.submit("hello");
    await ui.submit("one");
    await ui.submit("two");
    ui.steerNow();
    expect(queuedRows(ui.rows())).toEqual([`${QUEUED}two`]);
  });

  test("AC-18 a prompt holding only spaces still sends the queued line", async () => {
    const ui = screen({ steer: accepting().steer });
    await ui.submit("hello");
    await ui.submit("next please");
    ui.type("   ");
    ui.steerNow();
    expect(ui.host.steer).toHaveBeenCalledWith("next please");
  });

  test("a steer that throws leaves the queued line queued", async () => {
    const ui = screen({
      steer: () => {
        throw new Error("session is closed");
      },
    });
    await ui.submit("hello");
    await ui.submit("next please");
    ui.steerNow();
    expect(queuedRows(ui.rows())).toEqual([`${QUEUED}next please`]);
  });

  test("AC-14 offers up to edit queued and ctrl+s to send now on the footer row", async () => {
    const ui = screen({ steer: accepting().steer });
    await ui.submit("hello");
    await ui.submit("next please");
    expect(ui.footerRow()).toContain(QUEUED_GESTURE);
  });
});

describe("ctrl+s on a brain that cannot steer, with a queued line", () => {
  /** A host whose brain answers every steer with `unsupported`. */
  const unsupported = (): SteerResult => ({ status: "unsupported" });

  test("AC-5 interrupts the running turn once", async () => {
    const ui = screen({ steer: unsupported });
    await ui.submit("hello");
    await ui.submit("next please");
    ui.steerNow();
    expect(ui.host.cancel).toHaveBeenCalledTimes(1);
  });

  test("AC-6 sends the queued line once that turn settles", async () => {
    const ui = screen({ steer: unsupported });
    await ui.submit("hello");
    await ui.submit("next please");
    ui.steerNow();
    await ui.endTurn("cancelled");
    expect(ui.host.send).toHaveBeenCalledTimes(2);
    expect(ui.host.send).toHaveBeenNthCalledWith(2, "next please", expect.any(Function));
  });
});

describe("ctrl+s with a typed draft and a queued line", () => {
  test("AC-7 steers the typed draft", async () => {
    const ui = screen({ steer: accepting().steer });
    await ui.submit("hello");
    await ui.submit("queued line");
    ui.type("draft");
    ui.steerNow();
    expect(ui.host.steer).toHaveBeenCalledTimes(1);
    expect(ui.host.steer).toHaveBeenCalledWith("draft");
  });

  test("AC-8 leaves the queued line queued", async () => {
    const ui = screen({ steer: accepting().steer });
    await ui.submit("hello");
    await ui.submit("queued line");
    ui.type("draft");
    ui.steerNow();
    expect(queuedRows(ui.rows())).toEqual([`${QUEUED}queued line`]);
  });

  test("AC-15 the footer keeps the typed draft's own hint", async () => {
    const ui = screen({ steer: accepting().steer });
    await ui.submit("hello");
    await ui.submit("queued line");
    ui.type("draft");
    expect(ui.footerRow()).not.toContain(QUEUED_GESTURE);
  });
});

describe("ctrl+s with nothing waiting", () => {
  test("AC-9 calls neither steer nor cancel, as before", async () => {
    const ui = screen({ steer: accepting().steer });
    await ui.submit("hello");
    ui.steerNow();
    expect(ui.host.steer).not.toHaveBeenCalled();
    expect(ui.host.cancel).not.toHaveBeenCalled();
    expect(ui.host.send).toHaveBeenCalledTimes(1);
  });
});

describe("ctrl+s with an interrupt send already pending", () => {
  /**
   * A screen whose brain cannot steer, told by a first ctrl+s on the typed line `first`, and
   * with `a` then `b` queued behind that pending send.
   */
  async function pendingInterrupt() {
    const ui = screen({ steer: () => ({ status: "unsupported" }) });
    await ui.submit("hello");
    ui.type("first");
    ui.steerNow();
    await ui.submit("a");
    await ui.submit("b");
    return ui;
  }

  test("AC-16 a second ctrl+s makes no further steer or cancel call", async () => {
    const ui = await pendingInterrupt();
    expect(ui.host.steer).toHaveBeenCalledTimes(1);
    expect(ui.host.cancel).toHaveBeenCalledTimes(1);
    ui.steerNow();
    expect(ui.host.steer).toHaveBeenCalledTimes(1);
    expect(ui.host.cancel).toHaveBeenCalledTimes(1);
  });

  test("AC-17 the queued rows are untouched", async () => {
    const ui = await pendingInterrupt();
    ui.steerNow();
    expect(queuedRows(ui.rows())).toEqual([`${QUEUED}a`, `${QUEUED}b`]);
  });
});
