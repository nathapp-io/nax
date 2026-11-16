/**
 * US-007: idle compaction while a job runs.
 *
 * Nothing used to react to idle time: a chat that sat waiting on a long `nax run` reached the
 * token cap only when its own context grew, which on a large window is hours away. The screen
 * now arms one timer per running job and compacts through the existing `/compact` path — same
 * working line, same notices, same turn slot — once the chat has been idle for the configured
 * delay after the later of the turn ending and the job starting.
 *
 * The compactor's own state machine is covered by `test/unit/chat/chat-compaction.test.ts`;
 * this file covers the hook that feeds it and the screen that uses it. Every case drives the
 * real `ChatApp` or the real hook and advances a fake clock, so nothing waits on wall time.
 */
import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import type { CompactResult, SessionEvent, TurnEndStatus } from "@nathapp/nax-agent";
import { assertDefined } from "@test/helpers";
import { Box, Text } from "ink";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import {
  type ChatHost,
  type ChatHostState,
  type ChatJob,
  type ChatJobs,
  type ChatSendOptions,
  createChatAskController,
} from "@/chat";
import { ChatApp } from "@/tui/chat/ChatApp";
import { resolveChatTheme } from "@/tui/chat/theme";
import { useIdleCompact } from "@/tui/chat/use-idle-compact";
import { _jobPanelsDeps } from "@/tui/chat/use-job-panels";

const THEME = resolveChatTheme({ env: {}, colorLevel: 0 });
const RETURN = "\r";
const MODEL = "test-model";
const ACP_MODEL = "acp:codex";
const REPO_ROOT = "/repo";
/** The delay the config's 55-minute default resolves to. */
const DELAY_MS = 3_300_000;
const JOB_ID = "run-12345678";
const REASON = `idle compact: 55m idle while job ${JOB_ID} runs`;
/** The context the finished turn leaves behind in the screen's status. */
const CONTEXT_TOKENS = 50_000;

const COMPACTED: CompactResult = {
  compacted: true,
  tokensBefore: 50_000,
  tokensAfter: 12_100,
  usage: { inputTokens: 900, outputTokens: 120 },
  costUsd: 0.02,
};

const JOB: ChatJob = {
  schemaVersion: 1,
  id: JOB_ID,
  kind: "run",
  target: "f1",
  argv: [],
  cwd: REPO_ROOT,
  pid: 123,
  startedAt: "now",
  state: "running",
  logPath: "/log",
  sessionId: "idle-session",
  approvedAt: "now",
};

/** The view the stubbed panel reader answers with: display only, and never from disk here. */
const PANEL_VIEW = {
  jobId: JOB_ID,
  kind: "run" as const,
  target: "f1",
  state: "running" as const,
  elapsedMs: 0,
  stories: [],
  decisions: [],
  logTail: [],
};

const savedPanels = {
  readJobPanelView: _jobPanelsDeps.readJobPanelView,
  setTimeout: _jobPanelsDeps.setTimeout,
  clearTimeout: _jobPanelsDeps.clearTimeout,
};

beforeEach(() => {
  jest.useFakeTimers();
  // The panel's own refresh cadence is not what this story tests, and it would read the job's
  // artifacts from disk on every tick a 55-minute advance crosses.
  _jobPanelsDeps.readJobPanelView = async () => PANEL_VIEW;
  _jobPanelsDeps.setTimeout = () => 0;
  _jobPanelsDeps.clearTimeout = () => {};
});

afterEach(() => {
  cleanup();
  mock.restore();
  _jobPanelsDeps.readJobPanelView = savedPanels.readJobPanelView;
  _jobPanelsDeps.setTimeout = savedPanels.setTimeout;
  _jobPanelsDeps.clearTimeout = savedPanels.clearTimeout;
  jest.useRealTimers();
});

