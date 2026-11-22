/**
 * The full-screen shell view (chat-live-shell-output US-006): a background shell's command,
 * state, elapsed time, exit code and id in the header, its bounded tail in the body over the
 * chat's own transcript viewport, and the hint that says how to leave it.
 *
 * Every mounted case renders `ShellView` itself — the chat is mounted over it by US-008 — with a
 * `ChatShellOutput` fake for the tails, a `ChatBackgroundTasks` fake for the task, and the clock
 * fixed to an epoch millisecond so the elapsed time is arithmetic rather than the wall clock.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "ink-testing-library";
import { act, type ReactElement } from "react";
import type { BackgroundTask, ChatBackgroundTasks, ChatShellOutput, ShellTailView } from "@/chat/background";
import { _shellViewDeps, ShellView } from "@/tui/chat/ShellView";
import { resolveChatTheme } from "@/tui/chat/theme";

/** The fixed "now" every case reads through `_shellViewDeps.now`, in epoch milliseconds. */
const NOW = 1_700_000_000_000;
const ID = "bash-00000001";
/** An id no task fake here lists: the defensive path the registry's own invariants never reach. */
const UNLISTED = "bash-00000009";
const LOG_PATH = "/logs/bash-00000001.log";
const COLUMNS = 100;
const ROWS = 20;
/** The tail `bash-00000001` reports unless a case replaces it. */
const TAIL: readonly string[] = ["compiling", "2 tests passed"];
/** The rows above the body: the title and the rule. */
const HEADER_ROWS = 2;
/** Colour off, so a frame row is plain text and no assertion depends on escapes. */
const THEME = resolveChatTheme({ env: {}, colorLevel: 0 });

const savedDeps = { ..._shellViewDeps };
const onClose = mock(() => {});

afterEach(() => {
  cleanup();
  Object.assign(_shellViewDeps, savedDeps);
  onClose.mockClear();
});

/** A background shell as the registry records it, started 75 seconds before NOW. */
function shellTask(patch: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: ID,
    command: "npm test",
    origin: "moved",
    startedAt: new Date(NOW - 75_000).toISOString(),
    state: "running",
    logPath: LOG_PATH,
    ...patch,
  };
}

/** A task registry fake: the listed tasks, and nothing that needs a real registry. */
function tasksFake(listed: readonly BackgroundTask[]): ChatBackgroundTasks {
  return {
    adopt: () => {
      throw new Error("unused");
    },
    adoptAgent: () => {
      throw new Error("unused");
    },
    foreground: () => () => {},
    stop: () => {
      throw new Error("unused");
    },
    stopAll: async () => {},
    moveForeground: () => false,
    agentRun: () => undefined,
    onAgentEvents: () => () => {},
    hasForeground: () => false,
    peekNotice: () => undefined,
    releaseNotice: () => {},
    takeNotice: () => undefined,
    onChange: () => () => {},
    list: () => listed,
    get: (id) => listed.find((row) => row.id === id),
    running: () => listed.filter((row) => row.state === "running"),
    output: async () => "",
  };
}

/** A shell-output fake: the tails it holds, keyed by task id, and no listeners of its own. */
function shellsFake(tails: ReadonlyMap<string, ShellTailView>): ChatShellOutput {
  return {
    taskTail: (id) => tails.get(id),
    foregroundTail: () => undefined,
    onShellOutput: () => () => {},
  };
}

interface MountOptions {
  /** The tasks the registry lists; one running `bash-00000001` by default. */
  readonly listed?: readonly BackgroundTask[];
  /** The id the view draws; the listed task's own id by default. */
  readonly id?: string;
  /** The tails the shell-output fake reports, so a case can hand an unlisted id a stale one. */
  readonly tails?: ReadonlyMap<string, ShellTailView>;
}

/** The view's props, built once so a parent redraw hands it the very same ones. */
function propsOf(options: MountOptions = {}) {
  const listed = options.listed ?? [shellTask()];
  return {
    shells: shellsFake(options.tails ?? new Map([[ID, { lines: TAIL, truncated: false }]])),
    tasks: tasksFake(listed),
    id: options.id ?? ID,
    columns: COLUMNS,
    rows: ROWS,
    theme: THEME,
    onClose,
  };
}

/**
 * The view, mounted under a parent that re-renders on demand: the parent holds no memo, so a
 * redraw re-evaluates it and only the view's own memo can keep `_shellViewDeps.rendered` still.
 */
