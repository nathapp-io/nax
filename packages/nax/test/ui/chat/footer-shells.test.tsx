import { afterEach, describe, expect, mock, test } from "bun:test";
import { mountChatPicker } from "@test/helpers";
import { Box } from "ink";
import { cleanup, render } from "ink-testing-library";
import { act } from "react";
import type { BackgroundTask, ChatBackgroundTasks } from "@/chat/background/task-types";
import type { ChatJobs } from "@/chat/jobs/job-runner";
import type { ChatJob } from "@/chat/jobs/job-types";
import { displayWidth, type StyledLine } from "@/tui/chat/styled-line";
import { TranscriptViewport } from "@/tui/chat/TranscriptViewport";
import { resolveChatTheme } from "@/tui/chat/theme";
import { fakeMouse } from "./mouse";

/** Colour off, so a frame row is the plain text and no assertion depends on escapes. */
const THEME = resolveChatTheme({ env: {}, colorLevel: 0 });
const PAGE_UP = "\x1b[5~";
const END = "\x1b[F";
const CTRL_G = "\x07";
const SCROLL_MARKER = "↓ Scroll to bottom (End)";
const UNSEEN_MARKER = "↓ 3 new lines (End)";
const HEIGHT = 5;
const WIDE = 60;
const NARROW = 10;
const TITLE = "Jobs and tasks · enter output · ctrl+x stop";
const TASK_ID = "bash-1a2b3c4d";
const OTHER_TASK_ID = "bash-5e6f7a8b";
const COMMAND = "sleep 60";
const STRIP = "1 shell";
const LISTING = `bash ${COMMAND} · running`;
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
    sessionId: "footer-shells",
    approvedAt: new Date().toISOString(),
    ...patch,
  };
}

function fakeTasks(rows: readonly BackgroundTask[]): ChatBackgroundTasks {
  return {
    adopt: () => {
      throw new Error("unused");
    },
    adoptAgent: () => {
      throw new Error("unused");
    },
    foreground: () => () => {},
    stop: mock<ChatBackgroundTasks["stop"]>((id) => rows.find((row) => row.id === id) ?? task()),
    stopAll: async () => {},
    moveForeground: () => false,
    hasForeground: () => false,
    peekNotice: () => undefined,
    takeNotice: () => undefined,
    onChange: () => () => {},
    list: () => rows,
    get: (id) => rows.find((row) => row.id === id),
    running: () => rows.filter((row) => row.state === "running"),
    output: async () => "",
  };
}

function fakeJobs(rows: readonly ChatJob[] = []): ChatJobs {
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
    logTail: async () => "",
    dispose: () => {},
    peekNotice: () => undefined,
    takeNotice: () => undefined,
    onChange: () => () => {},
  };
}

type Ui = ReturnType<typeof mountChatPicker>;

const text = (ui: Ui): string => ui.rows().join("\n");
const footerRowOf = (ui: Ui): string => ui.rows().at(-1) ?? "";
const stripColumn = (ui: Ui): number => footerRowOf(ui).indexOf(STRIP) + 1;
const flush = async (ui: Ui): Promise<void> => {
  for (let at = 0; at < FLUSHES; at += 1) await ui.settle();
};

/** The screen over the given registries, a mouse, and the click the strip's cases send. */
function withShell(
  options: {
    readonly tasks?: readonly BackgroundTask[];
    readonly jobs?: readonly ChatJob[];
    /** The strip part the footer draws, whose first column the click lands on. */
    readonly strip?: string;
  } = {},
) {
  const mouse = fakeMouse();
  const ui = mountChatPicker({
    tasks: fakeTasks(options.tasks ?? [task()]),
    jobs: fakeJobs(options.jobs),
    mouse: mouse.events,
  });
  /** The strip's own column in the footer row, whose hit-test covers the whole strip. */
  const column = (): number => footerRowOf(ui).indexOf(options.strip ?? STRIP) + 1;
  /** A press and a release in one act, so the frame read afterwards is the one they produced. */
  const click = (button: "left" | "right" = "left"): void => {
    const x = column();
    act(() => {
      mouse.emit("press", { button, x, y: ui.rows().length });
      mouse.emit("release", { button, x, y: ui.rows().length });
    });
  };
  return { ui, mouse, column, click };
}

describe("the footer strip's shell part", () => {
  test("AC-6 a lone running host task reads as one shell, never as its command", async () => {
    const ui = mountChatPicker({ tasks: fakeTasks([task()]) });
    await flush(ui);
    expect(footerRowOf(ui)).toContain(STRIP);
    expect(footerRowOf(ui)).not.toContain("bash ");
  });
});

