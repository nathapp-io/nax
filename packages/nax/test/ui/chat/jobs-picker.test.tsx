import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  pickerEntryRows as entryRows,
  pickerFrameOf as frameOf,
  pickerLabelOf as labelOf,
  mountChatPicker as mount,
} from "@test/helpers";
import { cleanup } from "ink-testing-library";
import type { ChatHost } from "@/chat";
import type { BackgroundTask, ChatBackgroundTasks } from "@/chat/background/task-types";
import type { ChatJobs } from "@/chat/jobs/job-runner";
import type { ChatJob } from "@/chat/jobs/job-types";

const RETURN = "\r";
const ESCAPE = "\x1b";
const CTRL_O = "\x0f";
const TITLE = "Jobs and tasks · enter output · ctrl+x stop";
const TASK_ID = "bash-1a2b3c4d";
const JOB_ID = "run-0000aaaa";
const OUTPUT_LINES = 40;
afterEach(cleanup);

function task(patch: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: TASK_ID,
    command: "bun run test",
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
  readonly output: ReturnType<typeof mock<ChatBackgroundTasks["output"]>>;
  rows: BackgroundTask[];
  /** Ids `get` no longer knows although `list` still returns them. */
  forgotten: Set<string>;
  fire(): void;
}

function fakeTasks(rows: BackgroundTask[], read: ChatBackgroundTasks["output"] = async () => ""): TasksFixture {
  const listeners = new Set<() => void>();
  const output = mock<ChatBackgroundTasks["output"]>(read);
  const fixture: TasksFixture = {
    rows,
    forgotten: new Set(),
    output,
    fire: () => {
      for (const listener of listeners) listener();
    },
    port: {
      adopt: () => {
        throw new Error("unused");
      },
      foreground: () => () => {},
      stop: () => {
        throw new Error("unused");
      },
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
      get: (id) => (fixture.forgotten.has(id) ? undefined : fixture.rows.find((row) => row.id === id)),
      running: () => fixture.rows.filter((row) => row.state === "running"),
      output,
    },
  };
  return fixture;
}

interface JobsFixture {
  readonly port: ChatJobs;
  readonly logTail: ReturnType<typeof mock<ChatJobs["logTail"]>>;
  forgotten: Set<string>;
}

function fakeJobs(rows: ChatJob[], read: ChatJobs["logTail"] = async () => ""): JobsFixture {
  const logTail = mock<ChatJobs["logTail"]>(read);
  const forgotten = new Set<string>();
  return {
    logTail,
    forgotten,
    port: {
      list: () => rows,
      running: () => rows.filter((row) => row.state === "running"),
      owned: () => [],
      get: (id) => (forgotten.has(id) ? undefined : rows.find((row) => row.id === id)),
      start: async () => {
        throw new Error("unused");
      },
      cancel: async () => {
        throw new Error("unused");
      },
      canCancel: async () => ({ ok: true }),
      attach: async () => {},
      logTail,
      dispose: () => {},
      peekNotice: () => undefined,
      takeNotice: () => undefined,
      onChange: () => () => {},
    },
  };
}

const text = (ui: ReturnType<typeof mount>): string => ui.rows().join("\n");
const pickerEntries = (ui: ReturnType<typeof mount>) => entryRows(frameOf(ui.rows(), TITLE).inside);

async function openWith(options: { tasks?: TasksFixture; jobs?: JobsFixture; send?: ChatHost["send"] }) {
  const ui = mount({
    ...(options.tasks ? { tasks: options.tasks.port } : {}),
    ...(options.jobs ? { jobs: options.jobs.port } : {}),
    ...(options.send ? { send: options.send } : {}),
  });
  await ui.submit("/jobs");
  return ui;
}

