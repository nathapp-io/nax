import { afterEach, describe, expect, test } from "bun:test";
import { mountChatPicker as mount } from "@test/helpers";
import { cleanup } from "ink-testing-library";
import { act } from "react";

const CTRL_T = "\x14";
const SHIFT_TAB = "\x1b[Z";
const LEVELS = ["default", "low", "high", "max"] as const;
afterEach(cleanup);

/** Switches really advance current(), including across consecutive idle presses. */
function fixture(model = "p/m") {
  const ui = mount({
    current: { model, mode: "guarded" },
    effortLevels: () => LEVELS,
    switchTo: async (next) => {
      Object.assign(ui.host.current(), next);
    },
  });
  return ui;
}

describe("effort keys", () => {
  test.each([
    ["AC-7", "p/m[max]", "p/m"],
    ["AC-8", "p/m", "p/m[low]"],
  ])("US-002 %s idle ctrl+t switches supported effort", async (_ac, initial, expected) => {
    const ui = fixture(initial);
    ui.press(CTRL_T);
    await ui.settle();
    expect(ui.switchTo).toHaveBeenCalledTimes(1);
    expect(ui.switchTo).toHaveBeenLastCalledWith({ model: expected });
    expect(ui.host.current().model).toBe(expected);
    ui.press(CTRL_T);
    await ui.settle();
    expect(ui.switchTo).toHaveBeenCalledTimes(2);
    expect(ui.host.current().model).toBe(expected === "p/m" ? "p/m[low]" : "p/m[high]");
  });
  test("US-002 AC-9 AC-10 repeated busy ctrl+t queues one switch from queued effort", async () => {
    const ui = fixture("p/m[low]");
    await ui.submit("work");
    act(() => {
      ui.ui.stdin.write(CTRL_T);
      ui.ui.stdin.write(CTRL_T);
    });
    expect(ui.switchTo).not.toHaveBeenCalled();
    await ui.finish();
    expect(ui.switchTo).toHaveBeenCalledTimes(1);
    expect(ui.switchTo).toHaveBeenCalledWith({ model: "p/m[max]" });
  });
  test.each([
    ["AC-11", [SHIFT_TAB, CTRL_T], { mode: "full", model: "p/m[low]" }],
    ["AC-12", [SHIFT_TAB], { mode: "full" }],
    ["reverse combined order", [CTRL_T, SHIFT_TAB], { mode: "full", model: "p/m[low]" }],
  ] as const)("US-002 %s applies exactly one combined switch after the turn", async (_ac, keys, expected) => {
    const ui = fixture();
    await ui.submit("work");
    for (const key of keys) ui.press(key);
    expect(ui.switchTo).not.toHaveBeenCalled();
    await ui.finish();
    expect(ui.switchTo).toHaveBeenCalledTimes(1);
    expect(ui.switchTo).toHaveBeenCalledWith(expected);
    if (!("model" in expected)) expect(Object.keys(ui.switchTo.mock.calls[0]?.[0] ?? {})).toEqual(["mode"]);
  });
});
