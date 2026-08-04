import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { NaxConfigSchema } from "../../../src/config/schemas";
import {
  _manifestStoreDeps,
  loadContextManifests,
  writeContextManifest,
} from "../../../src/context/engine/manifest-store";
import { ContextOrchestrator } from "../../../src/context/engine/orchestrator";
import { StaticRulesProvider, _staticRulesDeps } from "../../../src/context/engine/providers/static-rules";
import type {
  ContextManifest,
  ContextProviderResult,
  ContextRequest,
  IContextProvider,
} from "../../../src/context/engine/types";
import {
  DEFAULT_CANONICAL_RULES_BUDGET_TOKENS,
  NeutralityLintError,
  _canonicalLoaderDeps,
  applyCanonicalRulesBudget,
  loadCanonicalRules,
} from "../../../src/context/rules/canonical-loader";
import type { CanonicalRule } from "../../../src/context/rules/canonical-loader";
import { collectStoryMetrics } from "../../../src/metrics/tracker";
import type { PipelineContext } from "../../../src/pipeline/types";
import type { PRD } from "../../../src/prd";
import { makeStory } from "../../../test/helpers";
import { makeMockRuntime } from "../../../test/helpers/runtime";

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeRule(overrides: Partial<CanonicalRule> & { id: string; tokens: number }): CanonicalRule {
  return {
    fileName: `${overrides.id}.md`,
    content: "x".repeat(overrides.tokens * 4),
    priority: 100,
    ...overrides,
  };
}

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

function makeManifest(overrides?: Partial<ContextManifest>): ContextManifest {
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
    ...overrides,
  };
}

const BASE_REQUEST: ContextRequest = {
  storyId: "US-001",
  repoRoot: "/project",
  packageDir: "/project",
  stage: "execution",
  role: "implementer",
  budgetTokens: 8_000,
};

function setupCanonical(rules: CanonicalRule[]) {
  _staticRulesDeps.loadCanonicalRules = async (dir: string) => (dir === "/project" ? rules : []);
}

// ─────────────────────────────────────────────────────────────────────────────
// US-001: ContextManifest write/read round trip (AC-1..AC-4)
// ─────────────────────────────────────────────────────────────────────────────

