/**
 * US-003 — the spec story structure is binding for the planner.
 *
 * Unit tests for the spec story structure binding in `PlanPromptBuilder`.
 *
 * The planner's `GROUPING_RULES`-driven freedom is right for a spec that
 * declares nothing, and wrong for one that pre-decomposes the feature: the ids,
 * workdirs and dependencies it states are binding. Three surfaces carry that
 * binding — the `## Binding Story Structure` section, the monorepo workdir
 * instruction that defers to it, and the structural repair prompt — plus the
 * rule `buildRefineContinuation` grows for a spec that declares stories.
 *
 * Split out of `plan-builder.test.ts` by concern (that file is at its size
 * target), not by ticket.
 */

import { describe, expect, test } from "bun:test";
import type { SpecStructureViolation } from "@/prd";
import { formatSpecStructureViolation } from "@/prd";
import { PlanPromptBuilder } from "@/prompts";

const CTX = "## Codebase Structure\nsrc/checkout/checkout.service.ts";
const OUTPUT_PATH = "/tmp/feature/prd.json";
const BINDING_RULE = "Never add or remove a dependency of a story the Binding Story Structure lists";

/** A spec that pre-decomposes the feature: workdirs stated, one dependency. */
const SPEC_WITH_STORIES = `# Checkout flow

## Stories

1. **US-001: Core** — \`Workdir: packages/core\` — no dependencies
2. **US-002: API** — \`Workdir: apps/api\` — depends on US-001
`;

/** A spec story that states neither a workdir nor its dependencies. */
const SPEC_WITH_UNSTATED_STORY = `# Checkout flow

## Stories

1. **US-001: Core** — \`Workdir: packages/core\` — no dependencies
2. **US-003: Migration**
`;

/** A spec that declares no story at all. */
const SPEC_WITHOUT_STORIES = `# Checkout flow

## Goal

Make checkout faster.
`;

/** Boundary: a `US-00N` id under `## Acceptance Criteria` is not a declared structure. */
const SPEC_AC_ONLY = `# Checkout flow

## Acceptance Criteria

- [unit] US-001 returns the cart total
`;

const PACKAGES = ["packages/core", "apps/api"];

function taskContextOf(specContent: string, packages?: string[]): string {
  return new PlanPromptBuilder().build(specContent, CTX, undefined, packages).taskContext;
}

/** Column cells of a markdown table row, with any backtick emphasis stripped. */
function cellsOf(line: string | undefined): string[] {
  if (line === undefined) return [];
  return line
    .replaceAll("`", "")
    .replaceAll("*", "")
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
}

/** The binding table's column headers, or [] when the section is absent. */
function bindingHeader(taskContext: string): string[] {
  const section = taskContext.slice(taskContext.indexOf("## Binding Story Structure"));
  return cellsOf(section.split("\n").find((line) => /^\|\s*Story\s*\|/.test(line)));
}

/** The binding table's row for `id`, or [] when the table has no such row. */
function bindingRow(taskContext: string, id: string): string[] {
  const section = taskContext.slice(taskContext.indexOf("## Binding Story Structure"));
  return cellsOf(section.split("\n").find((line) => new RegExp(`^\\|\\s*\\**\\s*${id}\\s*\\**\\s*\\|`).test(line)));
}

// ─── The binding table ────────────────────────────────────────────────────────

describe("PlanPromptBuilder.build — binding story structure table (US-003)", () => {
  test("AC1: states the spec's stories as a table after the ## Spec section", () => {
    const taskContext = taskContextOf(SPEC_WITH_STORIES);
    const specIndex = taskContext.indexOf("## Spec");
    const bindingIndex = taskContext.indexOf("## Binding Story Structure");

    expect(specIndex).toBeGreaterThan(-1);
    expect(bindingIndex).toBeGreaterThan(specIndex);
    expect(bindingHeader(taskContext)).toEqual(["Story", "Workdir", "Depends on"]);
    expect(bindingRow(taskContext, "US-001")).toEqual(["US-001", "packages/core", "none"]);
    expect(bindingRow(taskContext, "US-002")).toEqual(["US-002", "apps/api", "US-001"]);
  });

  test("AC2: omits the binding section when the spec declares no US-00N ids", () => {
    expect(taskContextOf(SPEC_WITHOUT_STORIES)).not.toContain("## Binding Story Structure");
  });

  test("AC2 boundary: a story id only under ## Acceptance Criteria is not a declared structure", () => {
    expect(taskContextOf(SPEC_AC_ONLY)).not.toContain("## Binding Story Structure");
  });

  test("AC3: renders (not stated) for a story whose workdir and dependencies are unstated", () => {
    const taskContext = taskContextOf(SPEC_WITH_UNSTATED_STORY);

    expect(bindingRow(taskContext, "US-003")).toEqual(["US-003", "(not stated)", "(not stated)"]);
    // The stated sibling is unaffected — only the unstated columns fall back.
    expect(bindingRow(taskContext, "US-001")).toEqual(["US-001", "packages/core", "none"]);
  });
});

// ─── The monorepo workdir instruction ─────────────────────────────────────────

