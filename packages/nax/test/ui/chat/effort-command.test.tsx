import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { CHAT_MODEL, makeSubagentHostHarness, mountChatPicker as mount, pickerFrameOf } from "@test/helpers";
import { cleanup } from "ink-testing-library";
import { EFFORT_LEVELS } from "@/chat";
import { COMMAND_DESCRIPTIONS, COMMANDS } from "@/tui/chat/slash-commands";

const DOWN = "\x1b[B";
const RETURN = "\r";
const TITLE = "Reasoning effort";
afterEach(() => {
  cleanup();
  mock.restore();
});

describe("model-supported effort", () => {
  const levels = ["default", "low", "high", "max"] as const;
  test("US-002 AC-1 lists exactly the model's supported levels", async () => {
    const ui = mount({ current: { model: "p/m" }, effortLevels: () => levels });
    await ui.submit("/effort");
    expect(pickerFrameOf(ui.rows(), TITLE).inside).toEqual(["❯ default  (current)", "  low", "  high", "  max"]);
  });
  test.each([
    ["AC-2 AC-3", "medium", 'effort "medium" is not available for p/m; use one of: default, low, high, max'],
    ["AC-4 AC-5", "bogus", 'unknown effort "bogus"; use one of: default, low, high, max'],
  ])("US-002 %s rejects %s without switching", async (_ac, level, message) => {
    const ui = mount({ current: { model: "p/m" }, effortLevels: () => levels });
    await ui.submit(`/effort ${level}`);
    expect(ui.switchTo).not.toHaveBeenCalled();
    expect(ui.rows().join("\n")).toContain(message);
  });
});

describe("effort command", () => {
  test("AC-1 AC-2 registers effort immediately after model with its description", () => {
    expect(COMMANDS[COMMANDS.indexOf("model") + 1]).toBe("effort");
  });
  test("AC-2 describes effort switching", () => {
    expect(Object.entries(COMMAND_DESCRIPTIONS)).toContainEqual(["effort", "Switch reasoning effort"]);
  });
  test.each([
    ["AC-3", "p/m[low]", "high", "p/m[high]"],
    ["AC-4", "p/m[low]", "default", "p/m"],
    ["AC-13", "p/m", "HIGH", "p/m[high]"],
    ["AC-20", "p/m[high]", "high", "p/m[high]"],
    ["unknown suffix rewritten", "p/m[turbo]", "default", "p/m"],
  ])("%s switches only the effort", async (_ac, model, level, expected) => {
    const ui = mount({ current: { model } });
    await ui.submit(`/effort ${level}`);
    expect(ui.switchTo).toHaveBeenCalledTimes(1);
    expect(ui.switchTo).toHaveBeenCalledWith({ model: expected });
    expect(ui.resume).not.toHaveBeenCalled();
  });
  test.each([
    ["AC-5 AC-6", "turbo", 'unknown effort "turbo"; use one of: default, off, minimal, low, medium, high, xhigh, max'],
    [
      "preserves invalid spelling",
      "TuRbO",
      'unknown effort "TuRbO"; use one of: default, off, minimal, low, medium, high, xhigh, max',
    ],
    ["AC-14 AC-15", "high now", "usage: /effort [level]"],
  ])("%s rejects invalid arguments", async (_ac, args, message) => {
    const ui = mount();
    await ui.submit(`/effort ${args}`);
    expect(ui.rows().join("\n")).toContain(message);
    expect(ui.switchTo).not.toHaveBeenCalled();
  });
  test("AC-17 AC-18 rejected command reports error and preserves host model", async () => {
    const ui = mount({
      current: { model: "p/m[low]" },
      switchTo: async () => {
        throw new Error("opening failed");
      },
    });
    const previous = ui.host.current();
    await ui.submit("/effort high");
    expect(ui.switchTo).toHaveBeenCalledWith({ model: "p/m[high]" });
    expect(ui.rows().join("\n")).toContain("✗ opening failed");
    expect(ui.host.current()).toBe(previous);
    expect(ui.host.current().model).toBe("p/m[low]");
  });
  test("AC-21 same effort uses the existing host session without reopening", async () => {
    const harness = makeSubagentHostHarness();
    try {
      await harness.host.start({ mode: "guarded", model: `${CHAT_MODEL}[high]` });
      const previous = harness.host.current();
      const switchTo = spyOn(harness.host, "switchTo");
      const ui = mount({ host: harness.host });
      await ui.submit("/effort high");
      expect(switchTo).toHaveBeenCalledWith({ model: `${CHAT_MODEL}[high]` });
      expect(harness.chatSessions).toHaveLength(1);
      expect(harness.host.current().sessionId).toBe(previous.sessionId);
      expect(harness.host.current().model).toBe(`${CHAT_MODEL}[high]`);
    } finally {
      await harness.dispose();
    }
  });
});

