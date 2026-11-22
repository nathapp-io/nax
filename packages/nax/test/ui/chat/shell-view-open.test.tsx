/**
 * Opening the live shell view from the chat (chat-live-shell-output US-008): a strip click on a
 * lone running shell and Enter on a shell row of the jobs picker both open `ShellView` over the
 * hidden chat, on a host that reports shell output. Escape and ctrl+c hand the screen back with
 * the draft exactly where it was; an ask card closes the view. A host without shell output, and
 * a job row, keep the one-shot output listing they have always drawn.
 *
 * Every case mounts the real `ChatApp` through `mountChatPicker` — the gestures are a real mouse
 * report and a real keypress, not a call to a hook — over a `ChatBackgroundTasks` fake and a
 * `ChatShellOutput` fake sharing one running `bash-00000001` with the command `npm test`, unless
 * the case says otherwise. `ShellView`'s timers run on a fake clock, so nothing real is armed.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { SessionEvent, SessionEventBody } from "@nathapp/nax-agent";
import { makeFakeClock, mountChatPicker } from "@test/helpers";
import { cleanup } from "ink-testing-library";
import { act } from "react";
import type { BackgroundAgentRun, BackgroundTask, ChatBackgroundTasks, ChatShellOutput } from "@/chat/background";
import type { ChatJobs } from "@/chat/jobs/job-runner";
import type { ChatJob } from "@/chat/jobs/job-types";
import { _shellViewDeps } from "@/tui/chat/ShellView";
import { fakeMouse } from "./mouse";

const ESC = "\x1b";
const CTRL_C = "\x03";
const CTRL_G = "\x07";
const RETURN = "\r";
/** The lone running shell every case mounts unless it says otherwise. */
const ID = "bash-00000001";
const COMMAND = "npm test";
/** The tail `bash-00000001` reports. */
const TAIL: readonly string[] = ["compiling", "2 tests passed"];
/** The strip the footer draws for one running shell, whose first column the click lands on. */
const STRIP = "1 shell";
/** The jobs picker's title: what says the picker opened instead of a view. */
const PICKER_TITLE = "Jobs and tasks · enter output · ctrl+x stop";
/** The hint the open view's footer carries while the shell runs. */
const VIEW_HINT = "esc to return";
/** The chat input's own prefix: the row the open view must not draw. */
const INPUT_PREFIX = "> ";
const FLUSHES = 6;

const savedDeps = { ..._shellViewDeps };
afterEach(() => {
  cleanup();
  Object.assign(_shellViewDeps, savedDeps);
});

/** A background shell as the registry records it; running unless a case patches it. */
function shellTask(patch: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: ID,
    command: COMMAND,
    origin: "agent",
    startedAt: new Date().toISOString(),
    state: "running",
    logPath: `/logs/${ID}.log`,
    ...patch,
  };
}

/** A background subagent, the control case's lone task. */
function agentTask(patch: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    ...shellTask(),
    id: "agent-1a2b3c4d",
    kind: "agent",
    command: "reviewer: Review the spec",
    ...patch,
  };
}

function job(patch: Partial<ChatJob> = {}): ChatJob {
  return {
    schemaVersion: 1,
    id: "run-1a2b3c4d",
    kind: "run",
    target: "feat",
    argv: [],
    cwd: "/repo",
    pid: 1,
    startedAt: new Date().toISOString(),
    state: "running",
    logPath: "/log",
    sessionId: "shell-view-open",
    approvedAt: new Date().toISOString(),
    ...patch,
  };
}

interface TasksHarness {
  readonly port: ChatBackgroundTasks;
  /** The rows the registry lists, live: a case mutates one and calls `change`. */
  readonly rows: BackgroundTask[];
  /** The shell output listing's text, as the registries report it. */
  readonly output: ReturnType<typeof mock>;
  /** A registry change, as a task ending fires it. */
  change(): void;
}