describe("PlanPromptBuilder.build — monorepo workdir instruction (US-003)", () => {
  test("AC4: with declared stories, the monorepo section defers to the binding table", () => {
    const taskContext = taskContextOf(SPEC_WITH_STORIES, PACKAGES);

    expect(taskContext).toContain("## Monorepo Context");
    expect(taskContext).toContain(`Set each story's "workdir" to the Workdir the Binding Story Structure lists`);
    expect(taskContext).not.toContain(`set the "workdir" field to the relevant package path`);
  });

  test("AC4 boundary: without declared stories the monorepo instruction is unchanged", () => {
    const taskContext = taskContextOf(SPEC_WITHOUT_STORIES, PACKAGES);

    expect(taskContext).toContain("## Monorepo Context");
    expect(taskContext).toContain(`set the "workdir" field to the relevant package path`);
  });
});

// ─── The story-rules override ─────────────────────────────────────────────────

describe("PlanPromptBuilder.build — story rules override in the binding section (US-003)", () => {
  test("AC5: a spec story that is all integration/test criteria stays its own story", () => {
    const taskContext = taskContextOf(SPEC_WITH_STORIES);

    expect(taskContext).toContain("stays its own story");
    expect(taskContext).toContain("combining small tasks");
    expect(taskContext).toContain("test-only stories do not apply to a story the spec declares");
  });

  test("AC5 boundary: the override does not leak into a spec that declares no stories", () => {
    const taskContext = taskContextOf(SPEC_WITHOUT_STORIES);

    expect(taskContext).not.toContain("stays its own story");
    expect(taskContext).not.toContain("test-only stories do not apply");
  });
});

// ─── buildRefineContinuation(bindingStructure) ────────────────────────────────

describe("PlanPromptBuilder.buildRefineContinuation — binding structure (US-003)", () => {
  test("AC6: bindingStructure=true appends the rule to dependency-minimization", () => {
    const prompt = new PlanPromptBuilder().buildRefineContinuation(OUTPUT_PATH, false, true);
    const itemIndex = prompt.indexOf("#### dependency-minimization");
    const ruleIndex = prompt.indexOf(BINDING_RULE);

    expect(itemIndex).toBeGreaterThan(-1);
    expect(ruleIndex).toBeGreaterThan(itemIndex);
    expect(ruleIndex).toBeLessThan(prompt.indexOf("#### routing-realism"));
  });

  test("AC6 boundary: the rule is absent when bindingStructure is false, explicitly or by default", () => {
    const builder = new PlanPromptBuilder();

    expect(builder.buildRefineContinuation(OUTPUT_PATH)).not.toContain(BINDING_RULE);
    expect(builder.buildRefineContinuation(OUTPUT_PATH, false, false)).not.toContain(BINDING_RULE);
    // Independent of specGuard: the drift audit does not imply a binding structure.
    expect(builder.buildRefineContinuation(OUTPUT_PATH, true, false)).not.toContain(BINDING_RULE);
  });
});

// ─── buildSpecStructureRepair() ───────────────────────────────────────────────

describe("PlanPromptBuilder.buildSpecStructureRepair() (US-003)", () => {
  const ORPHAN: SpecStructureViolation = {
    kind: "orphan-modifies",
    storyId: "US-002",
    path: "test/unit/checkout.test.ts",
  };
  const VIOLATIONS: readonly SpecStructureViolation[] = [{ kind: "missing-story", storyId: "US-004" }, ORPHAN];

  test("AC7: names the missing story, the orphan's line, the AC instruction and the output path", () => {
    const prompt = new PlanPromptBuilder().buildSpecStructureRepair(VIOLATIONS, OUTPUT_PATH);

    expect(prompt).toContain("Your PRD does not match the story structure the spec declares.");
    expect(prompt).toContain("The spec's stories are binding.");
    expect(prompt).toContain("US-004: missing");
    expect(prompt).toContain(formatSpecStructureViolation(ORPHAN));
    expect(prompt).toMatch(/move each acceptance criterion back to the story/i);
    expect(prompt).toMatch(/never merge, split or rename/i);
    expect(prompt).toContain(OUTPUT_PATH);
  });

  test("AC7 boundary: every violation kind reaches the prompt through its formatted line", () => {
    const violations: readonly SpecStructureViolation[] = [
      { kind: "missing-story", storyId: "US-004" },
      { kind: "extra-story", storyId: "US-009" },
      { kind: "workdir-mismatch", storyId: "US-002", expected: "apps/api", actual: "packages/core" },
      { kind: "dependencies-mismatch", storyId: "US-003", expected: ["US-002"], actual: ["US-001"] },
      ORPHAN,
    ];

    const prompt = new PlanPromptBuilder().buildSpecStructureRepair(violations, OUTPUT_PATH);

    for (const violation of violations) {
      expect(prompt).toContain(formatSpecStructureViolation(violation));
    }
  });

  test("AC7 boundary: the first missing story's line is rendered before the second one's", () => {
    const first: SpecStructureViolation = { kind: "missing-story", storyId: "US-004" };
    const second: SpecStructureViolation = { kind: "missing-story", storyId: "US-005" };

    const prompt = new PlanPromptBuilder().buildSpecStructureRepair([first, second], OUTPUT_PATH);

    expect(prompt.indexOf(formatSpecStructureViolation(first))).toBeGreaterThan(-1);
    expect(prompt.indexOf(formatSpecStructureViolation(first))).toBeLessThan(
      prompt.indexOf(formatSpecStructureViolation(second)),
    );
  });
});
