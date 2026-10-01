import { describe, expect, test } from "bun:test";
import type { PackedChunk } from "@/context/engine/packing";
import { renderChunks } from "@/context/engine/render";
import { fitScratchBlocks, SCRATCH_ENTRY_SEPARATOR } from "@/context/engine/render-utils";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makePacked(overrides: Partial<PackedChunk> = {}): PackedChunk {
  return {
    id: "chunk:1",
    kind: "feature",
    scope: "project",
    role: ["all"],
    content: "chunk content",
    tokens: 50,
    rawScore: 0.9,
    score: 0.9,
    roleFiltered: false,
    belowMinScore: false,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// renderChunks
// ─────────────────────────────────────────────────────────────────────────────

describe("renderChunks", () => {
  test("empty chunks: returns empty string", () => {
    expect(renderChunks([])).toBe("");
  });

  test("single project chunk: renders project section", () => {
    const chunk = makePacked({ scope: "project", content: "CLAUDE.md rules" });
    const md = renderChunks([chunk]);
    expect(md).toContain("## Project Context");
    expect(md).toContain("CLAUDE.md rules");
  });

  test("scope ordering: Project before Feature before Story before Session before Retrieved", () => {
    const chunks = [
      makePacked({ id: "r:1", scope: "retrieved", content: "retrieved chunk" }),
      makePacked({ id: "s:1", scope: "story", content: "story chunk" }),
      makePacked({ id: "p:1", scope: "project", content: "project chunk" }),
      makePacked({ id: "f:1", scope: "feature", content: "feature chunk" }),
      makePacked({ id: "se:1", scope: "session", content: "session chunk" }),
    ];
    const md = renderChunks(chunks);
    const pIdx = md.indexOf("## Project Context");
    const fIdx = md.indexOf("## Feature Context");
    const sIdx = md.indexOf("## Story Context");
    const seIdx = md.indexOf("## Session History");
    const rIdx = md.indexOf("## Retrieved Context");
    expect(pIdx).toBeLessThan(fIdx);
    expect(fIdx).toBeLessThan(sIdx);
    expect(sIdx).toBeLessThan(seIdx);
    expect(seIdx).toBeLessThan(rIdx);
  });

  test("empty scopes are omitted", () => {
    const chunk = makePacked({ scope: "feature", content: "feature only" });
    const md = renderChunks([chunk]);
    expect(md).not.toContain("## Project Context");
    expect(md).not.toContain("## Story Context");
    expect(md).toContain("## Feature Context");
  });

  test("multiple chunks in same scope: separated by divider", () => {
    const chunks = [
      makePacked({ id: "a:1", scope: "feature", content: "first chunk", score: 0.9 }),
      makePacked({ id: "b:1", scope: "feature", content: "second chunk", score: 0.7 }),
    ];
    const md = renderChunks(chunks);
    expect(md).toContain("first chunk");
    expect(md).toContain("second chunk");
    expect(md).toContain("---");
  });

  test("within scope: highest score rendered first", () => {
    const chunks = [
      makePacked({ id: "low:1", scope: "project", content: "low score chunk", score: 0.3 }),
      makePacked({ id: "high:1", scope: "project", content: "high score chunk", score: 0.9 }),
    ];
    const md = renderChunks(chunks);
    const highIdx = md.indexOf("high score chunk");
    const lowIdx = md.indexOf("low score chunk");
    expect(highIdx).toBeLessThan(lowIdx);
  });

  test("priorStageDigest: prepended before scope sections", () => {
    const chunk = makePacked({ scope: "feature", content: "feature content" });
    const digest = "Prior stage did X and Y.";
    const md = renderChunks([chunk], { priorStageDigest: digest });
    expect(md).toContain("## Prior Stage Summary");
    expect(md).toContain(digest);
    const summaryIdx = md.indexOf("## Prior Stage Summary");
    const featureIdx = md.indexOf("## Feature Context");
    expect(summaryIdx).toBeLessThan(featureIdx);
  });

  test("empty priorStageDigest: no preamble section", () => {
    const chunk = makePacked({ scope: "project", content: "rules" });
    const md = renderChunks([chunk], { priorStageDigest: "" });
    expect(md).not.toContain("## Prior Stage Summary");
  });

  test("content is trimmed before rendering", () => {
    const chunk = makePacked({ scope: "project", content: "  trimmed  \n\n" });
    const md = renderChunks([chunk]);
    expect(md).toContain("trimmed");
    expect(md).not.toMatch(/ {2}trimmed {2}/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// render-utils.ts — fitScratchBlocks (nax#1757)
//
// Both scratch render paths cap their output at a character ceiling. They used
// to join every block and take `slice(0, max)`, which keeps the HEAD — the
// oldest entries — and leaves a half-rendered entry at the cut. This helper
// drops whole entries from the oldest end instead, so what survives a ceiling
// is always the newest.
// ─────────────────────────────────────────────────────────────────────────────

const SEP_LEN = SCRATCH_ENTRY_SEPARATOR.length;

describe("fitScratchBlocks", () => {
  test("returns everything joined when it already fits", () => {
    expect(fitScratchBlocks(["aa", "bb", "cc"], 100)).toBe(
      `aa${SCRATCH_ENTRY_SEPARATOR}bb${SCRATCH_ENTRY_SEPARATOR}cc`,
    );
  });

  test("empty input returns an empty string", () => {
    expect(fitScratchBlocks([], 100)).toBe("");
  });

  test("oldest-first input: drops from the head, keeping the newest", () => {
    // Three 10-char blocks; the ceiling admits exactly two (10 + 2 + 10).
    const blocks = ["0".repeat(10), "1".repeat(10), "2".repeat(10)];
    const out = fitScratchBlocks(blocks, 10 + SEP_LEN + 10);
    expect(out).toBe(`${blocks[1]}${SCRATCH_ENTRY_SEPARATOR}${blocks[2]}`);
    expect(out).not.toContain("0000000000");
  });

  test("newest-first input: drops from the tail, keeping the newest", () => {
    // Pull path with `limit`: blocks[0] is the most recent.
    const blocks = ["2".repeat(10), "1".repeat(10), "0".repeat(10)];
    const out = fitScratchBlocks(blocks, 10 + SEP_LEN + 10, true);
    expect(out).toBe(`${blocks[0]}${SCRATCH_ENTRY_SEPARATOR}${blocks[1]}`);
    expect(out).not.toContain("0000000000");
  });

  test("never exceeds the ceiling", () => {
    const blocks = Array.from({ length: 20 }, (_, i) => `${i}`.repeat(50));
    for (const max of [0, 1, 51, 200, 999]) {
      expect(fitScratchBlocks(blocks, max).length).toBeLessThanOrEqual(Math.max(max, 50));
    }
  });

  test("cuts on entry boundaries — no partial block when at least one fits", () => {
    const blocks = ["a".repeat(30), "b".repeat(30), "c".repeat(30)];
    const out = fitScratchBlocks(blocks, 70);
    for (const part of out.split(SCRATCH_ENTRY_SEPARATOR)) {
      expect(part.length).toBe(30);
    }
  });

  test("a single block over the ceiling degrades to its head rather than vanishing", () => {
    // Otherwise the caller would emit an empty chunk and the newest entry —
    // the one the reader most needs — would disappear entirely.
    const out = fitScratchBlocks(["old", "z".repeat(500)], 100);
    expect(out).toBe("z".repeat(100));
  });

  test("a single over-ceiling block is taken from the newest end when newestFirst", () => {
    const out = fitScratchBlocks(["z".repeat(500), "old"], 100, true);
    expect(out).toBe("z".repeat(100));
  });
});
