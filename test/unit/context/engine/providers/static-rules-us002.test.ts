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

import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { _clearRootConfigCache, loadConfig } from "@/config/loader";
import { _staticRulesDeps, StaticRulesProvider } from "@/context/engine";
import type { ContextRequest } from "@/context/engine/types";
import { type CanonicalRule, loadCanonicalRules } from "@/context/rules/canonical-loader";
import type { RuleSection } from "@/context/rules/rule-sections";
import type { Logger } from "@/logger";
import { extractTestDirs, globsToPathspec, globsToTestRegex } from "@/test-runners/conventions";
import type { ResolvedTestPatterns } from "@/test-runners/resolver";
import { resolveTestFilePatterns } from "@/test-runners/resolver";

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

// ─────────────────────────────────────────────────────────────────────────────
// appliesTo scoping for authoring stages (nax#2060) — absorbed from
// static-rules-authoring-scope.test.ts
//
// Regression coverage for: rules scoped to prospective test paths are
// filtered out of `tdd-test-writer` — the one stage whose job is to author
// those files — because `appliesTo:` was matched only against
// `request.scopeFiles` (the resolved evidence set of files the story
// already touches, which at test-writing time contains only source files).
//
// The decisive block below runs against the REAL config loader and the
// REAL `resolveTestFilePatterns()` resolver — no stubbed `ResolvedTestPatterns`.
// ─────────────────────────────────────────────────────────────────────────────

/** Mirrors resolveTestFilePatterns() output via buildResolved() (ADR-009). */
function makePatterns(globs: readonly string[]): ResolvedTestPatterns {
  return {
    globs,
    pathspec: globsToPathspec(globs),
    regex: globsToTestRegex(globs),
    testDirs: extractTestDirs(globs),
    resolution: "root-config",
  };
}

const TEST_PATTERNS = makePatterns(["test/unit/**/*.test.ts"]);

const AUTHORING_BASE_REQUEST: ContextRequest = {
  storyId: "US-002",
  repoRoot: "/project",
  packageDir: "/project",
  stage: "tdd-test-writer",
  role: "tdd",
  budgetTokens: 8000,
};

