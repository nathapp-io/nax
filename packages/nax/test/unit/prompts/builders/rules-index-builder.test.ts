/**
 * US-003 — the rules index builder (brief §Rules index).
 *
 * The section is prompt text, so it lives under `src/prompts/builders/`; these
 * are the pure-function tests for it. The brief-rendering and `writeBrief`
 * seams are covered by `test/unit/workflow/brief-rules-index.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import type { ResolvedRule } from "@/context/rules/rule-set";
import { buildRuleDeliveryText, buildRulesIndexSection, toRulesIndexEntry } from "@/prompts";

/** A `ResolvedRule` with only the fields an index entry reads. */
function resolvedRule(partial: Partial<ResolvedRule> & { ruleId: string }): ResolvedRule {
  return {
    fileName: `${partial.ruleId}.md`,
    content: "",
    source: "repo",
    displayPath: `.nax/rules/${partial.ruleId}.md`,
    ...partial,
  };
}

describe("buildRulesIndexSection", () => {
  test("AC-1: starts with the heading and renders one File Format line per entry", () => {
    const text = buildRulesIndexSection({
      entries: [
        {
          ruleId: "forbidden-patterns-source",
          displayPath: ".nax/rules/forbidden-patterns-source.md",
          source: "repo",
          description: "Forbidden Patterns",
          appliesTo: ["packages/nax/src/**/*.ts", "packages/nax/bin/*.ts"],
          priority: 100,
        },
      ],
      shownAutomatically: true,
    });
    expect(text.startsWith("## Rules index")).toBe(true);
    expect(text.split("\n").filter((line) => line.startsWith("- `"))).toEqual([
      "- `forbidden-patterns-source` (.nax/rules/forbidden-patterns-source.md): Forbidden Patterns. Applies to: packages/nax/src/**/*.ts, packages/nax/bin/*.ts",
    ]);
  });

  test("AC-1: one line per entry, and both intro sentences are present", () => {
    const text = buildRulesIndexSection({
      entries: [
        {
          ruleId: "a",
          displayPath: ".nax/rules/a.md",
          source: "repo",
          description: "A",
          appliesTo: [],
          priority: 10,
        },
        {
          ruleId: "b",
          displayPath: ".nax/rules/b.md",
          source: "package",
          description: "B",
          appliesTo: [],
          priority: 20,
        },
      ],
      shownAutomatically: true,
    });
    expect(text.split("\n").filter((line) => line.startsWith("- `"))).toHaveLength(2);
    expect(text).toContain("This repository's rules.");
    expect(text).toContain(
      "Each rule's full text is shown to you the first time you read, write or edit a file it applies to.",
    );
    expect(text).toContain("Open a rule's file to read it sooner.");
  });

  test("AC-2: an entry with no appliesTo renders its scope as all files", () => {
    const text = buildRulesIndexSection({
      entries: [
        {
          ruleId: "org-logging",
          displayPath: ".nax/rules/org-logging.md",
          source: "repo",
          description: "Logging",
          appliesTo: [],
          priority: 100,
        },
      ],
      shownAutomatically: true,
    });
    expect(text).toContain("Applies to: all files");
  });

  test("AC-3: override entries carry ', override' after the display path; repo and package entries do not", () => {
    const text = buildRulesIndexSection({
      entries: [
        {
          ruleId: "org-logging",
          displayPath: "/abs/path/to/org-rules/org-logging.md",
          source: "override",
          description: "Logging policy for unattended runs",
          appliesTo: [],
          priority: 1,
        },
        {
          ruleId: "repo-rule",
          displayPath: ".nax/rules/repo-rule.md",
          source: "repo",
          description: "Repo rule",
          appliesTo: [],
          priority: 2,
        },
        {
          ruleId: "pkg-rule",
          displayPath: "packages/api/.nax/rules/pkg-rule.md",
          source: "package",
          description: "Package rule",
          appliesTo: [],
          priority: 3,
        },
      ],
      shownAutomatically: true,
    });
    expect(text).toContain("- `org-logging` (/abs/path/to/org-rules/org-logging.md, override): ");
    expect(text).toContain("- `repo-rule` (.nax/rules/repo-rule.md): ");
    expect(text).toContain("- `pkg-rule` (packages/api/.nax/rules/pkg-rule.md): ");
    expect(text).not.toContain(".nax/rules/repo-rule.md, override");
    expect(text).not.toContain("pkg-rule.md, override");
  });

  test("AC-5: lines are ordered by priority ascending, then by rule id ascending", () => {
    const text = buildRulesIndexSection({
      entries: [
        {
          ruleId: "z-high",
          displayPath: ".nax/rules/z-high.md",
          source: "repo",
          description: "Z",
          appliesTo: [],
          priority: 100,
        },
        {
          ruleId: "b-default",
          displayPath: ".nax/rules/b-default.md",
          source: "repo",
          description: "B",
          appliesTo: [],
          priority: 100,
        },
        {
          ruleId: "a-first",
          displayPath: ".nax/rules/a-first.md",
          source: "repo",
          description: "A",
          appliesTo: [],
          priority: 10,
        },
      ],
      shownAutomatically: true,
    });
    const ids = text
      .split("\n")
      .filter((line) => line.startsWith("- `"))
      .map((line) => line.slice(3, line.indexOf("`", 3)));
    expect(ids).toEqual(["a-first", "b-default", "z-high"]);
  });

  test("AC-5: the caller's entry array is not reordered in place", () => {
    const entries = [
      {
        ruleId: "b",
        displayPath: ".nax/rules/b.md",
        source: "repo" as const,
        description: "B",
        appliesTo: [] as string[],
        priority: 2,
      },
      {
        ruleId: "a",
        displayPath: ".nax/rules/a.md",
        source: "repo" as const,
        description: "A",
        appliesTo: [] as string[],
        priority: 1,
      },
    ];
    buildRulesIndexSection({ entries, shownAutomatically: true });
    expect(entries.map((e) => e.ruleId)).toEqual(["b", "a"]);
  });

  test("AC-6: shownAutomatically false swaps the delivery sentence for the read-it-yourself one", () => {
    const entries = [
      {
        ruleId: "a",
        displayPath: ".nax/rules/a.md",
        source: "repo" as const,
        description: "A",
        appliesTo: [] as string[],
        priority: 1,
      },
    ];
    const manual = buildRulesIndexSection({ entries, shownAutomatically: false });
    expect(manual).toContain("Before you write or edit a file a rule applies to, read that rule's file.");
    expect(manual).not.toContain("shown to you the first time");
    expect(manual).toContain("Open a rule's file to read it sooner.");

    const automatic = buildRulesIndexSection({ entries, shownAutomatically: true });
    expect(automatic).toContain("shown to you the first time");
    expect(automatic).not.toContain("Before you write or edit a file a rule applies to");
  });

  test("an empty entry set renders no section", () => {
    expect(buildRulesIndexSection({ entries: [], shownAutomatically: true })).toBe("");
    expect(buildRulesIndexSection({ entries: [], shownAutomatically: false })).toBe("");
  });
});

