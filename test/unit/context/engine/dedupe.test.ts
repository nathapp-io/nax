import { describe, test, expect } from "bun:test";
import { dedupeChunks, SIMILARITY_THRESHOLD } from "../../../../src/context/engine/dedupe";
import type { ScoredChunk } from "../../../../src/context/engine/scoring";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeScored(overrides: Partial<ScoredChunk> = {}): ScoredChunk {
  return {
    id: `chunk:${Math.random().toString(36).slice(2, 8)}`,
    kind: "feature",
    scope: "feature",
    role: ["implementer"],
    content: "unique content about a specific topic",
    tokens: 50,
    rawScore: 0.9,
    score: 0.9,
    roleFiltered: false,
    belowMinScore: false,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// dedupeChunks
// ─────────────────────────────────────────────────────────────────────────────

describe("dedupeChunks", () => {
  test("empty input returns empty result", () => {
    const result = dedupeChunks([]);
    expect(result.kept).toHaveLength(0);
    expect(result.droppedIds).toHaveLength(0);
  });

  test("single chunk is always kept", () => {
    const chunk = makeScored({ id: "a:1", content: "hello world" });
    const result = dedupeChunks([chunk]);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0].id).toBe("a:1");
    expect(result.droppedIds).toHaveLength(0);
  });

  test("two completely different chunks are both kept", () => {
    const chunks = [
      makeScored({ id: "a:1", content: "The quick brown fox jumps over the lazy dog" }),
      makeScored({ id: "b:1", content: "async function fetchData() { return await api.get('/data'); }" }),
    ];
    const result = dedupeChunks(chunks);
    expect(result.kept).toHaveLength(2);
    expect(result.droppedIds).toHaveLength(0);
  });

  test("near-identical chunks: second is dropped", () => {
    const base = "The configuration object must include a valid timeout value greater than zero.";
    const chunks = [
      makeScored({ id: "a:1", score: 0.9, content: base }),
      makeScored({ id: "b:1", score: 0.7, content: base + " " }),  // trivially different
    ];
    const result = dedupeChunks(chunks);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0].id).toBe("a:1");
    expect(result.droppedIds).toContain("b:1");
  });

  test("exact duplicates: only first is kept", () => {
    const content = "# Setup\n\nRun bun install before running bun test.";
    const chunks = [
      makeScored({ id: "a:1", content }),
      makeScored({ id: "b:1", content }),
      makeScored({ id: "c:1", content }),
    ];
    const result = dedupeChunks(chunks);
    expect(result.kept).toHaveLength(1);
    expect(result.droppedIds).toHaveLength(2);
  });

  test("short/empty content chunks: each treated independently", () => {
    const chunks = [
      makeScored({ id: "a:1", content: "" }),
      makeScored({ id: "b:1", content: "" }),
    ];
    // Both are empty — both have similarity 1.0 → second is dropped
    const result = dedupeChunks(chunks);
    expect(result.kept).toHaveLength(1);
  });

  test("preserves high-score representative when ordered correctly", () => {
    // Sort by score desc before calling dedupe — first is highest score
    const content = "Same content about database migrations and schema changes";
    const chunks = [
      makeScored({ id: "high:1", score: 0.95, content }),
      makeScored({ id: "low:1", score: 0.5, content }),
    ];
    const result = dedupeChunks(chunks);
    expect(result.kept[0].id).toBe("high:1");
  });
});

describe("SIMILARITY_THRESHOLD", () => {
  test("is 0.9", () => {
    expect(SIMILARITY_THRESHOLD).toBe(0.9);
  });
});
