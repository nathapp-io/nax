/**
 * The live shell view (chat-live-shell-output US-007): the open view follows its shell, takes
 * the elapsed-time tick and the two keys it owns, shows why a stop was refused, and leaves
 * nothing behind when it closes.
 *
 * Every case mounts `ShellView` itself — the chat mounts over it in US-008 — with a
 * `ChatShellOutput` fake that notifies its listeners on demand, a `ChatBackgroundTasks` fake
 * whose registry change is a call the case makes, and the fake clock wired through
 * `_shellViewDeps.schedule` / `_shellViewDeps.cancel`, so a case says exactly when a redraw
 * lands and the elapsed time is arithmetic rather than the wall clock.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { makeFakeClock } from "@test/helpers";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import {
  type BackgroundTask,
  type ChatBackgroundTasks,
  type ChatShellOutput,
  SHELL_TAIL_REFRESH_MS,
} from "@/chat/background";
import { NaxError } from "@/errors";
import { _shellViewDeps, SHELL_VIEW_TICK_MS, ShellView } from "@/tui/chat/ShellView";
import { resolveChatTheme } from "@/tui/chat/theme";

const ID = "bash-00000001";
/** Another shell the registry notifies about while this view is open. */
const OTHER_ID = "bash-00000002";
/** An id no task fake here lists: the view is open on a task the registry dropped. */
const UNLISTED = "bash-00000009";
const COLUMNS = 100;
const ROWS = 20;
/** The tail `bash-00000001` starts with. */
const TAIL: readonly string[] = ["compiling", "2 tests passed"];
/** The rows above the body: the title and the rule. */
const HEADER_ROWS = 2;
/** How long before "now" the running shell started, so the header opens on 1m 15s. */
const RUNNING_FOR_MS = 75_000;
/** Colour off, so a frame row is plain text and no assertion depends on escapes. */
const THEME = resolveChatTheme({ env: {}, colorLevel: 0 });
/** What ink parses as the escape key. */
const ESC = "\x1b";
const STOP_KEY = "k";

const savedDeps = { ..._shellViewDeps };
const onClose = mock(() => {});

afterEach(() => {
  cleanup();
  Object.assign(_shellViewDeps, savedDeps);
  onClose.mockClear();
});

/** A background shell as the registry records it, started `startedAt`. */
function shellTask(startedAt: string, patch: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: ID,
    command: "npm test",
    origin: "moved",
    startedAt,
    state: "running",
    logPath: `/logs/${ID}.log`,
    ...patch,
  };
}

interface ShellsHarness {
  readonly port: ChatShellOutput;
  /** Give task `id` the tail `lines`, as an append to a running shell would. */
  setTail(id: string, lines: readonly string[]): void;
  /** Notify every listener about `id`, as the registry does on one append. */
  notify(id: string): void;
  /** How many listeners are still subscribed — what an unmount has to bring back to zero. */
  listening(): number;
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
    listening: () => listeners.size,
  };
}

interface TasksHarness {
  readonly port: ChatBackgroundTasks;
  /** The registry's rows, live: a case mutates one and calls `change`. */
  readonly rows: BackgroundTask[];
  /** The stop the view calls; a case inspects its calls, or makes it throw. */
  readonly stop: ReturnType<typeof mock>;
  /** A registry change, as `stop()` and task end fire it. */
  change(): void;
  /** How many change listeners are still subscribed — what an unmount has to bring back to zero. */
  listening(): number;
}

/** A `ChatBackgroundTasks` fake: the rows it lists, one stop, and the change listeners. */
function tasksHarness(rows: BackgroundTask[]): TasksHarness {
  const listeners = new Set<() => void>();
  const stop = mock((id: string): BackgroundTask => rows.find((row) => row.id === id) ?? shellTask(id));
  const port: ChatBackgroundTasks = {
    adopt: () => {
      throw new Error("unused");
    },
    adoptAgent: () => {
      throw new Error("unused");
    },
    foreground: () => () => {},
    stop: (id) => stop(id),
    stopAll: async () => {},
    moveForeground: () => false,
    agentRun: () => undefined,
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
    output: async () => "",
  };
  return {
    port,
    rows,
    stop,
    change: () => {
      for (const listener of [...listeners]) listener();
    },
    listening: () => listeners.size,
  };
}

/**
 * The view over one running `bash-00000001` (or `id`), with the fake clock wired to every
 * timer seam and the verbs a case needs: advance the clock, notify the tails, end the task,
 * press a key, and read the frame.
 */
