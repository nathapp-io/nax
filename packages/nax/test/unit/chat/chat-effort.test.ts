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

describe("cycleEffort", () => {
  test.each([
    ["AC-12", "high", 1, "xhigh"],
    ["AC-13", "high", -1, "medium"],
    ["AC-14", "max", 1, "default"],
    ["AC-15", "default", -1, "max"],
  ] as const)("%s: cycles %s by %s", (_criterion, level, step, expected) => {
    expect(chat.cycleEffort(level, step)).toBe(expected);
  });
});
