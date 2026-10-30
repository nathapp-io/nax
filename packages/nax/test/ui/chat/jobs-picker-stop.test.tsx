import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  pickerEntryRows as entryRows,
  pickerFrameOf as frameOf,
  pickerLabelOf as labelOf,
  mountChatPicker as mount,
} from "@test/helpers";
import { cleanup } from "ink-testing-library";
import type { BackgroundTask, ChatBackgroundTasks } from "@/chat/background/task-types";
import type { ChatJobs } from "@/chat/jobs/job-runner";
import type { ChatJob } from "@/chat/jobs/job-types";
import { NaxError } from "@/errors";

const CTRL_X = "\x18";
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const TITLE = "Jobs and tasks · enter output · ctrl+x stop";
const MODEL_TITLE = "Switch model";
const TASK_ID = "bash-1a2b3c4d";
const TASK_B_ID = "bash-5e6f7a8b";
const JOB_ID = "run-0000aaaa";
const REFUSAL = "job is not owned by this chat";
const FLUSHES = 6;
const MINUTE_MS = 60_000;
const POINTER = "❯";
afterEach(cleanup);

function task(patch: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: TASK_ID,
    command: "bun dev",
    origin: "agent",
    startedAt: new Date().toISOString(),
    state: "running",
    logPath: "/log",
    ...patch,
  };
}

function job(patch: Partial<ChatJob> = {}): ChatJob {
  return {
    schemaVersion: 1,
    id: JOB_ID,
    kind: "run",
    target: "f1",
    argv: [],
    cwd: "/repo",
    pid: 123,
    startedAt: new Date().toISOString(),
    state: "running",
    logPath: "/log",
    sessionId: "picker-session",
    approvedAt: "now",
    ...patch,
  };
}

interface TasksFixture {
  readonly port: ChatBackgroundTasks;
  readonly stop: ReturnType<typeof mock<ChatBackgroundTasks["stop"]>>;
  rows: BackgroundTask[];
  fire(): void;
}

type StopImpl = (fixture: TasksFixture, id: string) => BackgroundTask;

function fakeTasks(rows: BackgroundTask[], stopImpl?: StopImpl): TasksFixture {
  const listeners = new Set<() => void>();
  const stop = mock<ChatBackgroundTasks["stop"]>((id) => {
    if (stopImpl) return stopImpl(fixture, id);
    const found = fixture.rows.find((row) => row.id === id);
    if (found === undefined) throw new Error("unknown task");
    return found;
  });
  const fixture: TasksFixture = {
    rows,
    stop,
    fire: () => {
      for (const listener of listeners) listener();
    },
    port: {
      adopt: () => {
        throw new Error("unused");
      },
      foreground: () => () => {},
      stop,
      stopAll: async () => {},
      moveForeground: () => false,
      hasForeground: () => false,
      peekNotice: () => undefined,
      takeNotice: () => undefined,
      onChange: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      list: () => fixture.rows,
      get: (id) => fixture.rows.find((row) => row.id === id),
      running: () => fixture.rows.filter((row) => row.state === "running"),
      output: async () => "",
    },
  };
  return fixture;
}

interface JobsFixture {
  readonly port: ChatJobs;
  readonly cancel: ReturnType<typeof mock<ChatJobs["cancel"]>>;
  readonly canCancel: ReturnType<typeof mock<ChatJobs["canCancel"]>>;
}

function fakeJobs(
  rows: ChatJob[],
  options: { canCancel?: ChatJobs["canCancel"]; cancel?: ChatJobs["cancel"] } = {},
): JobsFixture {
  const cancel = mock<ChatJobs["cancel"]>(options.cancel ?? (async (id) => rows.find((row) => row.id === id) ?? job()));
  const canCancel = mock<ChatJobs["canCancel"]>(options.canCancel ?? (async () => ({ ok: true })));
  return {
    cancel,
    canCancel,
    port: {
      list: () => rows,
      running: () => rows.filter((row) => row.state === "running"),
      owned: () => [],
      get: (id) => rows.find((row) => row.id === id),
      start: async () => {
        throw new Error("unused");
      },
      cancel,
      canCancel,
      attach: async () => {},
      logTail: async () => "",
      dispose: () => {},
      peekNotice: () => undefined,
      takeNotice: () => undefined,
      onChange: () => () => {},
    },
  };
}

