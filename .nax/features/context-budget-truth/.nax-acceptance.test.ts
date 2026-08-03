import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { estimateAvailableBudgetTokens } from "../../../src/context/engine/available-budget";
import { digestTokens, DIGEST_RESERVE_TOKENS } from "../../../src/context/engine/digest";
import { _manifestStoreDeps } from "../../../src/context/engine/manifest-store";
import { ContextOrchestrator } from "../../../src/context/engine/orchestrator";
import { FLOOR_KINDS, packChunks } from "../../../src/context/engine/packing";
import type { PackedChunk } from "../../../src/context/engine/packing";
import { StaticRulesProvider, _staticRulesDeps } from "../../../src/context/engine/providers/static-rules";
import type {
  ContextManifest,
  ContextProviderResult,
  ContextRequest,
  IContextProvider,
  RawChunk,
} from "../../../src/context/engine/types";
import type { ScoredChunk } from "../../../src/context/engine/scoring";
import {
  RulesFrontmatterError,
  _canonicalLoaderDeps,
  applyCanonicalRulesBudget,
  loadCanonicalRules,
} from "../../../src/context/rules/canonical-loader";
import type { CanonicalRule } from "../../../src/context/rules/canonical-loader";
import { rulesLintCommand, translateLegacyFrontmatter, withReviewNotice } from "../../../src/cli/rules";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { addSink, initLogger, resetLogger } from "../../../src/logger";
import { collectStoryMetrics } from "../../../src/metrics/tracker";
import type { PipelineContext } from "../../../src/pipeline/types";
import type { PRD } from "../../../src/prd";
import { cleanupTempDir, makeStory, makeTempDir } from "../../../test/helpers";
import { makeMockRuntime } from "../../../test/helpers/runtime";

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(import.meta.dir, "../../../");

const BASE_REQUEST: ContextRequest = {
  storyId: "US-budget-truth",
  repoRoot: "/project",
  packageDir: "/project",
  stage: "execution",
  role: "implementer",
  budgetTokens: 10_000,
};

function makeProvider(id: string, kind: RawChunk["kind"], result: Partial<ContextProviderResult> = {}): IContextProvider {
  return {
    id,
    kind,
    fetch: async () => ({ chunks: [], pullTools: [], ...result }),
  };
}