describe("US-001: ContextManifest write/read round trip", () => {
  let origMkdirp: typeof _manifestStoreDeps.mkdirp;
  let origWriteFile: typeof _manifestStoreDeps.writeFile;
  let origFileExists: typeof _manifestStoreDeps.fileExists;
  let origReadFile: typeof _manifestStoreDeps.readFile;
  let origListFeatureDirs: typeof _manifestStoreDeps.listFeatureDirs;
  let origListManifestFiles: typeof _manifestStoreDeps.listManifestFiles;

  let writes: Map<string, string>;

  beforeEach(() => {
    origMkdirp = _manifestStoreDeps.mkdirp;
    origWriteFile = _manifestStoreDeps.writeFile;
    origFileExists = _manifestStoreDeps.fileExists;
    origReadFile = _manifestStoreDeps.readFile;
    origListFeatureDirs = _manifestStoreDeps.listFeatureDirs;
    origListManifestFiles = _manifestStoreDeps.listManifestFiles;

    writes = new Map<string, string>();
    _manifestStoreDeps.mkdirp = async () => undefined;
    _manifestStoreDeps.writeFile = async (path, content) => {
      writes.set(path, content);
      return content.length;
    };
    _manifestStoreDeps.fileExists = async (path) => writes.has(path);
    _manifestStoreDeps.readFile = async (path) => writes.get(path) ?? "";
    _manifestStoreDeps.listFeatureDirs = async () => [FEATURE];
    _manifestStoreDeps.listManifestFiles = async () => ["context-manifest-execution.json"];
  });

  afterEach(() => {
    _manifestStoreDeps.mkdirp = origMkdirp;
    _manifestStoreDeps.writeFile = origWriteFile;
    _manifestStoreDeps.fileExists = origFileExists;
    _manifestStoreDeps.readFile = origReadFile;
    _manifestStoreDeps.listFeatureDirs = origListFeatureDirs;
    _manifestStoreDeps.listManifestFiles = origListManifestFiles;
  });

  test("AC-1: a manifest object conforming to ContextManifest is accepted by writeContextManifest without throwing", async () => {
    const manifest = makeManifest();
    await expect(writeContextManifest(PROJECT_DIR, FEATURE, STORY_ID, "execution", manifest)).resolves.toBeUndefined();
  });

  test("AC-2: includedChunks written are read back with the same length and same IDs in order", async () => {
    const chunkIds = ["static-rules:a:001", "static-rules:b:002", "static-rules:c:003"];
    await writeContextManifest(PROJECT_DIR, FEATURE, STORY_ID, "execution", makeManifest({ includedChunks: chunkIds }));

    const loaded = await loadContextManifests(PROJECT_DIR, STORY_ID, FEATURE);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.manifest.includedChunks).toHaveLength(chunkIds.length);
    expect(loaded[0]?.manifest.includedChunks).toEqual(chunkIds);
  });

  test("AC-3: providerResults value written is deep-equal after read back", async () => {
    const providerResults: NonNullable<ContextManifest["providerResults"]> = [
      { providerId: "static-rules", status: "ok", chunkCount: 2, durationMs: 40, tokensProduced: 300 },
    ];
    await writeContextManifest(PROJECT_DIR, FEATURE, STORY_ID, "execution", makeManifest({ providerResults }));

    const loaded = await loadContextManifests(PROJECT_DIR, STORY_ID, FEATURE);
    expect(loaded[0]?.manifest.providerResults).toEqual(providerResults);
  });

  test("AC-4: an injected writeFile rejection propagates from writeContextManifest unchanged", async () => {
    const failure = new Error("disk full");
    _manifestStoreDeps.writeFile = async () => {
      throw failure;
    };

    await expect(writeContextManifest(PROJECT_DIR, FEATURE, STORY_ID, "execution", makeManifest())).rejects.toThrow(
      "disk full",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-002: applyCanonicalRulesBudget soft/hard modes + enforceBudget config
// (AC-5..AC-16)
// ─────────────────────────────────────────────────────────────────────────────

describe("US-002: applyCanonicalRulesBudget soft-by-default budget", () => {
  test("AC-5: enforce=false keeps every rule when total exceeds budget", () => {
    const rules = [
      makeRule({ id: "a", tokens: 100 }),
      makeRule({ id: "b", tokens: 100 }),
      makeRule({ id: "c", tokens: 100 }),
    ];
    const result = applyCanonicalRulesBudget(rules, 150, { enforce: false });
    expect(result.rules).toHaveLength(3);
  });

  test("AC-6: enforce=false reports droppedCount 0 when total exceeds budget", () => {
    const rules = [makeRule({ id: "a", tokens: 100 }), makeRule({ id: "b", tokens: 100 })];
    const result = applyCanonicalRulesBudget(rules, 50, { enforce: false });
    expect(result.droppedCount).toBe(0);
  });

  test("AC-7: enforce=false reports overageTokens = totalTokens - budgetTokens", () => {
    const rules = [makeRule({ id: "a", tokens: 100 }), makeRule({ id: "b", tokens: 100 })];
    const result = applyCanonicalRulesBudget(rules, 120, { enforce: false });
    expect(result.overageTokens).toBe(200 - 120);
  });

  test("AC-8: enforce=false reports usedTokens = totalTokens", () => {
    const rules = [makeRule({ id: "a", tokens: 100 }), makeRule({ id: "b", tokens: 100 })];
    const result = applyCanonicalRulesBudget(rules, 120, { enforce: false });
    expect(result.usedTokens).toBe(result.totalTokens);
    expect(result.usedTokens).toBe(200);
  });

  test("AC-9: enforce=true returns the longest leading prefix whose cumulative tokens fit the budget", () => {
    const rules = [
      makeRule({ id: "a", tokens: 10, priority: 1 }),
      makeRule({ id: "b", tokens: 10, priority: 2 }),
      makeRule({ id: "c", tokens: 100, priority: 3 }),
      makeRule({ id: "d", tokens: 10, priority: 4 }),
    ];
    const result = applyCanonicalRulesBudget(rules, 30, { enforce: true });
    expect(result.rules.map((r) => r.id)).toEqual(["a", "b"]);
  });

  test("AC-10: enforce=true reports droppedCount = N - kept.length", () => {
    const rules = [
      makeRule({ id: "a", tokens: 10, priority: 1 }),
      makeRule({ id: "b", tokens: 10, priority: 2 }),
      makeRule({ id: "c", tokens: 100, priority: 3 }),
      makeRule({ id: "d", tokens: 10, priority: 4 }),
    ];
    const result = applyCanonicalRulesBudget(rules, 30, { enforce: true });
    expect(result.droppedCount).toBe(rules.length - result.rules.length);
    expect(result.droppedCount).toBe(2);
  });

  test("AC-11: overageTokens is 0 when totalTokens <= budgetTokens", () => {
    const rules = [makeRule({ id: "a", tokens: 10 }), makeRule({ id: "b", tokens: 10 })];
    const result = applyCanonicalRulesBudget(rules, 100, { enforce: false });
    expect(result.overageTokens).toBe(0);
  });

  test("AC-12: budgetTokens=0 drops every rule", () => {
    const rules = [
      makeRule({ id: "a", tokens: 10 }),
      makeRule({ id: "b", tokens: 10 }),
      makeRule({ id: "c", tokens: 10 }),
    ];
    const result = applyCanonicalRulesBudget(rules, 0);
    expect(result.rules).toHaveLength(0);
    expect(result.droppedCount).toBe(3);
  });

  test("AC-13: negative budgetTokens drops every rule", () => {
    const rules = [makeRule({ id: "a", tokens: 10 }), makeRule({ id: "b", tokens: 10 })];
    const result = applyCanonicalRulesBudget(rules, -100);
    expect(result.rules).toHaveLength(0);
    expect(result.droppedCount).toBe(2);
  });

  test("AC-14: Infinity, -Infinity, and NaN budgetTokens each drop every rule", () => {
    const rules = [
      makeRule({ id: "a", tokens: 10 }),
      makeRule({ id: "b", tokens: 10 }),
      makeRule({ id: "c", tokens: 10 }),
    ];
    for (const budget of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN]) {
      const result = applyCanonicalRulesBudget(rules, budget);
      expect(result.rules).toHaveLength(0);
      expect(result.droppedCount).toBe(3);
    }
  });

  test("AC-15: config.context.v2.rules.enforceBudget defaults to false when unset", () => {
    const parsed = NaxConfigSchema.parse({});
    expect((parsed.context.v2.rules as unknown as { enforceBudget: boolean }).enforceBudget).toBe(false);
  });

  test("AC-16: config.context.v2.rules.enforceBudget resolves to true when explicitly set", () => {
    const parsed = NaxConfigSchema.parse({
      ...(DEFAULT_CONFIG as Record<string, unknown>),
      context: {
        ...DEFAULT_CONFIG.context,
        v2: {
          ...DEFAULT_CONFIG.context.v2,
          rules: { ...DEFAULT_CONFIG.context.v2.rules, enforceBudget: true },
        },
      },
    });
    expect((parsed.context.v2.rules as unknown as { enforceBudget: boolean }).enforceBudget).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-003: StaticRulesProvider reports budgetPressure (AC-17..AC-27)
// ─────────────────────────────────────────────────────────────────────────────

describe("US-003: StaticRulesProvider budgetPressure reporting", () => {
  let origLoadCanonicalRules: typeof _staticRulesDeps.loadCanonicalRules;
  let origFileExists: typeof _staticRulesDeps.fileExists;
  let origReadFile: typeof _staticRulesDeps.readFile;
  let origGlobInDir: typeof _staticRulesDeps.globInDir;

  beforeEach(() => {
    origLoadCanonicalRules = _staticRulesDeps.loadCanonicalRules;
    origFileExists = _staticRulesDeps.fileExists;
    origReadFile = _staticRulesDeps.readFile;
    origGlobInDir = _staticRulesDeps.globInDir;
    _staticRulesDeps.fileExists = async () => false;
    _staticRulesDeps.readFile = async () => "";
    _staticRulesDeps.globInDir = () => [];
  });

  afterEach(() => {
    _staticRulesDeps.loadCanonicalRules = origLoadCanonicalRules;
    _staticRulesDeps.fileExists = origFileExists;
    _staticRulesDeps.readFile = origReadFile;
    _staticRulesDeps.globInDir = origGlobInDir;
  });

  test("AC-17: fetch returns one chunk per rule (including over-budget rules) when enforceBudget=false", async () => {
    const rules = [
      makeRule({ id: "a", tokens: 3_000, priority: 1 }),
      makeRule({ id: "b", tokens: 3_000, priority: 2 }),
      makeRule({ id: "c", tokens: 3_000, priority: 3 }),
    ];
    setupCanonical(rules);
    const provider = new StaticRulesProvider({ budgetTokens: 5_000, enforceBudget: false } as never);
    const result = (await provider.fetch(BASE_REQUEST)) as ContextProviderResult;

    expect(result.chunks).toHaveLength(3);
    for (const rule of rules) {
      const chunk = result.chunks.find((c) => c.id.startsWith(`static-rules:${rule.id}:`));
      expect(chunk?.content).toContain(rule.content);
    }
  });

  test("AC-18: fetch reports budgetPressure.overageTokens = storeTotal - budgetTokens when over budget and enforceBudget=false", async () => {
    const rules = [makeRule({ id: "a", tokens: 3_000 }), makeRule({ id: "b", tokens: 3_000 })];
    setupCanonical(rules);
    const provider = new StaticRulesProvider({ budgetTokens: 5_000, enforceBudget: false } as never);
    const result = (await provider.fetch(BASE_REQUEST)) as ContextProviderResult & {
      budgetPressure?: { overageTokens: number };
    };

    expect(result.budgetPressure?.overageTokens).toBe(6_000 - 5_000);
  });

  test("AC-19: fetch reports budgetPressure.droppedCount = 0 when enforceBudget=false", async () => {
    const rules = [makeRule({ id: "a", tokens: 3_000 }), makeRule({ id: "b", tokens: 3_000 })];
    setupCanonical(rules);
    const provider = new StaticRulesProvider({ budgetTokens: 5_000, enforceBudget: false } as never);
    const result = (await provider.fetch(BASE_REQUEST)) as ContextProviderResult & {
      budgetPressure?: { droppedCount: number };
    };

    expect(result.budgetPressure?.droppedCount).toBe(0);
  });

  test("AC-20: enforceBudget=true reports droppedCount matching omitted rules and chunks.length = total - dropped", async () => {
    const rules = [
      makeRule({ id: "a", tokens: 2_000, priority: 1 }),
      makeRule({ id: "b", tokens: 2_000, priority: 2 }),
      makeRule({ id: "c", tokens: 2_000, priority: 3 }),
    ];
    setupCanonical(rules);
    const provider = new StaticRulesProvider({ budgetTokens: 3_000, enforceBudget: true } as never);
    const result = (await provider.fetch(BASE_REQUEST)) as ContextProviderResult & {
      budgetPressure?: { droppedCount: number };
    };

    expect(result.budgetPressure?.droppedCount).toBe(2);
    expect(result.chunks).toHaveLength(rules.length - 2);
  });

  test("AC-21: enforceBudget=true reports droppedTokens matching the omitted rules' combined tokens", async () => {
    const rules = [
      makeRule({ id: "a", tokens: 2_000, priority: 1 }),
      makeRule({ id: "b", tokens: 2_000, priority: 2 }),
      makeRule({ id: "c", tokens: 2_000, priority: 3 }),
    ];
    setupCanonical(rules);
    const provider = new StaticRulesProvider({ budgetTokens: 3_000, enforceBudget: true } as never);
    const result = (await provider.fetch(BASE_REQUEST)) as ContextProviderResult & {
      budgetPressure?: { droppedTokens: number; droppedCount: number };
    };

    expect(result.budgetPressure?.droppedTokens).toBe(4_000);
    expect(result.budgetPressure?.droppedCount).toBe(2);
  });

  test("AC-22: enforceBudget=true reports droppedIds containing exactly the omitted rule IDs", async () => {
    const rules = [
      makeRule({ id: "a", tokens: 2_000, priority: 1 }),
      makeRule({ id: "b", tokens: 2_000, priority: 2 }),
      makeRule({ id: "c", tokens: 2_000, priority: 3 }),
    ];
    setupCanonical(rules);
    const provider = new StaticRulesProvider({ budgetTokens: 3_000, enforceBudget: true } as never);
    const result = (await provider.fetch(BASE_REQUEST)) as ContextProviderResult & {
      budgetPressure?: { droppedIds: string[] };
    };

    expect(result.budgetPressure?.droppedIds).toHaveLength(2);
    expect(new Set(result.budgetPressure?.droppedIds)).toEqual(new Set(["b", "c"]));
  });

  test("AC-23: budgetPressure is undefined when the store total is within budgetTokens", async () => {
    const rules = [makeRule({ id: "a", tokens: 100 }), makeRule({ id: "b", tokens: 100 })];
    setupCanonical(rules);
    const provider = new StaticRulesProvider({ budgetTokens: 5_000, enforceBudget: false } as never);
    const result = (await provider.fetch(BASE_REQUEST)) as ContextProviderResult & { budgetPressure?: unknown };

    expect(result.budgetPressure).toBeUndefined();
  });

  test("AC-24: NeutralityLintError from the canonical loader propagates and is not swallowed", async () => {
    _staticRulesDeps.loadCanonicalRules = async () => {
      throw new NeutralityLintError([
        { file: "bad.md", lineNumber: 1, line: "IMPORTANT:", ruleId: "important-shouting", pattern: "shouting" },
      ]);
    };
    const provider = new StaticRulesProvider();

    await expect(provider.fetch(BASE_REQUEST)).rejects.toBeInstanceOf(NeutralityLintError);
  });

  test("AC-25: with default provider options, fetch returns one chunk per .md rule file in this repo's .nax/rules/", async () => {
    _staticRulesDeps.loadCanonicalRules = origLoadCanonicalRules;
    const repoRoot = `${import.meta.dir}/../../..`;
    const onDiskRules = await loadCanonicalRules(repoRoot);
    expect(onDiskRules.length).toBeGreaterThan(0);

    const provider = new StaticRulesProvider();
    const result = await provider.fetch({ ...BASE_REQUEST, repoRoot, packageDir: repoRoot });

    expect(result.chunks).toHaveLength(onDiskRules.length);
  });

  test("AC-26: default config against this repo's .nax/rules/ reports budgetPressure per the T-vs-B relationship", async () => {
    _staticRulesDeps.loadCanonicalRules = origLoadCanonicalRules;
    const repoRoot = `${import.meta.dir}/../../..`;
    const onDiskRules = await loadCanonicalRules(repoRoot);
    const total = onDiskRules.reduce((sum, r) => sum + (r.tokens ?? 0), 0);

    const provider = new StaticRulesProvider();
    const result = (await provider.fetch({
      ...BASE_REQUEST,
      repoRoot,
      packageDir: repoRoot,
    })) as ContextProviderResult & {
      budgetPressure?: { droppedCount: number };
    };

    if (total <= DEFAULT_CANONICAL_RULES_BUDGET_TOKENS) {
      expect(result.budgetPressure).toBeUndefined();
    } else {
      expect(result.budgetPressure?.droppedCount).toBe(0);
    }
  });

  test("AC-27: allowLegacyClaudeMd=false with an empty canonical store returns no chunks and never probes legacy files", async () => {
    setupCanonical([]);
    let legacyProbed = false;
    _staticRulesDeps.fileExists = async () => {
      legacyProbed = true;
      return false;
    };

    const provider = new StaticRulesProvider({ allowLegacyClaudeMd: false });
    const result = await provider.fetch(BASE_REQUEST);

    expect(result.chunks).toEqual([]);
    expect(legacyProbed).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-004a: budgetPressure flows through ContextOrchestrator.assemble() (AC-28, AC-29)
// ─────────────────────────────────────────────────────────────────────────────

describe("US-004: budgetPressure reaches the manifest via assemble()", () => {
  function makeProvider(id: string, result: Partial<ContextProviderResult>): IContextProvider {
    return {
      id,
      kind: "static",
      fetch: async () => ({ chunks: [], pullTools: [], ...result }),
    };
  }

  const ASSEMBLE_REQUEST: ContextRequest = {
    storyId: "US-001",
    repoRoot: "/project",
    packageDir: "/project",
    stage: "execution",
    role: "implementer",
    budgetTokens: 10_000,
    providerIds: ["pressure-provider", "quiet-provider"],
  };

  test("AC-28: manifest.providerResults entry carries the provider's returned budgetPressure verbatim", async () => {
    const pressure = { overageTokens: 100, droppedCount: 5, droppedTokens: 500 };
    const provider = makeProvider("pressure-provider", { budgetPressure: pressure } as Partial<ContextProviderResult>);
    const orch = new ContextOrchestrator([provider]);

    const bundle = await orch.assemble({ ...ASSEMBLE_REQUEST, providerIds: ["pressure-provider"] });
    const entry = bundle.manifest.providerResults?.find((pr) => pr.providerId === "pressure-provider") as
      | { budgetPressure?: typeof pressure }
      | undefined;

    expect(entry?.budgetPressure).toEqual(pressure);
  });

  test("AC-29: manifest.providerResults entry omits budgetPressure when the provider returns none", async () => {
    const provider = makeProvider("quiet-provider", {});
    const orch = new ContextOrchestrator([provider]);

    const bundle = await orch.assemble({ ...ASSEMBLE_REQUEST, providerIds: ["quiet-provider"] });
    const entry = bundle.manifest.providerResults?.find((pr) => pr.providerId === "quiet-provider") as
      | { budgetPressure?: unknown }
      | undefined;

    expect(entry).toBeDefined();
    expect(entry?.budgetPressure).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(entry ?? {}, "budgetPressure")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-004b: budgetPressure aggregates into collectStoryMetrics (AC-30..AC-35)
// ─────────────────────────────────────────────────────────────────────────────

describe("US-004: collectStoryMetrics aggregates budgetPressure across stages", () => {
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

  function providerResultWithPressure(pressure: Record<string, unknown>) {
    return [
      {
        providerId: "static-rules",
        status: "ok" as const,
        chunkCount: 1,
        durationMs: 10,
        tokensProduced: 100,
        budgetPressure: pressure,
      },
    ];
  }

  test("AC-30: budgetPressure.overageTokens sums across stage manifests for the same provider", async () => {
    mockManifests({
      [`${FEATURE}/execution`]: makeManifest({
        stage: "execution",
        providerResults: providerResultWithPressure({ overageTokens: 200, droppedCount: 0, droppedTokens: 0 }) as never,
        includedChunks: ["static-rules:a:001"],
      }),
      [`${FEATURE}/verify`]: makeManifest({
        stage: "verify",
        providerResults: providerResultWithPressure({ overageTokens: 300, droppedCount: 0, droppedTokens: 0 }) as never,
        includedChunks: ["static-rules:a:001"],
      }),
    });
    const metrics = await collectStoryMetrics(makeCtx(), new Date().toISOString());
    const providers = metrics.context?.providers as
      | Record<string, { budgetPressure?: { overageTokens: number } }>
      | undefined;

    expect(providers?.["static-rules"]?.budgetPressure?.overageTokens).toBe(500);
  });

  test("AC-31: budgetPressure.droppedCount sums across stage manifests for the same provider", async () => {
    mockManifests({
      [`${FEATURE}/execution`]: makeManifest({
        stage: "execution",
        providerResults: providerResultWithPressure({ overageTokens: 0, droppedCount: 3, droppedTokens: 0 }) as never,
        includedChunks: ["static-rules:a:001"],
      }),
      [`${FEATURE}/verify`]: makeManifest({
        stage: "verify",
        providerResults: providerResultWithPressure({ overageTokens: 0, droppedCount: 7, droppedTokens: 0 }) as never,
        includedChunks: ["static-rules:a:001"],
      }),
    });
    const metrics = await collectStoryMetrics(makeCtx(), new Date().toISOString());
    const providers = metrics.context?.providers as
      | Record<string, { budgetPressure?: { droppedCount: number } }>
      | undefined;

    expect(providers?.["static-rules"]?.budgetPressure?.droppedCount).toBe(10);
  });

  test("AC-32: budgetPressure.droppedTokens sums across stage manifests for the same provider", async () => {
    mockManifests({
      [`${FEATURE}/execution`]: makeManifest({
        stage: "execution",
        providerResults: providerResultWithPressure({
          overageTokens: 0,
          droppedCount: 0,
          droppedTokens: 1_000,
        }) as never,
        includedChunks: ["static-rules:a:001"],
      }),
      [`${FEATURE}/verify`]: makeManifest({
        stage: "verify",
        providerResults: providerResultWithPressure({
          overageTokens: 0,
          droppedCount: 0,
          droppedTokens: 2_000,
        }) as never,
        includedChunks: ["static-rules:a:001"],
      }),
    });
    const metrics = await collectStoryMetrics(makeCtx(), new Date().toISOString());
    const providers = metrics.context?.providers as
      | Record<string, { budgetPressure?: { droppedTokens: number } }>
      | undefined;

    expect(providers?.["static-rules"]?.budgetPressure?.droppedTokens).toBe(3_000);
  });

  test("AC-33: budgetPressure is undefined when the provider's manifest entry carries no budgetPressure field", async () => {
    mockManifests({
      [`${FEATURE}/execution`]: makeManifest({
        stage: "execution",
        providerResults: [
          { providerId: "static-rules", status: "ok", chunkCount: 1, durationMs: 10, tokensProduced: 100 },
        ],
        includedChunks: ["static-rules:a:001"],
      }),
    });
    const metrics = await collectStoryMetrics(makeCtx(), new Date().toISOString());
    const providers = metrics.context?.providers as Record<string, { budgetPressure?: unknown }> | undefined;

    expect(providers?.["static-rules"]?.budgetPressure).toBeUndefined();
  });

  test("AC-34: a legacy manifest with no budgetPressure on any provider yields budgetPressure=undefined for every provider", async () => {
    mockManifests({
      [`${FEATURE}/execution`]: makeManifest({
        stage: "execution",
        providerResults: [
          { providerId: "static-rules", status: "ok", chunkCount: 1, durationMs: 10, tokensProduced: 100 },
          { providerId: "git-history", status: "ok", chunkCount: 1, durationMs: 5, tokensProduced: 50 },
        ],
        includedChunks: ["static-rules:a:001", "git-history:b:002"],
      }),
    });
    const metrics = await collectStoryMetrics(makeCtx(), new Date().toISOString());
    const providers = metrics.context?.providers as Record<string, { budgetPressure?: unknown }> | undefined;

    expect(providers?.["static-rules"]?.budgetPressure).toBeUndefined();
    expect(providers?.["git-history"]?.budgetPressure).toBeUndefined();
  });

  test("AC-35: the aggregated budgetPressure never carries a droppedIds property, even if the stored manifest had one", async () => {
    mockManifests({
      [`${FEATURE}/execution`]: makeManifest({
        stage: "execution",
        providerResults: providerResultWithPressure({
          overageTokens: 50,
          droppedCount: 2,
          droppedTokens: 200,
          droppedIds: ["id1", "id2"],
        }) as never,
        includedChunks: ["static-rules:a:001"],
      }),
    });
    const metrics = await collectStoryMetrics(makeCtx(), new Date().toISOString());
    const providers = metrics.context?.providers as
      | Record<string, { budgetPressure?: { overageTokens: number; droppedCount: number; droppedTokens: number } }>
      | undefined;
    const pressure = providers?.["static-rules"]?.budgetPressure;

    expect(pressure).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(pressure ?? {}, "droppedIds")).toBe(false);
    expect(pressure?.overageTokens).toBe(50);
    expect(pressure?.droppedCount).toBe(2);
    expect(pressure?.droppedTokens).toBe(200);
  });
});