describe("mounted effort picker", () => {
  test("AC-7 AC-8 AC-9 shows eight ordered levels with current marked", async () => {
    const ui = mount({ current: { model: "p/m[low]" } });
    await ui.submit("/effort");
    expect(ui.rows()).toContain(TITLE);
    expect(pickerFrameOf(ui.rows(), TITLE).inside).toEqual(
      EFFORT_LEVELS.map((level, i) => `${i === 0 ? "❯ " : "  "}${level}${level === "low" ? "  (current)" : ""}`),
    );
    expect(ui.listSessions).not.toHaveBeenCalled();
  });
  test("unknown suffix is marked default", async () => {
    const ui = mount({ current: { model: "p/m[turbo]" } });
    await ui.submit("/effort");
    expect(pickerFrameOf(ui.rows(), TITLE).inside[0]).toBe("❯ default  (current)");
  });
  test("AC-10 AC-16 choosing xhigh switches and never resumes", async () => {
    const ui = mount({ current: { model: "p/m[low]" } });
    await ui.submit("/effort");
    for (let i = 0; i < 6; i++) ui.press(DOWN);
    ui.press(RETURN);
    await ui.settle();
    expect(ui.switchTo).toHaveBeenCalledWith({ model: "p/m[xhigh]" });
    expect(ui.resume).not.toHaveBeenCalled();
    expect(ui.rows()).not.toContain(TITLE);
  });
  test("selection reads the host model at choose time, not opening time", async () => {
    const ui = mount({ current: { model: "p/m[low]" } });
    await ui.submit("/effort");
    Object.assign(ui.host.current(), { model: "q/new[turbo]" });
    for (let i = 0; i < 6; i++) ui.press(DOWN);
    ui.press(RETURN);
    await ui.settle();
    expect(ui.switchTo).toHaveBeenCalledWith({ model: "q/new[xhigh]" });
    expect(ui.resume).not.toHaveBeenCalled();
  });
  test("AC-11 AC-12 escape closes without switching", async () => {
    const ui = mount();
    await ui.submit("/effort");
    expect(ui.rows()).toContain(TITLE);
    ui.press("\x1b");
    expect(ui.rows()).not.toContain(TITLE);
    expect(ui.switchTo).not.toHaveBeenCalled();
    expect(ui.resume).not.toHaveBeenCalled();
  });
  test("AC-22 rejected choice uses transcript error route", async () => {
    const ui = mount({
      current: { model: "p/m[low]" },
      switchTo: async () => {
        throw new Error("picker opening failed");
      },
    });
    await ui.submit("/effort");
    ui.press(DOWN);
    ui.press(RETURN);
    await ui.settle();
    expect(ui.switchTo).toHaveBeenCalledWith({ model: "p/m[off]" });
    expect(ui.rows().join("\n")).toContain("✗ picker opening failed");
    expect(ui.rows()).not.toContain(TITLE);
    expect(ui.resume).not.toHaveBeenCalled();
    expect(ui.host.current().model).toBe("p/m[low]");
  });
});