function makeScoredChunk(overrides: Partial<ScoredChunk> & { id: string; kind: RawChunk["kind"]; tokens: number }): ScoredChunk {
  return {
    scope: "project",
    role: ["implementer"],
    content: "placeholder content",
    rawScore: 1.0,
    score: 1.0,
    roleFiltered: false,
    belowMinScore: false,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// US-001 AC-1/AC-2: estimateAvailableBudgetTokens returns a truthful number
// ─────────────────────────────────────────────────────────────────────────────

describe("US-001: estimateAvailableBudgetTokens", () => {
  test("AC-1: returns exactly 0 when the existing prompt leaves non-positive remaining room", () => {
    // "claude" profile: maxContextTokens 200_000. An 800_000-char prompt (200_000
    // estimated tokens) plus the reserved/safety margins drives remaining below 0.
    const exhaustingPrompt = "x".repeat(800_000);
    const result = estimateAvailableBudgetTokens("claude", exhaustingPrompt);
    expect(result).toBe(0);
  });

  test("AC-2: returns a positive value smaller than maxContextTokens for a short prompt", () => {
    const result = estimateAvailableBudgetTokens("claude", "Short existing prompt.");
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(200_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-001 AC-3/AC-4: packChunks ceiling semantics
// ─────────────────────────────────────────────────────────────────────────────

describe("US-001: packChunks availableBudgetTokens ceiling", () => {
  test("AC-3: availableBudgetTokens 0 packs every floor chunk and no non-floor chunk", () => {
    const chunks: ScoredChunk[] = [
      makeScoredChunk({ id: "floor:1", kind: "static", tokens: 400 }),
      makeScoredChunk({ id: "floor:2", kind: "feature", tokens: 400 }),
      makeScoredChunk({ id: "nonfloor:1", kind: "session", tokens: 200 }),
      makeScoredChunk({ id: "nonfloor:2", kind: "history", tokens: 200 }),
    ];
    const result = packChunks(chunks, 5_000, 0);
    const packedIds = result.packed.map((c) => c.id).sort();
    expect(packedIds).toEqual(["floor:1", "floor:2"]);
    expect(result.packed.every((c) => FLOOR_KINDS.includes(c.kind))).toBe(true);
  });

  test("AC-4: an omitted availableBudgetTokens packs identically to a call before the ceiling existed", () => {
    const chunks: ScoredChunk[] = [
      makeScoredChunk({ id: "floor:1", kind: "static", tokens: 300 }),
      makeScoredChunk({ id: "nonfloor:1", kind: "session", tokens: 400 }),
      makeScoredChunk({ id: "nonfloor:2", kind: "session", tokens: 400 }),
    ];
    const withThirdArgOmitted = packChunks(chunks, 900);
    const withExplicitUndefined = packChunks(chunks, 900, undefined);

    expect(withThirdArgOmitted.packed.map((c) => c.id).sort()).toEqual(
      withExplicitUndefined.packed.map((c) => c.id).sort(),
    );
    expect(withThirdArgOmitted.usedTokens).toBe(withExplicitUndefined.usedTokens);
    expect(withThirdArgOmitted.effectiveBudget).toBe(900);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-001 AC-5/AC-6/AC-7: ContextOrchestrator.assemble budget + digest accounting
// ─────────────────────────────────────────────────────────────────────────────

describe("US-001: ContextOrchestrator.assemble budget/digest accounting", () => {
  test("AC-5: packed non-floor chunks never exceed stageBudget minus DIGEST_RESERVE_TOKENS", async () => {
    const provider = makeProvider("p1", "session", {
      chunks: Array.from({ length: 6 }, (_, i) => ({
        id: `nonfloor:${i}`,
        kind: "session" as const,
        scope: "session" as const,
        role: ["implementer"] as ["implementer"],
        content: `Non-floor chunk content number ${i}.`,
        tokens: 600,
        rawScore: 1.0,
      })),
    });
    const orch = new ContextOrchestrator([provider]);
    const bundle = await orch.assemble({
      ...BASE_REQUEST,
      budgetTokens: 3_000,
      providerIds: ["p1"],
    });

    const nonFloorTotal = bundle.chunks
      .filter((c) => !FLOOR_KINDS.includes(c.kind))
      .reduce((sum, c) => sum + c.tokens, 0);

    expect(nonFloorTotal).toBeLessThanOrEqual(3_000 - DIGEST_RESERVE_TOKENS);
  });

  test("AC-6: manifest.usedTokens equals packed chunk tokens plus the prior-stage digest token count", async () => {
    const provider = makeProvider("p1", "session", {
      chunks: [
        {
          id: "nonfloor:1",
          kind: "session",
          scope: "session",
          role: ["implementer"],
          content: "Single non-floor chunk content.",
          tokens: 200,
          rawScore: 1.0,
        },
      ],
    });
    // Deliberately much longer than the digest this stage's own packed chunk
    // would produce, so the assertion cannot pass by token-count coincidence
    // between the produced digest and the prior-stage digest.
    const priorStageDigest =
      "Prior stage found something important here that is described in much greater detail than the single short chunk this stage packs, so its estimated token count is clearly distinguishable from whatever digest this stage itself produces from the packed chunk content below.";
    const orch = new ContextOrchestrator([provider]);
    const bundle = await orch.assemble({
      ...BASE_REQUEST,
      budgetTokens: 10_000,
      providerIds: ["p1"],
      priorStageDigest,
    });

    const packedTokenSum = bundle.chunks.reduce((sum, c) => sum + c.tokens, 0);
    expect(bundle.manifest.usedTokens).toBe(packedTokenSum + digestTokens(priorStageDigest));
  });

  test("AC-7: rendered markdown token estimate does not exceed request.budgetTokens when no floor chunk overflows", async () => {
    const floorProvider = makeProvider("floor-p", "static", {
      chunks: [
        {
          id: "floor:1",
          kind: "static",
          scope: "project",
          role: ["all"],
          content: "Short floor content for AC-7.",
          tokens: 100,
          rawScore: 1.0,
        },
      ],
    });
    const nonFloorProvider = makeProvider("nonfloor-p", "session", {
      chunks: [
        {
          id: "nonfloor:1",
          kind: "session",
          scope: "session",
          role: ["implementer"],
          content: "Short non-floor content for AC-7.",
          tokens: 100,
          rawScore: 1.0,
        },
      ],
    });
    const orch = new ContextOrchestrator([floorProvider, nonFloorProvider]);
    const bundle = await orch.assemble({
      ...BASE_REQUEST,
      budgetTokens: 5_000,
      providerIds: ["floor-p", "nonfloor-p"],
    });

    expect(bundle.manifest.floorOverageItems ?? []).toHaveLength(0);
    const estimatedTokenCount = Math.ceil(bundle.pushMarkdown.length / 4);
    expect(estimatedTokenCount).toBeLessThanOrEqual(5_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-002 AC-8..AC-11: applyCanonicalRulesBudget tail-biased truncation
// ─────────────────────────────────────────────────────────────────────────────

function rule(fileName: string, tokens: number): CanonicalRule {
  return { fileName, content: `content for ${fileName}`, tokens };
}

describe("US-002: applyCanonicalRulesBudget", () => {
  test("AC-8: drops every rule (not just the first) when the first priority-ordered rule alone exceeds budget", () => {
    const rules = [rule("r1.md", 100), rule("r2.md", 10)];
    const result = applyCanonicalRulesBudget(rules, 50);
    expect(result.rules).toHaveLength(0);
  });

  test("AC-9: keeps the longest leading run that fits and reports droppedCount for the rest", () => {
    // R1(30)+R2(30)=60 fits within 70; R3(40) would push to 100 and is dropped;
    // R4(1) would trivially fit alone but must NOT be reached once R3 breaks the run.
    const rules = [rule("r1.md", 30), rule("r2.md", 30), rule("r3.md", 40), rule("r4.md", 1)];
    const result = applyCanonicalRulesBudget(rules, 70);
    expect(result.rules.map((r) => r.fileName)).toEqual(["r1.md", "r2.md"]);
    expect(result.droppedCount).toBe(2);
  });

  test("AC-10: keeps every rule with droppedCount 0 and usedTokens equal to totalTokens when the budget fits all", () => {
    const rules = [rule("r1.md", 30), rule("r2.md", 30), rule("r3.md", 30)];
    const result = applyCanonicalRulesBudget(rules, 100);
    expect(result.rules).toHaveLength(3);
    expect(result.droppedCount).toBe(0);
    expect(result.usedTokens).toBe(result.totalTokens);
  });

  test("AC-11: budgetTokens 0 returns no rules, usedTokens 0, and totalTokens as the summed estimate", () => {
    const rules = [rule("r1.md", 30), rule("r2.md", 20)];
    const result = applyCanonicalRulesBudget(rules, 0);
    expect(result.rules).toEqual([]);
    expect(result.usedTokens).toBe(0);
    expect(result.totalTokens).toBe(50);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-002 AC-12: StaticRulesProvider emits only the surviving leading run
// ─────────────────────────────────────────────────────────────────────────────

describe("US-002: StaticRulesProvider truncation propagation", () => {
  let origLoadCanonicalRules: typeof _staticRulesDeps.loadCanonicalRules;

  beforeEach(() => {
    origLoadCanonicalRules = _staticRulesDeps.loadCanonicalRules;
  });

  afterEach(() => {
    _staticRulesDeps.loadCanonicalRules = origLoadCanonicalRules;
  });

  test("AC-12: emits chunks only for the surviving leading run, none for the dropped tail", async () => {
    // priority ascending = more important first. rule-a(100)+rule-b(100)=200 fits
    // within a 250 budget; rule-c(1000) breaks the run and must be entirely absent.
    _staticRulesDeps.loadCanonicalRules = async () => [
      { fileName: "rule-a.md", content: "a".repeat(400), priority: 10, tokens: 100 },
      { fileName: "rule-b.md", content: "b".repeat(400), priority: 20, tokens: 100 },
      { fileName: "rule-c.md", content: "c".repeat(4000), priority: 30, tokens: 1000 },
    ];
    const provider = new StaticRulesProvider({ budgetTokens: 250 });
    const result = await provider.fetch({ ...BASE_REQUEST });

    const ids = result.chunks.map((c) => c.id);
    expect(ids.some((id) => id.startsWith("static-rules:rule-a:"))).toBe(true);
    expect(ids.some((id) => id.startsWith("static-rules:rule-b:"))).toBe(true);
    expect(ids.some((id) => id.startsWith("static-rules:rule-c:"))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-003 AC-13: packChunks floorOverageIds contract
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003: packChunks floorOverageIds", () => {
  test("AC-13: floorOverageIds names exactly the overflowing floor chunks, all floor chunks still pack", () => {
    const chunks: ScoredChunk[] = [
      makeScoredChunk({ id: "floor:1", kind: "static", tokens: 600 }),
      makeScoredChunk({ id: "floor:2", kind: "feature", tokens: 600 }),
    ];
    const result: { packed: PackedChunk[]; floorOverageIds: string[] } = packChunks(chunks, 800);

    // floor:1 fits alone (0 + 600 <= 800); floor:2 pushes cumulative usage to
    // 1200 > 800, so only floor:2 is the overflowing chunk.
    expect(result.floorOverageIds).toEqual(["floor:2"]);
    expect(result.packed.map((c) => c.id).sort()).toEqual(["floor:1", "floor:2"]);
    const packedIds = new Set(result.packed.filter((c) => FLOOR_KINDS.includes(c.kind)).map((c) => c.id));
    for (const id of result.floorOverageIds) {
      expect(packedIds.has(id)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-003 AC-14/AC-15: collectStoryMetrics floor overage
// ─────────────────────────────────────────────────────────────────────────────

const PROJECT_DIR = "/repo";
const FEATURE = "test-feature";
const STORY_ID = "US-001";

function makeCtx(overrides?: Partial<PipelineContext>): PipelineContext {
  const story = makeStory({ id: STORY_ID, status: "passed", passes: true, attempts: 1 });
  return {
    config: DEFAULT_CONFIG,
    prd: {
      project: "test",
      feature: FEATURE,
      branchName: "feat/test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      userStories: [story],
    } satisfies PRD,
    story,
    stories: [story],
    routing: { complexity: "medium", modelTier: "balanced", testStrategy: "test-after", reasoning: "test" },
    workdir: PROJECT_DIR,
    projectDir: PROJECT_DIR,
    hooks: { hooks: {} },
    agentResult: { success: true, output: "", estimatedCostUsd: 0.01, durationMs: 5_000 },
    runtime: makeMockRuntime(),
    ...overrides,
  } as unknown as PipelineContext;
}

function makeFloorOverageManifest(overrides?: Partial<ContextManifest>): ContextManifest {
  return {
    requestId: "req-001",
    stage: "execution",
    totalBudgetTokens: 8_000,
    usedTokens: 500,
    includedChunks: [],
    excludedChunks: [],
    floorItems: [],
    digestTokens: 50,
    buildMs: 120,
    providerResults: [{ providerId: "static-rules", status: "ok", chunkCount: 1, durationMs: 10, tokensProduced: 100 }],
    ...overrides,
  };
}

describe("US-003: collectStoryMetrics floor overage", () => {
  let origListFeatureDirs: typeof _manifestStoreDeps.listFeatureDirs;
  let origListManifestFiles: typeof _manifestStoreDeps.listManifestFiles;
  let origFileExists: typeof _manifestStoreDeps.fileExists;
  let origReadFile: typeof _manifestStoreDeps.readFile;

  function mockManifests(manifests: Record<string, ContextManifest>) {
    _manifestStoreDeps.listFeatureDirs = async () => [FEATURE];
    _manifestStoreDeps.listManifestFiles = async () =>
      Object.keys(manifests)
        .filter((k) => k.startsWith(`${FEATURE}/`))
        .map((k) => `context-manifest-${k.split("/")[1]}.json`);
    _manifestStoreDeps.fileExists = async () => true;
    _manifestStoreDeps.readFile = async (path: string) => {
      const stage = path.replace(/.*context-manifest-/, "").replace(/\.json$/, "");
      const m = manifests[`${FEATURE}/${stage}`];
      return m ? JSON.stringify(m) : "{}";
    };
  }

  beforeEach(() => {
    origListFeatureDirs = _manifestStoreDeps.listFeatureDirs;
    origListManifestFiles = _manifestStoreDeps.listManifestFiles;
    origFileExists = _manifestStoreDeps.fileExists;
    origReadFile = _manifestStoreDeps.readFile;
  });

  afterEach(() => {
    _manifestStoreDeps.listFeatureDirs = origListFeatureDirs;
    _manifestStoreDeps.listManifestFiles = origListManifestFiles;
    _manifestStoreDeps.fileExists = origFileExists;
    _manifestStoreDeps.readFile = origReadFile;
  });

  test("AC-14: records the overage token count and the overflowing chunk ids when floor tokens exceed budget", async () => {
    mockManifests({
      [`${FEATURE}/execution`]: makeFloorOverageManifest({
        totalBudgetTokens: 800,
        floorItems: ["static-rules:a:1", "static-rules:b:2"],
        floorOverageItems: ["static-rules:b:2"],
        chunkTokens: { "static-rules:a:1": 600, "static-rules:b:2": 600 },
        includedChunks: ["static-rules:a:1", "static-rules:b:2"],
      }),
    });
    const ctx = makeCtx();
    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());
    // sum(floor tokens) = 1200, effective budget = 800 -> overage = 400
    expect(metrics.context?.floorOverage?.tokenCount).toBe(400);
    expect(metrics.context?.floorOverage?.chunkIds).toEqual(["static-rules:b:2"]);
  });

  test("AC-15: records 0 overage tokens and no chunk ids when floor tokens fit within budget", async () => {
    mockManifests({
      [`${FEATURE}/execution`]: makeFloorOverageManifest({
        totalBudgetTokens: 8_000,
        floorItems: ["static-rules:a:1"],
        floorOverageItems: [],
        chunkTokens: { "static-rules:a:1": 600 },
        includedChunks: ["static-rules:a:1"],
      }),
    });
    const ctx = makeCtx();
    const metrics = await collectStoryMetrics(ctx, new Date().toISOString());
    expect(metrics.context?.floorOverage?.tokenCount).toBe(0);
    expect(metrics.context?.floorOverage?.chunkIds).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-003 AC-16: ContextOrchestrator.assemble warn log on floor overage
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003: ContextOrchestrator.assemble floor-overage warn log", () => {
  let unsubscribe: (() => void) | null = null;
  let entries: Array<{ level: string; stage: string; message: string; data?: Record<string, unknown> }> = [];

  beforeEach(() => {
    entries = [];
    resetLogger();
    initLogger({ level: "debug", suppressConsole: true });
    unsubscribe = addSink((entry) => {
      entries.push(entry);
    });
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
    resetLogger();
  });

  test("AC-16: emits a warn log whose data begins with storyId and includes stage, effectiveBudget, and excluded non-floor count", async () => {
    const floorProvider = makeProvider("floor-p", "static", {
      chunks: [
        {
          id: "floor:huge",
          kind: "static",
          scope: "project",
          role: ["all"],
          content: "Large floor content that consumes the whole budget on its own.",
          tokens: 2_000,
          rawScore: 1.0,
        },
      ],
    });
    const nonFloorProvider = makeProvider("nonfloor-p", "session", {
      chunks: [
        {
          id: "nonfloor:excluded",
          kind: "session",
          scope: "session",
          role: ["implementer"],
          content: "This non-floor chunk cannot fit once the floor chunk overflows the budget.",
          tokens: 50,
          rawScore: 1.0,
        },
      ],
    });
    const orch = new ContextOrchestrator([floorProvider, nonFloorProvider]);
    await orch.assemble({
      ...BASE_REQUEST,
      storyId: "US-overage-log",
      budgetTokens: 500,
      providerIds: ["floor-p", "nonfloor-p"],
    });

    const overageEntries = entries.filter(
      (e) => e.level === "warn" && e.data?.stage === "context-assembly",
    );
    expect(overageEntries.length).toBeGreaterThan(0);
    const entry = overageEntries[0];
    const data = entry?.data ?? {};
    expect(Object.keys(data)[0]).toBe("storyId");
    expect(data.storyId).toBe("US-overage-log");
    expect(Number.isInteger(data.effectiveBudget)).toBe(true);
    expect((data.effectiveBudget as number)).toBeGreaterThan(0);
    expect(data.excludedNonFloorChunkCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-004 AC-17/AC-18/AC-19/AC-21: canonical rule frontmatter validation
// ─────────────────────────────────────────────────────────────────────────────

describe("US-004: loadCanonicalRules frontmatter validation", () => {
  let origGlobInDir: typeof _canonicalLoaderDeps.globInDir;
  let origReadFile: typeof _canonicalLoaderDeps.readFile;

  beforeEach(() => {
    origGlobInDir = _canonicalLoaderDeps.globInDir;
    origReadFile = _canonicalLoaderDeps.readFile;
  });

  afterEach(() => {
    _canonicalLoaderDeps.globInDir = origGlobInDir;
    _canonicalLoaderDeps.readFile = origReadFile;
  });

  function mockRulesFile(workdir: string, fileName: string, content: string) {
    const fullPath = `${workdir}/.nax/rules/${fileName}`;
    _canonicalLoaderDeps.globInDir = () => [fullPath];
    _canonicalLoaderDeps.readFile = async (p: string) => (p === fullPath ? content : "");
  }

  async function expectRulesFrontmatterError(promise: Promise<unknown>, mustContain: string[]): Promise<void> {
    let threw: unknown;
    try {
      await promise;
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(RulesFrontmatterError);
    const message = (threw as Error).message;
    for (const substr of mustContain) {
      expect(message).toContain(substr);
    }
  }

  test("AC-17: throws RulesFrontmatterError naming the file and the unknown key", async () => {
    mockRulesFile("/project", "test.md", "---\npriority: 60\nunknownKey: value\n---\nBody text.\n");
    await expectRulesFrontmatterError(loadCanonicalRules("/project"), ["test.md", "unknownKey"]);
  });

  test("AC-18: throws RulesFrontmatterError naming the file when appliesTo is not a list of strings", async () => {
    mockRulesFile("/project", "test.md", "---\nappliesTo: not-a-list\n---\nBody text.\n");
    await expectRulesFrontmatterError(loadCanonicalRules("/project"), ["test.md", "appliesTo"]);
  });

  test("AC-19: resolves normally when a rule declares priority, paths, and appliesTo together", async () => {
    mockRulesFile(
      "/project",
      "test.md",
      '---\npriority: 60\npaths:\n  - "packages/core/**"\nappliesTo:\n  - "src/agents/**/*.ts"\n---\nBody text.\n',
    );
    const rules = await loadCanonicalRules("/project");
    expect(rules).toHaveLength(1);
    expect(rules[0]?.priority).toBe(60);
    expect(rules[0]?.paths).toEqual(["packages/core/**"]);
    expect(rules[0]?.appliesTo).toEqual(["src/agents/**/*.ts"]);
  });

  test("AC-21: withReviewNotice(translateLegacyFrontmatter(...)) round-trips through loadCanonicalRules with appliesTo restored", async () => {
    const legacyContent = '---\npaths:\n  - "legacy/path/**"\n---\nLegacy rule body.\n';
    const { content: translated } = translateLegacyFrontmatter(legacyContent);
    const withNotice = withReviewNotice(translated, 1);

    mockRulesFile("/project", "test.md", withNotice);
    const rules = await loadCanonicalRules("/project");
    expect(rules).toHaveLength(1);
    expect(rules[0]?.appliesTo?.[0]).toContain("legacy/path/**");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-004 AC-20: nax rules lint warns on a dead appliesTo glob
// ─────────────────────────────────────────────────────────────────────────────

describe("US-004: rulesLintCommand dead-glob warning", () => {
  let tempDir: string;
  let unsubscribe: (() => void) | null = null;
  let entries: Array<{ level: string; stage: string; message: string; data?: Record<string, unknown> }> = [];

  beforeEach(() => {
    tempDir = makeTempDir("nax-rules-lint-");
    entries = [];
    resetLogger();
    initLogger({ level: "debug", suppressConsole: true });
    unsubscribe = addSink((entry) => {
      entries.push(entry);
    });
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
    resetLogger();
    cleanupTempDir(tempDir);
  });

  test("AC-20: warns once naming the rule file and unmatched pattern, and completes without throwing", async () => {
    await Bun.write(
      `${tempDir}/.nax/rules/test.md`,
      '---\nappliesTo:\n  - "nonexistent/**/*"\n---\nBody text.\n',
    );

    await expect(rulesLintCommand({ dir: tempDir })).resolves.toBeUndefined();

    const warnEntries = entries.filter((e) => e.level === "warn");
    const match = warnEntries.find((e) => {
      const haystack = `${e.message} ${JSON.stringify(e.data ?? {})}`;
      return haystack.includes("test.md") && haystack.includes("nonexistent/**/*");
    });
    expect(match).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-004 AC-22/AC-23/AC-24: StaticRulesProvider scoping against the real
// .nax/rules store of this repository
// ─────────────────────────────────────────────────────────────────────────────

describe("US-004: StaticRulesProvider real .nax/rules store scoping", () => {
  function realRequest(touchedFiles: string[]): ContextRequest {
    return {
      ...BASE_REQUEST,
      repoRoot: REPO_ROOT,
      packageDir: REPO_ROOT,
      touchedFiles,
    };
  }

  test("AC-22: emits no test-writing-scoped chunk when only non-test source files were touched", async () => {
    const provider = new StaticRulesProvider({ budgetTokens: 100_000 });
    const result = await provider.fetch(realRequest(["src/agents/client.ts", "src/operations/index.ts"]));
    expect(result.chunks.some((c) => c.id.startsWith("static-rules:test-writing:"))).toBe(false);
  });

  test("AC-23: emits a test-writing-scoped chunk when a test/ file was touched", async () => {
    const provider = new StaticRulesProvider({ budgetTokens: 100_000 });
    const result = await provider.fetch(realRequest(["test/unit/client.test.ts"]));
    expect(result.chunks.some((c) => c.id.startsWith("static-rules:test-writing:"))).toBe(true);
  });

  test("AC-24: emits no adapter-wiring-scoped chunk when touched files are outside src/agents and src/operations", async () => {
    const provider = new StaticRulesProvider({ budgetTokens: 100_000 });
    const result = await provider.fetch(realRequest(["src/other/module.ts"]));
    expect(result.chunks.some((c) => c.id.startsWith("static-rules:adapter-wiring:"))).toBe(false);
  });
});