/** A `ChatBackgroundTasks` fake: the rows it lists, one output read, and a change listener set. */
function tasksHarness(rows: BackgroundTask[], run?: BackgroundAgentRun): TasksHarness {
  const listeners = new Set<() => void>();
  const output = mock(async (_id: string, _lines?: number) => "shell output");
  const port: ChatBackgroundTasks = {
    adopt: () => {
      throw new Error("unused");
    },
    adoptAgent: () => {
      throw new Error("unused");
    },
    foreground: () => () => {},
    stop: mock((id: string) => rows.find((row) => row.id === id) ?? shellTask({ id })),
    stopAll: async () => {},
    moveForeground: () => false,
    agentRun: (id) => (id === run?.id ? { ...run } : undefined),
    onAgentEvents: () => () => {},
    hasForeground: () => false,
    peekNotice: () => undefined,
    releaseNotice: () => {},
    takeNotice: () => undefined,
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    list: () => rows,
    get: (id) => rows.find((row) => row.id === id),
    running: () => rows.filter((row) => row.state === "running"),
    output,
  };
  return {
    port,
    rows,
    output,
    change: () => {
      for (const listener of [...listeners]) listener();
    },
  };
}

interface ShellsHarness {
  readonly port: ChatShellOutput;
  /** Give task `id` the tail `lines`, as an append to a running shell would. */
  setTail(id: string, lines: readonly string[]): void;
  /** Notify every listener about `id`, as the registry does on one append. */
  notify(id: string): void;
}

