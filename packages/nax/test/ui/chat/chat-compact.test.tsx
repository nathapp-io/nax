/**
 * US-005: `/compact` in the chat screen.
 *
 * Compaction used to happen only on its own, near the context limit. `/compact` sheds a long,
 * finished exploration before the next task: the screen holds the turn slot while it runs, so
 * a line typed meanwhile queues exactly as it does during a turn, and the footer's context
 * reading becomes what the compaction left behind.
 *
 * Everything here drives the real `ChatApp` through stdin and replaces nothing but the host,
 * so what is asserted is what a user would see and what the host was asked to do.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { AgentSession, CompactResult, SessionEvent, SessionMeta, TurnEndStatus } from "@nathapp/nax-agent";
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

const THEME = resolveChatTheme({ env: {}, colorLevel: 0 });
const RETURN = "\r";

const MODEL = "test-model";
const ACP_MODEL = "acp:codex";
const REPO_ROOT = "/repo";
/** The window the footer reads a context percentage from. */
const WINDOW = 100_000;
/** 84_200 of 100_000 is 84%; 12_100 is the 12% the footer must show after the compaction. */
const AFTER_PERCENT = "12% ctx";

/** What the screen says while a compaction runs, and how it reports the two outcomes. */
const COMPACTING = `compacting${THEME.glyphs.ellipsis}`;
const NOTHING_TO_COMPACT = "nothing to compact";
const NOT_AVAILABLE = "compaction is not available in this session";
const BUSY_NOTICE = "wait for the turn to finish (Ctrl-C to interrupt)";
const COMPACTED = "compacted: 84.2k → 12.1k tokens";

/** A compaction that spent its summarizer call. */
const RESULT: CompactResult = {
  compacted: true,
  tokensBefore: 84_200,
  tokensAfter: 12_100,
  usage: { inputTokens: 900, outputTokens: 120 },
  costUsd: 0.02,
};

/** A compaction with nothing to drop: no model call, so no usage and no cost. */
const NOTHING: CompactResult = {
  compacted: false,
  tokensBefore: 1_000,
  tokensAfter: 1_000,
  usage: { inputTokens: 0, outputTokens: 0 },
  costUsd: 0,
};

afterEach(() => {
  cleanup();
  mock.restore();
});

function stateOf(model: string, contextWindow?: number): ChatHostState {
  return {
    sessionId: "compact-session",
    mode: "guarded",
    model,
    meta: {
      schemaVersion: 1,
      sessionId: "compact-session",
      cwd: REPO_ROOT,
      mode: "ask",
      model,
      bashApproval: "gated",
      title: null,
      createdAt: "now",
      updatedAt: null,
      costUsd: 0,
    },
    ...(contextWindow === undefined ? {} : { contextWindow }),
  };
}

/** One `host.send` as it happened, with the listener that turn's events arrive on. */
interface Turn {
  readonly message: string;
  readonly onEvent: (event: SessionEvent) => void;
  /** Settle the send, so the screen's finally block runs. */
  finish(): Promise<void>;
  /** The turn ends with `status` — what the screen watches to decide what to send next. */
  end(status: TurnEndStatus): void;
}

type CompactFn = () => Promise<CompactResult>;

interface ScreenOptions {
  readonly model?: string;
  /** The host's `compact`; `null` builds a host that has none at all. */
  readonly compact?: CompactFn | null;
  readonly contextWindow?: number;
}

/**
 * A host that hands every send and every compaction its own gate, so a case says exactly
 * which turn ends, which compaction settles, and when. `sends` records what the screen asked
 * the host to send, in order.
 */
function chatHost(options: ScreenOptions = {}) {
  const turns: Turn[] = [];
  const sends: string[] = [];
  const state = stateOf(options.model ?? MODEL, options.contextWindow);

  const send = mock(async (message: string, onEvent: (event: SessionEvent) => void, _options?: ChatSendOptions) => {
    sends.push(message);
    const gate = Promise.withResolvers<void>();
    turns.push({
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
    });
    await gate.promise;
  });
  const compactFn = options.compact === null ? null : (options.compact ?? (() => Promise.resolve(RESULT)));
  const compact = compactFn === null ? undefined : mock(compactFn);

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
    ...(compact === undefined ? {} : { compact }),
    cancel: () => {},
    listSessions: async () => [],
    close: async () => {},
  };
  return { host, send, sends, compact, turns };
}

/** The mounted screen, with the frame rows and the verbs a case drives it with. */
function mountScreen(options: ScreenOptions = {}) {
  const fake = chatHost(options);
  const ui = render(<ChatApp host={fake.host} theme={THEME} />);
  /** The frame's rows as the terminal shows them: no escape codes, no trailing blanks. */
  const rows = (): string[] =>
    Bun.stripANSI(ui.lastFrame() ?? "")
      .split("\n")
      .map((row) => row.trimEnd());
  const frame = (): string => rows().join("\n");
  const press = (sequence: string): void => {
    act(() => {
      ui.stdin.write(sequence);
    });
  };
  /** The microtasks a send's or a compaction's `await`s run, with no wall-clock wait. */
  const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 5; turn++) {
      await Promise.resolve(
        act(async () => {
          await Promise.resolve();
        }),
      );
    }
  };
  /** A keypress whose effect lands after an `await` — a slash command, a compaction. */
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

