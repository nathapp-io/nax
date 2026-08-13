/**
 * code-neighbor-chunk.ts — US-002 chunk assembly tests
 *
 * Pure unit tests for the extracted chunk-assembly module. No filesystem I/O.
 * Covers the assemble code-neighbor chunk surface that US-002 introduces:
 *   - assembles sections into a single RawChunk with id `code-neighbor:<hash>`
 *   - populates RawChunk.scopePaths with each analysed file plus the neighbour
 *     paths listed beneath it, deduped and order-stable
 *   - returns null when no sections are included (empty-chunk behavior preserved)
 *   - respects MAX_CHUNK_TOKENS cap on body; appends truncation note when set
 *   - chunk tokens = ceil(content.length / 4)
 */

import { describe, expect, test } from "bun:test";
import { assembleCodeNeighborChunk, type NeighborSection } from "@/context/engine";
import type { RawChunk } from "@/context/engine/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const SECTION_HEADER = "## Code Neighbors\n\nRelated files (imports, reverse-deps, tests):";

function section(file: string, neighbors: string[]): NeighborSection {
  return { file, neighbors };
}

function makeSections(items: Array<[string, string[]]>): NeighborSection[] {
  return items.map(([file, neighbors]) => section(file, neighbors));
}

// ─────────────────────────────────────────────────────────────────────────────
// AC3 — empty-chunk behaviour preserved: no sections → null
// ─────────────────────────────────────────────────────────────────────────────