describe("toRulesIndexEntry", () => {
  test("AC-4: description is the frontmatter description when present", () => {
    const entry = toRulesIndexEntry(
      resolvedRule({
        ruleId: "a",
        description: "From frontmatter",
        content: "# Heading\n\nbody\n",
        appliesTo: ["packages/api/**"],
        priority: 5,
      }),
    );
    expect(entry).toEqual({
      ruleId: "a",
      displayPath: ".nax/rules/a.md",
      source: "repo",
      description: "From frontmatter",
      appliesTo: ["packages/api/**"],
      priority: 5,
    });
  });

  test("AC-4: description falls back to the first Markdown heading's text", () => {
    const entry = toRulesIndexEntry(
      resolvedRule({ ruleId: "b", content: "preamble line\n\n# First Heading\n\nbody\n\n## Second Heading\n" }),
    );
    expect(entry.description).toBe("First Heading");
  });

  test("AC-4: description falls back to the rule id when there is no heading", () => {
    const entry = toRulesIndexEntry(resolvedRule({ ruleId: "c", content: "prose only\nno heading at all\n" }));
    expect(entry.description).toBe("c");
  });

  test("AC-4: an entry keeps the rule's displayPath and source", () => {
    const entry = toRulesIndexEntry(
      resolvedRule({
        ruleId: "org-logging",
        source: "override",
        displayPath: "/abs/path/to/org-rules/org-logging.md",
        content: "# Logging\n",
      }),
    );
    expect(entry.displayPath).toBe("/abs/path/to/org-rules/org-logging.md");
    expect(entry.source).toBe("override");
  });

  test("a rule with no appliesTo yields an empty appliesTo list (all files)", () => {
    expect(toRulesIndexEntry(resolvedRule({ ruleId: "d", content: "# D\n" })).appliesTo).toEqual([]);
  });

  test("a rule with no priority takes the frontmatter default", () => {
    expect(toRulesIndexEntry(resolvedRule({ ruleId: "e", content: "# E\n" })).priority).toBe(100);
  });

  // `stages:` is a pipeline-only key: workflow mode never applies it, so an
  // entry is listed whatever stages it names.
  test("a rule carrying stages frontmatter is still indexed", () => {
    const entry = toRulesIndexEntry(
      resolvedRule({ ruleId: "f", content: "# F\n", stages: ["execution", "not-a-stage"] }),
    );
    expect(entry.ruleId).toBe("f");
    expect(entry.description).toBe("F");
  });
});