function mount(options: { readonly id?: string; readonly listed?: boolean } = {}) {
  const clock = makeFakeClock();
  _shellViewDeps.now = () => clock.now();
  _shellViewDeps.schedule = (callback, ms) => clock.setTimeout(callback, ms);
  _shellViewDeps.cancel = (handle) => clock.clearTimeout(Number(handle));
  const shells = shellsHarness();
  const rows = options.listed === false ? [] : [shellTask(new Date(clock.now() - RUNNING_FOR_MS).toISOString())];
  const tasks = tasksHarness(rows);
  const ui = render(
    <ShellView
      shells={shells.port}
      tasks={tasks.port}
      id={options.id ?? ID}
      columns={COLUMNS}
      rows={ROWS}
      theme={THEME}
      onClose={onClose}
    />,
  );
  /** The frame's rows, trailing blanks trimmed; the header is the first, the footer the last. */
  const frameRows = (): string[] =>
    Bun.stripANSI(ui.lastFrame() ?? "")
      .split("\n")
      .map((row) => row.trimEnd());
  /** The body rows: everything between the two header rows and the footer. */
  const body = (): string[] => frameRows().slice(HEADER_ROWS, Math.max(HEADER_ROWS, frameRows().length - 1));
  /** Let the virtual clock reach `ms` from now, inside the act that redraws afterwards. */
  const advance = (ms: number): Promise<void> =>
    Promise.resolve(
      act(async () => {
        await clock.advance(ms);
      }),
    );
  /** Flush whatever is already pending, without moving the clock. */
  const settle = (): Promise<void> =>
    Promise.resolve(
      act(async () => {
        await Promise.resolve();
      }),
    );
  /** Hand the registry an ended task and announce the change, as finishing a shell does. */
  const end = (state: BackgroundTask["state"], exitCode: number): Promise<void> =>
    Promise.resolve(
      act(async () => {
        const current = rows[0] ?? shellTask(new Date(clock.now()).toISOString());
        rows[0] = { ...current, state, exitCode, endedAt: new Date(clock.now()).toISOString() };
        tasks.change();
      }),
    );
  return {
    ui,
    clock,
    shells,
    tasks,
    rows,
    advance,
    settle,
    end,
    header: (): string => frameRows()[0] ?? "",
    footer: (): string => frameRows()[frameRows().length - 1] ?? "",
    /** The newest body line the viewport drew, blank padding skipped. */
    lastBodyLine: (): string =>
      body()
        .filter((row) => row !== "")
        .at(-1) ?? "",
    frame: (): string => frameRows().join("\n"),
    press: (sequence: string): Promise<void> =>
      Promise.resolve(
        act(async () => {
          ui.stdin.write(sequence);
        }),
      ),
  };
}

describe("the shell view follows its shell", () => {
  test("AC-1 the elapsed time advances a tick with no output at all", async () => {
    const view = mount();
    expect(view.header()).toContain("1m 15s");
    await view.advance(SHELL_VIEW_TICK_MS);
    expect(view.header()).toContain("1m 16s");
  });

  test("AC-2 a notified tail line is the last body line once the refresh window passed", async () => {
    const view = mount();
    view.shells.setTail(ID, [...TAIL, "3 tests passed"]);
    view.shells.notify(ID);
    await view.advance(SHELL_TAIL_REFRESH_MS - 1);
    expect(view.frame()).not.toContain("3 tests passed");
    await view.advance(1);
    expect(view.lastBodyLine()).toBe("3 tests passed");
  });

  test("AC-3 a notification for another id does not re-render the view", async () => {
    const rendered = mock(() => {});
    _shellViewDeps.rendered = rendered;
    const view = mount();
    const renders = rendered.mock.calls.length;
    expect(renders).toBeGreaterThan(0);
    view.shells.setTail(OTHER_ID, ["someone else's output"]);
    view.shells.notify(OTHER_ID);
    await view.advance(SHELL_TAIL_REFRESH_MS);
    expect(rendered.mock.calls.length).toBe(renders);
    expect(view.frame()).not.toContain("someone else's output");
    // The counter is live: the same notification for the viewed id does reach the view, so
    // what the case above measured is the id filter and not a view that never redraws.
    view.shells.setTail(ID, [...TAIL, "this shell's output"]);
    view.shells.notify(ID);
    await view.advance(SHELL_TAIL_REFRESH_MS);
    expect(rendered.mock.calls.length).toBeGreaterThan(renders);
    expect(view.lastBodyLine()).toBe("this shell's output");
  });

  test("AC-4 a task that ends while the view is open shows its ended state at once", async () => {
    const view = mount();
    expect(view.header()).toContain("running");
    await view.end("succeeded", 0);
    expect(view.header()).toContain("succeeded");
    expect(view.header()).toContain("exit 0");
  });

  test("AC-5 the footer offers only the way back once the task ended", async () => {
    const view = mount();
    expect(view.footer()).toBe("esc to return · k to stop");
    await view.end("stopped", 143);
    expect(view.footer()).toBe("esc to return");
  });
});

