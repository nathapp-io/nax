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
// Truncation contract — atomic section drop + scopePaths from included only.
// Mirrors the git-history pattern: when MAX_CHUNK_TOKENS*4 cap kicks in,
// later sections are dropped entirely (never sliced mid-section) so the
// chunk never claims scope over a path whose section was truncated away.
// ─────────────────────────────────────────────────────────────────────────────

describe("assembleCodeNeighborChunk — truncation contract (AC2: scope only what is rendered)", () => {
  test("scopePaths excludes paths from sections that were dropped at the cap", () => {
    // Each rendered section is large enough that the second section pushes
    // the total over the 2000-char cap and must be dropped atomically.
    // Section shape: "### <file>\n- <neighbor>\n" (~30 chars) + 1900 chars
    // of long neighbor names → ~1930 chars per section.
    // Header + "\n\n" is ~52 chars. First section (~1930) fits under the
    // cap; the second pushes the total over and is excluded entirely.
    const longNeighborName = "n".repeat(1900);
    const sections: NeighborSection[] = [
      { file: "src/a.ts", neighbors: [longNeighborName] },
      { file: "src/b.ts", neighbors: [longNeighborName] },
    ];
    const chunk = assembleCodeNeighborChunk({ sections, truncated: false, maxGlobFiles: 500 }) as RawChunk;
    // src/b.ts was dropped — must NOT be in chunk.content.
    expect(chunk.content).not.toContain("src/b.ts");
    // src/b.ts must NOT be in scopePaths either (AC2: scopePaths contains
    // only neighbor paths rendered in the chunk body).
    expect(chunk.scopePaths).toEqual(["src/a.ts", longNeighborName]);
  });

  test("scopePaths preserves order across included sections when only some fit", () => {
    // Choose neighbor-name length so the first two sections fit under the
    // 2000-char cap and the third pushes the total over.
    //   header + sep + section1(1500) + sep + section2 + sep + section3(1500)
    //   ≈ 66 + 1515 + 2 + 27 + 2 + 1515 = 3127  → over cap, section 3 dropped.
    const smallNeighborName = "n".repeat(1500);
    const sections: NeighborSection[] = [
      { file: "src/a.ts", neighbors: [smallNeighborName] },
      { file: "src/b.ts", neighbors: ["src/b/dep.ts"] },
      { file: "src/c.ts", neighbors: [smallNeighborName] },
    ];
    const chunk = assembleCodeNeighborChunk({ sections, truncated: false, maxGlobFiles: 500 }) as RawChunk;
    // src/a.ts fits, src/b.ts fits, src/c.ts pushes over the cap and is dropped.
    expect(chunk.scopePaths).toEqual(["src/a.ts", smallNeighborName, "src/b.ts", "src/b/dep.ts"]);
    // And src/c.ts is not rendered.
    expect(chunk.content).not.toContain("src/c.ts");
  });

  test("first section is always included even when it would exceed the cap (atomic inclusion)", () => {
    // A single section that itself exceeds the 2000-char cap. The chunk
    // still emits a result with that section's paths in scopePaths — the
    // cap slices the body but never drops the only section.
    const hugeSection = "n".repeat(3000);
    const sections: NeighborSection[] = [{ file: "src/only.ts", neighbors: [hugeSection] }];
    const chunk = assembleCodeNeighborChunk({ sections, truncated: false, maxGlobFiles: 500 }) as RawChunk;
    expect(chunk.content.length).toBeLessThanOrEqual(2000);
    expect(chunk.scopePaths).toEqual(["src/only.ts", hugeSection]);
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