type Ui = ReturnType<typeof mount>;

const frame = (ui: Ui, title = TITLE) => frameOf(ui.rows(), title);
const entries = (ui: Ui, title = TITLE) => entryRows(frame(ui, title).inside);
/** The picker's last row inside the frame: its note when it has one. */
const noteOf = (ui: Ui): string => frame(ui).inside.at(-1) ?? "";
const highlighted = (ui: Ui): string => entries(ui).find((row) => row.startsWith(POINTER)) ?? "";
const hasWarning = (ui: Ui): boolean => frame(ui).inside.some((row) => row.includes("not running"));
const flush = async (ui: Ui): Promise<void> => {
  for (let at = 0; at < FLUSHES; at += 1) await ui.settle();
};

async function open(options: { tasks?: TasksFixture; jobs?: JobsFixture }): Promise<Ui> {
  const ui = mount({
    ...(options.tasks ? { tasks: options.tasks.port } : {}),
    ...(options.jobs ? { jobs: options.jobs.port } : {}),
  });
  await ui.submit("/jobs");
  return ui;
}

async function stopKey(ui: Ui): Promise<void> {
  ui.press(CTRL_X);
  await flush(ui);
}

describe("ctrl+x on a running task", () => {
  test("AC-1 stops the highlighted task once", async () => {
    const tasks = fakeTasks([task()]);
    const ui = await open({ tasks });
    await stopKey(ui);
    expect(tasks.stop).toHaveBeenCalledTimes(1);
    expect(tasks.stop).toHaveBeenCalledWith(TASK_ID);
  });
  test("AC-2 keeps the picker open", async () => {
    const ui = await open({ tasks: fakeTasks([task()]) });
    await stopKey(ui);
    expect(ui.rows()).toContain(TITLE);
  });
  test("AC-9 AC-10 a thrown NaxError shows its message and keeps the picker open", async () => {
    const message = `[chat] task ${TASK_ID} is not running`;
    const tasks = fakeTasks([task()], () => {
      throw new NaxError(message, "TASK_NOT_RUNNING", { stage: "chat" });
    });
    const ui = await open({ tasks });
    await stopKey(ui);
    expect(noteOf(ui)).toContain(message);
    expect(ui.rows()).toContain(TITLE);
  });
});

describe("ctrl+x on a running job", () => {
  test("AC-3 AC-4 cancels the highlighted job once and keeps the picker open", async () => {
    const jobs = fakeJobs([job()]);
    const ui = await open({ jobs });
    await stopKey(ui);
    expect(jobs.cancel).toHaveBeenCalledTimes(1);
    expect(jobs.cancel).toHaveBeenCalledWith(JOB_ID);
    expect(ui.rows()).toContain(TITLE);
  });
  test("AC-5 AC-6 a canCancel refusal skips cancel and shows its message", async () => {
    const jobs = fakeJobs([job()], { canCancel: async () => ({ ok: false, message: REFUSAL }) });
    const ui = await open({ jobs });
    await stopKey(ui);
    expect(jobs.cancel).not.toHaveBeenCalled();
    expect(noteOf(ui)).toContain(REFUSAL);
    expect(ui.rows()).toContain(TITLE);
  });
  test("AC-11 AC-12 a rejected cancel shows its message and keeps the picker open", async () => {
    const jobs = fakeJobs([job()], {
      cancel: async () => {
        throw new Error("kill failed");
      },
    });
    const ui = await open({ jobs });
    await stopKey(ui);
    expect(noteOf(ui)).toContain("kill failed");
    expect(ui.rows()).toContain(TITLE);
  });
});

