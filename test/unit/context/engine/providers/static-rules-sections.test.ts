/**
 * StaticRulesProvider — US-004 section-level chunking tests
 *
 * Verifies that StaticRulesProvider.fetch() emits one chunk per rule section
 * (instead of one chunk per rule), feeds sections through the new
 * applySectionBudget dependency, and surfaces section-level budget pressure
 * plus a sectionCount on the scoping report.
 *
 * Each test injects `_staticRulesDeps.splitRuleIntoSections` and
 * `_staticRulesDeps.applySectionBudget` so the test owns the sectionisation
 * shape and the budget-result shape. The provider must call the new deps;
 * the canonical rule and stage/appliesTo filtering is otherwise real.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _staticRulesDeps, StaticRulesProvider } from "@/context/engine";
import type { ContextRequest } from "@/context/engine/types";
import type { CanonicalRule } from "@/context/rules/canonical-loader";
import type { RuleSection } from "@/context/rules/rule-sections";
import { byCodePoint } from "@/utils/sort";

// ─────────────────────────────────────────────────────────────────────────────
// Dep save/restore
// ─────────────────────────────────────────────────────────────────────────────

type DepSnapshot = {
  readFile: typeof _staticRulesDeps.readFile;
  fileExists: typeof _staticRulesDeps.fileExists;
  globInDir: typeof _staticRulesDeps.globInDir;
  loadCanonicalRules: typeof _staticRulesDeps.loadCanonicalRules;
  splitRuleIntoSections: typeof _staticRulesDeps.splitRuleIntoSections;
  applySectionBudget: typeof _staticRulesDeps.applySectionBudget;
};

let origDeps: DepSnapshot;

beforeEach(() => {
  origDeps = {
    readFile: _staticRulesDeps.readFile,
    fileExists: _staticRulesDeps.fileExists,
    globInDir: _staticRulesDeps.globInDir,
    loadCanonicalRules: _staticRulesDeps.loadCanonicalRules,
    splitRuleIntoSections: _staticRulesDeps.splitRuleIntoSections,
    applySectionBudget: _staticRulesDeps.applySectionBudget,
  };
  _staticRulesDeps.readFile = async () => "";
  _staticRulesDeps.fileExists = async () => false;
  _staticRulesDeps.globInDir = () => [];
  _staticRulesDeps.loadCanonicalRules = async () => [];
  // Real default implementations wired by the provider file — leave them
  // as-is unless a specific test overrides.
});

afterEach(() => {
  _staticRulesDeps.readFile = origDeps.readFile;
  _staticRulesDeps.fileExists = origDeps.fileExists;
  _staticRulesDeps.globInDir = origDeps.globInDir;
  _staticRulesDeps.loadCanonicalRules = origDeps.loadCanonicalRules;
  _staticRulesDeps.splitRuleIntoSections = origDeps.splitRuleIntoSections;
  _staticRulesDeps.applySectionBudget = origDeps.applySectionBudget;
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixture builders
// ─────────────────────────────────────────────────────────────────────────────

const BASE_REQUEST: ContextRequest = {
  storyId: "US-004",
  repoRoot: "/project",
  packageDir: "/project",
  stage: "execution",
  role: "implementer",
  budgetTokens: 4000,
};

function sectionOf(
  rule: CanonicalRule,
  partial: Partial<RuleSection> & { slug: string; content: string },
): RuleSection {
  return {
    ruleId: rule.id ?? rule.fileName.replace(/\.md$/i, ""),
    rulePath: rule.path ?? rule.fileName,
    content: partial.content,
    tokens: partial.tokens ?? Math.max(1, Math.ceil(partial.content.length / 4)),
    priority: rule.priority,
    paths: rule.paths,
    appliesTo: rule.appliesTo,
    stages: rule.stages,
    ordinal: partial.ordinal ?? 0,
    heading: partial.heading,
    slug: partial.slug,
  };
}

function setupCanonical(rules: CanonicalRule[]) {
  _staticRulesDeps.loadCanonicalRules = async () => rules;
}

// ─────────────────────────────────────────────────────────────────────────────
// AC1: splitRuleIntoSections called once per loaded canonical rule
// ─────────────────────────────────────────────────────────────────────────────

describe("StaticRulesProvider — US-004 AC1: splitRuleIntoSections invocation", () => {
  test("AC1: splitRuleIntoSections is called once for each loaded canonical rule", async () => {
    const rules: CanonicalRule[] = [
      { fileName: "a.md", id: "a", content: "## A\nbody" },
      { fileName: "b.md", id: "b", content: "## B\nbody" },
      { fileName: "c.md", id: "c", content: "## C\nbody" },
    ];
    setupCanonical(rules);
    const calls: string[] = [];
    _staticRulesDeps.splitRuleIntoSections = ((rule: CanonicalRule) => {
      calls.push(rule.id ?? rule.fileName);
      return [sectionOf(rule, { slug: "section", content: rule.content, ordinal: 0 })];
    }) as typeof _staticRulesDeps.splitRuleIntoSections;
    _staticRulesDeps.applySectionBudget = ((sections: RuleSection[]) => ({
      retainedSections: sections,
      totalTokens: sections.reduce((sum, s) => sum + s.tokens, 0),
      usedTokens: sections.reduce((sum, s) => sum + s.tokens, 0),
      droppedIds: [],
      overageTokens: 0,
    })) as typeof _staticRulesDeps.applySectionBudget;

    const provider = new StaticRulesProvider();
    await provider.fetch(BASE_REQUEST);

    expect(calls.sort(byCodePoint)).toEqual(["a", "b", "c"]);
    expect(calls).toHaveLength(rules.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2: applySectionBudget receives min(rulesShare * request.budgetTokens, budgetTokens)
// ─────────────────────────────────────────────────────────────────────────────

describe("StaticRulesProvider — US-004 AC2: applySectionBudget invocation", () => {
  test("AC2: applySectionBudget receives budgetTokens = rulesShare * request.budgetTokens when below provider cap", async () => {
    setupCanonical([{ fileName: "a.md", id: "a", content: "## A\nbody" }]);
    const section = sectionOf({ fileName: "a.md", id: "a" } as CanonicalRule, {
      slug: "section",
      content: "## A\nbody",
      ordinal: 0,
    });
    _staticRulesDeps.splitRuleIntoSections = (() => [section]) as typeof _staticRulesDeps.splitRuleIntoSections;
    let receivedBudget = -1;
    _staticRulesDeps.applySectionBudget = ((_sections: RuleSection[], budgetTokens: number) => {
      receivedBudget = budgetTokens;
      return {
        retainedSections: [],
        totalTokens: 0,
        usedTokens: 0,
        droppedIds: [],
        overageTokens: 0,
      };
    }) as typeof _staticRulesDeps.applySectionBudget;

    const provider = new StaticRulesProvider();
    await provider.fetch({ ...BASE_REQUEST, budgetTokens: 4000 });

    // rulesShare default = 0.4, so 4000 * 0.4 = 1600
    expect(receivedBudget).toBe(1600);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3: two ## sections in one rule produce two distinct chunks
// ─────────────────────────────────────────────────────────────────────────────

describe("StaticRulesProvider — US-004 AC3/AC4/AC5/AC6: section chunk shape", () => {
  test("AC3: one rule file with two ## sections produces two chunks with different ids", async () => {
    setupCanonical([{ fileName: "multi.md", id: "multi", content: "## First\nfirst body\n## Second\nsecond body" }]);
    const rule = { fileName: "multi.md", id: "multi" } as CanonicalRule;
    const sections: RuleSection[] = [
      sectionOf(rule, { slug: "first", content: "## First\nfirst body", heading: "First", ordinal: 0 }),
      sectionOf(rule, { slug: "second", content: "## Second\nsecond body", heading: "Second", ordinal: 1 }),
    ];
    _staticRulesDeps.splitRuleIntoSections = (() => sections) as typeof _staticRulesDeps.splitRuleIntoSections;
    _staticRulesDeps.applySectionBudget = ((s: RuleSection[]) => ({
      retainedSections: s,
      totalTokens: s.reduce((sum, x) => sum + x.tokens, 0),
      usedTokens: s.reduce((sum, x) => sum + x.tokens, 0),
      droppedIds: [],
      overageTokens: 0,
    })) as typeof _staticRulesDeps.applySectionBudget;

    const provider = new StaticRulesProvider();
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.chunks).toHaveLength(2);
    expect(result.chunks[0]?.id).not.toBe(result.chunks[1]?.id);
  });

  test("AC4: every chunk id incorporates the owning section slug", async () => {
    setupCanonical([{ fileName: "multi.md", id: "multi", content: "## Alpha\nbody\n## Beta\nbody" }]);
    const rule = { fileName: "multi.md", id: "multi" } as CanonicalRule;
    const sections: RuleSection[] = [
      sectionOf(rule, { slug: "alpha", content: "## Alpha\nbody", heading: "Alpha", ordinal: 0 }),
      sectionOf(rule, { slug: "beta", content: "## Beta\nbody", heading: "Beta", ordinal: 1 }),
    ];
    _staticRulesDeps.splitRuleIntoSections = (() => sections) as typeof _staticRulesDeps.splitRuleIntoSections;
    _staticRulesDeps.applySectionBudget = ((s: RuleSection[]) => ({
      retainedSections: s,
      totalTokens: s.reduce((sum, x) => sum + x.tokens, 0),
      usedTokens: s.reduce((sum, x) => sum + x.tokens, 0),
      droppedIds: [],
      overageTokens: 0,
    })) as typeof _staticRulesDeps.applySectionBudget;

    const provider = new StaticRulesProvider();
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.chunks[0]?.id).toContain("alpha");
    expect(result.chunks[1]?.id).toContain("beta");
  });

  test("AC5: every section chunk has kind 'static'", async () => {
    setupCanonical([{ fileName: "multi.md", id: "multi", content: "## A\nbody\n## B\nbody" }]);
    const rule = { fileName: "multi.md", id: "multi" } as CanonicalRule;
    const sections: RuleSection[] = [
      sectionOf(rule, { slug: "a", content: "## A\nbody", heading: "A", ordinal: 0 }),
      sectionOf(rule, { slug: "b", content: "## B\nbody", heading: "B", ordinal: 1 }),
    ];
    _staticRulesDeps.splitRuleIntoSections = (() => sections) as typeof _staticRulesDeps.splitRuleIntoSections;
    _staticRulesDeps.applySectionBudget = ((s: RuleSection[]) => ({
      retainedSections: s,
      totalTokens: s.reduce((sum, x) => sum + x.tokens, 0),
      usedTokens: s.reduce((sum, x) => sum + x.tokens, 0),
      droppedIds: [],
      overageTokens: 0,
    })) as typeof _staticRulesDeps.applySectionBudget;

    const provider = new StaticRulesProvider();
    const result = await provider.fetch(BASE_REQUEST);
    for (const chunk of result.chunks) {
      expect(chunk.kind).toBe("static");
    }
  });

  test("AC6: every section chunk has rawScore 1.0", async () => {
    setupCanonical([{ fileName: "multi.md", id: "multi", content: "## A\nbody\n## B\nbody" }]);
    const rule = { fileName: "multi.md", id: "multi" } as CanonicalRule;
    const sections: RuleSection[] = [
      sectionOf(rule, { slug: "a", content: "## A\nbody", heading: "A", ordinal: 0 }),
      sectionOf(rule, { slug: "b", content: "## B\nbody", heading: "B", ordinal: 1 }),
    ];
    _staticRulesDeps.splitRuleIntoSections = (() => sections) as typeof _staticRulesDeps.splitRuleIntoSections;
    _staticRulesDeps.applySectionBudget = ((s: RuleSection[]) => ({
      retainedSections: s,
      totalTokens: s.reduce((sum, x) => sum + x.tokens, 0),
      usedTokens: s.reduce((sum, x) => sum + x.tokens, 0),
      droppedIds: [],
      overageTokens: 0,
    })) as typeof _staticRulesDeps.applySectionBudget;

    const provider = new StaticRulesProvider();
    const result = await provider.fetch(BASE_REQUEST);
    for (const chunk of result.chunks) {
      expect(chunk.rawScore).toBe(1.0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC7 / AC8: budget pressure reports omitted sections
// ─────────────────────────────────────────────────────────────────────────────

describe("StaticRulesProvider — US-004 AC7/AC8: section-level budget pressure", () => {
  test("AC7: droppedCount equals the number of omitted sections when budget is exceeded", async () => {
    setupCanonical([{ fileName: "multi.md", id: "multi", content: "## A\nbody\n## B\nbody\n## C\nbody" }]);
    const rule = { fileName: "multi.md", id: "multi" } as CanonicalRule;
    const sections: RuleSection[] = [
      sectionOf(rule, { slug: "a", content: "## A\nbody", heading: "A", ordinal: 0 }),
      sectionOf(rule, { slug: "b", content: "## B\nbody", heading: "B", ordinal: 1 }),
      sectionOf(rule, { slug: "c", content: "## C\nbody", heading: "C", ordinal: 2 }),
    ];
    _staticRulesDeps.splitRuleIntoSections = (() => sections) as typeof _staticRulesDeps.splitRuleIntoSections;
    // Keep only section "a" — drop "b" and "c"
    _staticRulesDeps.applySectionBudget = ((s: RuleSection[]) => {
      const kept = s.filter((x) => x.slug === "a");
      return {
        retainedSections: kept,
        totalTokens: s.reduce((sum, x) => sum + x.tokens, 0),
        usedTokens: kept.reduce((sum, x) => sum + x.tokens, 0),
        droppedIds: s.filter((x) => x.slug !== "a").map((x) => `${x.ruleId}#${x.slug}`),
        overageTokens: s.reduce((sum, x) => sum + x.tokens, 0),
      };
    }) as typeof _staticRulesDeps.applySectionBudget;

    const provider = new StaticRulesProvider();
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.budgetPressure?.droppedCount).toBe(2);
  });

  test("AC8: droppedTokens equals the summed tokens of omitted sections when budget is exceeded", async () => {
    setupCanonical([{ fileName: "multi.md", id: "multi", content: "## A\nbody\n## B\nbody\n## C\nbody" }]);
    const rule = { fileName: "multi.md", id: "multi" } as CanonicalRule;
    const bTokens = 25;
    const cTokens = 40;
    const sections: RuleSection[] = [
      sectionOf(rule, { slug: "a", content: "## A\nbody", heading: "A", ordinal: 0 }),
      sectionOf(rule, { slug: "b", content: "## B\nbody", heading: "B", ordinal: 1, tokens: bTokens }),
      sectionOf(rule, { slug: "c", content: "## C\nbody", heading: "C", ordinal: 2, tokens: cTokens }),
    ];
    _staticRulesDeps.splitRuleIntoSections = (() => sections) as typeof _staticRulesDeps.splitRuleIntoSections;
    // Keep "a" only — drop "b" and "c"
    _staticRulesDeps.applySectionBudget = ((s: RuleSection[]) => {
      const kept = s.filter((x) => x.slug === "a");
      return {
        retainedSections: kept,
        totalTokens: s.reduce((sum, x) => sum + x.tokens, 0),
        usedTokens: kept.reduce((sum, x) => sum + x.tokens, 0),
        droppedIds: s.filter((x) => x.slug !== "a").map((x) => `${x.ruleId}#${x.slug}`),
        overageTokens: s.reduce((sum, x) => sum + x.tokens, 0),
      };
    }) as typeof _staticRulesDeps.applySectionBudget;

    const provider = new StaticRulesProvider();
    const result = await provider.fetch(BASE_REQUEST);
    expect(result.budgetPressure?.droppedTokens).toBe(bTokens + cTokens);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC9: scopingReport.sectionCount reflects post-filter section count
// ─────────────────────────────────────────────────────────────────────────────

describe("StaticRulesProvider — US-004 AC9: scopingReport.sectionCount", () => {
  test("AC9: scopingReport.sectionCount equals the number of sections remaining after stage + appliesTo filtering", async () => {
    // Two rules: one matches the stage and scope; another is filtered by stage.
    setupCanonical([
      { fileName: "kept.md", id: "kept", content: "## A\nbody" },
      { fileName: "filtered.md", id: "filtered", content: "## B\nbody", stages: ["other"] },
    ]);
    const keptRule = { fileName: "kept.md", id: "kept" } as CanonicalRule;
    const filteredRule = { fileName: "filtered.md", id: "filtered" } as CanonicalRule;
    _staticRulesDeps.splitRuleIntoSections = ((rule: CanonicalRule) => {
      if (rule.id === "kept")
        return [sectionOf(keptRule, { slug: "a", content: "## A\nbody", heading: "A", ordinal: 0 })];
      return [sectionOf(filteredRule, { slug: "b", content: "## B\nbody", heading: "B", ordinal: 0 })];
    }) as typeof _staticRulesDeps.splitRuleIntoSections;
    _staticRulesDeps.applySectionBudget = ((s: RuleSection[]) => ({
      retainedSections: s,
      totalTokens: s.reduce((sum, x) => sum + x.tokens, 0),
      usedTokens: s.reduce((sum, x) => sum + x.tokens, 0),
      droppedIds: [],
      overageTokens: 0,
    })) as typeof _staticRulesDeps.applySectionBudget;

    const provider = new StaticRulesProvider();
    const result = await provider.fetch(BASE_REQUEST);
    // Only the "kept" rule passes the stage filter, and it has one section.
    expect(result.scopingReport).toBeDefined();
    expect(result.scopingReport?.sectionCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC10 / AC11: stage filter removes the rule and its sections entirely
// ─────────────────────────────────────────────────────────────────────────────

describe("StaticRulesProvider — US-004 AC10/AC11: stage filter removes rule sections", () => {
  test("AC10: returns no chunk originating from a rule whose stages list excludes request.stage", async () => {
    setupCanonical([
      { fileName: "kept.md", id: "kept", content: "## A\nbody" },
      { fileName: "filtered.md", id: "filtered", content: "## B\nbody", stages: ["other-stage"] },
    ]);
    const keptRule = { fileName: "kept.md", id: "kept" } as CanonicalRule;
    const filteredRule = { fileName: "filtered.md", id: "filtered" } as CanonicalRule;
    _staticRulesDeps.splitRuleIntoSections = ((rule: CanonicalRule) => {
      if (rule.id === "kept")
        return [sectionOf(keptRule, { slug: "a", content: "## A\nbody", heading: "A", ordinal: 0 })];
      return [sectionOf(filteredRule, { slug: "b", content: "## B\nbody", heading: "B", ordinal: 0 })];
    }) as typeof _staticRulesDeps.splitRuleIntoSections;
    _staticRulesDeps.applySectionBudget = ((s: RuleSection[]) => ({
      retainedSections: s,
      totalTokens: s.reduce((sum, x) => sum + x.tokens, 0),
      usedTokens: s.reduce((sum, x) => sum + x.tokens, 0),
      droppedIds: [],
      overageTokens: 0,
    })) as typeof _staticRulesDeps.applySectionBudget;

    const provider = new StaticRulesProvider();
    const result = await provider.fetch({ ...BASE_REQUEST, stage: "execution" });
    const ids = result.chunks.map((c) => c.id);
    expect(ids.some((id) => id.includes("filtered"))).toBe(false);
  });

  test("AC11: when request.stage excludes a rule, applySectionBudget receives no section from that rule", async () => {
    setupCanonical([
      { fileName: "kept.md", id: "kept", content: "## A\nbody" },
      { fileName: "filtered.md", id: "filtered", content: "## B\nbody", stages: ["other-stage"] },
    ]);
    const keptRule = { fileName: "kept.md", id: "kept" } as CanonicalRule;
    const filteredRule = { fileName: "filtered.md", id: "filtered" } as CanonicalRule;
    _staticRulesDeps.splitRuleIntoSections = ((rule: CanonicalRule) => {
      if (rule.id === "kept")
        return [sectionOf(keptRule, { slug: "a", content: "## A\nbody", heading: "A", ordinal: 0 })];
      return [sectionOf(filteredRule, { slug: "b", content: "## B\nbody", heading: "B", ordinal: 0 })];
    }) as typeof _staticRulesDeps.splitRuleIntoSections;
    let receivedOwners: string[] = [];
    _staticRulesDeps.applySectionBudget = ((s: RuleSection[]) => {
      receivedOwners = s.map((x) => x.ruleId ?? "");
      return {
        retainedSections: s,
        totalTokens: s.reduce((sum, x) => sum + x.tokens, 0),
        usedTokens: s.reduce((sum, x) => sum + x.tokens, 0),
        droppedIds: [],
        overageTokens: 0,
      };
    }) as typeof _staticRulesDeps.applySectionBudget;

    const provider = new StaticRulesProvider();
    await provider.fetch({ ...BASE_REQUEST, stage: "execution" });
    expect(receivedOwners).toContain("kept");
    expect(receivedOwners).not.toContain("filtered");
  });
});
