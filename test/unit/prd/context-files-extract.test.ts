import { describe, expect, test } from "bun:test";
import { MAX_SPEC_CONTEXT_FILES, extractSpecContextFiles } from "@/prd";

/** The canonical shape spec-kit's spec-writing guide produces. */
const CANONICAL_SPEC = [
  "# Feature",
  "",
  "## Stories",
  "",
  "1. **US-001: Budget arithmetic** — no dependencies.",
  "2. **US-002: Truncation** — no dependencies.",
  "",
  "### Context Files",
  "",
  "**US-001**",
  "- `src/context/engine/available-budget.ts` — the ceiling estimator being corrected",
  "- `src/context/engine/orchestrator.ts` — effective-budget computation and pack call site",
  "",
  "**US-002**",
  "- `src/context/rules/canonical-loader.ts` — applyCanonicalRulesBudget and the priority sort",
  "",
  "### Creates",
  "",
  "**US-001**",
  "- `test/unit/context/engine/available-budget.test.ts` — first tests for an untested module",
].join("\n");

describe("extractSpecContextFiles", () => {
  test("extracts one entry per bullet, attributed to its `**US-00N**` group", () => {
    const entries = extractSpecContextFiles(CANONICAL_SPEC);

    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({
      storyId: "US-001",
      path: "src/context/engine/available-budget.ts",
      reason: "the ceiling estimator being corrected",
    });
    expect(entries[1].path).toBe("src/context/engine/orchestrator.ts");
    expect(entries[2]).toEqual({
      storyId: "US-002",
      path: "src/context/rules/canonical-loader.ts",
      reason: "applyCanonicalRulesBudget and the priority sort",
    });
  });

  test("stops at the next sibling heading, so `### Creates` is not absorbed", () => {
    const entries = extractSpecContextFiles(CANONICAL_SPEC);

    expect(entries.some((e) => e.path.includes("available-budget.test.ts"))).toBe(false);
  });

  test("accepts a parenthetical heading suffix", () => {
    const spec = ["### Context Files (per story)", "", "**US-003**", "- `src/a.ts` — reason a"].join("\n");

    const entries = extractSpecContextFiles(spec);

    expect(entries).toHaveLength(1);
    expect(entries[0].storyId).toBe("US-003");
  });

  test("ignores a `### Context Files` block written inside a fenced code example", () => {
    const spec = [
      "# Spec about specs",
      "",
      "Authors write the block like this:",
      "",
      "```markdown",
      "### Context Files",
      "",
      "**US-001**",
      "- `src/fabricated.ts` — this is documentation, not a real declaration",
      "```",
      "",
      "## Design",
    ].join("\n");

    expect(extractSpecContextFiles(spec)).toEqual([]);
  });

  test("returns an unattributed entry with a null storyId rather than guessing", () => {
    const spec = ["## Context Files", "", "- `src/orphan.ts` — nobody declared which story owns this"].join("\n");

    const entries = extractSpecContextFiles(spec);

    expect(entries).toHaveLength(1);
    expect(entries[0].storyId).toBeNull();
    expect(entries[0].path).toBe("src/orphan.ts");
  });

  test("records a bare path with an empty reason rather than dropping the entry", () => {
    const spec = ["### Context Files", "", "**US-001**", "- `src/bare.ts`"].join("\n");

    expect(extractSpecContextFiles(spec)).toEqual([{ storyId: "US-001", path: "src/bare.ts", reason: "" }]);
  });

  test("returns an empty list for a spec with no Context Files section", () => {
    expect(extractSpecContextFiles("# Feature\n\n## Design\n\n- nothing here")).toEqual([]);
    expect(extractSpecContextFiles("")).toEqual([]);
  });

  test("caps runaway sections at MAX_SPEC_CONTEXT_FILES", () => {
    const bullets = Array.from({ length: MAX_SPEC_CONTEXT_FILES + 10 }, (_, i) => `- \`src/f${i}.ts\` — reason ${i}`);
    const spec = ["### Context Files", "", "**US-001**", ...bullets].join("\n");

    expect(extractSpecContextFiles(spec)).toHaveLength(MAX_SPEC_CONTEXT_FILES);
  });
});
