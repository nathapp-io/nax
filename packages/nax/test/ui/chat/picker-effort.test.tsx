import { afterEach, describe, expect, test } from "bun:test";
import {
  pickerEntryRows as entryRows,
  pickerFrameOf as frameOf,
  pickerLabelOf as labelOf,
  mountChatPicker as mount,
} from "@test/helpers";
import { cleanup } from "ink-testing-library";
import { act } from "react";
import { cycleEffort, withEffort } from "@/chat";
import { pickerLayout, pickerModel } from "@/tui/chat/Picker";
import { plainText } from "@/tui/chat/styled-line";
import { resolveChatTheme } from "@/tui/chat/theme";

const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const DOWN = "\x1b[B";
const RETURN = "\r";
const ESCAPE = "\x1b";
const MODELS = ["p/a[high]", "p/a[low]", "p/b"];
afterEach(cleanup);
const model = (currentModel = "p/b", models = MODELS) =>
  pickerModel({ kind: "model", models, currentModel, currentMode: "guarded" });
const entries = (ui: ReturnType<typeof mount>) => entryRows(frameOf(ui.rows(), "Switch model").inside);
async function open(models: readonly string[] = MODELS) {
  const ui = mount({ models, current: { model: "p/b" } });
  await ui.submit("/model");
  return ui;
}

describe("pickerModel effort rows", () => {
  test("AC-1 deduplicates in first-seen base order", () => {
    expect(model().entries.map((entry) => entry.value)).toEqual(["p/a", "p/b"]);
  });
  test("AC-2 uses the first-seen suffix", () => {
    expect(model().entries[0]).toMatchObject({ original: "p/a[high]", effortLabel: "high" });
  });
  test("AC-3 labels an unsuffixed model default", () => {
    expect(model().entries[1]?.effortLabel).toBe("default");
  });
  test("AC-4 prefers the current model's suffix", () => {
    expect(model("p/a[low]").entries[0]).toMatchObject({ original: "p/a[low]", effortLabel: "low" });
  });
  test("AC-5 marks the base current", () => {
    expect(model("p/a[low]").entries[0]?.current).toBe(true);
  });
  test("sanitizes unknown effort detail without changing selection metadata", () => {
    const effort = "turbo\nboost\x07\r\t\x7f";
    const original = `m/x[${effort}]`;
    const rows = model(original, [original]);
    expect(rows.entries[0]).toMatchObject({
      value: "m/x",
      original,
      effortLabel: effort,
      detail: "effort turbo boost  ",
    });
    const layout = pickerLayout(rows, { width: 80, budget: 20, theme: resolveChatTheme({ env: {}, colorLevel: 0 }) });
    expect(layout.lines.map(plainText)).toContain("❯ m/x  effort turbo boost    (current)");
  });
  test.each([
    ["AC-6", "p/a[high]", "p/a", "high"],
    ["AC-7", "m/x[turbo]", "m/x", "turbo"],
  ])("%s renders effort detail", (_ac, original, base, effort) => {
    const rows = model(original, [original]);
    expect(rows.entries[0]).toMatchObject({ effortLabel: effort, detail: `effort ${effort}` });
    const layout = pickerLayout(rows, { width: 80, budget: 20, theme: resolveChatTheme({ env: {}, colorLevel: 0 }) });
    expect(layout.lines.map(plainText)).toContain(`❯ ${base}  effort ${effort}  (current)`);
  });
});

