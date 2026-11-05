import { describe, expect, test } from "bun:test";
import { COMPACTION_SUMMARY_PREFIX, estimateTokens, type TranscriptMessage } from "#src/native/session/compaction";
import { MANUAL_KEEP_TURNS, manualKeepTokens } from "#src/native/session/manual-compaction";

const user = (content: string): TranscriptMessage => ({ role: "user", content });
const assistant = (content: string): TranscriptMessage => ({ role: "assistant", content });
const sum = (messages: readonly TranscriptMessage[]): number =>
  messages.reduce((total, message) => total + estimateTokens(message), 0);

describe("MANUAL_KEEP_TURNS", () => {
  test("AC-1: equals 1", () => {
    expect(MANUAL_KEEP_TURNS).toBe(1);
  });
});

describe("manualKeepTokens", () => {
  const u1 = user("u".repeat(400));
  const a1 = assistant("a".repeat(800));
  const u2 = user("v".repeat(1200));
  const a2 = assistant("b".repeat(2000));

  test("AC-2: keeps only the last turn for keepTurns 1", () => {
    expect(manualKeepTokens([u1, a1, u2, a2], 1)).toBe(estimateTokens(u2) + estimateTokens(a2));
  });

  test("AC-3: keepTurns 2 covers both turns", () => {
    expect(manualKeepTokens([u1, a1, u2, a2], 2)).toBe(sum([u1, a1, u2, a2]));
  });

  test("AC-4: fewer turns than keepTurns sums everything", () => {
    expect(manualKeepTokens([u1, a1], 2)).toBe(sum([u1, a1]));
  });

  test("AC-5: a summary message is not a turn start", () => {
    const summary = user(`${COMPACTION_SUMMARY_PREFIX}old work\n</summary>\n`);
    const a0 = assistant("c".repeat(4000));
    expect(manualKeepTokens([summary, a0, u1, a1], 1)).toBe(estimateTokens(u1) + estimateTokens(a1));
  });

  test("AC-6: tool results after the last turn start are counted", () => {
    const withCall: TranscriptMessage = {
      role: "assistant",
      content: "calling",
      toolCalls: [{ id: "t1", name: "read", input: { path: "a.ts" } }],
    };
    const result: TranscriptMessage = { role: "tool-result", toolCallId: "t1", content: "r".repeat(600) };
    const a3 = assistant("done");
    expect(manualKeepTokens([u1, a1, u2, withCall, result, a3], 1)).toBe(sum([u2, withCall, result, a3]));
  });
});
