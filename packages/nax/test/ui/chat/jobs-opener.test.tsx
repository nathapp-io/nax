import { afterEach, describe, expect, mock, test } from "bun:test";
import { mountChatPicker as mount } from "@test/helpers";
import { cleanup } from "ink-testing-library";
import type { BackgroundTask, ChatBackgroundTasks } from "@/chat/background/task-types";
import type { ChatJobs } from "@/chat/jobs/job-runner";
import { fakeMouse } from "./mouse";

const CTRL_G = "\x07";
const CTRL_X = "\x18";
const RETURN = "\r";
const TITLE = "Jobs and tasks · enter output · ctrl+x stop";
const MODEL_TITLE = "Switch model";
const BUSY_NOTICE = "wait for the turn to finish (Ctrl-C to interrupt)";
const UNAVAILABLE = "jobs are not available in this session";
const TASK_ID = "bash-1a2b3c4d";
const COMMAND = "bun run test";
const STRIP = `bash ${COMMAND}`;
const FLUSHES = 6;
afterEach(cleanup);

function task(patch: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: TASK_ID,
    command: COMMAND,
    origin: "agent",
    startedAt: new Date().toISOString(),
    state: "running",
    logPath: "/log",
    ...patch,
  };
}

function fakeTasks(rows: BackgroundTask[], read: ChatBackgroundTasks["output"] = async () => "") {
  const stop = mock<ChatBackgroundTasks["stop"]>((id) => rows.find((row) => row.id === id) ?? task());
  const port: ChatBackgroundTasks = {
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
    onChange: () => () => {},
    list: () => rows,
    get: (id) => rows.find((row) => row.id === id),
    running: () => rows.filter((row) => row.state === "running"),
    output: read,
  };
  return { port, stop };
}

function fakeJobs(): ChatJobs {
  return {
    list: () => [],
    running: () => [],
    owned: () => [],
    get: () => undefined,
    start: async () => {
      throw new Error("unused");
    },
    cancel: async () => {
      throw new Error("unused");
    },
    canCancel: async () => ({ ok: true }),
    attach: async () => {},
    logTail: async () => "",
    dispose: () => {},
    peekNotice: () => undefined,
    takeNotice: () => undefined,
    onChange: () => () => {},
  };
}

type Ui = ReturnType<typeof mount>;

const text = (ui: Ui): string => ui.rows().join("\n");
const flush = async (ui: Ui): Promise<void> => {
  for (let at = 0; at < FLUSHES; at += 1) await ui.settle();
};

/** A mounted screen with one running task and a fake mouse; the strip's cell is read off the frame. */
function withStrip(options: { tasks?: ReturnType<typeof fakeTasks> } = {}) {
  const mouse = fakeMouse();
  const tasks = options.tasks ?? fakeTasks([task()]);
  const ui = mount({ tasks: tasks.port, mouse: mouse.events });
  const rows = ui.rows();
  const footerRow = rows.length;
  const footer = rows[footerRow - 1] ?? "";
  const stripColumn = footer.indexOf(STRIP) + 1;
  /** A press and a release, each in its own act so the frame read afterwards is the one they produced. */
  const click = (press: { x: number; y: number }, release = press, button: "left" | "right" = "left"): void => {
    mouse.emit("press", { button, ...press });
    mouse.emit("release", { button, ...release });
  };
  return { ui, mouse, tasks, footerRow, stripColumn, click };
}

describe("ctrl+g", () => {
  test("AC-6 opens the jobs picker over a running task", async () => {
    const ui = mount({ tasks: fakeTasks([task()]).port });
    ui.press(CTRL_G);
    await flush(ui);
    expect(ui.rows()).toContain(TITLE);
  });
  test("AC-7 leaves an open model picker alone", async () => {
    const ui = mount({ tasks: fakeTasks([task()]).port });
    await ui.submit("/model");
    ui.press(CTRL_G);
    await flush(ui);
    expect(ui.rows()).toContain(MODEL_TITLE);
    expect(ui.rows()).not.toContain(TITLE);
  });
  test("AC-8 opens no picker while an approval ask card is pending", async () => {
    const ui = mount({ tasks: fakeTasks([task()]).port });
    await ui.settleAfter(() => {
      void ui.host.asks.requestHostApproval({ tool: "bash", summary: "run it", reason: "needs approval" });
    });
    expect(ui.host.asks.pending()).toHaveLength(1);
    ui.press(CTRL_G);
    await flush(ui);
    expect(ui.rows()).not.toContain(TITLE);
  });
  test("AC-9 opens no picker while the slash menu is shown", async () => {
    const ui = mount({ tasks: fakeTasks([task()]).port });
    ui.press("/");
    await flush(ui);
    expect(text(ui)).toContain("/help");
    ui.press(CTRL_G);
    await flush(ui);
    expect(ui.rows()).not.toContain(TITLE);
  });
  test("AC-10 notes that jobs are unavailable on a host with neither jobs nor tasks", async () => {
    const ui = mount();
    ui.press(CTRL_G);
    await flush(ui);
    expect(text(ui)).toContain(UNAVAILABLE);
    expect(ui.rows()).not.toContain(TITLE);
  });
});

