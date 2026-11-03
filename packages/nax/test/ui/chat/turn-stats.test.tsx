/**
 * US-007: the decode-speed row a finished turn leaves in the transcript.
 *
 * The screen watches a turn's own live events, so what it reports is what arrived on the
 * stream — never the replayed history of a resumed session, and never a turn that did not
 * finish with output to measure.
 *
 * Everything here drives the real `ChatApp` through its host, so the row asserted is the one
 * a user would see under the reply.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SessionEvent, TurnEndStatus } from "@nathapp/nax-agent";
import chalk from "chalk";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import {
  type ChatHistory,
  type ChatHost,
  type ChatHostState,
  type ChatSendOptions,
  createChatAskController,
} from "@/chat";
import { ChatApp } from "@/tui/chat/ChatApp";
import { resolveChatTheme } from "@/tui/chat/theme";

const THEME = resolveChatTheme({ env: {}, colorLevel: 3 });
/** The SGR that closes a foreground colour, which ink writes after the coloured text. */
const COLOR_OFF = "\u001b[39m";
const MODEL = "test-model";
const REPO_ROOT = "/repo";
const RETURN = "\r";

/** Every case states its window in milliseconds past this instant. */
const BASE = Date.parse("2026-10-26T00:00:00.000Z");

/** What the turn asks the model, and what the model streams back. */
const ASK = "how fast";
const REPLY = "very fast";
/** 241 tokens in 5s is 48.2 tok/s — and 1.3k output over 14.4s is the story's own row. */
const STATS = "48.2 tok/s · 1.3k out · 14s";
/** The same turn with no measurable round: the rate part is left out. */
const STATS_NO_RATE = "1.3k out · 14s";
const OUTPUT_TOKENS = 1_300;

/** The SGR code that opens `hex` as a foreground colour — what ink writes for a theme token. */
function sgr(hex: string | undefined): string {
  const channels = [1, 3, 5].map((at) => Number.parseInt((hex ?? "").slice(at, at + 2), 16));
  return `\u001b[38;2;${channels.join(";")}m`;
}

function at(ms: number): string {
  return new Date(BASE + ms).toISOString();
}

let originalChalkLevel: typeof chalk.level;

beforeEach(() => {
  originalChalkLevel = chalk.level;
  chalk.level = 3;
});

afterEach(() => {
  chalk.level = originalChalkLevel;
  cleanup();
});