describe("mounted model effort", () => {
  test("AC-8 preserves an uncycled unknown suffix", async () => {
    const ui = await open(["m/x[turbo]"]);
    ui.press(RETURN);
    await ui.settle();
    expect(ui.switchTo).toHaveBeenCalledWith({ model: "m/x[turbo]" });
  });
  test.each([
    ["AC-9 batched right and Return", [RIGHT, RETURN], "p/a[xhigh]"],
    ["repeated batched arrows", [RIGHT, RIGHT, RETURN], "p/a[max]"],
    ["AC-12 left and Return", [LEFT, RETURN], "p/a[medium]"],
  ] as const)("%s", async (_name, keys, expected) => {
    const ui = mount({ models: ["p/a[high]", "p/b[low]"], current: { model: "p/z" } });
    await ui.submit("/model");
    act(() => {
      for (const key of keys) ui.ui.stdin.write(key);
    });
    await ui.settle();
    expect(ui.switchTo).toHaveBeenCalledTimes(1);
    expect(ui.switchTo).toHaveBeenCalledWith({ model: expected });
  });
  test("AC-13 another row keeps its own effort after a visible cycle", async () => {
    const ui = mount({ models: ["p/a[high]", "p/b[low]"], current: { model: "p/z" } });
    await ui.submit("/model");
    ui.press(RIGHT);
    expect(entries(ui)[0]).toBe("❯ p/a  effort xhigh");
    ui.press(DOWN);
    ui.press(RETURN);
    await ui.settle();
    expect(ui.switchTo).toHaveBeenCalledTimes(1);
    expect(ui.switchTo).toHaveBeenCalledWith({ model: "p/b[low]" });
  });
  test("AC-10 query matches only the base", async () => {
    const ui = await open(["p/a[high]", "p/high-model[low]"]);
    ui.press("high");
    expect(entries(ui).map(labelOf)).toEqual(["p/high-model"]);
  });
  test("AC-11 separate right and Return applies shared effort helpers", async () => {
    const ui = await open(["p/a[high]", "p/b"]);
    ui.press(RIGHT);
    ui.press(RETURN);
    await ui.settle();
    expect(ui.switchTo).toHaveBeenCalledWith({ model: withEffort("p/a", cycleEffort("high", 1)) });
  });
  test.each([
    [LEFT, "medium"],
    [RIGHT, "xhigh"],
  ])("AC-14 AC-15 query survives %s and detail becomes %s", async (key, effort) => {
    const ui = await open(["p/a[high]", "p/high-model[high]"]);
    ui.press("high");
    ui.press(key);
    expect(ui.rows()).toContain("Filter: high");
    expect(entries(ui)).toEqual([`❯ p/high-model  effort ${effort}`]);
  });
  test("pending effort is discarded on cancellation and choice", async () => {
    const ui = await open();
    ui.press(RIGHT);
    ui.press(ESCAPE);
    await ui.submit("/model");
    expect(entries(ui)[0]).toBe("❯ p/a  effort high");
    ui.press(RIGHT);
    ui.press(RETURN);
    await ui.settle();
    await ui.submit("/model");
    expect(entries(ui)[0]).toBe("❯ p/a  effort high");
  });
  test("unknown suffix cycles from default", async () => {
    const ui = await open(["m/x[turbo]"]);
    ui.press(RIGHT);
    ui.press(RETURN);
    await ui.settle();
    expect(ui.switchTo).toHaveBeenCalledWith({ model: "m/x[off]" });
  });
  test("AC-19 rejected cycled switch uses transcript error route", async () => {
    const ui = mount({
      models: ["p/a[high]"],
      switchTo: async () => {
        throw new Error("effort rejected");
      },
    });
    await ui.submit("/model");
    ui.press(RIGHT);
    ui.press(RETURN);
    await ui.settle();
    expect(ui.switchTo).toHaveBeenCalledWith({ model: "p/a[xhigh]" });
    expect(ui.rows().join("\n")).toContain("✗ effort rejected");
    expect(ui.rows()).not.toContain("Switch model");
  });
});

describe("non-model arrows", () => {
  test("AC-16 AC-17 AC-18 resume ignores horizontal arrows", async () => {
    const ui = mount({
      sessions: async () => [
        { sessionId: "one", title: "first", updatedAt: null },
        { sessionId: "two", title: "second", updatedAt: null },
      ],
    });
    await ui.submit("/resume");
    await ui.settle();
    ui.press(DOWN);
    const before = ui.rows();
    ui.press(LEFT);
    expect(ui.rows()).toEqual(before);
    ui.press(RIGHT);
    expect(ui.rows()).toEqual(before);
    expect(ui.switchTo).not.toHaveBeenCalled();
    expect(ui.resume).not.toHaveBeenCalled();
  });
});
