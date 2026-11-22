/**
 * The full-screen subagent view: opened by a click on the footer's agent strip (directly for a
 * lone agent, through the jobs picker otherwise), read-only, live, scrollable, and closed by
 * escape with the chat exactly as it was.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { SessionEvent } from "@nathapp/nax-agent";
import {
  mountChatPicker as mount,
  textDeltaEvent,
  toolCallEvent,
  toolResultEvent,
  waitForCondition,
} from "@test/helpers";
import { cleanup } from "ink-testing-library";
import type { BackgroundAgentRun, BackgroundTask, ChatBackgroundTasks } from "@/chat/background";
import { _agentViewDeps } from "@/tui/chat/AgentView";
import { fakeMouse } from "./mouse";

const ESC = "\x1b";
const CTRL_C = "\x03";
const CTRL_G = "\x07";
const RETURN = "\r";
const PAGE_UP = "\x1b[5~";
const AGENT_ID = "agent-1a2b3c4d";
const SHELL_ID = "bash-1a2b3c4d";
const STRIP = "1 agent";
const FLUSHES = 6;
afterEach(cleanup);

function agentTask(patch: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: AGENT_ID,
    kind: "agent",
    command: "reviewer: Review the spec",
    origin: "agent",
    startedAt: new Date().toISOString(),
    state: "running",
    logPath: "/log",
    ...patch,
  };
}

function shellTask(): BackgroundTask {
  return { ...agentTask(), id: SHELL_ID, command: "bun test", kind: undefined };
}

/** A registry whose one agent run can be changed and announced while the screen is mounted. */
function fakeTasks(rows: BackgroundTask[], run: { current: BackgroundAgentRun | undefined }) {
  const listeners = new Set<(id: string) => void>();
  const output = mock(async () => "shell output");
  const port: ChatBackgroundTasks = {
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
    // A fresh object per call, like the registry's snapshot: identity must not hide a refold.
    agentRun: (id) => (id === run.current?.id ? { ...run.current } : undefined),
    onAgentEvents: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    hasForeground: () => false,
    peekNotice: () => undefined,
    releaseNotice: () => {},
    takeNotice: () => undefined,
    onChange: () => () => {},
    list: () => rows,
    get: (id) => rows.find((row) => row.id === id),
    running: () => rows.filter((row) => row.state === "running"),
    output,
  };
  return {
    port,
    output,
    announce: (id: string): void => {
      for (const listener of listeners) listener(id);
    },
  };
}

function runOf(events: readonly SessionEvent[], patch: Partial<BackgroundAgentRun> = {}): BackgroundAgentRun {
  return {
    id: AGENT_ID,
    agent: "reviewer",
    model: "openai-codex/gpt-6-luna",
    prompt: "Review the spec for gaps",
    state: "running",
    logRetained: true,
    events,
    ...patch,
  };
}

function thinkingEvent(text: string): SessionEvent {
  const base = textDeltaEvent(text);
  return { ...base, type: "thinking_delta", round: 1, text };
}

const SAMPLE: readonly SessionEvent[] = [
  thinkingEvent("weighing the options"),
  toolCallEvent("c1"),
  toolResultEvent("c1"),
  textDeltaEvent("Found two gaps in section 3"),
];

type Ui = ReturnType<typeof mount>;
const text = (ui: Ui): string => ui.rows().join("\n");
const flush = async (ui: Ui): Promise<void> => {
  for (let at = 0; at < FLUSHES; at += 1) await ui.settle();
};

