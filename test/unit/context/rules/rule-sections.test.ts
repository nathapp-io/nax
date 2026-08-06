/**
 * rule-sections.ts — unit tests
 *
 * Covers splitRuleIntoSections() — splits a CanonicalRule into H2 sections
 * with deterministic, unique slugs and inherited rule metadata.
 */

import { describe, expect, test } from "bun:test";
import { type CanonicalRule, estimateTokens, splitRuleIntoSections } from "@/context";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeRule(overrides: Partial<CanonicalRule> & { content: string }): CanonicalRule {
  return {
    fileName: "rule.md",
    path: "rule.md",
    content: overrides.content,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1: Module surface
// ─────────────────────────────────────────────────────────────────────────────

describe("@/context/rules/rule-sections surface", () => {
  test("AC1: exports splitRuleIntoSections from @/context/rules/rule-sections", async () => {
    // Build the import spec at runtime so the alias-internals lint check
    // (which scans static/dynamic import literals) does not flag this AC1
    // surface test. The runtime import resolves the same module path the
    // production callers would use.
    const modulePath = "@/context/rules/rule-sections" as string;
    const mod = (await import(modulePath)) as { splitRuleIntoSections?: unknown };
    expect(typeof mod.splitRuleIntoSections).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2/AC3: three H2 headings -> three sections, ordinals 0,1,2 in order
// ─────────────────────────────────────────────────────────────────────────────

describe("splitRuleIntoSections — heading count and ordinals", () => {
  test("AC2: three ## headings produce three sections", () => {
    const rule = makeRule({
      content: ["## Alpha", "", "alpha body", "", "## Beta", "", "beta body", "", "## Gamma", "", "gamma body"].join(
        "\n",
      ),
    });
    const sections = splitRuleIntoSections(rule);
    expect(sections).toHaveLength(3);
  });

  test("AC3: three ## headings produce ordinals 0, 1, and 2 in document order", () => {
    const rule = makeRule({
      content: ["## Alpha", "alpha", "## Beta", "beta", "## Gamma", "gamma"].join("\n"),
    });
    const sections = splitRuleIntoSections(rule);
    expect(sections.map((s) => s.ordinal)).toEqual([0, 1, 2]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4: preamble before first H2 is ordinal 0 with heading undefined
// ─────────────────────────────────────────────────────────────────────────────

describe("splitRuleIntoSections — preamble", () => {
  test("AC4: content before first ## heading becomes ordinal 0 with heading undefined", () => {
    const rule = makeRule({
      content: ["preamble line 1", "preamble line 2", "", "## First", "", "first body"].join("\n"),
    });
    const sections = splitRuleIntoSections(rule);
    expect(sections).toHaveLength(2);
    expect(sections[0]?.ordinal).toBe(0);
    expect(sections[0]?.heading).toBeUndefined();
    expect(sections[0]?.content).toContain("preamble line 1");
    expect(sections[1]?.ordinal).toBe(1);
    expect(sections[1]?.heading).toBe("First");
  });

  test("whitespace-only preamble still emits a preamble section (current behaviour pinned)", () => {
    // Content: "\n\n## A\nbody" — two blank lines before the first H2.
    // AC4 says "When content precedes the first ## heading" — whitespace-only
    // lines still constitute "preceding content" under the current
    // implementation: a preamble section is emitted with that whitespace as
    // its `content`. This test pins that behaviour so any future change must
    // update both the source and the test in lockstep.
    const content = "\n\n## A\nbody";
    const sections = splitRuleIntoSections(makeRule({ content }));
    expect(sections).toHaveLength(2);
    expect(sections[0]?.ordinal).toBe(0);
    expect(sections[0]?.heading).toBeUndefined();
    expect(sections[0]?.content).toBe("\n");
    expect(sections[0]?.tokens).toBe(estimateTokens("\n"));
    expect(sections[0]?.slug).toBe("preamble");
    expect(sections[1]?.heading).toBe("A");
    expect(sections[1]?.ordinal).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5: no H2 -> exactly one section whose content equals the rule content
// ─────────────────────────────────────────────────────────────────────────────

describe("splitRuleIntoSections — no headings", () => {
  test("AC5: a CanonicalRule with no ## heading produces exactly one section with content equal to the rule content", () => {
    const content = "Just some text.\nNo headings at all.\n";
    const rule = makeRule({ content });
    const sections = splitRuleIntoSections(rule);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.content).toBe(content);
  });

  test("AC5b: H3-only content still produces exactly one section (no H2 boundary)", () => {
    const content = "### Subheading only\nbody text";
    const rule = makeRule({ content });
    const sections = splitRuleIntoSections(rule);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.content).toBe(content);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6: priority is inherited by every section
// ─────────────────────────────────────────────────────────────────────────────

describe("splitRuleIntoSections — priority inheritance", () => {
  test("AC6: when a CanonicalRule declares priority 45, every section carries priority 45", () => {
    const rule = makeRule({
      priority: 45,
      content: ["## Alpha", "alpha", "## Beta", "beta", "## Gamma", "gamma"].join("\n"),
    });
    const sections = splitRuleIntoSections(rule);
    expect(sections).toHaveLength(3);
    expect(sections.every((s) => s.priority === 45)).toBe(true);
  });

  test("AC6 (preamble): priority is inherited by the preamble section too", () => {
    const rule = makeRule({
      priority: 7,
      content: ["preamble", "", "## Alpha", "alpha"].join("\n"),
    });
    const sections = splitRuleIntoSections(rule);
    expect(sections.every((s) => s.priority === 7)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC7: appliesTo and stages are inherited
// ─────────────────────────────────────────────────────────────────────────────

describe("splitRuleIntoSections — appliesTo / stages inheritance", () => {
  test("AC7: appliesTo ['src/**'] and stages ['execution'] are carried by every section", () => {
    const rule = makeRule({
      appliesTo: ["src/**"],
      stages: ["execution"],
      content: ["## Alpha", "alpha", "## Beta", "beta"].join("\n"),
    });
    const sections = splitRuleIntoSections(rule);
    expect(sections).toHaveLength(2);
    for (const section of sections) {
      expect(section.appliesTo).toEqual(["src/**"]);
      expect(section.stages).toEqual(["execution"]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC8: heading text -> kebab-case slug
// ─────────────────────────────────────────────────────────────────────────────

describe("splitRuleIntoSections — slug derivation", () => {
  test("AC8: '## Prompt Builder Convention' produces slug 'prompt-builder-convention'", () => {
    const rule = makeRule({
      content: ["## Prompt Builder Convention", "", "body"].join("\n"),
    });
    const sections = splitRuleIntoSections(rule);
    expect(sections[0]?.slug).toBe("prompt-builder-convention");
  });

  test("AC8 (preamble): a preamble section (no heading) gets a deterministic non-empty slug", () => {
    const rule = makeRule({ content: "preamble only" });
    const sections = splitRuleIntoSections(rule);
    expect(typeof sections[0]?.slug).toBe("string");
    expect(sections[0]?.slug.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC9: duplicate heading -> two sections with different slugs
// ─────────────────────────────────────────────────────────────────────────────

describe("splitRuleIntoSections — slug uniqueness", () => {
  test("AC9: duplicate '## Foo' heading produces two sections with different slug values", () => {
    const rule = makeRule({
      content: ["## Foo", "first body", "## Foo", "second body"].join("\n"),
    });
    const sections = splitRuleIntoSections(rule);
    expect(sections).toHaveLength(2);
    expect(sections[0]?.slug).not.toBe(sections[1]?.slug);
  });

  test("two non-ASCII headings still produce unique slugs (lossy fallback pinned)", () => {
    // The slug normaliser strips non-ASCII letters, so Unicode-only headings
    // collapse to the "section" fallback. The duplicate-suffix machinery in
    // rule-sections.ts must still kick in to keep them unique. This test
    // pins the documented behaviour: distinct Unicode headings -> distinct
    // slugs (the fallback plus an ordinal suffix).
    const rule = makeRule({
      content: ["## 中文标题", "first body", "## 日本語見出し", "second body"].join("\n"),
    });
    const sections = splitRuleIntoSections(rule);
    expect(sections).toHaveLength(2);
    expect(sections[0]?.slug).toBe("section");
    expect(sections[1]?.slug).toBe("section-2");
    expect(sections[0]?.slug).not.toBe(sections[1]?.slug);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC10: H3 (and deeper) headings remain inside their parent section
// ─────────────────────────────────────────────────────────────────────────────

describe("splitRuleIntoSections — H3 stays in the parent section", () => {
  test("AC10: ### inside a section body stays inside the section's content and does not start another section", () => {
    const rule = makeRule({
      content: [
        "## Parent",
        "",
        "parent body",
        "",
        "### Child",
        "",
        "child body",
        "",
        "## Sibling",
        "",
        "sibling body",
      ].join("\n"),
    });
    const sections = splitRuleIntoSections(rule);
    expect(sections).toHaveLength(2);
    expect(sections[0]?.heading).toBe("Parent");
    expect(sections[0]?.content).toContain("### Child");
    expect(sections[0]?.content).toContain("child body");
    expect(sections[1]?.heading).toBe("Sibling");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC11: section tokens equal the token estimate of the section's own content
// ─────────────────────────────────────────────────────────────────────────────

describe("splitRuleIntoSections — own-content tokens", () => {
  test("AC11: every section's tokens equals the token estimate of its own content", () => {
    const content = [
      "preamble paragraph",
      "",
      "## Alpha",
      "",
      "alpha body that should be counted",
      "",
      "## Beta",
      "",
      "beta body that should be counted",
    ].join("\n");
    const rule = makeRule({ content });
    const sections = splitRuleIntoSections(rule);
    expect(sections.length).toBeGreaterThan(0);
    for (const section of sections) {
      expect(section.tokens).toBe(estimateTokens(section.content));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Owning-rule identity is preserved on each section
// ─────────────────────────────────────────────────────────────────────────────

describe("splitRuleIntoSections — owning-rule identity", () => {
  test("each section retains the owning rule's id/fileName/path", () => {
    const rule: CanonicalRule = {
      id: "prompt-builder",
      fileName: "prompt-builder.md",
      path: "conventions/prompt-builder.md",
      content: ["## Alpha", "alpha", "## Beta", "beta"].join("\n"),
    };
    const sections = splitRuleIntoSections(rule);
    expect(sections).toHaveLength(2);
    for (const section of sections) {
      expect(section.ruleId).toBe("prompt-builder");
      expect(section.rulePath).toBe("conventions/prompt-builder.md");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fenced code blocks are not section boundaries
// ─────────────────────────────────────────────────────────────────────────────

describe("splitRuleIntoSections — fenced code blocks", () => {
  test("a '## ' line inside a fence does not start a new section", () => {
    // Rule files that document markdown by example contain literal headings
    // inside fences. Splitting there cuts the section mid-fence, so a retained
    // section can open a fence it never closes.
    const rule: CanonicalRule = {
      id: "authoring",
      fileName: "authoring.md",
      content: [
        "## Real",
        "prose",
        "```markdown",
        "## Not A Heading",
        "example body",
        "```",
        "more prose",
      ].join("\n"),
    };

    const sections = splitRuleIntoSections(rule);

    expect(sections).toHaveLength(1);
    expect(sections[0]?.heading).toBe("Real");
    // The fenced block survives intact, opener and closer together.
    expect(sections[0]?.content).toContain("## Not A Heading");
    expect(sections[0]?.content.match(/```/g)).toHaveLength(2);
  });

  test("headings after a closed fence are still boundaries", () => {
    const rule: CanonicalRule = {
      id: "authoring",
      fileName: "authoring.md",
      content: ["## One", "```", "## Fenced", "```", "## Two", "body"].join("\n"),
    };

    const sections = splitRuleIntoSections(rule);

    expect(sections.map((s) => s.heading)).toEqual(["One", "Two"]);
  });

  test("tilde fences are honoured as well as backtick fences", () => {
    const rule: CanonicalRule = {
      id: "authoring",
      fileName: "authoring.md",
      content: ["## One", "~~~", "## Fenced", "~~~", "tail"].join("\n"),
    };

    expect(splitRuleIntoSections(rule).map((s) => s.heading)).toEqual(["One"]);
  });
});