describe("a click on the footer strip", () => {
  test("AC-11 opens the jobs picker at the strip's first column on the footer row", async () => {
    const { ui, footerRow, stripColumn, click } = withStrip();
    expect(stripColumn).toBeGreaterThan(0);
    click({ x: stripColumn, y: footerRow });
    await flush(ui);
    expect(ui.rows()).toContain(TITLE);
  });
  test("the strip's last column opens it too", async () => {
    const { ui, footerRow, stripColumn, click } = withStrip();
    click({ x: stripColumn + STRIP.length - 1, y: footerRow });
    await flush(ui);
    expect(ui.rows()).toContain(TITLE);
  });
  test("AC-12 one column left of the strip opens nothing", async () => {
    const { ui, footerRow, stripColumn, click } = withStrip();
    click({ x: stripColumn - 1, y: footerRow });
    await flush(ui);
    expect(ui.rows()).not.toContain(TITLE);
  });
  test("AC-13 a release on a different cell opens nothing", async () => {
    const { ui, footerRow, stripColumn, click } = withStrip();
    click({ x: stripColumn, y: footerRow }, { x: stripColumn + 1, y: footerRow });
    await flush(ui);
    expect(ui.rows()).not.toContain(TITLE);
  });
  test("AC-14 a right-button click opens nothing", async () => {
    const { ui, footerRow, stripColumn, click } = withStrip();
    click({ x: stripColumn, y: footerRow }, undefined, "right");
    await flush(ui);
    expect(ui.rows()).not.toContain(TITLE);
  });
  test("AC-15 opens nothing while an approval ask card is pending", async () => {
    const { ui, footerRow, stripColumn, click } = withStrip();
    await ui.settleAfter(() => {
      void ui.host.asks.requestHostApproval({ tool: "bash", summary: "run it", reason: "needs approval" });
    });
    click({ x: stripColumn, y: footerRow });
    await flush(ui);
    expect(ui.rows()).not.toContain(TITLE);
  });
  test("AC-16 leaves an open picker as it was", async () => {
    const { ui, footerRow, stripColumn, click } = withStrip();
    await ui.submit("/model");
    click({ x: stripColumn, y: footerRow });
    await flush(ui);
    expect(ui.rows()).toContain(MODEL_TITLE);
    expect(ui.rows()).not.toContain(TITLE);
  });
  test("AC-17 opens nothing while the slash menu is shown", async () => {
    const { ui, footerRow, stripColumn, click } = withStrip();
    ui.press("/");
    await flush(ui);
    click({ x: stripColumn, y: footerRow });
    await flush(ui);
    expect(ui.rows()).not.toContain(TITLE);
  });
  test("drops its mouse subscription when the screen unmounts", () => {
    const { ui, mouse } = withStrip();
    const mounted = mouse.listeners.size;
    expect(mounted).toBeGreaterThan(0);
    ui.ui.unmount();
    expect(mouse.listeners.size).toBe(0);
  });
});

describe("while a turn is running", () => {
  /** The turn opens and its stream stays open: the host's send has not settled. */
  async function running(tasks: ReturnType<typeof fakeTasks>): Promise<Ui> {
    const ui = mount({ tasks: tasks.port, jobs: fakeJobs() });
    await ui.submit("hello");
    await ui.submit("/help");
    expect(text(ui)).toContain(BUSY_NOTICE);
    return ui;
  }

  test("AC-18 ctrl+g opens the jobs picker", async () => {
    const ui = await running(fakeTasks([task()]));
    ui.press(CTRL_G);
    await flush(ui);
    expect(ui.rows()).toContain(TITLE);
    await ui.finish();
  });
  test("AC-19 Enter on a task lists its output in the transcript", async () => {
    const tasks = fakeTasks([task()], async () => "line1\nline2");
    const ui = await running(tasks);
    ui.press(CTRL_G);
    await flush(ui);
    ui.press(RETURN);
    await flush(ui);
    expect(ui.rows()).not.toContain(TITLE);
    expect(text(ui)).toContain(`bash ${COMMAND} · running`);
    expect(text(ui)).toContain("line2");
    await ui.finish();
  });
  test("AC-20 ctrl+x stops the highlighted running task", async () => {
    const tasks = fakeTasks([task()]);
    const ui = await running(tasks);
    ui.press(CTRL_G);
    await flush(ui);
    ui.press(CTRL_X);
    await flush(ui);
    expect(tasks.stop).toHaveBeenCalledTimes(1);
    expect(tasks.stop).toHaveBeenCalledWith(TASK_ID);
    await ui.finish();
  });
});