/** A mounted screen over one running agent task, with the strip's cell read off the footer. */
function withAgent(
  options: { rows?: BackgroundTask[]; run?: BackgroundAgentRun; strip?: string; holdTurn?: boolean } = {},
) {
  const run: { current: BackgroundAgentRun | undefined } = { current: options.run ?? runOf(SAMPLE) };
  const tasks = fakeTasks(options.rows ?? [agentTask()], run);
  const mouse = fakeMouse();
  const ui = mount({
    tasks: tasks.port,
    mouse: mouse.events,
    ...(options.holdTurn === true ? {} : { send: async () => {} }),
  });
  const footerRow = ui.rows().length;
  const stripColumn = (ui.rows()[footerRow - 1] ?? "").indexOf(options.strip ?? STRIP) + 1;
  const click = (): void => {
    mouse.emit("press", { button: "left", x: stripColumn, y: footerRow });
    mouse.emit("release", { button: "left", x: stripColumn, y: footerRow });
  };
  return { ui, tasks, run, click, stripColumn };
}

describe("the agent strip click", () => {
  test("a lone agent opens its full view directly", async () => {
    const { ui, click, stripColumn } = withAgent();
    expect(stripColumn).toBeGreaterThan(0);
    click();
    await flush(ui);
    const shown = text(ui);
    expect(shown).toContain("Agent reviewer");
    expect(shown).toContain("openai-codex/gpt-6-luna");
    expect(shown).toContain("running");
    expect(shown).toContain("Review the spec for gaps");
    expect(shown).toContain("Found two gaps in section 3");
    expect(shown).toContain("esc to return");
  });

  test("the view draws the task prompt first, then thinking, the tool card and the answer", async () => {
    const { ui, click } = withAgent();
    click();
    await flush(ui);
    const rows = ui.rows();
    const at = (needle: string) => rows.findIndex((row) => row.includes(needle));
    expect(at("Review the spec for gaps")).toBeGreaterThan(-1);
    expect(at("Review the spec for gaps")).toBeLessThan(at("Read"));
    expect(at("Read")).toBeLessThan(at("Found two gaps"));
    expect(at("Thought")).toBeGreaterThan(-1);
  });

  test("a lone shell still lists its output instead of opening a view", async () => {
    const { ui, click, tasks, stripColumn } = withAgent({ rows: [shellTask()], strip: "1 shell" });
    expect(stripColumn).toBeGreaterThan(0);
    click();
    await flush(ui);
    expect(tasks.output).toHaveBeenCalledTimes(1);
    expect(text(ui)).not.toContain("esc to return");
  });

  test("two tasks leave the jobs picker as the way in, and Enter on the agent row opens the view", async () => {
    const { ui } = withAgent({ rows: [agentTask(), shellTask()] });
    ui.press(CTRL_G);
    await flush(ui);
    expect(text(ui)).toContain("Jobs and tasks");
    ui.press(RETURN);
    await flush(ui);
    expect(text(ui)).toContain("esc to return");
    expect(text(ui)).toContain("Agent reviewer");
  });

  test("Enter on a shell row still lists its output", async () => {
    const { ui, tasks } = withAgent({ rows: [shellTask(), agentTask({ startedAt: "2000-01-01T00:00:00.000Z" })] });
    ui.press(CTRL_G);
    await flush(ui);
    ui.press(RETURN);
    await flush(ui);
    expect(tasks.output).toHaveBeenCalledTimes(1);
    expect(text(ui)).not.toContain("esc to return");
  });
});