describe("/jobs opens the picker", () => {
  test("AC-1 opens the titled picker", async () => {
    const ui = await openWith({ jobs: fakeJobs([job()]) });
    expect(ui.rows()).toContain(TITLE);
    expect(pickerEntries(ui).map(labelOf)).toEqual(["run f1"]);
  });
  test("AC-2 does not call send", async () => {
    const send = mock<ChatHost["send"]>(async () => {});
    await openWith({ jobs: fakeJobs([job()]), send });
    expect(send).not.toHaveBeenCalled();
  });
  test("AC-3 ignores arguments", async () => {
    const ui = mount({ jobs: fakeJobs([job()]).port });
    await ui.submit("/jobs foo");
    expect(ui.rows()).toContain(TITLE);
  });
  test("AC-4 AC-5 reports unavailable with neither capability and opens no picker", async () => {
    const ui = mount();
    await ui.submit("/jobs");
    expect(text(ui)).toContain("jobs are not available in this session");
    expect(ui.rows()).not.toContain(TITLE);
  });
  test("AC-6 help lists the new description", async () => {
    const ui = mount();
    await ui.submit("/help");
    expect(text(ui)).toContain("/jobs  Show nax jobs and background tasks");
  });
  test("a tasks-only host opens the picker too", async () => {
    const ui = await openWith({ tasks: fakeTasks([task()]) });
    expect(ui.rows()).toContain(TITLE);
  });
});

describe("Enter on a task row", () => {
  test("AC-7 closes the picker", async () => {
    const tasks = fakeTasks([task()], async () => "line1\nline2");
    const ui = await openWith({ tasks });
    ui.press(RETURN);
    await ui.settle();
    expect(ui.rows()).not.toContain(TITLE);
    expect(tasks.output).toHaveBeenCalledWith(TASK_ID, OUTPUT_LINES);
  });
  test("AC-8 shows a listing titled label · state with the output lines", async () => {
    const tasks = fakeTasks([task()], async () => "line1\nline2");
    const ui = await openWith({ tasks });
    ui.press(RETURN);
    await ui.settle();
    // The listing opens collapsed, so ctrl+o is what reveals the lines it counted.
    ui.press(CTRL_O);
    await ui.settle();
    const rows = ui.rows();
    const title = rows.indexOf("bash bun run test · running");
    expect(title).toBeGreaterThan(-1);
    expect(rows.filter((row) => row.includes("bash bun run test · running"))).toHaveLength(1);
    expect(rows.slice(title + 1).filter((row) => row.trim() === "line1" || row.trim() === "line2")).toEqual([
      expect.stringContaining("line1"),
      expect.stringContaining("line2"),
    ]);
    expect(tasks.output).toHaveBeenCalledWith(TASK_ID, OUTPUT_LINES);
  });
  test("AC-11 an empty output reads (no output yet)", async () => {
    const ui = await openWith({ tasks: fakeTasks([task()], async () => "") });
    ui.press(RETURN);
    await ui.settle();
    ui.press(CTRL_O);
    await ui.settle();
    expect(text(ui)).toContain("(no output yet)");
  });
});

describe("US-012 Enter on a finished task row", () => {
  /** The screen after choosing a finished task that printed two lines. */
  async function chosenTask() {
    const tasks = fakeTasks([task({ state: "succeeded" })], async () => "line1\nline2");
    const ui = await openWith({ tasks });
    ui.press(RETURN);
    await ui.settle();
    return { ui, tasks };
  }

  test("AC-7 adds a listing whose title row is followed by the count of the lines it withholds", async () => {
    const { ui, tasks } = await chosenTask();
    const rows = ui.rows();
    const title = rows.indexOf("bash bun run test · succeeded");
    expect(title).toBeGreaterThan(-1);
    expect(rows[title + 1]).toContain("2 lines (ctrl+o to show)");
    expect(tasks.output).toHaveBeenCalledWith(TASK_ID, OUTPUT_LINES);
  });

  test("AC-7 draws none of the task's output lines", async () => {
    const { ui } = await chosenTask();
    expect(text(ui)).not.toContain("line1");
    expect(text(ui)).not.toContain("line2");
  });

  test("AC-8 ctrl+o draws the task's output lines", async () => {
    const { ui } = await chosenTask();
    expect(text(ui)).not.toContain("line1");
    ui.press(CTRL_O);
    await ui.settle();
    expect(text(ui)).toContain("line1");
    expect(text(ui)).toContain("line2");
  });
});

