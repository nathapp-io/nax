import { describe, test, expect } from "bun:test";
import { buildDigest, digestTokens } from "../../../../src/context/engine/digest";
import type { PackedChunk } from "../../../../src/context/engine/packing";

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
    expect(digest.length).toBeLessThanOrEqual(1003);  // 1000 + "..."
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
