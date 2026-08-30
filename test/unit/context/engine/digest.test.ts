import { describe, expect, test } from "bun:test";
import { buildDigest, digestTokens } from "@/context/engine/digest";
import type { PackedChunk } from "@/context/engine/packing";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makePacked(overrides: Partial<PackedChunk> = {}): PackedChunk {
  return {
    id: "chunk:abc",
    kind: "feature",
    scope: "project",
    role: ["all"],
    content: "# Section\n\nSome descriptive content here.",
    tokens: 50,
    rawScore: 0.9,
    score: 0.9,
    roleFiltered: false,
    belowMinScore: false,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// buildDigest
// ─────────────────────────────────────────────────────────────────────────────

describe("buildDigest", () => {
  test("empty chunks: returns empty string", () => {
    expect(buildDigest([])).toBe("");
  });

  test("single chunk: includes scope tag and first-line summary", () => {
    const chunk = makePacked({ scope: "project", content: "# CLAUDE.md\n\nRun bun install first." });
    const digest = buildDigest([chunk]);
    expect(digest).toContain("[project]");
    expect(digest).toContain("CLAUDE.md");
  });

  test("skips markdown heading prefixes in first-line", () => {
    const chunk = makePacked({ content: "## Installation\n\nRun bun install." });
    const digest = buildDigest([chunk]);
    // Should strip the ## and use the heading text
    expect(digest).toContain("Installation");
    expect(digest).not.toContain("##");
  });

  test("deterministic: same input → same output", () => {
    const chunks = [
      makePacked({ id: "a:1", scope: "project", content: "project rule one" }),
      makePacked({ id: "b:1", scope: "feature", content: "feature context two" }),
    ];
    const d1 = buildDigest(chunks);
    const d2 = buildDigest(chunks);
    expect(d1).toBe(d2);
  });

  test("deterministic regardless of input array order", () => {
    // Digest sorts by scope rank then chunk ID — input order should not matter
    const a = makePacked({ id: "a:1", scope: "feature", content: "feature chunk" });
    const b = makePacked({ id: "b:1", scope: "project", content: "project chunk" });
    const d1 = buildDigest([a, b]);
    const d2 = buildDigest([b, a]);
    expect(d1).toBe(d2);
  });

  test("scope ordering: project lines appear before feature lines", () => {
    const chunks = [
      makePacked({ id: "f:1", scope: "feature", content: "feature stuff" }),
      makePacked({ id: "p:1", scope: "project", content: "project stuff" }),
    ];
    const digest = buildDigest(chunks);
    const projIdx = digest.indexOf("[project]");
    const featIdx = digest.indexOf("[feature]");
    expect(projIdx).toBeLessThan(featIdx);
  });

  test("truncated when content exceeds MAX_DIGEST_CHARS", () => {
    // Build a chunk with very long content
    const longContent = "A".repeat(2000);
    const chunks = Array.from({ length: 10 }, (_, i) =>
      makePacked({ id: `c:${i}`, scope: "project", content: longContent }),
    );
    const digest = buildDigest(chunks);
    expect(digest.length).toBeLessThanOrEqual(1003); // 1000 + "..."
    expect(digest.endsWith("...")).toBe(true);
  });

  test("first-line truncated at 120 chars", () => {
    const longLine = "X".repeat(200);
    const chunk = makePacked({ content: longLine });
    const digest = buildDigest([chunk]);
    // "..." appended to the 117-char truncation
    const line = digest.split("\n")[0] ?? "";
    expect(line.length).toBeLessThanOrEqual(140); // tag + space + 120
  });

  // ───────────────────────────────────────────────────────────────────────
  // #1774 defect B: repeated rule filenames starve non-project scopes
  // ───────────────────────────────────────────────────────────────────────

  test("multiple sections from one rule file dedupe to a single digest line", () => {
    // static-rules.ts builds every section of a rule as `### <rulePath>\n\n<section>`
    // (static-rules.ts:417) — every section of one file therefore shares the
    // identical firstLine summary. Without dedupe, N sections produce N lines.
    const chunks = Array.from({ length: 9 }, (_, i) =>
      makePacked({
        id: `static-rules:adapter-wiring:${i}`,
        scope: "project",
        content: "### adapter-wiring.md\n\nSection body.",
      }),
    );
    const digest = buildDigest(chunks);
    const occurrences = digest.split("\n").filter((l) => l.includes("adapter-wiring.md")).length;
    expect(occurrences).toBe(1);
  });

  test("a project-scope overflow does not starve a feature-scope chunk", () => {
    // Simulates the reported bug: many distinct project-scope rule chunks
    // (each a different file, so dedupe above doesn't collapse them) exceed
    // MAX_DIGEST_CHARS on their own — the feature-scope chunk must still
    // survive into the digest.
    const projectChunks = Array.from({ length: 15 }, (_, i) =>
      makePacked({
        id: `static-rules:rule-${i}`,
        scope: "project",
        // Distinct per-chunk content (no shared header line) so this exercises
        // budget starvation specifically, independent of the dedupe fix above —
        // ~125 chars/line x 15 chunks comfortably exceeds MAX_DIGEST_CHARS (1000)
        // on its own.
        content: `Distinct rule content block number ${i} with enough unique padding text to consume real digest budget space.`,
      }),
    );
    const featureChunk = makePacked({
      id: "feature:us-004",
      scope: "feature",
      content: "# US-004\n\nStory-specific feature context that must survive.",
    });
    const digest = buildDigest([...projectChunks, featureChunk]);
    expect(digest).toContain("[feature] US-004");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// digestTokens
// ─────────────────────────────────────────────────────────────────────────────

describe("digestTokens", () => {
  test("empty string: 0 tokens", () => {
    expect(digestTokens("")).toBe(0);
  });

  test("4 chars: 1 token", () => {
    expect(digestTokens("abcd")).toBe(1);
  });

  test("5 chars: 2 tokens (ceiling)", () => {
    expect(digestTokens("abcde")).toBe(2);
  });
});