describe("Enter on a job row", () => {
  test("AC-9 reads the log tail of the highlighted job", async () => {
    const jobs = fakeJobs([job()], async () => "job log");
    const ui = await openWith({ jobs });
    ui.press(RETURN);
    await ui.settle();
    expect(jobs.logTail).toHaveBeenCalledWith(JOB_ID, OUTPUT_LINES);
  });
  test("AC-10 shows a listing titled label · state with the log text", async () => {
    const jobs = fakeJobs([job()], async () => "job log");
    const ui = await openWith({ jobs });
    ui.press(RETURN);
    await ui.settle();
    expect(ui.rows()).toContain("run f1 · running");
    // The listing opens collapsed, so ctrl+o is what reveals the log it counted.
    ui.press(CTRL_O);
    await ui.settle();
    expect(text(ui)).toContain("job log");
    expect(jobs.logTail).toHaveBeenCalledWith(JOB_ID, OUTPUT_LINES);
  });
});

describe("Enter on a row that is gone", () => {
  test("AC-12 AC-13 notices the id and appends no listing", async () => {
    const tasks = fakeTasks([task()]);
    const jobs = fakeJobs([]);
    const ui = await openWith({ tasks, jobs });
    tasks.forgotten.add(TASK_ID);
    ui.press(RETURN);
    await ui.settle();
    expect(text(ui)).toContain(`${TASK_ID} is no longer listed`);
    expect(text(ui)).not.toContain("(no output yet)");
    expect(text(ui)).not.toContain("bash bun run test · running");
    expect(tasks.output).not.toHaveBeenCalled();
    expect(jobs.logTail).not.toHaveBeenCalled();
  });
});

describe("a rejected read", () => {
  test("AC-14 AC-15 a rejected task output closes the picker and shows an error entry", async () => {
    const gate = Promise.withResolvers<string>();
    const ui = await openWith({ tasks: fakeTasks([task()], () => gate.promise) });
    ui.press(RETURN);
    await ui.settle();
    expect(ui.rows()).not.toContain(TITLE);
    expect(text(ui)).not.toContain("boom");
    await ui.settleAfter(() => gate.reject(new Error("boom")));
    await ui.settle();
    expect(ui.rows()).not.toContain(TITLE);
    expect(text(ui)).toContain("boom");
  });
  test("AC-16 AC-17 a rejected log tail closes the picker first and shows an error entry", async () => {
    const gate = Promise.withResolvers<string>();
    const ui = await openWith({ jobs: fakeJobs([job()], () => gate.promise) });
    ui.press(RETURN);
    await ui.settle();
    expect(ui.rows()).not.toContain(TITLE);
    expect(text(ui)).not.toContain("boom");
    await ui.settleAfter(() => gate.reject(new Error("boom")));
    await ui.settle();
    expect(ui.rows()).not.toContain(TITLE);
    expect(text(ui)).toContain("boom");
  });
});

describe("leaving and staying local", () => {
  test("AC-18 AC-19 escape closes the picker and reads nothing", async () => {
    const tasks = fakeTasks([task()]);
    const jobs = fakeJobs([job()]);
    const ui = await openWith({ tasks, jobs });
    ui.press(ESCAPE);
    await ui.settle();
    expect(ui.rows()).not.toContain(TITLE);
    expect(tasks.output).not.toHaveBeenCalled();
    expect(jobs.logTail).not.toHaveBeenCalled();
  });
  test("AC-20 Enter never switches or resumes a session", async () => {
    const ui = await openWith({ tasks: fakeTasks([task()], async () => "x"), jobs: fakeJobs([job()]) });
    ui.press(RETURN);
    await ui.settle();
    expect(ui.switchTo).not.toHaveBeenCalled();
    expect(ui.resume).not.toHaveBeenCalled();
  });
  test("AC-21 a task that finishes redraws its row without reopening the picker", async () => {
    const tasks = fakeTasks([task()]);
    const ui = await openWith({ tasks });
    expect(pickerEntries(ui)[0]).toContain("running");
    tasks.rows = [task({ state: "succeeded" })];
    await ui.settleAfter(() => tasks.fire());
    const row = pickerEntries(ui)[0] ?? "";
    expect(row).toContain("succeeded");
    expect(row).not.toContain("running");
  });
});