/** A `ChatShellOutput` fake: one tail per task id, and the listeners a case notifies. */
function shellsHarness(): ShellsHarness {
  const tails = new Map<string, readonly string[]>([[ID, TAIL]]);
  const listeners = new Set<(id: string) => void>();
  return {
    port: {
      taskTail: (id) => {
        const lines = tails.get(id);
        return lines === undefined ? undefined : { lines, truncated: false };
      },
      foregroundTail: () => undefined,
      onShellOutput: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    setTail: (id, lines) => {
      tails.set(id, lines);
    },
    notify: (id) => {
      for (const listener of [...listeners]) listener(id);
    },
  };
}

/** A `ChatJobs` fake: the rows it lists and the log tail its output listing reads. */
function jobsFake(rows: readonly ChatJob[] = []): ChatJobs {
  return {
    list: () => rows,
    running: () => rows.filter((row) => row.state === "running"),
    owned: () => [],
    get: (id) => rows.find((row) => row.id === id),
    start: async () => {
      throw new Error("unused");
    },
    cancel: async () => {
      throw new Error("unused");
    },
    canCancel: async () => ({ ok: true }),
    attach: async () => {},
    logTail: async () => "job output",
    dispose: () => {},
    peekNotice: () => undefined,
    takeNotice: () => undefined,
    onChange: () => () => {},
  };
}

/** One approval as the session raises it: the card the open view must give way to. */
const approval: SessionEventBody = {
  type: "approval_requested",
  requestId: "ask-1",
  tool: "Bash",
  command: COMMAND,
  reason: "Run the tests",
  summary: "test",
  expiresAt: "later",
};

interface MountOptions {
  readonly tasks?: readonly BackgroundTask[];
  readonly jobs?: readonly ChatJob[];
  /** The agent run the control case's agent view draws. */
  readonly run?: BackgroundAgentRun;
  /** False mounts a host with no shell output — the ACP-style host that lists output instead. */
  readonly shellOutput?: boolean;
  /** The strip part the footer draws, whose first column the click lands on. */
  readonly strip?: string;
}

type Ui = ReturnType<typeof mountChatPicker>;

/** The chat over one real `ChatApp`, with the verbs a case needs: click the strip, press a key. */
function withShell(options: MountOptions = {}) {
  // The view's timers are the fake clock's, so a tick neither fires during a case nor outlives it.
  const clock = makeFakeClock();
  _shellViewDeps.schedule = (callback, ms) => clock.setTimeout(callback, ms);
  _shellViewDeps.cancel = (handle) => clock.clearTimeout(Number(handle));
  const tasks = tasksHarness([...(options.tasks ?? [shellTask()])], options.run);
  const shells = shellsHarness();
  const mouse = fakeMouse();
  const ui = mountChatPicker({
    tasks: tasks.port,
    jobs: jobsFake(options.jobs ?? []),
    mouse: mouse.events,
    send: async () => {},
    ...(options.shellOutput === false ? {} : { shellOutput: shells.port }),
  });
  /** The strip's own column in the footer row, whose hit-test covers the whole strip. */
  const column = (): number => (ui.rows().at(-1) ?? "").indexOf(options.strip ?? STRIP) + 1;
  /** A press and a release on the strip in one act, so the frame read after is the one they drew. */
  const click = (): void => {
    const x = column();
    act(() => {
      mouse.emit("press", { button: "left", x, y: ui.rows().length });
      mouse.emit("release", { button: "left", x, y: ui.rows().length });
    });
  };
  return { ui, clock, tasks, shells, mouse, column, click };
}

const text = (ui: Ui): string => ui.rows().join("\n");
const flush = async (ui: Ui): Promise<void> => {
  for (let at = 0; at < FLUSHES; at += 1) await ui.settle();
};
/** The chat's input row, or undefined while the view hides it. */
const inputRow = (ui: Ui): string | undefined => ui.rows().find((row) => row.startsWith(INPUT_PREFIX));

function event(body: SessionEventBody): SessionEvent {
  return { sessionId: "picker-session", turnId: "t1", at: "now", metadata: {}, ...body };
}

/** Type `text` a key at a time, in its own act, and read the frame it produced. */
async function type(ui: Ui, text: string): Promise<void> {
  for (const char of text) ui.press(char);
  await flush(ui);
}

describe("a strip click on one lone running shell", () => {
  test("AC-1 opens the shell view: its header names the command and the chat input is gone", async () => {
    const screen = withShell();
    expect(screen.column()).toBeGreaterThan(0);
    await type(screen.ui, "half typed");
    expect(inputRow(screen.ui)).toContain("half typed");
    screen.click();
    await flush(screen.ui);
    const shown = text(screen.ui);
    expect(shown).toContain(COMMAND);
    expect(shown).toContain(ID);
    expect(shown).toContain(VIEW_HINT);
    expect(shown).toContain("2 tests passed");
    expect(inputRow(screen.ui)).toBeUndefined();
  });

  test("AC-2 escape brings the chat back with the very draft it had", async () => {
    const screen = withShell();
    await type(screen.ui, "half typed");
    const before = screen.ui.rows();
    screen.click();
    await flush(screen.ui);
    expect(text(screen.ui)).not.toContain("half typed");
    screen.ui.press(ESC);
    await flush(screen.ui);
    expect(screen.ui.rows()).toEqual(before);
    expect(inputRow(screen.ui)).toContain("half typed");
  });

  test("AC-3 ctrl+c closes the view and the chat input reappears", async () => {
    const screen = withShell();
    await type(screen.ui, "draft");
    screen.click();
    await flush(screen.ui);
    expect(text(screen.ui)).toContain(VIEW_HINT);
    screen.ui.press(CTRL_C);
    await flush(screen.ui);
    expect(text(screen.ui)).not.toContain(VIEW_HINT);
    expect(inputRow(screen.ui)).toContain("draft");
    // The key closed the view; it did not reach the hidden session as an interrupt.
    expect(screen.ui.host.cancel).not.toHaveBeenCalled();
  });
});

describe("the jobs picker's shell rows", () => {
  test("AC-4 Enter on the running shell's row closes the picker and opens its view", async () => {
    const screen = withShell();
    screen.ui.press(CTRL_G);
    await flush(screen.ui);
    expect(screen.ui.rows()).toContain(PICKER_TITLE);
    expect(text(screen.ui)).toContain(`bash ${COMMAND}`);
    screen.ui.press(RETURN);
    await flush(screen.ui);
    expect(screen.ui.rows()).not.toContain(PICKER_TITLE);
    const shown = text(screen.ui);
    expect(shown).toContain(COMMAND);
    expect(shown).toContain(ID);
    expect(shown).toContain(VIEW_HINT);
  });

  test("AC-5 Enter on an ended shell's row opens its view showing the ended state", async () => {
    const screen = withShell({ tasks: [shellTask({ state: "succeeded", exitCode: 0, endedAt: "now" })] });
    screen.ui.press(CTRL_G);
    await flush(screen.ui);
    screen.ui.press(RETURN);
    await flush(screen.ui);
    const shown = text(screen.ui);
    expect(shown).toContain(COMMAND);
    expect(shown).toContain("succeeded");
    expect(shown).toContain("exit 0");
    expect(shown).toContain(VIEW_HINT);
    // An ended shell offers no stop key, so the footer is the way back alone.
    expect(shown).not.toContain("k to stop");
  });
});

describe("hosts and rows that keep the output listing", () => {
  test("AC-6 a host without shell output appends the listing on a strip click", async () => {
    const screen = withShell({ shellOutput: false });
    expect(screen.column()).toBeGreaterThan(0);
    screen.click();
    await flush(screen.ui);
    expect(screen.tasks.output).toHaveBeenCalledTimes(1);
    expect(text(screen.ui)).toContain(`bash ${COMMAND} · running`);
    expect(text(screen.ui)).not.toContain(VIEW_HINT);
  });

  test("AC-7 a host without shell output appends the listing on Enter over a shell row", async () => {
    const screen = withShell({ shellOutput: false });
    screen.ui.press(CTRL_G);
    await flush(screen.ui);
    screen.ui.press(RETURN);
    await flush(screen.ui);
    expect(screen.tasks.output).toHaveBeenCalledTimes(1);
    expect(text(screen.ui)).toContain(`bash ${COMMAND} · running`);
    expect(screen.ui.rows()).not.toContain(PICKER_TITLE);
    expect(text(screen.ui)).not.toContain(VIEW_HINT);
  });

  test("AC-8 (control) Enter on a job row still appends the job's listing on a shell-output host", async () => {
    // One shell and one job run; the job started a second later, so its row is the first one.
    const started = new Date();
    const screen = withShell({
      tasks: [shellTask({ startedAt: new Date(started.getTime() - 1000).toISOString() })],
      jobs: [job({ startedAt: started.toISOString() })],
    });
    screen.ui.press(CTRL_G);
    await flush(screen.ui);
    expect(text(screen.ui)).toContain("run feat");
    screen.ui.press(RETURN);
    await flush(screen.ui);
    expect(text(screen.ui)).toContain("run feat · running");
    expect(screen.ui.rows()).not.toContain(PICKER_TITLE);
    expect(text(screen.ui)).not.toContain(VIEW_HINT);
  });
});

describe("the gestures that do not open a shell view", () => {
  test("AC-9 (control) a lone running agent opens the agent view on a shell-output host", async () => {
    const run: BackgroundAgentRun = {
      id: "agent-1a2b3c4d",
      agent: "reviewer",
      model: "openai-codex/gpt-6-luna",
      prompt: "Review the spec for gaps",
      state: "running",
      logRetained: true,
      events: [],
    };
    const screen = withShell({ tasks: [agentTask()], run, strip: "1 agent" });
    expect(screen.column()).toBeGreaterThan(0);
    screen.click();
    await flush(screen.ui);
    const shown = text(screen.ui);
    expect(shown).toContain("Agent reviewer");
    expect(shown).toContain("Review the spec for gaps");
    expect(shown).toContain(VIEW_HINT);
  });

  test("AC-10 two running shells leave the strip opening the jobs picker, not a view", async () => {
    const screen = withShell({
      tasks: [shellTask(), shellTask({ id: "bash-00000002", command: "bun test" })],
      strip: "2 shells",
    });
    expect(screen.column()).toBeGreaterThan(0);
    screen.click();
    await flush(screen.ui);
    expect(screen.ui.rows()).toContain(PICKER_TITLE);
    expect(text(screen.ui)).not.toContain(VIEW_HINT);
  });
});

describe("inside the opened shell view", () => {
  test("AC-11 an ask card arriving closes the view and shows the card", async () => {
    const screen = withShell();
    screen.click();
    await flush(screen.ui);
    expect(text(screen.ui)).toContain(VIEW_HINT);
    await screen.ui.settleAfter(() => screen.ui.host.asks.handle(event(approval)));
    await flush(screen.ui);
    expect(text(screen.ui)).not.toContain(VIEW_HINT);
    expect(text(screen.ui)).toContain("Bash command");
    expect(inputRow(screen.ui)).toBeUndefined();
  });

  test("AC-12 typed characters reach no chat input while the view is open", async () => {
    const screen = withShell();
    await type(screen.ui, "keep");
    screen.click();
    await flush(screen.ui);
    await type(screen.ui, "typed");
    expect(text(screen.ui)).not.toContain("typed");
    screen.ui.press(ESC);
    await flush(screen.ui);
    // The input is back with the draft it had, and none of what the view swallowed.
    expect(inputRow(screen.ui)).toContain("keep");
    expect(text(screen.ui)).not.toContain("typed");
  });
});