function mount(options: MountOptions = {}) {
  _shellViewDeps.now = () => NOW;
  const props = propsOf(options);
  const Parent = (): ReactElement => <ShellView {...props} />;
  const ui = render(<Parent />);
  /** The frame's rows, trailing blanks trimmed; the header is the first, the footer the last. */
  const rows = (): string[] =>
    Bun.stripANSI(ui.lastFrame() ?? "")
      .split("\n")
      .map((row) => row.trimEnd());
  /** The body rows: everything between the two header rows and the footer. */
  const body = (): string[] => rows().slice(HEADER_ROWS, Math.max(HEADER_ROWS, rows().length - 1));
  return {
    ui,
    props,
    rows,
    body,
    header: (): string => rows()[0] ?? "",
    footer: (): string => rows()[rows().length - 1] ?? "",
    frame: (): string => rows().join("\n"),
    redraw: (): Promise<void> =>
      Promise.resolve(
        act(async () => {
          ui.rerender(<Parent />);
        }),
      ),
  };
}

describe("the shell view's header", () => {
  test("AC-1 shows the command and the running state", () => {
    const header = mount().header();
    expect(header).toContain("npm test");
    expect(header).toContain("running");
  });

  test("AC-2 shows the task id", () => {
    expect(mount().header()).toContain(ID);
  });

  test("AC-3 shows the elapsed time of a running task as 1m 15s", () => {
    expect(mount().header()).toContain("1m 15s");
  });

  test("AC-4 shows the state and the exit code of a task that failed with 2", () => {
    const failed = shellTask({ state: "failed", exitCode: 2, endedAt: new Date(NOW).toISOString() });
    const header = mount({ listed: [failed] }).header();
    expect(header).toContain("failed");
    expect(header).toContain("exit 2");
  });

  test("AC-5 shows the description beside the command", () => {
    const described = shellTask({ description: "run the test suite" });
    expect(mount({ listed: [described] }).header()).toContain("npm test (run the test suite)");
  });
});

describe("the shell view's body", () => {
  test("AC-6 shows the tail lines of the task", () => {
    const body = mount().body();
    expect(body[0]).toBe("compiling");
    expect(body[1]).toBe("2 tests passed");
  });

  test("AC-7 names the log path first when the tail is truncated", () => {
    const tails = new Map([[ID, { lines: TAIL, truncated: true }]]);
    expect(mount({ tails }).body()[0]).toBe(`earlier output dropped; full log: ${LOG_PATH}`);
  });

  test("AC-8 neutralises a control sequence a tail line carries", () => {
    const tails = new Map([[ID, { lines: ["before\u001b[?1049lafter"], truncated: false }]]);
    const bare = mount({ tails }).ui.lastFrame() ?? "";
    // The raw frame, not a stripped one: a sequence left in the text is what this asserts against.
    expect(bare).toContain("beforeafter");
    expect(bare).not.toContain("\u001b[?1049l");
  });
});

describe("the shell view's footer", () => {
  test("AC-9 offers to stop a running shell", () => {
    expect(mount().footer()).toBe("esc to return · k to stop");
  });

  test("AC-10 offers only the way back once the shell ended", () => {
    const ended = shellTask({ state: "succeeded", exitCode: 0, endedAt: new Date(NOW).toISOString() });
    expect(mount({ listed: [ended] }).footer()).toBe("esc to return");
  });
});

describe("the shell view for an id the registry does not list", () => {
  /** A tail the fake would hand out for the unlisted id, if the view asked for one. */
  const stale = new Map([[UNLISTED, { lines: ["stale shell output"], truncated: false }]]);

  test("AC-11 names the id and says it is no longer listed", () => {
    expect(mount({ id: UNLISTED, tails: stale }).header()).toBe("bash-00000009 is no longer listed");
  });

  test("AC-12 draws an empty body", () => {
    const view = mount({ id: UNLISTED, tails: stale });
    expect(view.frame()).not.toContain("stale shell output");
    // An empty body, not merely a tail withheld: every body row the viewport draws is blank.
    expect(view.body().every((row) => row === "")).toBe(true);
  });
});

describe("the shell view's memoization", () => {
  test("AC-13 a redraw of the parent with the same props does not re-render the view", async () => {
    const rendered = mock(() => {});
    _shellViewDeps.rendered = rendered;
    const view = mount();
    const mounts = rendered.mock.calls.length;
    // The seam is what the counter counts: the first render went through it.
    expect(mounts).toBe(1);
    await view.redraw();
    await view.redraw();
    expect(rendered.mock.calls.length).toBe(mounts);
  });

  test("a changed state does re-render the view, so the counter is live", async () => {
    const rendered = mock(() => {});
    _shellViewDeps.rendered = rendered;
    const view = mount();
    expect(rendered.mock.calls.length).toBe(1);
    const ended = shellTask({ state: "succeeded", exitCode: 0, endedAt: new Date(NOW).toISOString() });
    const next = propsOf({ listed: [ended] });
    await Promise.resolve(
      act(async () => {
        view.ui.rerender(<ShellView {...next} />);
      }),
    );
    expect(rendered.mock.calls.length).toBe(2);
  });
});