function stateOf(model: string): ChatHostState {
  return {
    sessionId: "idle-session",
    mode: "guarded",
    model,
    meta: {
      schemaVersion: 1,
      sessionId: "idle-session",
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

/** The job registry as the screen reads it: one running job, no notices, no changes. */
function jobsOf(running: readonly ChatJob[]): ChatJobs {
  return {
    running: () => running,
    list: () => running,
    owned: () => running,
    get: (id) => running.find((job) => job.id === id),
    start: async () => JOB,
    cancel: async () => JOB,
    canCancel: async () => ({ ok: true }),
    attach: async () => {},
    logTail: async () => "",
    dispose: () => {},
    peekNotice: () => undefined,
    takeNotice: () => undefined,
    onChange: () => () => {},
  };
}

/** The screen's calls, in the order they reached the host, and the compaction's outcome. */
function hostOf(input: {
  readonly model?: string;
  readonly compact: () => Promise<CompactResult>;
  readonly onSend?: (message: string, onEvent: (event: SessionEvent) => void) => Promise<void>;
}) {
  const order: string[] = [];
  const state = stateOf(input.model ?? MODEL);
  const compact = mock(async () => {
    order.push("compact");
    return input.compact();
  });
  const send = mock(
    async (message: string, onEvent: (event: SessionEvent) => void, _options?: ChatSendOptions): Promise<void> => {
      order.push(`send:${message}`);
      await input.onSend?.(message, onEvent);
    },
  );
  const host: ChatHost = {
    repoRoot: REPO_ROOT,
    models: [state.model],
    asks: createChatAskController({ mode: "guarded", answer: () => {} }),
    jobs: jobsOf([JOB]),
    current: () => state,
    notice: () => undefined,
    send,
    compact,
    cancel: () => {},
    start: async () => {},
    clear: async () => {},
    resume: async () => {},
    switchTo: async () => {},
    listSessions: async () => [],
    close: async () => {},
  };
  return { host, compact, send, order };
}

/** The microtasks an `await` inside the screen or the hook runs, with no wall-clock wait. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 6; turn++) {
    await Promise.resolve(
      act(async () => {
        await Promise.resolve();
      }),
    );
  }
}

/** Advance the fake clock by `ms` and let what it triggered settle. */
async function advance(ms: number): Promise<void> {
  await flush();
  await Promise.resolve(
    act(async () => {
      jest.advanceTimersByTime(ms);
    }),
  );
  await flush();
}

/* ---------------------------------------------------------------------------------------
 * The hook: what it tells the compactor, on every render.
 * ------------------------------------------------------------------------------------- */

interface HarnessProps {
  readonly host: ChatHost;
  readonly delayMs: number;
  readonly turnRunning: boolean;
  readonly contextTokens?: number;
  readonly order: string[];
}

/** A component that only runs the hook, so a case can see what the hook asked for. */
function IdleHarness({ host, delayMs, turnRunning, contextTokens, order }: HarnessProps) {
  useIdleCompact({
    host,
    delayMs,
    turnRunning,
    ...(contextTokens === undefined ? {} : { contextTokens }),
    compact: async () => {
      order.push("compact");
    },
    note: (text) => {
      order.push(`note:${text}`);
    },
  });
  return (
    <Box>
      <Text>harness</Text>
    </Box>
  );
}

function mountHarness(options: { readonly model?: string; readonly contextTokens?: number; readonly delayMs: number }) {
  const order: string[] = [];
  const { host } = hostOf({ model: options.model, compact: async () => COMPACTED });
  const ui = render(
    <IdleHarness
      host={host}
      delayMs={options.delayMs}
      turnRunning={false}
      {...(options.contextTokens === undefined ? {} : { contextTokens: options.contextTokens })}
      order={order}
    />,
  );
  return { ui, order };
}

describe("useIdleCompact", () => {
  test("AC-13: notes the reason and then compacts, once, after the delay", async () => {
    const { ui, order } = mountHarness({ delayMs: DELAY_MS, contextTokens: CONTEXT_TOKENS });
    await advance(DELAY_MS - 1);
    expect(order).toEqual([]);
    await advance(1);
    expect(order).toEqual([`note:${REASON}`, "compact"]);
    expect(ui.lastFrame()).toContain("harness");
  });

  test("AC-14: does nothing on an ACP model, whose agent owns its context", async () => {
    mountHarness({ model: ACP_MODEL, delayMs: DELAY_MS, contextTokens: CONTEXT_TOKENS });
    await advance(DELAY_MS * 2);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("disposes its timer on unmount", async () => {
    const { ui, order } = mountHarness({ delayMs: DELAY_MS, contextTokens: CONTEXT_TOKENS });
    ui.unmount();
    expect(jest.getTimerCount()).toBe(0);
    await advance(DELAY_MS * 2);
    expect(order).toEqual([]);
  });
});

/* ---------------------------------------------------------------------------------------
 * The screen: the notice, the compaction and the failure path a user sees.
 * ------------------------------------------------------------------------------------- */

/** One `host.send` as it happened, with the listener that turn's events arrive on. */
interface Turn {
  readonly onEvent: (event: SessionEvent) => void;
  end(status: TurnEndStatus): void;
  finish(): Promise<void>;
}

function mountScreen(options: {
  readonly idleCompactAfterMs?: number;
  readonly compact: () => Promise<CompactResult>;
}) {
  const turns: Turn[] = [];
  const gates: Array<ReturnType<typeof Promise.withResolvers<void>>> = [];
  const state = stateOf(MODEL);
  const fake = hostOf({
    compact: options.compact,
    onSend: async (_message, onEvent) => {
      const gate = Promise.withResolvers<void>();
      gates.push(gate);
      turns.push({
        onEvent,
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
        finish: async () => {
          gate.resolve();
          await flush();
        },
      });
      await gate.promise;
    },
  });
  const app = (
    <ChatApp
      host={fake.host}
      theme={THEME}
      {...(options.idleCompactAfterMs === undefined ? {} : { idleCompactAfterMs: options.idleCompactAfterMs })}
    />
  );
  const ui = render(app);
  const frame = (): string => Bun.stripANSI(ui.lastFrame() ?? "");
  const press = (sequence: string): void => {
    act(() => {
      ui.stdin.write(sequence);
    });
  };
  const type = (text: string): void => {
    for (const char of text) press(char);
  };
  /** Run one turn that leaves `contextTokens` behind when it ends. */
  const runTurn = async (): Promise<void> => {
    type("hello");
    await flush();
    press(RETURN);
    await flush();
    const turn = turns.at(-1);
    assertDefined(turn, "the turn the screen is running");
    act(() => {
      turn.onEvent({
        sessionId: state.sessionId,
        turnId: "t1",
        at: "now",
        metadata: {},
        type: "usage",
        round: 1,
        inputTokens: CONTEXT_TOKENS,
        outputTokens: 0,
        costUsd: 0,
      });
    });
    act(() => turn.end("completed"));
    await turn.finish();
    await flush();
  };
  return { ...fake, ui, frame, runTurn };
}

describe("ChatApp idle compaction", () => {
  test("AC-15: shows an idle-compact notice and compacts once after the delay", async () => {
    const ui = mountScreen({ idleCompactAfterMs: DELAY_MS, compact: async () => COMPACTED });
    await ui.runTurn();
    expect(ui.compact).not.toHaveBeenCalled();
    await advance(DELAY_MS);
    expect(ui.frame()).toContain(REASON);
    expect(ui.compact).toHaveBeenCalledTimes(1);
    expect(ui.order).toEqual(["send:hello", "compact"]);
  });

  test("AC-17: a failed compaction shows its error row and is not retried for that job", async () => {
    const ui = mountScreen({
      idleCompactAfterMs: DELAY_MS,
      compact: async () => {
        throw new Error("boom");
      },
    });
    await ui.runTurn();
    await advance(DELAY_MS);
    expect(ui.frame()).toContain("boom");
    // A later idle period for the same job: the compactor already fired for it.
    await advance(DELAY_MS * 2);
    expect(ui.compact).toHaveBeenCalledTimes(1);
  });

  test("AC-18: a screen rendered without the prop never compacts on idle", async () => {
    const ui = mountScreen({ compact: async () => COMPACTED });
    await ui.runTurn();
    await advance(DELAY_MS * 2);
    expect(ui.compact).not.toHaveBeenCalled();
    expect(ui.frame()).not.toContain("idle compact:");
  });
});
