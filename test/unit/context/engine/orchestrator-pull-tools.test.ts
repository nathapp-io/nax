/**
 * Pull-tool assembly — split out of orchestrator.test.ts when that file crossed
 * the 800-line test limit. Covers Phase 4 (per-stage descriptors, allowedTools
 * filtering, maxCallsPerSession precedence) and Phase 5 (review-stage tools).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { assertDefined, type MockLogger, makeLogger } from "@test/helpers";
import {
  _orchestratorDeps,
  ContextOrchestrator,
  DIGEST_RESERVE_TOKENS,
  FIXED_RENDER_OVERHEAD_TOKENS,
  PULL_TOOL_REGISTRY,
  QUERY_FEATURE_CONTEXT_DESCRIPTOR,
  QUERY_NEIGHBOR_DESCRIPTOR,
} from "@/context/engine";
import type {
  ChunkKind,
  ContextProviderResult,
  ContextRequest,
  IContextProvider,
  RawChunk,
} from "@/context/engine/types";

let _reqSeq = 0;
const _origUuid = _orchestratorDeps.uuid;
const _origNow = _orchestratorDeps.now;
beforeEach(() => {
  _reqSeq = 0;
  _orchestratorDeps.uuid = () => `test-uuid-${++_reqSeq}` as `${string}-${string}-${string}-${string}-${string}`;
  _orchestratorDeps.now = () => Date.now();
});
afterEach(() => {
  _orchestratorDeps.uuid = _origUuid;
  _orchestratorDeps.now = _origNow;
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4: pull tools
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 4: pull tools", () => {
  const TDD_IMPLEMENTER_REQUEST: ContextRequest = {
    storyId: "US-001",
    repoRoot: "/project",
    packageDir: "/project",
    stage: "tdd-implementer",
    role: "implementer",
    budgetTokens: 8_000,
    providerIds: [],
  };

  test.each([
    ["pullConfig is absent", undefined],
    ["pullConfig.enabled is false", { enabled: false, allowedTools: [] as string[], maxCallsPerSession: 5 }],
  ])("pullTools is empty when %s", async (_label, pullConfig) => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({ ...TDD_IMPLEMENTER_REQUEST, pullConfig });
    expect(bundle.pullTools).toEqual([]);
  });

  test("pullTools items are ToolDescriptor objects; maxCallsPerSession reflects pullConfig override", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({
      ...TDD_IMPLEMENTER_REQUEST,
      pullConfig: { enabled: true, allowedTools: [], maxCallsPerSession: 3 },
    });
    const tool = bundle.pullTools[0];
    assertDefined(tool, "bundle.pullTools[0]");
    expect(typeof tool.name).toBe("string");
    expect(typeof tool.description).toBe("string");
    expect(typeof tool.inputSchema).toBe("object");
    expect(typeof tool.maxCallsPerSession).toBe("number");
    expect(typeof tool.maxTokensPerCall).toBe("number");
    expect(tool.maxCallsPerSession).toBe(3);
  });

  test("a descriptor's own maxCallsPerSession survives when pullConfig is left at the schema default", async () => {
    const orch = new ContextOrchestrator([]);
    const probe = await orch.assemble({
      ...TDD_IMPLEMENTER_REQUEST,
      pullConfig: { enabled: true, allowedTools: [], maxCallsPerSession: 5 },
    });
    const firstTool = probe.pullTools[0];
    assertDefined(firstTool, "probe.pullTools[0]");
    const toolName = firstTool.name;
    const original = PULL_TOOL_REGISTRY[toolName];
    assertDefined(original, `PULL_TOOL_REGISTRY.${toolName}`);

    PULL_TOOL_REGISTRY[toolName] = { ...original, maxCallsPerSession: 9 };
    try {
      // 5 is the schema default, i.e. "operator configured nothing" — the
      // descriptor's own per-tool ceiling must win.
      const unconfigured = await orch.assemble({
        ...TDD_IMPLEMENTER_REQUEST,
        pullConfig: { enabled: true, allowedTools: [], maxCallsPerSession: 5 },
      });
      expect(unconfigured.pullTools.find((t) => t.name === toolName)?.maxCallsPerSession).toBe(9);

      // An explicitly configured ceiling still overrides the descriptor.
      const configured = await orch.assemble({
        ...TDD_IMPLEMENTER_REQUEST,
        pullConfig: { enabled: true, allowedTools: [], maxCallsPerSession: 2 },
      });
      expect(configured.pullTools.find((t) => t.name === toolName)?.maxCallsPerSession).toBe(2);
    } finally {
      PULL_TOOL_REGISTRY[toolName] = original;
    }
  });

  test("allowedTools filter restricts pull tools", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({
      ...TDD_IMPLEMENTER_REQUEST,
      pullConfig: { enabled: true, allowedTools: ["other_tool"], maxCallsPerSession: 5 },
    });
    // query_neighbor is not in allowedTools — filtered out
    expect(bundle.pullTools).toEqual([]);
  });

  test("empty allowedTools means all stage-configured tools are allowed; tdd-implementer has query_neighbor", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({
      ...TDD_IMPLEMENTER_REQUEST,
      pullConfig: { enabled: true, allowedTools: [], maxCallsPerSession: 5 },
    });
    expect(bundle.pullTools.length).toBeGreaterThan(0);
    expect(bundle.pullTools[0]?.name).toBe("query_neighbor");
  });

  test("stage with no pullToolNames returns empty pullTools even when enabled", async () => {
    const orch = new ContextOrchestrator([]);
    const verifyRequest: ContextRequest = {
      ...TDD_IMPLEMENTER_REQUEST,
      stage: "verify",
      pullConfig: { enabled: true, allowedTools: [], maxCallsPerSession: 5 },
    };
    const bundle = await orch.assemble(verifyRequest);
    expect(bundle.pullTools).toEqual([]);
  });

  // Regression: the native agent id had no AGENT_PROFILES entry, so it fell
  // back to CONSERVATIVE_DEFAULT_PROFILE (supportsToolCalls: false) and
  // received zero pull tools regardless of stage/pullConfig — a real
  // capability downgrade for the native transport, not just a log warning.
  test("native agent receives pull tools like any other tool-capable agent", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({
      ...TDD_IMPLEMENTER_REQUEST,
      agentId: "native",
      pullConfig: { enabled: true, allowedTools: [], maxCallsPerSession: 5 },
    });
    expect(bundle.pullTools.length).toBeGreaterThan(0);
    expect(bundle.pullTools[0]?.name).toBe("query_neighbor");
  });

  test("rebuildForAgent preserves pullTools from original bundle", async () => {
    const orch = new ContextOrchestrator([]);
    const original = await orch.assemble({
      ...TDD_IMPLEMENTER_REQUEST,
      pullConfig: { enabled: true, allowedTools: [], maxCallsPerSession: 5 },
    });
    expect(original.pullTools).toHaveLength(1);

    const rebuilt = orch.rebuildForAgent(original);
    expect(rebuilt.pullTools).toEqual(original.pullTools);
    expect(rebuilt.pullTools[0]?.name).toBe(QUERY_NEIGHBOR_DESCRIPTOR.name);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5: review stage pull tools
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 5: review stage pull tools", () => {
  const REVIEW_REQUEST: ContextRequest = {
    storyId: "US-001",
    repoRoot: "/project",
    packageDir: "/project",
    stage: "review-semantic",
    role: "reviewer",
    budgetTokens: 6_000,
    providerIds: [],
  };

  test.each(["review-semantic", "review-adversarial"] as const)(
    "%s with pullConfig enabled returns query_feature_context",
    async (stage) => {
      const orch = new ContextOrchestrator([]);
      const bundle = await orch.assemble({
        ...REVIEW_REQUEST,
        stage,
        pullConfig: { enabled: true, allowedTools: [], maxCallsPerSession: 5 },
      });
      expect(bundle.pullTools).toHaveLength(1);
      expect(bundle.pullTools[0]?.name).toBe(QUERY_FEATURE_CONTEXT_DESCRIPTOR.name);
    },
  );

  test("review-semantic pullConfig disabled returns empty pull tools", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({
      ...REVIEW_REQUEST,
      pullConfig: { enabled: false, allowedTools: [], maxCallsPerSession: 5 },
    });
    expect(bundle.pullTools).toEqual([]);
  });

  test("pull tool names do not bleed across stages: tdd-implementer lacks query_feature_context, review-semantic lacks query_neighbor", async () => {
    const orchA = new ContextOrchestrator([]);
    const bundleA = await orchA.assemble({
      storyId: "US-001",
      repoRoot: "/project",
      packageDir: "/project",
      stage: "tdd-implementer",
      role: "implementer",
      budgetTokens: 8_000,
      providerIds: [],
      pullConfig: { enabled: true, allowedTools: [], maxCallsPerSession: 5 },
    });
    expect(bundleA.pullTools.map((t) => t.name)).not.toContain("query_feature_context");
    const orchB = new ContextOrchestrator([]);
    const bundleB = await orchB.assemble({
      ...REVIEW_REQUEST,
      pullConfig: { enabled: true, allowedTools: [], maxCallsPerSession: 5 },
    });
    expect(bundleB.pullTools.map((t) => t.name)).not.toContain("query_neighbor");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// orchestrator.ts — US-004 effectiveness weights during scoring tests
//
// Covers AC5, AC6, AC9 of US-004. The story threads per-provider weights from
// ContextRequest.providerWeights through scoreChunks, then into the manifest's
// includedChunks / excludedChunks lists.
// ─────────────────────────────────────────────────────────────────────────────

const BASE_REQUEST: ContextRequest = {
  storyId: "US-004",
  repoRoot: "/project",
  packageDir: "/project",
  stage: "execution",
  role: "implementer",
  budgetTokens: 10_000,
  // Bypass stage-config provider filtering so all providers are activated.
  providerIds: ["static-rules", "code-neighbor", "feature-context"],
};

function makeProvider(
  id: string,
  result: Partial<ContextProviderResult> = {},
  kind: RawChunk["kind"] = "feature",
): IContextProvider {
  return {
    id,
    kind,
    fetch: async () => ({
      chunks: [],
      pullTools: [],
      ...result,
    }),
  };
}

function makeChunk(overrides: Partial<RawChunk> = {}): RawChunk {
  return {
    id: "chunk:abc123",
    kind: "feature",
    scope: "feature",
    role: ["implementer"],
    content: "stub content",
    tokens: 100,
    rawScore: 1.0,
    ...overrides,
  };
}

describe("orchestrator — static-kind floor inclusion survives low weight (AC5)", () => {
  test("AC5: static chunk whose low weight drops it below minScore stays in includedChunks", async () => {
    const staticChunk: RawChunk = makeChunk({
      id: "static-rules:rules-md",
      kind: "static",
      scope: "project",
      rawScore: 1.0,
    });
    const staticProvider = makeProvider("static-rules", { chunks: [staticChunk] }, "static");
    const orch = new ContextOrchestrator([staticProvider]);
    const request: ContextRequest = {
      ...BASE_REQUEST,
      providerWeights: { "static-rules": 0.05 }, // weight × kindWeight(1.0) = 0.05 < 0.1 (MIN_SCORE)
    };
    const bundle = await orch.assemble(request);
    expect(bundle.manifest.includedChunks).toContain("static-rules:rules-md");
    expect(bundle.manifest.excludedChunks.find((c) => c.id === "static-rules:rules-md")).toBeUndefined();
  });

  test("AC5 (with explicit minScore): low weight × low minScore still keeps static in includedChunks", async () => {
    const staticChunk: RawChunk = makeChunk({
      id: "static-rules:r",
      kind: "static",
      scope: "project",
      rawScore: 1.0,
    });
    const staticProvider = makeProvider("static-rules", { chunks: [staticChunk] }, "static");
    const orch = new ContextOrchestrator([staticProvider]);
    const request: ContextRequest = {
      ...BASE_REQUEST,
      minScore: 0.5, // explicitly raised
      providerWeights: { "static-rules": 0.05 },
    };
    const bundle = await orch.assemble(request);
    expect(bundle.manifest.includedChunks).toContain("static-rules:r");
  });
});

describe("orchestrator — neighbor-kind excluded when low weight drops score below minScore (AC6)", () => {
  test("AC6: neighbor chunk whose low weight drops its score below MIN_SCORE is excluded with below-min-score", async () => {
    // neighbor kindWeight = 0.75. rawScore=0.5, weight=0.2 → 0.5 × 0.75 × 0.2 = 0.075 < 0.1.
    const neighborChunk: RawChunk = makeChunk({
      id: "code-neighbor:file-x",
      kind: "neighbor",
      scope: "feature",
      rawScore: 0.5,
    });
    const neighborProvider = makeProvider("code-neighbor", { chunks: [neighborChunk] }, "neighbor");
    const orch = new ContextOrchestrator([neighborProvider]);
    const request: ContextRequest = {
      ...BASE_REQUEST,
      providerWeights: { "code-neighbor": 0.2 },
    };
    const bundle = await orch.assemble(request);
    expect(bundle.manifest.includedChunks).not.toContain("code-neighbor:file-x");
    const excluded = bundle.manifest.excludedChunks.find((c) => c.id === "code-neighbor:file-x");
    expect(excluded).toBeDefined();
    expect(excluded?.reason).toBe("below-min-score");
  });

  test("AC6 (boundary): without low weight, the same chunk stays included", async () => {
    const neighborChunk: RawChunk = makeChunk({
      id: "code-neighbor:file-x",
      kind: "neighbor",
      scope: "feature",
      rawScore: 0.5,
    });
    const neighborProvider = makeProvider("code-neighbor", { chunks: [neighborChunk] }, "neighbor");
    const orch = new ContextOrchestrator([neighborProvider]);
    const bundle = await orch.assemble(BASE_REQUEST);
    // Without weights, score = 0.5 × 0.75 = 0.375 > MIN_SCORE — chunk is included.
    expect(bundle.manifest.includedChunks).toContain("code-neighbor:file-x");
  });
});

describe("orchestrator — undefined vs empty providerWeights produce identical results (AC9)", () => {
  test("AC9: includedChunks and excludedChunks match between undefined and empty weight maps", async () => {
    const chunks: RawChunk[] = [
      makeChunk({ id: "feature-context:f1", kind: "feature", scope: "feature", rawScore: 0.9 }),
      makeChunk({ id: "code-neighbor:n1", kind: "neighbor", scope: "feature", rawScore: 0.5 }),
      makeChunk({ id: "static-rules:s1", kind: "static", scope: "project", rawScore: 0.8 }),
    ];
    const provider = makeProvider("mixed-provider", { chunks }, "feature");

    const orch = new ContextOrchestrator([provider]);
    const withoutWeights = await orch.assemble(BASE_REQUEST);
    const withEmptyWeights = await orch.assemble({ ...BASE_REQUEST, providerWeights: {} });

    expect(withoutWeights.manifest.includedChunks).toEqual(withEmptyWeights.manifest.includedChunks);
    expect(withoutWeights.manifest.excludedChunks).toEqual(withEmptyWeights.manifest.excludedChunks);
  });

  test("AC9 (boundary): even when the request declares an empty map, behaviour matches no map at all", async () => {
    const chunks: RawChunk[] = [
      makeChunk({ id: "feature-context:f1", kind: "feature", scope: "feature", rawScore: 0.4 }),
    ];
    const provider = makeProvider("mixed-provider", { chunks }, "feature");

    const orch = new ContextOrchestrator([provider]);
    const withoutWeights = await orch.assemble(BASE_REQUEST);
    const withEmptyWeights = await orch.assemble({ ...BASE_REQUEST, providerWeights: {} });
    expect(withoutWeights.manifest.includedChunks).toEqual(withEmptyWeights.manifest.includedChunks);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-003 AC-4 — ContextOrchestrator.assemble() emits a warn-level floor-overage
// log carrying storyId, stage, effectiveBudget, and the count of excluded
// non-floor chunks whenever floor chunks pushed the bundle past the effective
// budget.
// ─────────────────────────────────────────────────────────────────────────────

const floorOverageBaseRequest: ContextRequest = {
  storyId: "US-001",
  repoRoot: "/project",
  packageDir: "/project",
  stage: "execution",
  role: "implementer",
  budgetTokens: 10_000,
  providerIds: ["test-provider"],
};

function floorOverageMakeProvider(id: string, result: Partial<ContextProviderResult> = {}): IContextProvider {
  return {
    id,
    kind: "feature",
    fetch: async () => ({
      chunks: [],
      pullTools: [],
      ...result,
    }),
  };
}

function makeChunkResult(overrides: {
  id: string;
  kind?: ChunkKind;
  content?: string;
  tokens?: number;
  rawScore?: number;
}): ContextProviderResult {
  return {
    chunks: [
      {
        id: overrides.id,
        kind: overrides.kind ?? "feature",
        scope: "feature",
        role: ["implementer"],
        content: overrides.content ?? "feature context content",
        tokens: overrides.tokens ?? 200,
        rawScore: overrides.rawScore ?? 1.0,
      },
    ],
    pullTools: [],
  };
}

describe("ContextOrchestrator.assemble() — US-003 floor overage warn log (AC-4)", () => {
  let origGetLogger: typeof _orchestratorDeps.getLogger;
  let mockLogger: MockLogger;

  beforeEach(() => {
    origGetLogger = _orchestratorDeps.getLogger;
    mockLogger = makeLogger();
    _orchestratorDeps.getLogger = () => mockLogger;
  });

  afterEach(() => {
    _orchestratorDeps.getLogger = origGetLogger;
  });

  test("emits warn-level log with storyId/stage/effectiveBudget/excludedNonFloorChunkCount when floor overage occurs", async () => {
    // A 9k feature chunk overflows the conservative 8k ceiling, pushing the bundle past budget.
    // The non-floor guarantee (Ruling 8, #2061c) admits the single 200-token session chunk, so no
    // non-floor chunk is excluded.
    const orch = new ContextOrchestrator([
      floorOverageMakeProvider("test-provider", {
        chunks: [
          {
            id: "feat:big",
            kind: "feature",
            scope: "feature",
            role: ["implementer"],
            content: "x".repeat(36_000),
            tokens: 9_000,
            rawScore: 1.0,
          },
          {
            id: "sess:1",
            kind: "session",
            scope: "feature",
            role: ["implementer"],
            content: "y".repeat(800),
            tokens: 200,
            rawScore: 0.9,
          },
        ],
        pullTools: [],
      }),
    ]);

    await orch.assemble({
      ...floorOverageBaseRequest,
      budgetTokens: 50_000,
      agentId: "some-unknown-agent", // conservative 8k profile — forces floor overage
      providerIds: ["test-provider"],
    });

    const warnCalls = mockLogger.calls.filter((c) => c.level === "warn");
    const floorWarn = warnCalls.find((c) => c.message.includes("floor") || c.stage.includes("floor"));
    assertDefined(floorWarn, "floor warn log call");
    expect(floorWarn.stage).toBe("context-v2");
    const data = floorWarn.data as Record<string, unknown>;
    // storyId is the first key.
    const firstKey = Object.keys(data)[0];
    expect(firstKey).toBe("storyId");
    expect(data.storyId).toBe("US-001");
    expect(data.stage).toBe("execution");
    expect(typeof data.effectiveBudget).toBe("number");
    expect(data.effectiveBudget).toBeGreaterThanOrEqual(0);
    expect(typeof data.excludedNonFloorChunkCount).toBe("number");
    // The guarantee admits the only non-floor candidate, so nothing is excluded.
    expect(data.excludedNonFloorChunkCount).toBe(0);
  });

  test("does NOT emit a floor-overage warn log when floor fits within budget", async () => {
    // Small floor chunks fit; no overage; no floor warn.
    const orch = new ContextOrchestrator([
      floorOverageMakeProvider("p1", makeChunkResult({ id: "feat:1", kind: "feature", tokens: 200, content: "tiny" })),
    ]);

    await orch.assemble({ ...floorOverageBaseRequest, budgetTokens: 10_000, providerIds: ["p1"] });

    const floorWarn = mockLogger.calls
      .filter((c) => c.level === "warn")
      .find((c) => c.message.includes("floor") || c.stage.includes("floor"));
    expect(floorWarn).toBeUndefined();
  });

  test("warn effectiveBudget reflects the post-availableBudgetTokens ceiling minus reserves, not request.budgetTokens or the raw ceiling", async () => {
    // request.budgetTokens = 50_000 but request.availableBudgetTokens = 400 — the caller's
    // remaining-window value is the binding constraint. It must be folded into the ceiling
    // BEFORE the digest/render reserves are subtracted (not passed straight through to
    // packChunks as a second, unreserved ceiling), so the reported effectiveBudget is
    // 400 - DIGEST_RESERVE_TOKENS - FIXED_RENDER_OVERHEAD_TOKENS, not 400 or 50_000. This
    // catches the regression where availableBudgetTokens bypassed every reserve.
    const orch = new ContextOrchestrator([
      floorOverageMakeProvider("test-provider", {
        chunks: [
          {
            id: "feat:1",
            kind: "feature",
            scope: "feature",
            role: ["implementer"],
            content: "x".repeat(1200),
            tokens: 300,
            rawScore: 1.0,
          },
        ],
        pullTools: [],
      }),
    ]);

    await orch.assemble({
      ...floorOverageBaseRequest,
      budgetTokens: 50_000,
      availableBudgetTokens: 400,
      providerIds: ["test-provider"],
    });

    const warnCalls = mockLogger.calls.filter((c) => c.level === "warn");
    const floorWarn = warnCalls.find((c) => c.message.includes("floor") || c.stage.includes("floor"));
    assertDefined(floorWarn, "floor warn log call");
    const data = floorWarn.data as Record<string, unknown>;
    // Single chunk, no prior digest → no separator overhead, no prior-digest reserve.
    const expectedEffectiveBudget = 400 - DIGEST_RESERVE_TOKENS - FIXED_RENDER_OVERHEAD_TOKENS;
    expect(data.effectiveBudget).toBe(expectedEffectiveBudget);
    expect(data.effectiveBudget).toBeLessThan(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// nax#1776 — static-rules floor items silently blow the stage budget.
//
// Floor chunks (`static`, `feature`, `test-coverage` kinds — see
// `FLOOR_KINDS`) bypass packing's budget check entirely, so
// `manifest.usedTokens` can land 2-3x over `manifest.totalBudgetTokens` with
// nothing surfacing it. This pins the `logger.debug` that names the
// responsible floor items and their token cost when that happens.
// ─────────────────────────────────────────────────────────────────────────────

const floorBudgetBaseRequest: ContextRequest = {
  storyId: "US-001",
  repoRoot: "/project",
  packageDir: "/project",
  stage: "tdd-test-writer",
  role: "tdd",
  budgetTokens: 8_000,
  providerIds: ["rules-provider"],
};

const FLOOR_OVERAGE_MESSAGE = "Stage budget exceeded by floor items";

function makeRulesProvider(): IContextProvider {
  return {
    id: "rules-provider",
    kind: "static",
    fetch: async () => ({
      chunks: [
        {
          id: "static-rules:big-rule",
          kind: "static",
          scope: "project",
          role: ["all"],
          content: "x".repeat(88_000),
          tokens: 22_000,
          rawScore: 1.0,
        },
      ],
      pullTools: [],
    }),
  };
}

describe("ContextOrchestrator.assemble() — floor items exceeding totalBudgetTokens (nax#1776)", () => {
  let origGetLogger: typeof _orchestratorDeps.getLogger;
  let mockLogger: MockLogger;

  beforeEach(() => {
    origGetLogger = _orchestratorDeps.getLogger;
    mockLogger = makeLogger();
    _orchestratorDeps.getLogger = () => mockLogger;
  });

  afterEach(() => {
    _orchestratorDeps.getLogger = origGetLogger;
  });

  test("debug-logs, naming the floor item and its token cost, when usedTokens exceeds totalBudgetTokens", async () => {
    const orch = new ContextOrchestrator([makeRulesProvider()]);

    const bundle = await orch.assemble(floorBudgetBaseRequest);

    expect(bundle.manifest.usedTokens).toBeGreaterThan(bundle.manifest.totalBudgetTokens);

    const call = mockLogger.calls.find((c) => c.level === "debug" && c.message === FLOOR_OVERAGE_MESSAGE);
    assertDefined(call, "floor-budget-exceeded debug log call");
    const data = call.data ?? {};
    expect(Object.keys(data)[0]).toBe("storyId");
    expect(data.storyId).toBe("US-001");
    expect(data.stage).toBe("tdd-test-writer");
    expect(data.usedTokens).toBe(bundle.manifest.usedTokens);
    expect(data.totalBudgetTokens).toBe(8_000);
    expect(data.floorOverageCount).toBe(1);
    expect(Array.isArray(data.heaviestFloorItems)).toBe(true);
    expect(data.heaviestFloorItems).toContainEqual({ id: "static-rules:big-rule", tokens: 22_000 });
  });

  test("debug-logs and caps the enumerated overage floor items at 10, heaviest first, but counts them all", async () => {
    // The overage condition holds on nearly every stage of every story and the
    // floor routinely runs to 60+ chunks, so the debug log must not dump the lot.
    const provider: IContextProvider = {
      id: "rules-provider",
      kind: "static",
      fetch: async () => ({
        chunks: Array.from({ length: 25 }, (_, i) => ({
          id: `static-rules:rule-${String(i).padStart(2, "0")}`,
          kind: "static" as const,
          scope: "project" as const,
          role: ["all"] as ["all"],
          content: `### rule-${i}.md\n\nbody`,
          tokens: 1_000 + i,
          rawScore: 1.0,
        })),
        pullTools: [],
      }),
    };
    const orch = new ContextOrchestrator([provider]);

    const bundle = await orch.assemble(floorBudgetBaseRequest);

    const call = mockLogger.calls.find((c) => c.level === "debug" && c.message === FLOOR_OVERAGE_MESSAGE);
    assertDefined(call, "floor-budget-exceeded debug log call");
    const data = call.data ?? {};
    // Ruling 11 attributes overage cumulatively: with budget 8,000 (minus
    // reserves) the walk crosses during the 8th chunk (rule-07, cumulative
    // 8,028), so the overage set is rule-07..rule-24 = 18 chunks — not all 25.
    expect(bundle.manifest.floorOverageItems).toHaveLength(18);
    expect(data.floorOverageCount).toBe(18);
    // Exactly the 10 heaviest of the overage set, heaviest first — rule-24
    // (1024) down to rule-15 (1015).
    expect(data.heaviestFloorItems).toEqual([
      { id: "static-rules:rule-24", tokens: 1024 },
      { id: "static-rules:rule-23", tokens: 1023 },
      { id: "static-rules:rule-22", tokens: 1022 },
      { id: "static-rules:rule-21", tokens: 1021 },
      { id: "static-rules:rule-20", tokens: 1020 },
      { id: "static-rules:rule-19", tokens: 1019 },
      { id: "static-rules:rule-18", tokens: 1018 },
      { id: "static-rules:rule-17", tokens: 1017 },
      { id: "static-rules:rule-16", tokens: 1016 },
      { id: "static-rules:rule-15", tokens: 1015 },
    ]);
  });

  test("debug log carries an occurrence ordinal that tallies repeats for the same story-stage", async () => {
    // Unique story id so the module-level ledger starts fresh for this key —
    // earlier tests reuse "US-001|tdd-test-writer" without asserting the tally.
    const orch = new ContextOrchestrator([makeRulesProvider()]);

    await orch.assemble({ ...floorBudgetBaseRequest, storyId: "US-001-tally" });
    await orch.assemble({ ...floorBudgetBaseRequest, storyId: "US-001-tally" });

    const calls = mockLogger.calls.filter((c) => c.level === "debug" && c.message === FLOOR_OVERAGE_MESSAGE);
    expect(calls).toHaveLength(2);
    expect(calls[0].data?.occurrence).toBe(1);
    expect(calls[1].data?.occurrence).toBe(2);
  });

  test("does not debug-log when floor items fit within totalBudgetTokens", async () => {
    const orch = new ContextOrchestrator([
      {
        id: "rules-provider",
        kind: "static",
        fetch: async () => ({
          chunks: [
            {
              id: "static-rules:small-rule",
              kind: "static",
              scope: "project",
              role: ["all"],
              content: "small rule content",
              tokens: 100,
              rawScore: 1.0,
            },
          ],
          pullTools: [],
        }),
      },
    ]);

    const bundle = await orch.assemble(floorBudgetBaseRequest);

    expect(bundle.manifest.usedTokens).toBeLessThanOrEqual(bundle.manifest.totalBudgetTokens);
    const call = mockLogger.calls.find((c) => c.level === "debug" && c.message === FLOOR_OVERAGE_MESSAGE);
    expect(call).toBeUndefined();
  });
});