describe("buildRuleDeliveryText", () => {
  test("AC-1: names the path and renders each delivered rule under a '### <id> (<path>)' heading", () => {
    const text = buildRuleDeliveryText({
      path: "packages/nax/src/foo.ts",
      delivered: [resolvedRule({ ruleId: "r", content: "RULE-BODY\n" })],
      listedOnly: [],
      mode: "read",
    });

    expect(text.startsWith("Rules that apply to packages/nax/src/foo.ts:")).toBe(true);
    expect(text).toContain("### r (.nax/rules/r.md)");
    expect(text).toContain("RULE-BODY");
  });

  test("AC-1: an override rule's absolute display path is the heading's parenthetical", () => {
    const text = buildRuleDeliveryText({
      path: "packages/nax/src/foo.ts",
      delivered: [
        resolvedRule({
          ruleId: "org-logging",
          source: "override",
          displayPath: "/abs/org-rules/org-logging.md",
          content: "ORG-BODY\n",
        }),
      ],
      listedOnly: [],
      mode: "read",
    });

    expect(text).toContain("### org-logging (/abs/org-rules/org-logging.md)");
  });

  test("AC-4: write mode ends with the refuse-once retry sentence", () => {
    const text = buildRuleDeliveryText({
      path: "packages/nax/src/foo.ts",
      delivered: [resolvedRule({ ruleId: "r", content: "RULE-BODY\n" })],
      listedOnly: [],
      mode: "write",
    });

    expect(text.trimEnd().endsWith("No files were changed. Review these rules and retry the tool call.")).toBe(true);
  });

  test("AC-1: read mode does not carry the retry sentence", () => {
    const text = buildRuleDeliveryText({
      path: "packages/nax/src/foo.ts",
      delivered: [resolvedRule({ ruleId: "r", content: "RULE-BODY\n" })],
      listedOnly: [],
      mode: "read",
    });

    expect(text).not.toContain("No files were changed");
  });

  test("AC-15: rules past the cap are listed by id and path, with no body", () => {
    const text = buildRuleDeliveryText({
      path: "packages/nax/src/foo.ts",
      delivered: [resolvedRule({ ruleId: "shown", content: "SHOWN-BODY\n" })],
      listedOnly: [resolvedRule({ ruleId: "listed", content: "LISTED-BODY\n" })],
      mode: "read",
    });

    expect(text).toContain("Also applies (not shown, open the file): listed (.nax/rules/listed.md)");
    expect(text).not.toContain("LISTED-BODY");
    expect(text).toContain("SHOWN-BODY");
  });

  test("AC-4: the retry sentence follows the listed-only lines in write mode", () => {
    const text = buildRuleDeliveryText({
      path: "packages/nax/src/foo.ts",
      delivered: [resolvedRule({ ruleId: "shown", content: "SHOWN-BODY\n" })],
      listedOnly: [resolvedRule({ ruleId: "listed", content: "LISTED-BODY\n" })],
      mode: "write",
    });

    expect(text.indexOf("Also applies (not shown, open the file): listed")).toBeLessThan(
      text.indexOf("No files were changed."),
    );
  });
});
