/**
 * `chat.compaction` resolvers (US-006, chat-job-panel): the absolute native-chat
 * token cap and the idle delay, each falling back to its own default when the
 * operator configured nothing.
 */
import { describe, expect, test } from "bun:test";
import { makeNaxConfig } from "@test/helpers";
import { chatCompactAtTokens, idleCompactAfterMs } from "@/chat";

describe("chatCompactAtTokens", () => {
  test("AC-7: returns 200000 for a config with no chat block", () => {
    expect(chatCompactAtTokens(makeNaxConfig())).toBe(200_000);
  });

  test("AC-8: returns a configured 100000", () => {
    expect(chatCompactAtTokens(makeNaxConfig({ chat: { compaction: { compactAtTokens: 100_000 } } }))).toBe(100_000);
  });

  test("AC-9: returns 0 when the cap is turned off", () => {
    expect(chatCompactAtTokens(makeNaxConfig({ chat: { compaction: { compactAtTokens: 0 } } }))).toBe(0);
  });

  test("falls back to the default when chat exists without a compaction block", () => {
    expect(chatCompactAtTokens(makeNaxConfig({ chat: { workflow: { specFixRounds: 3 } } }))).toBe(200_000);
  });
});

describe("idleCompactAfterMs", () => {
  test("AC-10: returns 3300000 for a config with no chat block", () => {
    expect(idleCompactAfterMs(makeNaxConfig())).toBe(3_300_000);
  });

  test("AC-11: returns 0 when idle compaction is turned off", () => {
    expect(idleCompactAfterMs(makeNaxConfig({ chat: { compaction: { idleCompactAfterMinutes: 0 } } }))).toBe(0);
  });

  test("converts a configured number of minutes to milliseconds", () => {
    expect(idleCompactAfterMs(makeNaxConfig({ chat: { compaction: { idleCompactAfterMinutes: 5 } } }))).toBe(300_000);
  });
});
