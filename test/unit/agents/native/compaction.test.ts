import { describe, expect, test } from "bun:test";
import {
  compactionThreshold,
  estimateContextTokens,
  estimateTokens,
  keepBudget,
  type ResolvedCompaction,
  shouldCompact,
  type TranscriptMessage,
} from "@/agents/native/session/compaction";

const cfg: ResolvedCompaction = { enabled: true, compactAtPercent: 90, keepRecentPercent: 30 };

describe("estimateTokens", () => {
  test("counts user content as characters over four", () => {
    expect(estimateTokens({ role: "user", content: "a".repeat(400) })).toBe(100);
  });

  test("counts assistant text, thinking and serialized tool arguments", () => {
    const m: TranscriptMessage = {
      role: "assistant",
      content: "ab",
      thinking: [{ text: "cd", signature: "sig" }],
      toolCalls: [{ id: "c1", name: "Read", input: { path: "x" } }],
    };
    // 2 (text) + 2 (thinking) + 4 ("Read") + 14 ('{"path":"x"}' is 12, plus name already counted)
    // Exact total is asserted rather than approximated so a change in what is
    // counted fails loudly instead of drifting.
    expect(estimateTokens(m)).toBe(Math.ceil((2 + 2 + 4 + JSON.stringify({ path: "x" }).length) / 4));
  });

  test("counts tool-result content", () => {
    expect(estimateTokens({ role: "tool-result", toolCallId: "c1", content: "x".repeat(40) })).toBe(10);
  });
});

describe("estimateContextTokens", () => {
  test("anchors on reported usage and estimates only what follows it", () => {
    const messages: TranscriptMessage[] = [
      { role: "user", content: "x".repeat(4000) },
      { role: "assistant", content: "" },
      { role: "user", content: "y".repeat(400) },
    ];
    // Anchor says the first two messages really cost 50 tokens; only the
    // trailing message is guessed. Without the anchor this would read ~1100.
    expect(estimateContextTokens(messages, { inputTokens: 50 }, 1)).toBe(150);
  });

  test("estimates every message when there is no anchor", () => {
    const messages: TranscriptMessage[] = [{ role: "user", content: "x".repeat(400) }];
    expect(estimateContextTokens(messages, undefined, undefined)).toBe(100);
  });
});

describe("compactionThreshold", () => {
  test.each([
    [128_000, 115_200],
    [262_144, 235_929],
    [1_048_576, 943_718],
  ])("uses the configured percentage on a %i window", (window, expected) => {
    expect(compactionThreshold(window, cfg)).toBe(expected);
  });

  test("falls back to the headroom floor when a percentage would leave no room to reply", () => {
    // 4095 is the smallest window in the catalog nax-ai ships. 90% of it leaves
    // 410 tokens, which cannot hold a reply, so the floor takes over at 75%.
    expect(compactionThreshold(4095, cfg)).toBe(3072);
  });

  test("never returns a threshold at or above the window", () => {
    for (const window of [4095, 8192, 128_000, 3_500_000]) {
      expect(compactionThreshold(window, cfg)).toBeLessThan(window);
    }
  });
});

describe("shouldCompact", () => {
  test("fires above the threshold and not at or below it", () => {
    expect(shouldCompact(115_201, 128_000, cfg)).toBe(true);
    expect(shouldCompact(115_200, 128_000, cfg)).toBe(false);
  });

  test("never fires when disabled", () => {
    expect(shouldCompact(999_999, 128_000, { ...cfg, enabled: false })).toBe(false);
  });
});

describe("keepBudget", () => {
  test("is the configured percentage of the window", () => {
    expect(keepBudget(128_000, cfg)).toBe(38_400);
  });

  test("halves for the aggressive backstop", () => {
    expect(keepBudget(128_000, cfg, true)).toBe(19_200);
  });

  test("stays below the threshold, so a compacted transcript cannot re-fire immediately", () => {
    for (const window of [4095, 128_000, 1_048_576]) {
      expect(keepBudget(window, cfg)).toBeLessThan(compactionThreshold(window, cfg));
    }
  });
});
