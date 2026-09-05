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
    expect(estimateContextTokens(messages, { promptTokens: 50 }, 1)).toBe(150);
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

import {
  applyCompaction,
  COMPACTION_SUMMARY_PREFIX,
  findCutPoint,
  prepareCompaction,
} from "@/agents/native/session/compaction";

/** A user/assistant/tool-result triple of a known size, for building transcripts. */
function exchange(id: string, size: number): TranscriptMessage[] {
  return [
    { role: "assistant", content: "a".repeat(size), toolCalls: [{ id, name: "Read", input: { path: id } }] },
    { role: "tool-result", toolCallId: id, content: "r".repeat(size) },
  ];
}

describe("findCutPoint", () => {
  test("never cuts at a tool-result, because that orphans it from its tool call", () => {
    const messages: TranscriptMessage[] = [
      { role: "user", content: "task" },
      ...exchange("c1", 4000),
      ...exchange("c2", 4000),
    ];
    // A budget that lands mid-exchange would naively cut at the tool-result.
    const cut = findCutPoint(messages, 1, 1000);
    expect(messages[cut].role).not.toBe("tool-result");
  });

  test("refuses every cut that would orphan a result, across every budget", () => {
    const messages: TranscriptMessage[] = [
      { role: "user", content: "task" },
      ...exchange("c1", 400),
      ...exchange("c2", 400),
      ...exchange("c3", 400),
    ];
    for (let budget = 1; budget < 2000; budget += 37) {
      expect(messages[findCutPoint(messages, 1, budget)].role).not.toBe("tool-result");
    }
  });

  test("keeps an assistant message whole, so a thinking block keeps its signature", () => {
    // ADR-028 s8: Anthropic requires the exact thinking block, text plus
    // signature, replayed on the next turn. Cutting inside an assistant message
    // is the only way to break that, so the cut index must always name a
    // message boundary.
    const messages: TranscriptMessage[] = [
      { role: "user", content: "task" },
      { role: "assistant", content: "x".repeat(4000), thinking: [{ text: "why", signature: "sig-1" }] },
      { role: "user", content: "next" },
    ];
    const cut = findCutPoint(messages, 1, 100);
    expect(Number.isInteger(cut)).toBe(true);
    const kept = messages.slice(cut);
    for (const m of kept) {
      if (m.role === "assistant" && m.thinking) expect(m.thinking[0].signature).toBe("sig-1");
    }
  });
});

/**
 * Four small exchanges with a keep budget of 250 tokens. Sizes are chosen so a
 * cut genuinely lands mid-transcript: with two 1000-token exchanges and a
 * 1000-token budget the walk reaches its budget on the very first message it
 * visits, `findCutPoint` returns the earliest valid cut, and prepareCompaction
 * correctly reports "nothing to do" — which would make every assertion below
 * vacuous.
 */
const KEEP = 250;
const fourExchanges: TranscriptMessage[] = [
  { role: "user", content: "the task" },
  ...exchange("c1", 400),
  ...exchange("c2", 400),
  ...exchange("c3", 400),
  ...exchange("c4", 400),
];

describe("prepareCompaction", () => {
  test("returns undefined when there is nothing between the pin and the cut", () => {
    const messages: TranscriptMessage[] = [
      { role: "user", content: "task" },
      { role: "assistant", content: "short" },
    ];
    expect(prepareCompaction(messages, 100_000)).toBeUndefined();
  });

  test("never includes the pinned first message in the span to summarize", () => {
    const plan = prepareCompaction(fourExchanges, KEEP);
    expect(plan).toBeDefined();
    expect(plan?.toSummarize).not.toContain(fourExchanges[0]);
  });

  test("returns undefined when a summary is present but the new span is empty (nax#1842)", () => {
    // A plan whose toSummarize is empty buys nothing: summarize() would be paid
    // to re-summarize the previous summary alone, and applyCompaction would
    // rebuild an array no smaller than the one it replaced. Left unguarded that
    // is one wasted model call per round trip for the rest of the turn.
    const first = prepareCompaction(fourExchanges, KEEP);
    if (!first) throw new Error("expected a plan");
    const already = applyCompaction(fourExchanges, first, "first summary");
    const grown: TranscriptMessage[] = [...already, ...exchange("c5", 400), ...exchange("c6", 400)];

    // A budget loose enough to keep everything after the summary verbatim, so
    // the span between the summary and the cut is empty.
    expect(prepareCompaction(grown, 1000)).toBeUndefined();
  });
});

describe("applyCompaction", () => {
  const messages = fourExchanges;

  test("leaves the pinned message byte-identical, so its cache prefix survives", () => {
    const plan = prepareCompaction(messages, KEEP);
    if (!plan) throw new Error("expected a plan");
    const out = applyCompaction(messages, plan, "what happened");
    expect(out[0]).toEqual(messages[0]);
  });

  test("places the summary immediately after the pin, carrying the prefix", () => {
    const plan = prepareCompaction(messages, KEEP);
    if (!plan) throw new Error("expected a plan");
    const out = applyCompaction(messages, plan, "what happened");
    expect(out[1].role).toBe("user");
    expect(out[1].role === "user" && out[1].content.startsWith(COMPACTION_SUMMARY_PREFIX)).toBe(true);
    expect(out[1].role === "user" && out[1].content.includes("what happened")).toBe(true);
  });

  test("shrinks the transcript", () => {
    const plan = prepareCompaction(messages, KEEP);
    if (!plan) throw new Error("expected a plan");
    expect(applyCompaction(messages, plan, "s").length).toBeLessThan(messages.length);
  });

  test("merges genuine new content with the previous summary rather than emptying toSummarize", () => {
    // A TRUE merge: a previousSummary is present AND toSummarize is non-empty at
    // the same time, using the same tight KEEP budget for both compaction rounds.
    // The empty-span half of this scenario is no longer reachable — since nax#1842
    // prepareCompaction returns undefined for it (asserted above) — so a merge
    // plan that reaches applyCompaction always carries new content to fold in.
    const first = prepareCompaction(fourExchanges, KEEP);
    if (!first) throw new Error("expected a plan");
    const already = applyCompaction(fourExchanges, first, "first summary");
    const grown: TranscriptMessage[] = [...already, ...exchange("c5", 400), ...exchange("c6", 400)];

    const plan = prepareCompaction(grown, KEEP);
    if (!plan) throw new Error("expected a plan");
    expect(plan.previousSummary).toBe("first summary");
    expect(plan.toSummarize.length).toBeGreaterThan(0);

    const out = applyCompaction(grown, plan, "merged summary");
    const summaries = out.filter((m) => m.role === "user" && m.content.startsWith(COMPACTION_SUMMARY_PREFIX));
    expect(summaries).toHaveLength(1);
    expect(summaries[0].role === "user" && summaries[0].content.includes("merged summary")).toBe(true);
  });
});