describe("the shell view's keys", () => {
  test("AC-6 k on an ended task does not call tasks.stop", async () => {
    // The key is wired: the very same key stops a running shell (AC-8), so what this case
    // measures is the ended-state guard rather than a view that never handles `k`.
    const running = mount();
    await running.press(STOP_KEY);
    expect(running.tasks.stop).toHaveBeenCalledTimes(1);
    const view = mount();
    await view.end("succeeded", 0);
    await view.press(STOP_KEY);
    expect(view.tasks.stop).not.toHaveBeenCalled();
  });

  test("AC-7 escape calls onClose once", async () => {
    const view = mount();
    await view.press(ESC);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("AC-8 k on a running task stops it once, by id", async () => {
    const view = mount();
    await view.press(STOP_KEY);
    expect(view.tasks.stop).toHaveBeenCalledTimes(1);
    expect(view.tasks.stop).toHaveBeenCalledWith(ID);
  });

  test("AC-9 k on a running task does not close the view", async () => {
    const view = mount();
    await view.press(STOP_KEY);
    expect(onClose).not.toHaveBeenCalled();
    // The same view's escape does close it, so `onClose` is reachable and the count is live.
    await view.press(ESC);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("AC-10 a failed stop puts its message in the footer row", async () => {
    const view = mount();
    view.tasks.stop.mockImplementation(() => {
      throw new NaxError("boom", "TASK_STOP_FAILED", { stage: "chat" });
    });
    await view.press(STOP_KEY);
    expect(view.footer()).toBe("boom");
  });

  test("AC-11 a failed stop does not close the view", async () => {
    const view = mount();
    view.tasks.stop.mockImplementation(() => {
      throw new NaxError("boom", "TASK_STOP_FAILED", { stage: "chat" });
    });
    await view.press(STOP_KEY);
    expect(onClose).not.toHaveBeenCalled();
    // Escape does close it, so `onClose` is reachable and the count is live.
    await view.press(ESC);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("AC-15 escape still closes a view whose task the registry dropped", async () => {
    const view = mount({ id: UNLISTED, listed: false });
    expect(view.header()).toBe("bash-00000009 is no longer listed");
    await view.press(ESC);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("the shell view's cleanup", () => {
  test("AC-12 an unmount cancels every armed timer", () => {
    const view = mount();
    // One timer while the shell merely runs: the elapsed-time tick.
    expect(view.clock.pending()).toBe(1);
    // A tail append arms the other one, the coalesced redraw — still inside its window, so both
    // timers are armed at the moment of the unmount and both have to be cancelled by it.
    view.shells.setTail(ID, [...TAIL, "one more line"]);
    view.shells.notify(ID);
    expect(view.clock.pending()).toBe(2);
    view.ui.unmount();
    expect(view.clock.pending()).toBe(0);
    expect(view.shells.listening()).toBe(0);
    expect(view.tasks.listening()).toBe(0);
  });

  test("AC-13 a tail notification after the unmount causes no render", async () => {
    const rendered = mock(() => {});
    _shellViewDeps.rendered = rendered;
    const view = mount();
    const renders = rendered.mock.calls.length;
    // Before the unmount the same notification does redraw, so the count is live.
    view.shells.setTail(ID, [...TAIL, "before the unmount"]);
    view.shells.notify(ID);
    await view.advance(SHELL_TAIL_REFRESH_MS);
    expect(rendered.mock.calls.length).toBeGreaterThan(renders);
    view.ui.unmount();
    const afterUnmount = rendered.mock.calls.length;
    view.shells.setTail(ID, [...TAIL, "after the unmount"]);
    view.shells.notify(ID);
    await view.settle();
    expect(rendered.mock.calls.length).toBe(afterUnmount);
  });

  test("AC-14 a registry change after the unmount causes no render", async () => {
    const rendered = mock(() => {});
    _shellViewDeps.rendered = rendered;
    const view = mount();
    const renders = rendered.mock.calls.length;
    // Before the unmount the same change does redraw, so the count is live.
    await view.end("succeeded", 0);
    expect(rendered.mock.calls.length).toBeGreaterThan(renders);
    view.ui.unmount();
    const afterUnmount = rendered.mock.calls.length;
    view.rows[0] = { ...view.rows[0], state: "failed", exitCode: 1 };
    view.tasks.change();
    await view.settle();
    expect(rendered.mock.calls.length).toBe(afterUnmount);
  });
});
