/**
 * US-006 — the "## Rules for the changed files" section a review package carries.
 *
 * The section is prompt text, so it lives under `src/prompts/builders/` beside the
 * rules index; these are the pure-function tests for it. The per-file map that
 * feeds it (`appendChangedFileRules`) is covered by
 * `test/unit/workflow/review-rules-map.test.ts`, and the two review steps that call
 * it by `test/integration/workflow-review-rules.test.ts`.
 *
 * The section deliberately carries no rule body: a `ChangedFileRuleGroup` holds a
 * `RulesIndexEntry` (id, display path, description, scope, priority) and a list of
 * paths, and neither type can carry one.
 */
import { describe, expect, test } from "bun:test";
import { buildChangedFileRulesSection, type ChangedFileRuleGroup } from "@/prompts";

/** One group: a rule and the changed files it governs, in diff order. */
function group(ruleId: string, paths: string[], displayPath = `.nax/rules/${ruleId}.md`): ChangedFileRuleGroup {
  return {
    rule: { ruleId, displayPath, source: "repo", description: "Forbidden Patterns", appliesTo: [], priority: 100 },
    paths,
  };
}

/** The `- ` lines of a rendered section. */
function lines(text: string): string[] {
  return text.split("\n").filter((line) => line.startsWith("- "));
}

describe("buildChangedFileRulesSection", () => {
  test("AC-1: starts with the heading and renders one File Format line per group", () => {
    const text = buildChangedFileRulesSection([
      group("forbidden-patterns-source", ["packages/nax/src/a.ts", "packages/nax/src/b.ts"]),
      group("org-logging", ["packages/nax/src/c.ts"]),
    ]);

    expect(text.startsWith("## Rules for the changed files")).toBe(true);
    expect(lines(text)).toEqual([
      "- `forbidden-patterns-source` (.nax/rules/forbidden-patterns-source.md): 2 changed files, e.g. packages/nax/src/a.ts, packages/nax/src/b.ts",
      "- `org-logging` (.nax/rules/org-logging.md): 1 changed files, e.g. packages/nax/src/c.ts",
    ]);
  });

  test("AC-1: the section carries the read-the-rule-first sentence after the heading", () => {
    const text = buildChangedFileRulesSection([group("a", ["src/a.ts"])]);
    const [heading, , intro] = text.split("\n");
    expect(heading).toBe("## Rules for the changed files");
    expect(intro).toBe("Read a rule's file before you judge the changed code against it.");
  });

  test("AC-2: five paths render the count and exactly the first three paths in input order", () => {
    const paths = ["src/1.ts", "src/2.ts", "src/3.ts", "src/4.ts", "src/5.ts"];
    const text = buildChangedFileRulesSection([group("a", paths)]);

    expect(lines(text)[0]).toContain("5 changed files, e.g. src/1.ts, src/2.ts, src/3.ts");
    expect(lines(text)[0]).not.toContain("src/4.ts");
    expect(lines(text)[0]).not.toContain("src/5.ts");
  });

  test("AC-3: a line holds the rule id, display path, count and examples, and no rule body", () => {
    const text = buildChangedFileRulesSection([
      group(
        "forbidden-patterns-source",
        ["packages/nax/src/a.ts"],
        "packages/api/.nax/rules/forbidden-patterns-source.md",
      ),
    ]);

    expect(lines(text)[0]).toBe(
      "- `forbidden-patterns-source` (packages/api/.nax/rules/forbidden-patterns-source.md): 1 changed files, e.g. packages/nax/src/a.ts",
    );
    // The entry's description (and therefore anything body-like) is not rendered: the
    // reviewer is told which file to open, never what it says.
    expect(text).not.toContain("Forbidden Patterns");
  });

  test("an override rule's absolute display path is what the line carries", () => {
    const text = buildChangedFileRulesSection([group("org-logging", ["src/a.ts"], "/abs/org-rules/org-logging.md")]);
    expect(lines(text)[0]).toContain("(/abs/org-rules/org-logging.md)");
  });

  test("the caller's group and path arrays are not reordered in place", () => {
    const paths = ["src/4.ts", "src/1.ts", "src/2.ts", "src/3.ts"];
    buildChangedFileRulesSection([group("a", paths)]);
    expect(paths).toEqual(["src/4.ts", "src/1.ts", "src/2.ts", "src/3.ts"]);
  });

  test("no groups renders no section", () => {
    expect(buildChangedFileRulesSection([])).toBe("");
  });

  // Defensive: the map never emits a group with no paths, and a line with a dangling
  // "e.g. " would read as a truncated list if one ever reached here.
  test("a group with no paths renders its count and no dangling example list", () => {
    expect(buildChangedFileRulesSection([group("a", [])])).toContain("- `a` (.nax/rules/a.md): 0 changed files\n");
  });
});