function stateOf(): ChatHostState {
  return {
    sessionId: "stats-session",
    mode: "guarded",
    model: MODEL,
    meta: {
      schemaVersion: 1,
      sessionId: "stats-session",
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
}

/** One `host.send` as it happened, with the listener that turn's events arrive on. */
interface Turn {
  /** The turn opens: the screen starts measuring from here. */
  start(ms: number): void;
  /** One round of a reply: a delta at `ms`, and the usage the provider reported for it. */
  round(openMs: number, closeMs: number, tokens: number): void;
  /** The turn ends with `status` and the usage the whole turn reported. */
  end(ms: number, status: TurnEndStatus, outputTokens: number, error?: { code: string; message: string }): void;
  /** Resolve the send, so the screen's own finally block runs. */
  finish(): Promise<void>;
}

interface ScreenOptions {
  readonly history?: ChatHistory;
}

/**
 * A host that hands every send its own turn, so a case says exactly which events arrived
 * and when the turn ended.
 */
function chatHost(options: ScreenOptions = {}) {
  const state = stateOf();
  const turns: Turn[] = [];
  const send = async (message: string, onEvent: (event: SessionEvent) => void, _options?: ChatSendOptions) => {
    const gate = Promise.withResolvers<void>();
    const body = (type: SessionEvent["type"], ms: number, fields: Record<string, unknown>): void => {
      onEvent({
        sessionId: state.sessionId,
        turnId: `t${turns.length}`,
        at: at(ms),
        metadata: {},
        type,
        ...fields,
      } as SessionEvent);
    };
    turns.push({
      start(ms) {
        body("turn_start", ms, {});
      },
      round(openMs, closeMs, tokens) {
        body("text_delta", openMs, { round: 1, text: REPLY });
        body("usage", closeMs, { round: 1, inputTokens: 10, outputTokens: tokens, costUsd: 0.01 });
      },
      end(ms, status, outputTokens, error) {
        body("turn_end", ms, {
          status,
          output: REPLY,
          usage: { inputTokens: 10, outputTokens },
          costUsd: 0.02,
          ...(error === undefined ? {} : { error }),
        });
      },
      async finish() {
        await Promise.resolve(
          act(async () => {
            gate.resolve();
            for (let flush = 0; flush < 5; flush++) await Promise.resolve();
          }),
        );
      },
    });
    await gate.promise;
    expect(message).toBe(ASK);
  };

  const host: ChatHost = {
    repoRoot: REPO_ROOT,
    models: [state.model],
    asks: createChatAskController({ mode: "guarded", answer: () => {} }),
    current: () => state,
    history: () => options.history ?? { messages: [] },
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
  return { host, turns };
}

/** The mounted screen, with the frame rows and the verbs a case drives it with. */
function mountScreen(options: ScreenOptions = {}) {
  const fake = chatHost(options);
  const ui = render(<ChatApp host={fake.host} theme={THEME} />);
  /** The frame's rows as the terminal shows them, escape codes and all. */
  const rawRows = (): string[] => (ui.lastFrame() ?? "").split("\n");
  /** The frame's rows as a reader sees them: no escape codes, no trailing blanks. */
  const rows = (): string[] =>
    Bun.stripANSI(ui.lastFrame() ?? "")
      .split("\n")
      .map((row) => row.trimEnd());
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
  /** A line typed and returned, drained through the screen's own submit path. */
  const submit = async (text: string): Promise<void> => {
    for (const char of text) {
      act(() => {
        ui.stdin.write(char);
      });
    }
    await Promise.resolve(
      act(async () => {
        ui.stdin.write(RETURN);
      }),
    );
    await settle();
  };
  /** Emit the events of the one turn the screen is running, then settle the send. */
  const drive = async (script: (turn: Turn) => void): Promise<void> => {
    await submit(ASK);
    const turn = fake.turns.at(-1);
    if (turn === undefined) throw new Error("the screen sent nothing");
    act(() => script(turn));
    await turn.finish();
    await settle();
  };
  /** The rows that state a decode speed or a measured turn. */
  const statsRows = (): readonly string[] => rows().filter((row) => row.includes(" out · "));
  return { ...fake, ui, rawRows, rows, settle, submit, drive, statsRows };
}

/** A turn that completed with 1.3k output over 14.4s, measured over one 5s round. */
function completedTurn(turn: Turn): void {
  turn.start(0);
  turn.round(0, 5_000, 241);
  turn.end(14_400, "completed", OUTPUT_TOKENS);
}

describe("a completed turn", () => {
  test("AC-9 appends one muted turn-stats row after the reply", async () => {
    const ui = mountScreen();
    await ui.drive(completedTurn);
    expect(ui.statsRows()).toEqual([STATS]);
    // The row is the reply's footnote: it follows the reply it measures.
    const rows = ui.rows();
    const reply = rows.indexOf(`⏺ ${REPLY}`);
    expect(reply).toBeGreaterThanOrEqual(0);
    expect(rows.indexOf(STATS)).toBeGreaterThan(reply);
    // Muted, not the terminal's default colour: the raw row is the theme's muted SGR.
    const drawn = ui.rawRows().find((row) => row.includes(STATS));
    expect(drawn).toBe(`${sgr(THEME.colors.muted)}${STATS}${COLOR_OFF}`);
  });

  test("leaves the rate out when no round measured a window", async () => {
    const ui = mountScreen();
    await ui.drive((turn) => {
      turn.start(0);
      turn.round(0, 0, 241);
      turn.end(14_400, "completed", OUTPUT_TOKENS);
    });
    expect(ui.statsRows()).toEqual([STATS_NO_RATE]);
  });
});

describe("a turn with nothing to measure", () => {
  test("AC-10 leaves no stats row for a cancelled turn", async () => {
    const ui = mountScreen();
    await ui.drive((turn) => {
      turn.start(0);
      turn.round(0, 5_000, 241);
      turn.end(14_400, "cancelled", OUTPUT_TOKENS);
    });
    expect(ui.rows()).toContain("  ⎿  Interrupted by user");
    expect(ui.statsRows()).toEqual([]);
  });

  test("AC-11 leaves no stats row for an errored turn", async () => {
    const ui = mountScreen();
    await ui.drive((turn) => {
      turn.start(0);
      turn.round(0, 5_000, 241);
      turn.end(14_400, "errored", OUTPUT_TOKENS, { code: "PROVIDER_ERROR", message: "boom" });
    });
    expect(ui.rows().some((row) => row.startsWith("✗ "))).toBe(true);
    expect(ui.statsRows()).toEqual([]);
  });

  test("AC-12 leaves no stats row for a completed turn with no output tokens", async () => {
    const ui = mountScreen();
    await ui.drive((turn) => {
      turn.start(0);
      turn.round(0, 5_000, 0);
      turn.end(14_400, "completed", 0);
    });
    // The turn did complete and did produce its reply: only the measurement is withheld.
    expect(ui.rows()).toContain(`⏺ ${REPLY}`);
    expect(ui.statsRows()).toEqual([]);
  });
});

describe("a second turn", () => {
  test("measures only its own events, not the turn before it", async () => {
    const ui = mountScreen();
    await ui.drive(completedTurn);
    await ui.drive((turn) => {
      turn.start(0);
      turn.round(0, 2_000, 100);
      turn.end(5_000, "completed", 500);
    });
    // Concatenating the two turns' rounds would read 48.7 tok/s; each turn's own is 50.0.
    expect(ui.statsRows()).toEqual([STATS, "50.0 tok/s · 500 out · 5s"]);
  });
});

describe("a resumed session", () => {
  test("AC-13 replays its history without any stats row", async () => {
    const ui = mountScreen({
      history: {
        messages: [
          { role: "user", content: "earlier question" },
          { role: "assistant", content: "earlier answer" },
        ],
      },
    });
    expect(ui.rows()).toContain(`⏺ earlier answer`);
    expect(ui.rows().some((row) => row.includes("tok/s"))).toBe(false);
    expect(ui.statsRows()).toEqual([]);
  });
});
