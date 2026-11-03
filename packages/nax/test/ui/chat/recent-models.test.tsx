/**
 * US-006: the `/model` picker over a host that remembers recently used models.
 *
 * The screen reads the host's list at the moment it builds the rows, so choosing a recent row
 * must hand the host back the exact id that row remembered — effort included — rather than the
 * bare base the catalogue row would have sent.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { pickerEntryRows as entryRows, pickerFrameOf as frameOf, mountChatPicker as mount } from "@test/helpers";
import { cleanup } from "ink-testing-library";

const RETURN = "\r";
const MODELS = ["a/x", "b/y", "c/z"];
afterEach(cleanup);

const entries = (ui: ReturnType<typeof mount>) => entryRows(frameOf(ui.rows(), "Switch model").inside);

describe("the model picker's recent rows", () => {
  test("AC-25 choosing a recent row switches to the effort that row remembers", async () => {
    const ui = mount({ models: MODELS, recents: ["b/y[high]"], current: { model: "a/x" } });
    await ui.submit("/model");
    expect(entries(ui)).toEqual([
      "❯ b/y  recent · effort high",
      "  a/x  effort default  (current)",
      "  c/z  effort default",
    ]);
    ui.press(RETURN);
    await ui.settle();
    expect(ui.switchTo).toHaveBeenCalledTimes(1);
    expect(ui.switchTo).toHaveBeenCalledWith({ model: "b/y[high]" });
  });

  test("a recent row can be cycled and chosen like any other row", async () => {
    const ui = mount({ models: MODELS, recents: ["b/y[high]"], current: { model: "a/x" } });
    await ui.submit("/model");
    ui.press("\x1b[C");
    expect(entries(ui)[0]).toBe("❯ b/y  recent · effort xhigh");
    ui.press(RETURN);
    await ui.settle();
    expect(ui.switchTo).toHaveBeenCalledWith({ model: "b/y[xhigh]" });
  });

  test("without a recent-model list the picker lists the catalogue alone", async () => {
    const ui = mount({ models: MODELS, current: { model: "a/x" } });
    await ui.submit("/model");
    expect(entries(ui)).toEqual(["❯ a/x  effort default  (current)", "  b/y  effort default", "  c/z  effort default"]);
  });
});