describe("inside the view", () => {
  test("escape returns to the chat exactly as it was: transcript and draft intact", async () => {
    const { ui, click } = withAgent();
    await ui.submit("first question");
    for (const char of "half-typed") ui.press(char);
    await flush(ui);
    const before = ui.rows();
    expect(text(ui)).toContain("first question");
    click();
    await flush(ui);
    expect(text(ui)).toContain("esc to return");
    expect(text(ui)).not.toContain("first question");
    ui.press(ESC);
    await flush(ui);
    expect(ui.rows()).toEqual(before);
    expect(text(ui)).toContain("half-typed");
  });

  test("it is read-only: typed keys reach no input and escape does not cancel a running turn", async () => {
    const { ui, click } = withAgent();
    click();
    await flush(ui);
    for (const char of "typed") ui.press(char);
    await flush(ui);
    expect(text(ui)).not.toContain("typed");
    ui.press(ESC);
    await flush(ui);
    expect(text(ui)).not.toContain("typed");
    expect(ui.host.cancel).not.toHaveBeenCalled();
  });

  test("ctrl+c closes the view and does not interrupt the hidden turn; a second one does", async () => {
    const { ui, click } = withAgent({ holdTurn: true });
    await ui.submit("long question");
    click();
    await flush(ui);
    expect(text(ui)).toContain("esc to return");
    ui.press(CTRL_C);
    await flush(ui);
    expect(text(ui)).not.toContain("esc to return");
    expect(ui.host.cancel).not.toHaveBeenCalled();
    ui.press(CTRL_C);
    await flush(ui);
    expect(ui.host.cancel).toHaveBeenCalledTimes(1);
  });

  test("it redraws while the run records more events", async () => {
    const { ui, click, run, tasks } = withAgent();
    click();
    await flush(ui);
    expect(text(ui)).not.toContain("a brand new line");
    run.current = runOf([...SAMPLE, textDeltaEvent(" and a brand new line")]);
    tasks.announce(AGENT_ID);
    await waitForCondition(() => text(ui).includes("a brand new line"));
  });

  test("the header follows the run's state while the view is open", async () => {
    const { ui, click, run, tasks } = withAgent();
    click();
    await flush(ui);
    expect(text(ui)).toContain("running");
    run.current = runOf(SAMPLE, { state: "failed" });
    tasks.announce(AGENT_ID);
    await waitForCondition(() => text(ui).includes("failed"));
    expect(text(ui)).toContain("Found two gaps in section 3");
  });

  test("it scrolls with the transcript's keys", async () => {
    const lines = Array.from({ length: 80 }, (_, index) => textDeltaEvent(`line ${index}\n`));
    const long = [...lines].map((event, index) => ({ ...event, turnId: `t${index}` }));
    const { ui, click } = withAgent({ run: runOf(long) });
    click();
    await flush(ui);
    expect(text(ui)).not.toContain("Scroll to bottom");
    ui.press(PAGE_UP);
    await flush(ui);
    expect(text(ui)).toMatch(/Scroll to bottom|new lines/);
  });

  test("a finished run whose log was dropped says so and still shows its prompt", async () => {
    const { ui, click } = withAgent({ run: runOf([], { state: "succeeded", logRetained: false }) });
    click();
    await flush(ui);
    expect(text(ui)).toContain("Review the spec for gaps");
    expect(text(ui)).toContain("the log of this agent is no longer retained");
    expect(text(ui)).toContain("done");
  });

  test("a redraw of the chat underneath does not refold or relayout the view; new agent events do", async () => {
    const { ui, click, run, tasks } = withAgent();
    const fold = mock(_agentViewDeps.fold);
    const layout = mock(_agentViewDeps.layout);
    const original = { ..._agentViewDeps };
    _agentViewDeps.fold = fold;
    _agentViewDeps.layout = layout;
    try {
      click();
      await flush(ui);
      const folds = fold.mock.calls.length;
      const layouts = layout.mock.calls.length;
      expect(folds).toBeGreaterThan(0);
      // Main-chat renders: a resize event re-renders the whole screen.
      for (let at = 0; at < 3; at += 1) await ui.settleAfter(() => ui.ui.stdout.emit("resize"));
      await flush(ui);
      expect(fold.mock.calls.length).toBe(folds);
      expect(layout.mock.calls.length).toBe(layouts);
      run.current = runOf([...SAMPLE, textDeltaEvent(" more")]);
      tasks.announce(AGENT_ID);
      await waitForCondition(() => fold.mock.calls.length > folds);
    } finally {
      Object.assign(_agentViewDeps, original);
    }
  });

  test("a task that has left the registry says so, and escape still returns", async () => {
    const { ui, click, run, tasks } = withAgent();
    click();
    await flush(ui);
    run.current = undefined;
    tasks.announce(AGENT_ID);
    await waitForCondition(() => text(ui).includes("no longer listed"));
    ui.press(ESC);
    await flush(ui);
    expect(text(ui)).not.toContain("esc to return");
  });
});