describe("the transcript marker row", () => {
  /** `count` one-span lines, so a frame row names the transcript line it shows. */
  function numbered(count: number): StyledLine[] {
    return Array.from({ length: count }, (_unused, index) => [{ text: `line ${index + 1}` }]);
  }

  /**
   * A viewport in a window of exactly `width` columns — a column box, as the screen mounts it, so
   * the rows are as wide as the window. The frame is read untrimmed, so the marker's indent counts.
   */
  function frameOf(lines: readonly StyledLine[], width: number) {
    return (
      <Box flexDirection="column" width={width}>
        <TranscriptViewport lines={lines} height={HEIGHT} theme={THEME} />
      </Box>
    );
  }

  function mountView(lines: readonly StyledLine[], width: number) {
    const ui = render(frameOf(lines, width));
    return {
      frame: (): string[] => (ui.lastFrame() ?? "").split("\n"),
      press: (sequence: string) =>
        act(() => {
          ui.stdin.write(sequence);
        }),
      update: (next: readonly StyledLine[]) =>
        Promise.resolve(
          act(async () => {
            ui.rerender(frameOf(next, width));
          }),
        ),
    };
  }

  /** The spaces the marker row is indented by, counted from the row's own text. */
  function leadingSpaces(row: string): number {
    return row.length - row.trimStart().length;
  }

  /** The columns the centred marker may start at: the floor or the ceiling of the even split. */
  function centred(row: string, width: number): number[] {
    const paint = displayWidth(row.trim());
    return [Math.floor((width - paint) / 2), Math.ceil((width - paint) / 2)];
  }

  test("AC-7 centres the scroll marker in a 60-column window", () => {
    const view = mountView(numbered(20), WIDE);
    view.press(PAGE_UP);
    const marker = view.frame().at(-1) ?? "";
    expect(marker.trim()).toBe(SCROLL_MARKER);
    expect(centred(marker, WIDE)).toContain(leadingSpaces(marker));
  });

  test("AC-8 centres the unseen marker by the width it is drawn at", async () => {
    const view = mountView(numbered(20), WIDE);
    view.press(PAGE_UP);
    await view.update(numbered(23));
    const marker = view.frame().at(-1) ?? "";
    expect(marker.trim()).toBe(UNSEEN_MARKER);
    // The unseen marker's own width, not the scroll marker's: the count makes it wider.
    expect(displayWidth(UNSEEN_MARKER)).not.toBe(displayWidth(SCROLL_MARKER));
    expect(centred(marker, WIDE)).toContain(leadingSpaces(marker));
  });

  test("AC-9 keeps the scroll marker inside a 10-column window", () => {
    const view = mountView(numbered(20), NARROW);
    view.press(PAGE_UP);
    const marker = view.frame().at(-1) ?? "";
    expect(marker.trimStart()).toStartWith("↓");
    expect(displayWidth(marker.trimEnd())).toBeLessThanOrEqual(NARROW);
  });

  test("end still returns the window to the newest line, so the marker is not drawn", () => {
    const view = mountView(numbered(20), WIDE);
    view.press(PAGE_UP);
    expect(view.frame().at(-1)?.trim()).toBe(SCROLL_MARKER);
    view.press(END);
    expect(view.frame().at(-1)?.trim()).toBe("line 20");
  });
});

describe("a strip click with a lone shell", () => {
  test("AC-10 appends the shell's output listing in the transcript", async () => {
    const { ui, click } = withShell();
    expect(stripColumn(ui)).toBeGreaterThan(0);
    click();
    await flush(ui);
    expect(text(ui)).toContain(LISTING);
  });

  test("AC-11 opens no picker", async () => {
    const { ui, click } = withShell();
    click();
    await flush(ui);
    expect(ui.rows()).not.toContain(TITLE);
  });

  test("AC-12 opens the jobs picker when two tasks run", async () => {
    const { ui, column, click } = withShell({
      tasks: [task(), task({ id: OTHER_TASK_ID, command: "bun test" })],
      strip: "2 shells",
    });
    expect(footerRowOf(ui)).toContain("2 shells");
    expect(column()).toBeGreaterThan(0);
    click();
    await flush(ui);
    expect(ui.rows()).toContain(TITLE);
  });

  test("AC-13 opens the jobs picker when a job runs beside the one task", async () => {
    const { ui, click } = withShell({ jobs: [job()] });
    // The shell is still counted beside the job, so the strip says there is more than one thing to see.
    expect(footerRowOf(ui)).toContain(`run feat · ${STRIP}`);
    click();
    await flush(ui);
    expect(ui.rows()).toContain(TITLE);
  });

  test("AC-14 ctrl+g still opens the jobs picker for the lone shell", async () => {
    const ui = mountChatPicker({ tasks: fakeTasks([task()]), jobs: fakeJobs() });
    ui.press(CTRL_G);
    await flush(ui);
    expect(ui.rows()).toContain(TITLE);
    expect(text(ui)).not.toContain(LISTING);
  });

  test("AC-15 a right-button strip click opens no picker", async () => {
    const { ui, click } = withShell();
    click("right");
    await flush(ui);
    expect(ui.rows()).not.toContain(TITLE);
  });

  test("AC-16 a right-button strip click appends no shell listing", async () => {
    const { ui, click } = withShell();
    click("right");
    await flush(ui);
    expect(text(ui)).not.toContain(LISTING);
  });
});
