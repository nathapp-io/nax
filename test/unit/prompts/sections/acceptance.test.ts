/**
 * Unit tests for buildAcceptanceSection() — US-001 AC1–AC3
 *
 * RED phase: all tests will fail until buildAcceptanceSection() is implemented.
 */

import { describe, expect, test } from "bun:test";
import {
  ACCEPTANCE_SECTION_MAX_BYTES,
  type AcceptanceEntry,
  buildAcceptanceSection,
} from "../../../../src/prompts/sections/acceptance";

// ─────────────────────────────────────────────────────────────────────────────
// AC2: empty entries → empty string
// ─────────────────────────────────────────────────────────────────────────────

describe("buildAcceptanceSection — empty input", () => {
  test("returns empty string for empty entries array", () => {
    expect(buildAcceptanceSection([])).toBe("");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC1: single entry → markdown with heading and fenced TS code block
// ─────────────────────────────────────────────────────────────────────────────

describe("buildAcceptanceSection — single entry", () => {
  const entry: AcceptanceEntry = {
    testPath: "test/unit/foo.test.ts",
    content: 'import { foo } from "../../src/foo";\ntest("foo works", () => {});',
  };

  test("includes the test file path as a heading", () => {
    const result = buildAcceptanceSection([entry]);
    expect(result).toContain("test/unit/foo.test.ts");
  });

  test("wraps content in a fenced TypeScript code block", () => {
    const result = buildAcceptanceSection([entry]);
    expect(result).toContain("```typescript");
    expect(result).toContain("```");
    expect(result).toContain(entry.content);
  });

  test("heading appears before the fenced code block", () => {
    const result = buildAcceptanceSection([entry]);
    const headingIdx = result.indexOf("test/unit/foo.test.ts");
    const fenceIdx = result.indexOf("```typescript");
    expect(headingIdx).toBeGreaterThanOrEqual(0);
    expect(fenceIdx).toBeGreaterThanOrEqual(0);
    expect(headingIdx).toBeLessThan(fenceIdx);
  });

  test("returns a non-empty string", () => {
    const result = buildAcceptanceSection([entry]);
    expect(result.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC1: multiple entries → multiple sections
// ─────────────────────────────────────────────────────────────────────────────

describe("buildAcceptanceSection — multiple entries", () => {
  const entries: AcceptanceEntry[] = [
    { testPath: "test/unit/a.test.ts", content: "// test A" },
    { testPath: "test/unit/b.test.ts", content: "// test B" },
  ];

  test("includes all test paths", () => {
    const result = buildAcceptanceSection(entries);
    expect(result).toContain("test/unit/a.test.ts");
    expect(result).toContain("test/unit/b.test.ts");
  });

  test("includes all content", () => {
    const result = buildAcceptanceSection(entries);
    expect(result).toContain("// test A");
    expect(result).toContain("// test B");
  });

  test("first entry heading appears before second entry heading", () => {
    const result = buildAcceptanceSection(entries);
    const idxA = result.indexOf("test/unit/a.test.ts");
    const idxB = result.indexOf("test/unit/b.test.ts");
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThanOrEqual(0);
    expect(idxA).toBeLessThan(idxB);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3: total > 50KB → truncate longest entry first
// ─────────────────────────────────────────────────────────────────────────────

describe("buildAcceptanceSection — 50KB truncation", () => {
  test("ACCEPTANCE_SECTION_MAX_BYTES is 50 * 1024", () => {
    expect(ACCEPTANCE_SECTION_MAX_BYTES).toBe(50 * 1024);
  });

  test("does not truncate when total content is within 50KB", () => {
    const entries: AcceptanceEntry[] = [
      { testPath: "small.ts", content: "x".repeat(10 * 1024) }, // 10KB
      { testPath: "also-small.ts", content: "y".repeat(10 * 1024) }, // 10KB
    ];
    const result = buildAcceptanceSection(entries);
    expect(result).not.toContain("[truncated");
  });

  test("truncates longest entry when total exceeds 50KB", () => {
    // 35KB + 20KB = 55KB > 50KB; longest is the 35KB entry
    const entries: AcceptanceEntry[] = [
      { testPath: "short.ts", content: "y".repeat(20 * 1024) },
      { testPath: "long.ts", content: "x".repeat(35 * 1024) },
    ];
    const result = buildAcceptanceSection(entries);
    expect(result).toContain("[truncated");
  });

  test("appends '[truncated — full file at <path>]' to truncated entry", () => {
    const entries: AcceptanceEntry[] = [
      { testPath: "short.ts", content: "y".repeat(20 * 1024) },
      { testPath: "long.ts", content: "x".repeat(35 * 1024) },
    ];
    const result = buildAcceptanceSection(entries);
    expect(result).toContain("[truncated — full file at long.ts]");
  });

  test("does not truncate the shorter entry when longer one is truncated", () => {
    const entries: AcceptanceEntry[] = [
      { testPath: "short.ts", content: "SHORT_MARKER" + "y".repeat(20 * 1024 - 12) },
      { testPath: "long.ts", content: "x".repeat(35 * 1024) },
    ];
    const result = buildAcceptanceSection(entries);
    expect(result).toContain("SHORT_MARKER");
  });

  test("total output is under 50KB after truncation (plus markdown overhead)", () => {
    const entries: AcceptanceEntry[] = [
      { testPath: "short.ts", content: "y".repeat(20 * 1024) },
      { testPath: "long.ts", content: "x".repeat(35 * 1024) },
    ];
    const result = buildAcceptanceSection(entries);
    // Content portion must be at most ~50KB; allow a generous overhead for markdown
    const contentBytes = new TextEncoder().encode(result).length;
    expect(contentBytes).toBeLessThan(ACCEPTANCE_SECTION_MAX_BYTES + 4 * 1024);
  });
});
