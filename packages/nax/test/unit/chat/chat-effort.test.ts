import { describe, expect, test } from "bun:test";
import * as chat from "@/chat";

describe("EFFORT_LEVELS", () => {
  test("AC-1: lists default then declared thinking levels", () => {
    expect(chat.EFFORT_LEVELS).toEqual(["default", "off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });
});

describe("isEffortLevel", () => {
  test.each([
    ["AC-2", "high", true],
    ["AC-3", "turbo", false],
    ["uppercase", "HIGH", false],
    ["whitespace", " high", false],
    ["default", "default", true],
    ["prototype key", "toString", false],
  ] as const)("%s: validates %s exactly", (_criterion, text, expected) => {
    expect(chat.isEffortLevel(text)).toBe(expected);
  });
});

describe("modelEffort", () => {
  test.each([
    ["AC-4", "opencode-go/deepseek-v4.1-flash[high]", "high"],
    ["AC-5", "minimax/MiniMax-M3", "default"],
    ["AC-6", "m/x[turbo]", "default"],
    ["malformed suffix", "m/x[high][low]", "default"],
  ] as const)("%s: reads effort from %s", (_criterion, model, expected) => {
    expect(chat.modelEffort(model)).toBe(expected);
  });
});

describe("withEffort", () => {
  test.each([
    ["AC-7", "opencode-go/deepseek-v4.1-flash[high]", "low", "opencode-go/deepseek-v4.1-flash[low]"],
    ["AC-8", "minimax/MiniMax-M3", "max", "minimax/MiniMax-M3[max]"],
    ["AC-9", "opencode-go/deepseek-v4.1-flash[high]", "default", "opencode-go/deepseek-v4.1-flash"],
    ["AC-10", "m/x[turbo]", "high", "m/x[high]"],
    ["AC-11", "huggingface/MiniMaxAI/MiniMax-M2.7", "low", "huggingface/MiniMaxAI/MiniMax-M2.7[low]"],
    ["unknown removal", "m/x[turbo]", "default", "m/x"],
    ["unsuffixed default", "m/x", "default", "m/x"],
  ] as const)("%s: rewrites %s to %s", (_criterion, model, level, expected) => {
    expect(chat.withEffort(model, level)).toBe(expected);
  });
});

describe("effortLevelsFor", () => {
  test.each([
    ["AC-1", ["low", "high", "max"], ["default", "low", "high", "max"]],
    ["AC-2", ["max", "low"], ["default", "low", "max"]],
    ["AC-3", undefined, chat.EFFORT_LEVELS],
    ["AC-4", [], ["default"]],
    ["duplicates", ["low", "low"], ["default", "low"]],
  ] as const)("US-001 %s normalizes supported levels", (_ac, supported, expected) => {
    expect(chat.effortLevelsFor(supported)).toEqual(expected);
  });
});

describe("clampEffort", () => {
  test.each([
    ["AC-10", "medium", ["default", "low", "high", "max"], "low"],
    ["AC-11", "xhigh", ["default", "low", "high", "max"], "high"],
    ["AC-12", "high", ["default"], "default"],
    ["listed", "high", ["default", "high"], "high"],
    ["default", "default", ["default", "low"], "default"],
    ["unsorted tie", "medium", ["default", "high", "low"], "low"],
  ] as const)("US-001 %s clamps %s", (_ac, level, levels, expected) => {
    expect(chat.clampEffort(level, levels)).toBe(expected);
  });
});

describe("clampModelEffort", () => {
  test("US-001 AC-13 rewrites the unsupported suffix", () => {
    expect(chat.clampModelEffort("p/m[medium]", ["default", "low", "high"])).toBe("p/m[low]");
  });
});

describe("cycleEffort", () => {
  test.each([
    ["AC-5", "max", 1, "default"],
    ["AC-6", "default", 1, "low"],
    ["AC-7", "medium", 1, "high"],
    ["AC-8", "medium", -1, "low"],
    ["reverse wrap", "default", -1, "max"],
  ] as const)("US-001 %s cycles supported levels", (_ac, level, step, expected) => {
    expect(chat.cycleEffort(level, step, ["default", "low", "high", "max"])).toBe(expected);
  });
  test("US-001 AC-9 retains the two-argument default", () => {
    expect(chat.cycleEffort("high", 1)).toBe("xhigh");
  });
  test.each([
    ["AC-12", "high", 1, "xhigh"],
    ["AC-13", "high", -1, "medium"],
    ["AC-14", "max", 1, "default"],
    ["AC-15", "default", -1, "max"],
  ] as const)("%s: cycles %s by %s", (_criterion, level, step, expected) => {
    expect(chat.cycleEffort(level, step)).toBe(expected);
  });
});
