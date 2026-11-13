import { describe, expect, test } from "bun:test";
import type { ToolCallRecord } from "@nathapp/nax-agent";
import { type DiffPart, toolReadParts } from "@/workflow/branch-diff-parts";

const parts: readonly DiffPart[] = [
  { path: "/run/package-branch-part-01.diff", files: ["a.ts"] },
  { path: "/run/package-branch-part-02.diff", files: ["a.ts", "b.ts"] },
];
const AT = "2026-01-01T00:00:00.000Z";

function read(path: string, overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return { tool: "Read", outcome: "ok", truncated: false, resultBytes: 30_000, input: { path }, at: AT, ...overrides };
}

describe("toolReadParts", () => {
  test("credits only files held by every part when one part was read (AC-1)", () => {
    expect(toolReadParts([read(parts[1].path)], parts)).toEqual(["b.ts"]);
  });

  test("credits files in part order without repeats when all parts were read (AC-2)", () => {
    expect(toolReadParts([read(parts[0].path), read(parts[1].path)], parts)).toEqual(["a.ts", "b.ts"]);
  });

  test.each([
    ["offset", { input: { path: parts[0].path, offset: 1 } }],
    ["limit", { input: { path: parts[0].path, limit: 100 } }],
    ["truncated result", { truncated: true }],
    ["missing truncation evidence", { truncated: undefined }],
    ["failed call", { outcome: "error" }],
    ["oversized result", { resultBytes: 40_001 }],
    ["non-Read tool", { tool: "Git" }],
  ] as const)("does not credit a %s", (_label, overrides) => {
    expect(toolReadParts([read(parts[0].path, overrides)], parts)).toEqual([]);
  });
});