describe("ctrl+x on a row that is not running", () => {
  test("AC-7 AC-8 an ended task is neither stopped nor cancelled and warns", async () => {
    const tasks = fakeTasks([task({ state: "succeeded" })]);
    const jobs = fakeJobs([]);
    const ui = await open({ tasks, jobs });
    await stopKey(ui);
    expect(tasks.stop).not.toHaveBeenCalled();
    expect(jobs.cancel).not.toHaveBeenCalled();
    expect(noteOf(ui)).toContain(`${TASK_ID} is not running`);
  });
  test("AC-7 AC-8 an ended job is neither stopped nor cancelled and warns", async () => {
    const tasks = fakeTasks([]);
    const jobs = fakeJobs([job({ state: "succeeded" })]);
    const ui = await open({ tasks, jobs });
    await stopKey(ui);
    expect(tasks.stop).not.toHaveBeenCalled();
    expect(jobs.canCancel).not.toHaveBeenCalled();
    expect(jobs.cancel).not.toHaveBeenCalled();
    expect(noteOf(ui)).toContain(`${JOB_ID} is not running`);
  });
});

describe("the warning", () => {
  test("AC-13 a successful stop clears it", async () => {
    const tasks = fakeTasks([task({ id: TASK_B_ID, state: "succeeded" }), task()]);
    const ui = await open({ tasks });
    // The running task sorts first; step down to the ended row to earn the warning.
    ui.press(DOWN);
    await stopKey(ui);
    expect(noteOf(ui)).toContain(`${TASK_B_ID} is not running`);
    ui.press(UP);
    await stopKey(ui);
    expect(tasks.stop).toHaveBeenCalledTimes(1);
    expect(hasWarning(ui)).toBe(false);
  });
});

describe("the rows follow the registries", () => {
  test("AC-14 a task that stops redraws with a stopped detail", async () => {
    const tasks = fakeTasks([task()]);
    const ui = await open({ tasks });
    tasks.rows = [task({ state: "stopped" })];
    await ui.settleAfter(() => tasks.fire());
    expect(entries(ui)[0]).toContain("stopped · ");
  });
});

describe("the highlight follows its row", () => {
  /** A is newer than B, so with both running A sorts first and starts highlighted. */
  function pair(): TasksFixture {
    const started = Date.now();
    const a = task({ command: "alpha", startedAt: new Date(started).toISOString() });
    const b = task({ id: TASK_B_ID, command: "beta", startedAt: new Date(started - MINUTE_MS).toISOString() });
    return fakeTasks([a, b], (fixture, id) => {
      fixture.rows = fixture.rows.map((row): BackgroundTask => (row.id === id ? { ...row, state: "stopped" } : row));
      fixture.fire();
      return fixture.rows.find((row) => row.id === id) ?? a;
    });
  }

  test("AC-15 a stopped row that moves below a running one stays highlighted", async () => {
    const ui = await open({ tasks: pair() });
    expect(highlighted(ui)).toContain("alpha");
    await stopKey(ui);
    const labels = entries(ui).map((row) => labelOf(row).trim());
    expect(labels).toEqual(["bash beta", "bash alpha"]);
    expect(highlighted(ui)).toContain("alpha");
  });
  test("AC-16 AC-17 a second ctrl+x does not stop the row that took its place", async () => {
    const tasks = pair();
    const ui = await open({ tasks });
    await stopKey(ui);
    await stopKey(ui);
    expect(tasks.stop).toHaveBeenCalledTimes(1);
    expect(tasks.stop).not.toHaveBeenCalledWith(TASK_B_ID);
    expect(noteOf(ui)).toContain(`${TASK_ID} is not running`);
  });
});

describe("the model picker", () => {
  test("AC-18 AC-19 ctrl+x stops nothing and leaves the picker as it was", async () => {
    const tasks = fakeTasks([task()]);
    const jobs = fakeJobs([job()]);
    const ui = mount({ tasks: tasks.port, jobs: jobs.port });
    await ui.submit("/model");
    const before = frame(ui, MODEL_TITLE);
    await stopKey(ui);
    expect(tasks.stop).not.toHaveBeenCalled();
    expect(jobs.cancel).not.toHaveBeenCalled();
    expect(before.inside.length).toBeGreaterThan(0);
    expect(frame(ui, MODEL_TITLE)).toEqual(before);
  });
});
