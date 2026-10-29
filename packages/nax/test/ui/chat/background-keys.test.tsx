import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanupTempDir, makeLogger, makeTempDir, mountChatPicker } from "@test/helpers";
import { cleanup } from "ink-testing-library";
import { createBackgroundTasks } from "@/chat/background";
import { _chatAppDeps } from "@/tui/chat/ChatApp";

const CTRL_B = "\x02";
const NOTICE = "no running command to move to the background";
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  cleanup();
  for (const dispose of disposers.splice(0)) await dispose();
  mock.restore();
});

function tasksFixture() {
  const dir = makeTempDir("background-keys-");
  const tasks = createBackgroundTasks({ outputDir: dir, now: () => new Date(), logger: makeLogger() });
  disposers.push(async () => {
    await tasks.stopAll();
    cleanupTempDir(dir);
  });
  return tasks;
}

describe("background footer", () => {
  test.each([
    ["AC-11", undefined, "ctrl+b to background"],
    ["AC-12", "/tmp/tmux-501/default,123,0", "ctrl+b ctrl+b to background"],
  ] as const)("%s shows the tmux-aware hint and AC-13 reacts without a keypress", async (_ac, tmux, hint) => {
    const readTmux = spyOn(_chatAppDeps, "tmux").mockReturnValue(tmux);
    const tasks = tasksFixture();
    let foreground = false;
    spyOn(tasks, "hasForeground").mockImplementation(() => foreground);
    let changed = () => {};
    const unsubscribe = mock(() => {});
    spyOn(tasks, "onChange").mockImplementation((listener) => {
      changed = listener;
      return unsubscribe;
    });
    const ui = mountChatPicker({ tasks });
    await ui.submit("work");
    expect(ui.rows().at(-1)).not.toContain("to background");
    await ui.settleAfter(() => {
      foreground = true;
      changed();
    });
    expect(ui.rows().at(-1)).toContain(`esc to interrupt · ${hint}`);
    await ui.settleAfter(() => {
      foreground = false;
      changed();
    });
    expect(ui.rows().at(-1)).toContain("esc to interrupt");
    expect(ui.rows().at(-1)).not.toContain("to background");
    expect(readTmux).toHaveBeenCalledTimes(1);
    await ui.finish();
    ui.ui.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("background keys", () => {
  test("AC-1 AC-2 busy ctrl+b moves exactly once without a notice", async () => {
    const tasks = tasksFixture();
    const move = spyOn(tasks, "moveForeground").mockReturnValue(true);
    const ui = mountChatPicker({ tasks });
    await ui.submit("work");
    const before = ui.ui.lastFrame();
    ui.press(CTRL_B);
    await ui.settle();
    expect(move).toHaveBeenCalledTimes(1);
    expect(ui.ui.lastFrame()).toBe(before);
    expect(ui.ui.lastFrame()).not.toContain(NOTICE);
    expect(ui.host.cancel).not.toHaveBeenCalled();
    await ui.finish();
  });
  test.each(["AC-3 false", "AC-4 absent"])("%s ctrl+b appends the unavailable notice", async (scenario) => {
    const tasks = scenario === "AC-3 false" ? tasksFixture() : undefined;
    const move = tasks ? spyOn(tasks, "moveForeground").mockReturnValue(false) : undefined;
    const ui = mountChatPicker({ tasks });
    await ui.submit("work");
    ui.press(CTRL_B);
    await ui.settle();
    expect(ui.ui.lastFrame()).toContain(NOTICE);
    if (move) expect(move).toHaveBeenCalledTimes(1);
    expect(ui.host.cancel).not.toHaveBeenCalled();
    await ui.finish();
  });
});