/** The rows that carry the queue's muted marker, in the order they are drawn. */
const queuedRows = (rows: readonly string[]): readonly string[] => rows.filter((row) => row.startsWith("queued · "));

describe("/compact on a native brain", () => {
  test("AC-8 shows compacting… while it runs, then what it left behind", async () => {
    const gate = Promise.withResolvers<CompactResult>();
    const ui = mountScreen({ compact: () => gate.promise });
    await ui.submit("/compact");
    expect(ui.rows()).toContain(`${THEME.glyphs.notice} ${COMPACTING}`);
    gate.resolve(RESULT);
    await ui.settle();
    expect(ui.frame()).toContain(COMPACTED);
  });

  test("AC-9 a compaction with nothing to drop says so", async () => {
    const ui = mountScreen({ compact: () => Promise.resolve(NOTHING) });
    await ui.submit("/compact");
    expect(ui.frame()).toContain(NOTHING_TO_COMPACT);
    expect(ui.frame()).not.toContain("compacted:");
  });

  test("AC-10 the footer's context reading becomes the result's tokensAfter", async () => {
    const ui = mountScreen({ contextWindow: WINDOW });
    await ui.submit("/compact");
    expect(ui.frame()).toContain(AFTER_PERCENT);
  });

  test("AC-16 a rejection is an error row carrying the message", async () => {
    const ui = mountScreen({
      compact: async () => {
        throw new Error("boom");
      },
    });
    await ui.submit("/compact");
    expect(ui.rows().some((row) => row.startsWith(`${THEME.glyphs.error} boom`))).toBe(true);
  });

  test("AC-17 a rejection leaves the session usable: the next message still sends", async () => {
    const ui = mountScreen({
      compact: async () => {
        throw new Error("boom");
      },
    });
    await ui.submit("/compact");
    await ui.submit("after");
    expect(ui.sends).toEqual(["after"]);
  });
});

describe("/compact while a turn runs", () => {
  test("AC-11 shows the busy notice", async () => {
    const ui = mountScreen();
    await ui.submit("hello");
    await ui.submit("/compact");
    expect(ui.frame()).toContain(BUSY_NOTICE);
  });

  test("AC-12 does not compact", async () => {
    const ui = mountScreen();
    await ui.submit("hello");
    await ui.submit("/compact");
    expect(ui.compact).not.toHaveBeenCalled();
  });
});

describe("/compact on an ACP brain", () => {
  test("AC-13 sends the line to the agent as typed", async () => {
    const ui = mountScreen({ model: ACP_MODEL });
    await ui.submit("/compact");
    expect(ui.sends).toEqual(["/compact"]);
  });

  test("AC-14 does not compact the local session", async () => {
    const ui = mountScreen({ model: ACP_MODEL });
    await ui.submit("/compact");
    expect(ui.compact).not.toHaveBeenCalled();
  });
});

describe("/compact with a host that cannot compact", () => {
  test("AC-15 says compaction is not available in this session", async () => {
    const ui = mountScreen({ compact: null });
    await ui.submit("/compact");
    expect(ui.frame()).toContain(NOT_AVAILABLE);
    expect(ui.sends).toEqual([]);
  });
});

describe("/help lists /compact", () => {
  test("AC-18 between /agents and /jobs", async () => {
    const ui = mountScreen();
    await ui.submit("/help");
    const rows = ui.rows();
    const at = (prefix: string): number => rows.findIndex((row) => row.startsWith(prefix));
    const agents = at("/agents ");
    const compact = at("/compact  compact the conversation history");
    const jobs = at("/jobs ");
    expect(agents).toBeGreaterThanOrEqual(0);
    expect(compact).toBeGreaterThan(agents);
    expect(jobs).toBeGreaterThan(compact);
  });
});

describe("a line queued while a compaction runs", () => {
  /** A screen holding a compaction open, with `after` typed and returned meanwhile. */
  async function queuedDuringCompact() {
    const gate = Promise.withResolvers<CompactResult>();
    const ui = mountScreen({ compact: () => gate.promise });
    await ui.submit("/compact");
    await ui.submit("after");
    return { ui, gate };
  }

  test("AC-19 draws queued · after", async () => {
    const { ui } = await queuedDuringCompact();
    expect(queuedRows(ui.rows())).toEqual(["queued · after"]);
  });

  test("AC-20 sends it once the compaction resolves", async () => {
    const { ui, gate } = await queuedDuringCompact();
    gate.resolve(RESULT);
    await ui.settle();
    expect(ui.sends).toEqual(["after"]);
  });
});

/* ---------------------------------------------------------------------------------------
 * AC-7 mounts the real host: the command is only worth having if it reaches the session.
 * ------------------------------------------------------------------------------------- */

describe("/compact over the real host", () => {
  test("AC-7 calls the open session's compact once", async () => {
    const compact = mock(async () => RESULT);
    const session: AgentSession = {
      id: "compact-session",
      backend: { kind: "native", capabilities: {} },
      lastTurn: undefined,
      async *send() {},
      answer: () => "accepted",
      cancel() {},
      close: async () => {},
      compact,
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
    const ui = render(<ChatApp host={host} theme={THEME} />);
    try {
      act(() => {
        ui.stdin.write("/compact");
      });
      await Promise.resolve(
        act(async () => {
          ui.stdin.write(RETURN);
        }),
      );
      expect(compact).toHaveBeenCalledTimes(1);
    } finally {
      await host.close();
    }
  });
});