function setupAuthoringCanonical(rules: CanonicalRule[]) {
  const orig = _staticRulesDeps.loadCanonicalRules;
  _staticRulesDeps.loadCanonicalRules = async () => rules;
  return () => {
    _staticRulesDeps.loadCanonicalRules = orig;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Decisive check — REAL loadConfig + REAL resolveTestFilePatterns
// ─────────────────────────────────────────────────────────────────────────────

describe("StaticRulesProvider — real resolver output (nax#2060 decisive check)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
    _clearRootConfigCache();
  });

  /** A root config mirroring nax's own — extension-only testFilePatterns, no directory prefix. */
  async function makeExtensionOnlyConfigRoot(): Promise<string> {
    const root = makeTempDir("nax-2060-real-resolver-");
    tempDirs.push(root);
    await mkdir(join(root, ".nax"), { recursive: true });
    const config = { execution: { smartTestRunner: { testFilePatterns: ["**/*.test.ts", "**/*.spec.ts"] } } };
    await Bun.write(join(root, ".nax", "config.json"), JSON.stringify(config, null, 2));
    return root;
  }

  test("admits both an extension-shaped and a directory-shaped test rule; still filters an unrelated rule", async () => {
    const root = await makeExtensionOnlyConfigRoot();
    const config = await loadConfig(root);
    const resolvedTestPatterns = await resolveTestFilePatterns(config, root, undefined);

    // Confirms the real defect precondition: no directory prefix in the resolved globs.
    expect(resolvedTestPatterns.testDirs).toEqual([]);
    expect(resolvedTestPatterns.resolution).toBe("root-config");

    const restore = setupAuthoringCanonical([
      {
        id: "test-writing",
        fileName: "test-writing.md",
        content: "Extension-shaped test rule.",
        stages: ["tdd-test-writer"],
        appliesTo: ["**/*.test.ts"],
      },
      {
        id: "test-ratchets",
        fileName: "test-ratchets.md",
        content: "Directory-shaped test rule.",
        stages: ["tdd-test-writer"],
        appliesTo: ["test/**/*.ts"],
      },
      {
        id: "unrelated-docs",
        fileName: "unrelated-docs.md",
        content: "Unrelated docs rule.",
        stages: ["tdd-test-writer"],
        appliesTo: ["docs/**/*.md"],
      },
    ]);
    try {
      const provider = new StaticRulesProvider();
      const result = await provider.fetch({
        ...AUTHORING_BASE_REQUEST,
        repoRoot: root,
        packageDir: root,
        scopeFiles: ["src/agents/acp/adapter.ts", "src/session/session-keeper.ts"],
        resolvedTestPatterns,
      });

      expect(result.scopingReport?.appliesToFilteredIds).not.toContain("test-writing");
      expect(result.scopingReport?.appliesToFilteredIds).not.toContain("test-ratchets");
      expect(result.scopingReport?.appliesToFilteredIds).toContain("unrelated-docs");
      // scopeFileCount stays the real evidence-set size — no fabricated candidate paths added.
      expect(result.scopingReport?.scopeFileCount).toBe(2);

      const contents = result.chunks.map((c) => c.content).join("\n");
      expect(contents).toContain("Extension-shaped test rule.");
      expect(contents).toContain("Directory-shaped test rule.");
      expect(contents).not.toContain("Unrelated docs rule.");
    } finally {
      restore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Guard-condition coverage (stubbed resolvedTestPatterns — mechanism edges,
// not the appliesTo-matching defect itself, which the block above covers)
// ─────────────────────────────────────────────────────────────────────────────

describe("StaticRulesProvider — authoring-stage appliesTo scoping guard conditions (nax#2060)", () => {
  test("does not extend matching for non-authoring stages (e.g. tdd-implementer)", async () => {
    const restore = setupAuthoringCanonical([
      {
        fileName: "test-writing.md",
        content: "Test-authoring rule.",
        stages: ["tdd-implementer"],
        appliesTo: ["test/**/*.test.ts"],
      },
    ]);
    try {
      const provider = new StaticRulesProvider();
      const result = await provider.fetch({
        ...AUTHORING_BASE_REQUEST,
        stage: "tdd-implementer",
        scopeFiles: ["src/cost-row-rate-provenance.ts"],
        resolvedTestPatterns: TEST_PATTERNS,
      });

      expect(result.chunks).toHaveLength(0);
      expect(result.scopingReport?.appliesToFilteredIds).toContain("test-writing");
    } finally {
      restore();
    }
  });

  test("does not extend matching when resolvedTestPatterns is absent (fail-open)", async () => {
    const restore = setupAuthoringCanonical([
      {
        fileName: "test-writing.md",
        content: "Test-authoring rule.",
        stages: ["tdd-test-writer"],
        appliesTo: ["test/**/*.test.ts"],
      },
    ]);
    try {
      const provider = new StaticRulesProvider();
      const result = await provider.fetch({
        ...AUTHORING_BASE_REQUEST,
        scopeFiles: ["src/cost-row-rate-provenance.ts"],
      });

      expect(result.chunks).toHaveLength(0);
      expect(result.scopingReport?.appliesToFilteredIds).toContain("test-writing");
    } finally {
      restore();
    }
  });

  describe("stage-contradiction warning", () => {
    let warnSpy: Mock<Logger["warn"]> | undefined;

    beforeEach(async () => {
      const { resetLogger, initLogger } = await import("@/logger");
      resetLogger();
      const logger = initLogger({ level: "silent" });
      warnSpy = spyOn(logger, "warn");
    });

    afterEach(async () => {
      warnSpy?.mockRestore();
      warnSpy = undefined;
      const { resetLogger } = await import("@/logger");
      resetLogger();
    });

    test("logs a warning when appliesTo drops every rule that explicitly named this stage", async () => {
      const restore = setupAuthoringCanonical([
        {
          id: "unrelated",
          fileName: "unrelated.md",
          content: "Unrelated docs rule.",
          stages: ["tdd-test-writer"],
          appliesTo: ["docs/**/*.md"],
        },
      ]);
      try {
        const provider = new StaticRulesProvider();
        await provider.fetch({
          ...AUTHORING_BASE_REQUEST,
          scopeFiles: ["src/cost-row-rate-provenance.ts"],
          resolvedTestPatterns: TEST_PATTERNS,
        });

        const call = warnSpy?.mock.calls.find(
          (c) =>
            c[0] === "static-rules" && c[1] === "appliesTo filter dropped every rule that named this stage explicitly",
        );
        expect(call).toBeDefined();
        expect(call?.[2]).toMatchObject({
          storyId: "US-002",
          stage: "tdd-test-writer",
          contradictedRuleIds: ["unrelated"],
        });
      } finally {
        restore();
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-006 stage scoping against the real .nax/rules store — absorbed from
// static-rules-us006.test.ts
//
// US-006: stage scoping drives chunk emission from the real .nax/rules
// store. The test-authoring rules declare `stages:` lists excluding
// plan/acceptance/route so they never appear in plan or acceptance or
// route contexts. These tests run against the real `.nax/rules/` directory
// by importing the real `loadCanonicalRules` and re-wiring `_staticRulesDeps`
// to invoke it for each test.
// ─────────────────────────────────────────────────────────────────────────────

describe("StaticRulesProvider — US-006 real .nax/rules store stage scoping", () => {
  const REAL_REPO_REQUEST: ContextRequest = {
    storyId: "US-006",
    repoRoot: process.cwd(),
    packageDir: process.cwd(),
    stage: "execution",
    role: "implementer",
    budgetTokens: 8000,
  };

  let origLoadCanonicalRules: typeof _staticRulesDeps.loadCanonicalRules;

  beforeEach(() => {
    origLoadCanonicalRules = _staticRulesDeps.loadCanonicalRules;
    _staticRulesDeps.loadCanonicalRules = async (workdir: string) => loadCanonicalRules(workdir);
  });

  afterEach(() => {
    _staticRulesDeps.loadCanonicalRules = origLoadCanonicalRules;
  });

  test("[US-006 AC 3] emits no static-rules:test-writing: chunk when request.stage is plan", async () => {
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    const result = await provider.fetch({ ...REAL_REPO_REQUEST, stage: "plan" });
    expect(result.chunks.some((c) => c.id.startsWith("static-rules:test-writing:"))).toBe(false);
  });

  test("[US-006 AC 3] emits no static-rules:test-architecture: chunk when request.stage is plan", async () => {
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    const result = await provider.fetch({ ...REAL_REPO_REQUEST, stage: "plan" });
    expect(result.chunks.some((c) => c.id.startsWith("static-rules:test-architecture:"))).toBe(false);
  });

  test("[US-006 AC 3] emits no static-rules:test-helpers: chunk when request.stage is plan", async () => {
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    const result = await provider.fetch({ ...REAL_REPO_REQUEST, stage: "plan" });
    expect(result.chunks.some((c) => c.id.startsWith("static-rules:test-helpers:"))).toBe(false);
  });

  test("[US-006 AC 3] emits no static-rules:testing-commands: chunk when request.stage is plan", async () => {
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    const result = await provider.fetch({ ...REAL_REPO_REQUEST, stage: "plan" });
    expect(result.chunks.some((c) => c.id.startsWith("static-rules:testing-commands:"))).toBe(false);
  });

  // Split into -source/-tests by SPEC-bounded-rules-floor US-005; the stage
  // scoping introduced by #1612 applies to both halves.
  const STAGE_SCOPED_EVERYWHERE_BUT_PLAN = [
    "forbidden-patterns-source",
    "forbidden-patterns-tests",
    "project-conventions",
  ] as const;

  for (const rule of STAGE_SCOPED_EVERYWHERE_BUT_PLAN) {
    test(`[US-006 AC 4] emits no static-rules:${rule}: chunk when request.stage is plan`, async () => {
      const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
      const result = await provider.fetch({ ...REAL_REPO_REQUEST, stage: "plan" });
      expect(result.chunks.some((c) => c.id.startsWith(`static-rules:${rule}:`))).toBe(false);
    });

    // Guards the exclusion above against passing vacuously: a rule scoped to
    // no stage at all, or one that stopped loading entirely, would satisfy the
    // plan-stage assertion while silently reaching no agent anywhere.
    test(`[US-006 AC 4] emits a static-rules:${rule}: chunk when request.stage is execution`, async () => {
      const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
      const result = await provider.fetch({ ...REAL_REPO_REQUEST, stage: "execution" });
      expect(result.chunks.some((c) => c.id.startsWith(`static-rules:${rule}:`))).toBe(true);
    });
  }

  test("[US-006 AC 5] emits a static-rules:test-writing: chunk when request.stage is tdd-test-writer", async () => {
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    const result = await provider.fetch({ ...REAL_REPO_REQUEST, stage: "tdd-test-writer" });
    expect(result.chunks.some((c) => c.id.startsWith("static-rules:test-writing:"))).toBe(true);
  });

  test("[US-006 AC 5] emits a static-rules:test-architecture: chunk when request.stage is tdd-test-writer", async () => {
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    const result = await provider.fetch({ ...REAL_REPO_REQUEST, stage: "tdd-test-writer" });
    expect(result.chunks.some((c) => c.id.startsWith("static-rules:test-architecture:"))).toBe(true);
  });

  test("[US-006 AC 5] emits a static-rules:test-helpers: chunk when request.stage is tdd-test-writer", async () => {
    const provider = new StaticRulesProvider({ budgetTokens: 1_000_000 });
    const result = await provider.fetch({ ...REAL_REPO_REQUEST, stage: "tdd-test-writer" });
    expect(result.chunks.some((c) => c.id.startsWith("static-rules:test-helpers:"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// appliesTo matching at the repo path frame (nax#2071) — absorbed from
// static-rules-path-frame.test.ts
//
// `request.scopeFiles` is repo-rooted per the path-frame convention, so a
// monorepo story's declared paths reach `ruleMatchesScopeFiles` already framed.
// These pin the MATCHER's behaviour at that frame.
// ─────────────────────────────────────────────────────────────────────────────

const FRAME_BASE_REQUEST: ContextRequest = {
  storyId: "US-001",
  repoRoot: "/project",
  packageDir: "/project",
  stage: "execution",
  role: "implementer",
  budgetTokens: 8000,
};

function setupFrameCanonical(rules: CanonicalRule[]) {
  _staticRulesDeps.loadCanonicalRules = async () => rules;
}

/** A monorepo story's scope file, as the post-nax#2071 resolver spells it. */
const FRAMED_SCOPE_FILE = "packages/app/src/agents/adapter.ts";

describe("StaticRulesProvider — appliesTo at the repo frame (nax#2071)", () => {
  test("a root-anchored rule matches a repo-framed scope file", async () => {
    // The delta the fix buys: before framing, the declared path was
    // "src/agents/adapter.ts" and this rule could not match it.
    setupFrameCanonical([{ fileName: "app.md", content: "App package rules", appliesTo: ["packages/app/src/**"] }]);
    const provider = new StaticRulesProvider();

    const result = await provider.fetch({ ...FRAME_BASE_REQUEST, scopeFiles: [FRAMED_SCOPE_FILE] });

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.content).toContain("App package rules");
  });

  test("a sibling package's rule is not admitted for a repo-framed scope file", async () => {
    // Framing must not over-admit: over-admission is how rule budgets blow up.
    setupFrameCanonical([
      { fileName: "lib.md", content: "Lib package rules", appliesTo: ["packages/lib/**"] },
      { fileName: "global.md", content: "Global rules" },
    ]);
    const provider = new StaticRulesProvider();

    const result = await provider.fetch({ ...FRAME_BASE_REQUEST, scopeFiles: [FRAMED_SCOPE_FILE] });

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.content).toContain("Global rules");
  });

  test("a package-relative rule still matches a repo-framed scope file", async () => {
    // Monotonicity: the (?:^|/) anchor means framing cannot drop a rule that
    // was admitted before. Guards anyone tightening that anchor to ^.
    setupFrameCanonical([
      { fileName: "agents.md", content: "Agent-specific coding rules", appliesTo: ["src/agents/**"] },
    ]);
    const provider = new StaticRulesProvider();

    const result = await provider.fetch({ ...FRAME_BASE_REQUEST, scopeFiles: [FRAMED_SCOPE_FILE] });

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.content).toContain("Agent-specific coding rules");
  });
});
