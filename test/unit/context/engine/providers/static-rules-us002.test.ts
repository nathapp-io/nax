/**
 * StaticRulesProvider — US-002 scopePaths tests
 *
 * Covers AC2 (StaticRulesProvider.fetch returns scopePaths [src-agents-glob]
 * for matching appliesTo frontmatter), AC3 (omits scopePaths for a rule
 * without appliesTo), and AC4 (two sections of one rule both get the rule's
 * appliesTo globs).
 *
 * These tests inject `_staticRulesDeps.splitRuleIntoSections` and
 * `_staticRulesDeps.applySectionBudget` so the test owns the sectionisation
 * shape, mirroring the US-004 section-chunking pattern. The real
 * `_staticRulesDeps.splitRuleIntoSections` (rule-sections.ts) inherits appliesTo
 * per section already, so the carrier exists — this story only threads it
 * through to the emitted RawChunk.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { StaticRulesProvider, _staticRulesDeps } from "@/context/engine";
import type { ContextRequest } from "@/context/engine/types";
import type { CanonicalRule } from "@/context/rules/canonical-loader";
import type { RuleSection } from "@/context/rules/rule-sections";

// ─────────────────────────────────────────────────────────────────────────────
// Dep save/restore
// ─────────────────────────────────────────────────────────────────────────────

let origDeps: {
  readFile: typeof _staticRulesDeps.readFile;
  fileExists: typeof _staticRulesDeps.fileExists;
  globInDir: typeof _staticRulesDeps.globInDir;
  loadCanonicalRules: typeof _staticRulesDeps.loadCanonicalRules;
  splitRuleIntoSections: typeof _staticRulesDeps.splitRuleIntoSections;
  applySectionBudget: typeof _staticRulesDeps.applySectionBudget;
};

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
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const BASE_REQUEST: ContextRequest = {
  storyId: "US-002",
  repoRoot: "/project",
  packageDir: "/project",
  stage: "execution",
  role: "implementer",
  budgetTokens: 8_000,
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

function setupSingleSectionPerRule(sections: RuleSection[]) {
  _staticRulesDeps.splitRuleIntoSections = ((rule: CanonicalRule) => {
    return sections.filter((s) => s.ruleId === (rule.id ?? rule.fileName.replace(/\.md$/i, "")));
  }) as typeof _staticRulesDeps.splitRuleIntoSections;
  _staticRulesDeps.applySectionBudget = ((s: RuleSection[]) => ({
    retainedSections: s,
    totalTokens: s.reduce((sum, x) => sum + x.tokens, 0),
    usedTokens: s.reduce((sum, x) => sum + x.tokens, 0),
    droppedIds: [],
    overageTokens: 0,
  })) as typeof _staticRulesDeps.applySectionBudget;
}

// ─────────────────────────────────────────────────────────────────────────────
// AC2: StaticRulesProvider.fetch returns scopePaths for matching appliesTo
// ─────────────────────────────────────────────────────────────────────────────

describe("StaticRulesProvider — US-002 AC2: scopePaths from appliesTo frontmatter", () => {
  test("AC2: a chunk from a rule with appliesTo [src-agents-glob] carries scopePaths [src-agents-glob]", async () => {
    const SCOPED_GLOB = "src/agents/**/*.ts";
    const rule: CanonicalRule = {
      fileName: "agents.md",
      id: "agents",
      content: "## Agent Coding\n\nbody",
      appliesTo: [SCOPED_GLOB],
    };
    setupCanonical([rule]);
    setupSingleSectionPerRule([
      sectionOf(rule, {
        slug: "agent-coding",
        content: "## Agent Coding\n\nbody",
        heading: "Agent Coding",
        ordinal: 0,
      }),
    ]);

    const provider = new StaticRulesProvider();
    const result = await provider.fetch(BASE_REQUEST);

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.scopePaths).toEqual([SCOPED_GLOB]);
  });

  test("AC2 (multi-glob): a chunk from a rule with multi-glob appliesTo carries every glob verbatim, in order", async () => {
    const GLOBS = ["src/agents/acp/**", "src/operations/**"];
    const rule: CanonicalRule = {
      fileName: "adapter-wiring.md",
      id: "adapter-wiring",
      content: "## Adapter Wiring\n\nbody",
      appliesTo: GLOBS,
    };
    setupCanonical([rule]);
    setupSingleSectionPerRule([
      sectionOf(rule, {
        slug: "adapter-wiring",
        content: "## Adapter Wiring\n\nbody",
        heading: "Adapter Wiring",
        ordinal: 0,
      }),
    ]);

    const provider = new StaticRulesProvider();
    const result = await provider.fetch(BASE_REQUEST);

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.scopePaths).toEqual(GLOBS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3: scopePaths is omitted when the rule has no appliesTo
// ─────────────────────────────────────────────────────────────────────────────

describe("StaticRulesProvider — US-002 AC3: scopePaths omitted without appliesTo", () => {
  test("AC3: a chunk from a rule with NO appliesTo key has scopePaths === undefined", async () => {
    const rule: CanonicalRule = {
      fileName: "global.md",
      id: "global",
      content: "## Global\n\nbody",
      // No appliesTo field
    };
    setupCanonical([rule]);
    setupSingleSectionPerRule([
      sectionOf(rule, { slug: "global", content: "## Global\n\nbody", heading: "Global", ordinal: 0 }),
    ]);

    const provider = new StaticRulesProvider();
    const result = await provider.fetch(BASE_REQUEST);

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.scopePaths).toBeUndefined();
  });

  test("AC3 (explicit empty array): a rule with appliesTo: [] also omits scopePaths", async () => {
    // An empty appliesTo list is the same as "no scoping declared" per
    // ruleMatchesScopeFiles, so the chunk must NOT carry a scopePaths
    // entry pointing at an empty array.
    const rule: CanonicalRule = {
      fileName: "global.md",
      id: "global",
      content: "## Global\n\nbody",
      appliesTo: [],
    };
    setupCanonical([rule]);
    setupSingleSectionPerRule([
      sectionOf(rule, { slug: "global", content: "## Global\n\nbody", heading: "Global", ordinal: 0 }),
    ]);

    const provider = new StaticRulesProvider();
    const result = await provider.fetch(BASE_REQUEST);

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.scopePaths).toBeUndefined();
  });

  test("AC3 (mixed): only the scoped rule's chunk carries scopePaths; the un-scoped rule's chunk does not", async () => {
    const SCOPED_GLOB = "src/agents/**/*.ts";
    const scopedRule: CanonicalRule = {
      fileName: "agents.md",
      id: "agents",
      content: "## Agents\n\nbody",
      appliesTo: [SCOPED_GLOB],
    };
    const unscopedRule: CanonicalRule = {
      fileName: "global.md",
      id: "global",
      content: "## Global\n\nbody",
    };
    setupCanonical([scopedRule, unscopedRule]);
    setupSingleSectionPerRule([
      sectionOf(scopedRule, {
        slug: "agents",
        content: "## Agents\n\nbody",
        heading: "Agents",
        ordinal: 0,
      }),
      sectionOf(unscopedRule, {
        slug: "global",
        content: "## Global\n\nbody",
        heading: "Global",
        ordinal: 0,
      }),
    ]);

    const provider = new StaticRulesProvider();
    const result = await provider.fetch(BASE_REQUEST);

    expect(result.chunks).toHaveLength(2);
    const scopedChunk = result.chunks.find((c) => c.id.includes(":agents:"));
    const unscopedChunk = result.chunks.find((c) => c.id.includes(":global:"));
    expect(scopedChunk?.scopePaths).toEqual([SCOPED_GLOB]);
    expect(unscopedChunk?.scopePaths).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4: two sections of one rule both get the rule's appliesTo globs
// ─────────────────────────────────────────────────────────────────────────────

describe("StaticRulesProvider — US-002 AC4: section-level scopePaths inheritance", () => {
  test("AC4: two sections of one rule with appliesTo [scoped] both carry scopePaths [scoped]", async () => {
    const SCOPED_GLOB = "src/agents/**/*.ts";
    const rule: CanonicalRule = {
      fileName: "agents.md",
      id: "agents",
      content: "## Agent Coding\nbody\n## Agent Testing\nbody",
      appliesTo: [SCOPED_GLOB],
    };
    setupCanonical([rule]);
    const sections: RuleSection[] = [
      sectionOf(rule, {
        slug: "agent-coding",
        content: "## Agent Coding\nbody",
        heading: "Agent Coding",
        ordinal: 0,
      }),
      sectionOf(rule, {
        slug: "agent-testing",
        content: "## Agent Testing\nbody",
        heading: "Agent Testing",
        ordinal: 1,
      }),
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
    for (const chunk of result.chunks) {
      expect(chunk.scopePaths).toEqual([SCOPED_GLOB]);
    }
  });

  test("AC4 (multi-glob): two sections of a rule with multi-glob appliesTo both carry every glob", async () => {
    const GLOBS = ["src/agents/acp/**", "src/operations/**", "src/pipeline/**"];
    const rule: CanonicalRule = {
      fileName: "adapter.md",
      id: "adapter",
      content: "## Adapter\nbody\n## Operations\nbody",
      appliesTo: GLOBS,
    };
    setupCanonical([rule]);
    const sections: RuleSection[] = [
      sectionOf(rule, {
        slug: "adapter",
        content: "## Adapter\nbody",
        heading: "Adapter",
        ordinal: 0,
      }),
      sectionOf(rule, {
        slug: "operations",
        content: "## Operations\nbody",
        heading: "Operations",
        ordinal: 1,
      }),
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
    for (const chunk of result.chunks) {
      expect(chunk.scopePaths).toEqual(GLOBS);
    }
  });
});