describe("assembleCodeNeighborChunk — empty input (AC3)", () => {
  test("[AC3] returns null when no sections are provided", () => {
    const chunk = assembleCodeNeighborChunk({ sections: [], truncated: false, maxGlobFiles: 500 });
    expect(chunk).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — touched file path appears in scopePaths
// ─────────────────────────────────────────────────────────────────────────────

describe("assembleCodeNeighborChunk — AC1 (touched file in scopePaths)", () => {
  test("[AC1] chunk.scopePaths contains the touched file path when one file has neighbors", () => {
    const sections = makeSections([["src/foo.ts", ["src/foo/dep.ts", "test/unit/foo.test.ts"]]]);
    const chunk = assembleCodeNeighborChunk({ sections, truncated: false, maxGlobFiles: 500 });
    expect(chunk).not.toBeNull();
    expect(chunk!.scopePaths).toBeDefined();
    expect(chunk!.scopePaths).toContain("src/foo.ts");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — every rendered neighbour path appears in scopePaths
// ─────────────────────────────────────────────────────────────────────────────

describe("assembleCodeNeighborChunk — AC2 (neighbours in scopePaths)", () => {
  test("[AC2] chunk.scopePaths contains each neighbor path rendered in the chunk body", () => {
    const sections = makeSections([
      ["src/foo.ts", ["src/foo/dep.ts", "src/foo/util.ts", "test/unit/foo.test.ts"]],
    ]);
    const chunk = assembleCodeNeighborChunk({ sections, truncated: false, maxGlobFiles: 500 });
    expect(chunk).not.toBeNull();

    const scope = chunk!.scopePaths!;
    expect(scope).toContain("src/foo/dep.ts");
    expect(scope).toContain("src/foo/util.ts");
    expect(scope).toContain("test/unit/foo.test.ts");

    // Each neighbor also appears in the rendered body (AC2 wording: "rendered in the chunk body")
    expect(chunk!.content).toContain("src/foo/dep.ts");
    expect(chunk!.content).toContain("src/foo/util.ts");
    expect(chunk!.content).toContain("test/unit/foo.test.ts");
  });

  test("[AC2] section header and file label appear in the chunk body", () => {
    const sections = makeSections([["src/foo.ts", ["src/foo/dep.ts"]]]);
    const chunk = assembleCodeNeighborChunk({ sections, truncated: false, maxGlobFiles: 500 });
    expect(chunk!.content).toContain(SECTION_HEADER);
    expect(chunk!.content).toContain("### src/foo.ts");
    expect(chunk!.content).toContain("- src/foo/dep.ts");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4 — shared neighbour across two touched files is listed exactly once
// ─────────────────────────────────────────────────────────────────────────────

describe("assembleCodeNeighborChunk — AC4 (shared neighbour dedup)", () => {
  test("[AC4] shared neighbor across two touched files appears exactly once in scopePaths", () => {
    const sections = makeSections([
      ["src/foo.ts", ["src/shared.ts"]],
      ["src/bar.ts", ["src/shared.ts"]],
    ]);
    const chunk = assembleCodeNeighborChunk({ sections, truncated: false, maxGlobFiles: 500 });
    expect(chunk).not.toBeNull();

    const scope = chunk!.scopePaths!;
    const sharedOccurrences = scope.filter((p) => p === "src/shared.ts").length;
    expect(sharedOccurrences).toBe(1);

    // Both touched files still appear (they are not shared with each other)
    expect(scope).toContain("src/foo.ts");
    expect(scope).toContain("src/bar.ts");
  });

  test("[AC4] chunk.content renders the shared neighbor's section under each touched file", () => {
    const sections = makeSections([
      ["src/foo.ts", ["src/shared.ts"]],
      ["src/bar.ts", ["src/shared.ts"]],
    ]);
    const chunk = assembleCodeNeighborChunk({ sections, truncated: false, maxGlobFiles: 500 });
    // The shared neighbor path appears in the rendered body under each
    // touched file's section — it is still listed twice in content (the
    // contract is about scopePaths, not content).
    const body = chunk!.content;
    const matches = body.split("src/shared.ts").length - 1;
    expect(matches).toBeGreaterThanOrEqual(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4 — order-stable: touched file first, then neighbors in declaration order
// ─────────────────────────────────────────────────────────────────────────────

describe("assembleCodeNeighborChunk — order contract", () => {
  test("[AC4] scopePaths lists the touched file first, then each neighbor in declaration order", () => {
    const sections = makeSections([["src/foo.ts", ["src/dep-a.ts", "src/dep-b.ts", "src/dep-c.ts"]]]);
    const chunk = assembleCodeNeighborChunk({ sections, truncated: false, maxGlobFiles: 500 });
    expect(chunk!.scopePaths).toEqual(["src/foo.ts", "src/dep-a.ts", "src/dep-b.ts", "src/dep-c.ts"]);
  });

  test("[AC4] across multiple sections: each touched file is recorded, neighbors follow their section's declaration order", () => {
    const sections = makeSections([
      ["src/foo.ts", ["src/foo/dep.ts"]],
      ["src/bar.ts", ["src/bar/dep.ts", "src/bar/util.ts"]],
    ]);
    const chunk = assembleCodeNeighborChunk({ sections, truncated: false, maxGlobFiles: 500 });
    // Touched files first, then neighbors in section order. The exact order
    // is: foo, foo/dep, bar, bar/dep, bar/util.
    expect(chunk!.scopePaths).toEqual([
      "src/foo.ts",
      "src/foo/dep.ts",
      "src/bar.ts",
      "src/bar/dep.ts",
      "src/bar/util.ts",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Chunk shape — id, kind, scope, role, rawScore, tokens
// ─────────────────────────────────────────────────────────────────────────────

describe("assembleCodeNeighborChunk — chunk shape", () => {
  test("chunk has expected metadata (kind, scope, role, rawScore)", () => {
    const sections = makeSections([["src/foo.ts", ["src/foo/dep.ts"]]]);
    const chunk = assembleCodeNeighborChunk({ sections, truncated: false, maxGlobFiles: 500 }) as RawChunk;
    expect(chunk.kind).toBe("neighbor");
    expect(chunk.scope).toBe("story");
    expect(chunk.role).toContain("implementer");
    expect(chunk.role).toContain("tdd");
    expect(chunk.rawScore).toBe(0.65);
  });

  test("chunk.id is 'code-neighbor:' followed by an 8-char content hash", () => {
    const sections = makeSections([["src/foo.ts", ["src/foo/dep.ts"]]]);
    const chunk = assembleCodeNeighborChunk({ sections, truncated: false, maxGlobFiles: 500 });
    expect(chunk!.id).toMatch(/^code-neighbor:[0-9a-f]{8}$/);
  });

  test("chunk.tokens equals ceil(content.length / 4)", () => {
    const sections = makeSections([["src/foo.ts", ["src/foo/dep.ts", "src/foo/util.ts"]]]);
    const chunk = assembleCodeNeighborChunk({ sections, truncated: false, maxGlobFiles: 500 }) as RawChunk;
    expect(chunk.tokens).toBe(Math.ceil(chunk.content.length / 4));
  });

  test("chunk content is capped at MAX_CHUNK_TOKENS * 4 = 2000 characters when sections overflow", () => {
    // Each section: "### <file>\n" + 8 bullet lines of "- <neighbor>\n"
    // We need enough sections to overflow 2000 chars.
    const sections: NeighborSection[] = [];
    for (let i = 0; i < 20; i++) {
      sections.push({
        file: `src/file-${i}.ts`,
        neighbors: Array.from({ length: 8 }, (_, j) => `src/file-${i}/dep-${j}.ts`),
      });
    }
    const chunk = assembleCodeNeighborChunk({ sections, truncated: false, maxGlobFiles: 500 }) as RawChunk;
    expect(chunk.content.length).toBeLessThanOrEqual(2000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Truncation note
// ─────────────────────────────────────────────────────────────────────────────

describe("assembleCodeNeighborChunk — truncation note", () => {
  test("appends the visible truncation note when truncated=true", () => {
    const sections = makeSections([["src/foo.ts", ["src/foo/dep.ts"]]]);
    const chunk = assembleCodeNeighborChunk({ sections, truncated: true, maxGlobFiles: 200 });
    expect(chunk!.content).toContain("reverse-dep scan capped at 200 files");
  });

  test("omits the truncation note when truncated=false", () => {
    const sections = makeSections([["src/foo.ts", ["src/foo/dep.ts"]]]);
    const chunk = assembleCodeNeighborChunk({ sections, truncated: false, maxGlobFiles: 500 });
    expect(chunk!.content).not.toContain("reverse-dep scan capped");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Determinism — same sections + same inputs → same id
// ─────────────────────────────────────────────────────────────────────────────

describe("assembleCodeNeighborChunk — determinism", () => {
  test("identical inputs produce identical chunk IDs", () => {
    const sections = makeSections([["src/foo.ts", ["src/foo/dep.ts"]]]);
    const a = assembleCodeNeighborChunk({ sections, truncated: false, maxGlobFiles: 500 });
    const b = assembleCodeNeighborChunk({ sections, truncated: false, maxGlobFiles: 500 });
    expect(a!.id).toBe(b!.id);
  });
});
