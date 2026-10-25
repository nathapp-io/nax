import { describe, expect, test } from "bun:test";

describe("chatSessionSettings", () => {
  test.each([
    ["AC-1", "full", { profile: "full", bashApproval: "raw", metaMode: "full" }],
    ["AC-2", "guarded", { profile: "ask", bashApproval: "gated", metaMode: "ask" }],
  ] as const)("%s: maps %s to session settings", async (_ac, mode, expected) => {
    const { chatSessionSettings } = await import("@/chat");
    expect(chatSessionSettings(mode)).toEqual(expected);
  });
});

describe("nextChatMode", () => {
  test.each([
    ["AC-3", "guarded", "full"],
    ["AC-4", "full", "guarded"],
  ] as const)("%s: toggles %s to %s", async (_ac, mode, expected) => {
    const { nextChatMode } = await import("@/chat");
    expect(nextChatMode(mode)).toBe(expected);
  });
});

describe("chatModeOfMeta", () => {
  test.each([
    ["AC-5", "ask", "guarded"],
    ["AC-6", "full", "full"],
    ["AC-7", "read", null],
    ["AC-8", "none", null],
  ] as const)("%s: maps metadata mode %s to %s", async (_ac, mode, expected) => {
    const { chatModeOfMeta } = await import("@/chat");
    expect(chatModeOfMeta(mode)).toBe(expected);
  });
});
