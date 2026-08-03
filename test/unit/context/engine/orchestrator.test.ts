import { describe, test, expect, beforeEach } from "bun:test";
import { ContextOrchestrator, _orchestratorDeps } from "../../../../src/context/engine/orchestrator";
import { QUERY_NEIGHBOR_DESCRIPTOR, QUERY_FEATURE_CONTEXT_DESCRIPTOR } from "../../../../src/context/engine/pull-tools";
import { NeutralityLintError } from "@/context";
import type { ContextRequest, IContextProvider, ContextProviderResult } from "../../../../src/context/engine/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

let _reqSeq = 0;
beforeEach(() => {
  _reqSeq = 0;
  _orchestratorDeps.uuid = () => `test-uuid-${++_reqSeq}` as `${string}-${string}-${string}-${string}-${string}`;
  _orchestratorDeps.now = () => Date.now();
});

const BASE_REQUEST: ContextRequest = {
  storyId: "US-001",
  repoRoot: "/project",
  packageDir: "/project",
  stage: "execution",
  role: "implementer",
  budgetTokens: 10_000,
  // Bypass stage-config provider filtering for test isolation.
  // Tests that verify providerIds filtering override this explicitly.
  providerIds: ["p1", "p2", "test-provider", "timeout-sim", "good"],
};

function makeProvider(id: string, result: Partial<ContextProviderResult> = {}): IContextProvider {
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
  content?: string;
  tokens?: number;
  rawScore?: number;
  role?: ("implementer" | "reviewer" | "tdd" | "all")[];
} = { id: "chunk:abc" }): ContextProviderResult {
  return {
    chunks: [{
      id: overrides.id,
      kind: "feature",
      scope: "feature",
      role: overrides.role ?? ["implementer"],
      content: overrides.content ?? "feature context content",
      tokens: overrides.tokens ?? 200,
      rawScore: overrides.rawScore ?? 1.0,
    }],
    pullTools: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// assemble()
// ─────────────────────────────────────────────────────────────────────────────

describe("ContextOrchestrator.assemble()", () => {
  test("no providers: returns empty bundle", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble(BASE_REQUEST);
    expect(bundle.pushMarkdown).toBe("");
    expect(bundle.digest).toBe("");
    expect(bundle.chunks).toHaveLength(0);
    expect(bundle.manifest.includedChunks).toHaveLength(0);
  });

  test("provider with chunks: bundle has pushMarkdown, digest, and manifest records chunk ID", async () => {
    const provider = makeProvider("test-provider", makeChunkResult({ id: "c:1" }));
    const orch = new ContextOrchestrator([provider]);
    const bundle = await orch.assemble(BASE_REQUEST);
    expect(bundle.pushMarkdown).toContain("feature context content");
    expect(bundle.digest).toBeTruthy();
    expect(bundle.chunks).toHaveLength(1);
    expect(bundle.manifest.includedChunks).toContain("c:1");
  });

  test("manifest records each packed chunk's token cost (#1421)", async () => {
    // Without this the curator can only record tokens:0 for every chunk, and the
    // context budget cannot be tuned against real data.
    // Distinct content per chunk — identical content is deduped before packing.
    const orch = new ContextOrchestrator([
      makeProvider("p1", makeChunkResult({ id: "c:1", tokens: 412, content: "alpha content" })),
      makeProvider("p2", makeChunkResult({ id: "c:2", tokens: 1180, content: "beta content" })),
    ]);
    const bundle = await orch.assemble(BASE_REQUEST);
    expect(bundle.manifest.chunkTokens).toEqual({ "c:1": 412, "c:2": 1180 });
  });

  test("chunkTokens covers exactly the included chunks and sums to usedTokens minus the prior-stage digest", async () => {
    // US-001 corrected accounting:
    //   manifest.usedTokens = packed chunk tokens + priorStageDigest tokens
    //   manifest.digestTokens = produced digest (this stage, threaded forward)
    // BASE_REQUEST supplies no priorStageDigest, so the prior-digest token count is 0.
    const orch = new ContextOrchestrator([
      makeProvider("p1", makeChunkResult({ id: "c:1", tokens: 300, content: "alpha content" })),
      makeProvider("p2", makeChunkResult({ id: "c:2", tokens: 700, content: "beta content" })),
    ]);
    const bundle = await orch.assemble(BASE_REQUEST);
    const tokenMap = bundle.manifest.chunkTokens ?? {};
    expect(bundle.manifest.includedChunks).toHaveLength(2);
    expect(Object.keys(tokenMap).sort()).toEqual([...bundle.manifest.includedChunks].sort());
    const summed = Object.values(tokenMap).reduce((a, b) => a + b, 0);
    // The new invariant: summed = usedTokens - priorDigestTokens. BASE_REQUEST
    // has no priorStageDigest, so priorDigestTokens = 0 and summed === usedTokens.
    const priorDigestTokens = 0;
    expect(summed).toBe(bundle.manifest.usedTokens - priorDigestTokens);
  });

  test("manifest omits chunkTokens when nothing was packed", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble(BASE_REQUEST);
    expect(bundle.manifest.chunkTokens).toBeUndefined();
  });

  test("role-filtered chunks excluded and recorded in manifest", async () => {
    const provider = makeProvider("p1", makeChunkResult({
      id: "reviewer:chunk",
      role: ["reviewer"],
    }));
    const orch = new ContextOrchestrator([provider]);
    const bundle = await orch.assemble({ ...BASE_REQUEST, role: "implementer" });
    expect(bundle.chunks).toHaveLength(0);
    const excluded = bundle.manifest.excludedChunks.find((c) => c.id === "reviewer:chunk");
    expect(excluded?.reason).toBe("role-filter");
  });

  test("provider timeout: failed provider returns empty, does not throw", async () => {
    // Simulate a provider that throws (mirrors timeout behavior in the orchestrator)
    const timeoutProvider: IContextProvider = {
      id: "timeout-sim",
      kind: "feature",
      fetch: async () => { throw new Error("simulated timeout"); },
    };
    const goodProvider = makeProvider("good", makeChunkResult({ id: "good:1" }));
    const orch = new ContextOrchestrator([timeoutProvider, goodProvider]);
    const bundle = await orch.assemble(BASE_REQUEST);
    // Good provider still works
    expect(bundle.chunks.some((c) => c.id === "good:1")).toBe(true);
  });

  test("NeutralityLintError from a rules provider aborts assembly instead of silently dropping rules", async () => {
    // A neutrality-lint failure is special: proceeding means the run gets
    // zero rules chunks, silently. This must abort assemble() so callers
    // (stage-assembler.ts / pipeline/stages/context.ts) can fall back to the
    // v1 context path instead of continuing ruleless in v2.
    const failingRules: IContextProvider = {
      id: "static-rules",
      kind: "static",
      fetch: async () => {
        throw new NeutralityLintError([{ file: "x.md", lineNumber: 1, line: "IMPORTANT:", ruleId: "important-shouting", pattern: "shouting-style IMPORTANT:" }]);
      },
    };
    const goodProvider = makeProvider("good", makeChunkResult({ id: "good:1" }));
    const orch = new ContextOrchestrator([failingRules, goodProvider]);
    await expect(
      orch.assemble({ ...BASE_REQUEST, providerIds: [...(BASE_REQUEST.providerIds ?? []), "static-rules"] }),
    ).rejects.toThrow(NeutralityLintError);
  });

  test("a non-lint error (e.g. timeout) from a static-kind provider still soft-skips like any other provider", async () => {
    // Escalation is scoped to NeutralityLintError specifically, not to
    // `kind: "static"` generally — a static provider timeout or transient
    // I/O error should degrade gracefully, not take down the whole bundle.
    const flakyRules: IContextProvider = {
      id: "static-rules",
      kind: "static",
      fetch: async () => { throw new Error("simulated I/O error"); },
    };
    const goodProvider = makeProvider("good", makeChunkResult({ id: "good:1" }));
    const orch = new ContextOrchestrator([flakyRules, goodProvider]);
    const bundle = await orch.assemble({
      ...BASE_REQUEST,
      providerIds: [...(BASE_REQUEST.providerIds ?? []), "static-rules"],
    });
    expect(bundle.chunks.some((c) => c.id === "good:1")).toBe(true);
  });

  test("providerIds filter restricts which providers fetch", async () => {
    const p1 = makeProvider("p1", makeChunkResult({ id: "p1:chunk" }));
    const p2 = makeProvider("p2", makeChunkResult({ id: "p2:chunk" }));
    const orch = new ContextOrchestrator([p1, p2]);
    const bundle = await orch.assemble({ ...BASE_REQUEST, providerIds: ["p1"] });
    const ids = bundle.chunks.map((c) => c.id);
    expect(ids).toContain("p1:chunk");
    expect(ids).not.toContain("p2:chunk");
  });

  test("priorStageDigest is prepended to pushMarkdown", async () => {
    const provider = makeProvider("p1", makeChunkResult({ id: "c:1" }));
    const orch = new ContextOrchestrator([provider]);
    const bundle = await orch.assemble({
      ...BASE_REQUEST,
      priorStageDigest: "Prior stage found X.",
    });
    expect(bundle.pushMarkdown).toContain("## Prior Stage Summary");
    expect(bundle.pushMarkdown).toContain("Prior stage found X.");
  });

  test("manifest stage matches request.stage; pullTools is empty when pullConfig is absent", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({ ...BASE_REQUEST, stage: "review" });
    expect(bundle.manifest.stage).toBe("review");
    const bundle2 = await orch.assemble(BASE_REQUEST);
    expect(bundle2.pullTools).toEqual([]);
  });

  test("test-coverage chunks are floor-included when score is below minScore", async () => {
    // AC6: test-coverage kind is always packed regardless of score (budget floor wins)
    const provider = makeProvider("p1", {
      chunks: [{
        id: "tc:1",
        kind: "test-coverage" as const,
        scope: "feature",
        role: ["implementer"],
        content: "coverage data",
        tokens: 200,
        rawScore: 0.05,
      }],
      pullTools: [],
    });
    const orch = new ContextOrchestrator([provider]);
    const bundle = await orch.assemble({
      ...BASE_REQUEST,
      providerIds: ["p1"],
      minScore: 0.1,
    });
    expect(bundle.chunks.some((c) => c.id === "tc:1")).toBe(true);
    expect(bundle.manifest.floorItems).toContain("tc:1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Agent profile gates (AC-32, AC-33)
// ─────────────────────────────────────────────────────────────────────────────

describe("ContextOrchestrator.assemble() — agent profile ceiling (AC-32)", () => {
  test("claude profile (16k) overflows on a 20k feature chunk despite 50k stage budget", async () => {
    const bigChunk = makeChunkResult({ id: "fc:1", content: "a".repeat(80_000), tokens: 20_000 });
    const provider = makeProvider("test-provider", bigChunk);
    const orch = new ContextOrchestrator([provider]);

    const bundle = await orch.assemble({
      ...BASE_REQUEST,
      budgetTokens: 50_000,
      agentId: "claude",
    });
    expect(bundle.manifest.totalBudgetTokens).toBe(50_000);
    // The agent-profile ceiling (16k) forces floor overage on a 20k feature chunk,
    // which would fit under a naive 50k stage budget.
    expect(bundle.manifest.floorOverageItems).toBeDefined();
    expect(bundle.manifest.floorOverageItems?.length).toBeGreaterThan(0);
  });

  test("unknown agent id falls back to 8k conservative ceiling", async () => {
    const chunk = makeChunkResult({ id: "fc:1", content: "a".repeat(36_000), tokens: 9_000 });
    const provider = makeProvider("test-provider", chunk);
    const orch = new ContextOrchestrator([provider]);

    const bundle = await orch.assemble({
      ...BASE_REQUEST,
      budgetTokens: 50_000,
      agentId: "some-unknown-agent",
    });
    // Conservative profile is 8k; feature chunk of 9k tokens overflows.
    expect(bundle.manifest.floorOverageItems?.length).toBeGreaterThan(0);
  });

  test("stage budget wins when smaller than profile ceiling", async () => {
    const chunk = makeChunkResult({ id: "fc:1", tokens: 500 });
    const provider = makeProvider("test-provider", chunk);
    const orch = new ContextOrchestrator([provider]);

    const bundle = await orch.assemble({
      ...BASE_REQUEST,
      budgetTokens: 1_000, // smaller than 8k conservative and 16k claude
      agentId: "claude",
    });
    // No overage: 500 fits in 1k
    expect(bundle.manifest.floorOverageItems).toBeUndefined();
  });
});

describe("ContextOrchestrator.assemble() — pull tool capability gate (AC-33)", () => {
  test("conservative profile (unknown agent) surfaces 0 pull tools; claude profile surfaces configured pull tools", async () => {
    const base = { ...BASE_REQUEST, stage: "tdd-test-writer" as const, providerIds: [], pullConfig: { enabled: true, allowedTools: [] as string[], maxCallsPerSession: 5 } };
    const conservative = await new ContextOrchestrator([]).assemble({ ...base, agentId: "some-unknown-agent" });
    expect(conservative.pullTools).toHaveLength(0);
    const claudeBundle = await new ContextOrchestrator([]).assemble({ ...base, agentId: "claude" });
    expect(claudeBundle.pullTools.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rebuildForAgent()
// ─────────────────────────────────────────────────────────────────────────────

describe("ContextOrchestrator.rebuildForAgent()", () => {
  test("re-renders same chunks without fetching providers", async () => {
    let fetchCount = 0;
    const provider: IContextProvider = {
      id: "p1",
      kind: "feature",
      fetch: async () => { fetchCount++; return makeChunkResult({ id: "c:1" }); },
    };
    const orch = new ContextOrchestrator([provider]);
    const original = await orch.assemble(BASE_REQUEST);
    expect(fetchCount).toBe(1);

    const rebuilt = orch.rebuildForAgent(original);
    expect(fetchCount).toBe(1); // no additional fetch
    expect(rebuilt.chunks.map((c) => c.id)).toEqual(original.chunks.map((c) => c.id));
  });

  test("rebuilt bundle has updated priorStageDigest and new requestId", async () => {
    const provider = makeProvider("p1", makeChunkResult({ id: "c:1" }));
    const orch = new ContextOrchestrator([provider]);
    const original = await orch.assemble(BASE_REQUEST);
    const rebuilt = orch.rebuildForAgent(original, { priorStageDigest: "Updated prior digest." });
    expect(rebuilt.pushMarkdown).toContain("Updated prior digest.");
    expect(rebuilt.manifest.requestId).not.toBe(original.manifest.requestId);
  });
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
    const tool = bundle.pullTools[0]!;
    expect(typeof tool.name).toBe("string");
    expect(typeof tool.description).toBe("string");
    expect(typeof tool.inputSchema).toBe("object");
    expect(typeof tool.maxCallsPerSession).toBe("number");
    expect(typeof tool.maxTokensPerCall).toBe("number");
    expect(tool.maxCallsPerSession).toBe(3);
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

  test.each(["review-semantic", "review-adversarial"] as const)("%s with pullConfig enabled returns query_feature_context", async (stage) => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({
      ...REVIEW_REQUEST,
      stage,
      pullConfig: { enabled: true, allowedTools: [], maxCallsPerSession: 5 },
    });
    expect(bundle.pullTools).toHaveLength(1);
    expect(bundle.pullTools[0]?.name).toBe(QUERY_FEATURE_CONTEXT_DESCRIPTOR.name);
  });

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
      storyId: "US-001", repoRoot: "/project", packageDir: "/project",
      stage: "tdd-implementer", role: "implementer", budgetTokens: 8_000, providerIds: [],
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
// AC-54 / AC-60 / AC-61 — dual workdir fields (repoRoot + packageDir)
// ─────────────────────────────────────────────────────────────────────────────

describe("ContextOrchestrator — repoRoot + packageDir (Amendment C AC-54/AC-60/AC-61)", () => {
  test("AC-54/AC-60/AC-61: manifest records repoRoot+packageDir for monorepo and non-monorepo", async () => {
    // Monorepo: packageDir differs from repoRoot
    const monoBundle = await new ContextOrchestrator([]).assemble({
      storyId: "US-001", repoRoot: "/repo", packageDir: "/repo/packages/api",
      stage: "execution", role: "implementer", budgetTokens: 4_000, providerIds: [],
    });
    expect(monoBundle.manifest.repoRoot).toBe("/repo");
    expect(monoBundle.manifest.packageDir).toBe("/repo/packages/api");

    // Non-monorepo: packageDir equals repoRoot
    const provider = makeProvider("p1", makeChunkResult({ id: "chunk:nm" }));
    const singleBundle = await new ContextOrchestrator([provider]).assemble({
      storyId: "US-001", repoRoot: "/repo", packageDir: "/repo",
      stage: "execution", role: "implementer", budgetTokens: 4_000, providerIds: ["p1"],
    });
    expect(singleBundle.manifest.repoRoot).toBe("/repo");
    expect(singleBundle.manifest.packageDir).toBe("/repo");
    expect(singleBundle.chunks.some((c) => c.id === "chunk:nm")).toBe(true);
  });

  test("AC-60: rebuildForAgent preserves repoRoot and packageDir from prior manifest", async () => {
    const orch = new ContextOrchestrator([]);
    const prior = await orch.assemble({
      storyId: "US-001",
      repoRoot: "/repo",
      packageDir: "/repo/packages/web",
      stage: "execution",
      role: "implementer",
      budgetTokens: 4_000,
      providerIds: [],
    });
    const rebuilt = orch.rebuildForAgent(prior, { newAgentId: "codex" });
    expect(rebuilt.manifest.repoRoot).toBe("/repo");
    expect(rebuilt.manifest.packageDir).toBe("/repo/packages/web");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-001 — context-budget arithmetic
// ─────────────────────────────────────────────────────────────────────────────

describe("US-001 — ContextOrchestrator budget arithmetic", () => {
  test("AC-5: packed non-floor chunks total ≤ stage budget − DIGEST_RESERVE_TOKENS", async () => {
    // Mix floor (static + feature) with non-floor (session + history) chunks so the
    // orchestrator's reserve subtraction has a non-floor cap to test.
    const FLOOR_KIND = "static";
    const orch = new ContextOrchestrator([
      makeProvider("p1", makeChunkResult({ id: "floor:1", kind: FLOOR_KIND, tokens: 500, content: "rules content a" })),
      makeProvider("p2", makeChunkResult({ id: "floor:2", kind: "feature", tokens: 500, content: "rules content b" })),
      makeProvider("p3", makeChunkResult({ id: "non-floor:1", kind: "session", tokens: 400, content: "sess content a" })),
      makeProvider("p4", makeChunkResult({ id: "non-floor:2", kind: "history", tokens: 400, content: "hist content a" })),
      makeProvider("p5", makeChunkResult({ id: "non-floor:3", kind: "session", tokens: 400, content: "sess content b" })),
    ]);
    const stageBudget = 2_000;
    const bundle = await orch.assemble({ ...BASE_REQUEST, budgetTokens: stageBudget });
    const nonFloorPacked = bundle.chunks
      .filter((c) => c.kind !== "static" && c.kind !== "feature" && c.kind !== "test-coverage")
      .reduce((sum, c) => sum + c.tokens, 0);
    // Reserve = Math.ceil(MAX_DIGEST_CHARS / 4) ≈ 250 tokens. Floor uses 1000 of
    // 2000; remaining ceiling is 1000 - DIGEST_RESERVE_TOKENS. Packing a 400-token
    // chunk three times (1200) would exceed 2000 - DIGEST_RESERVE_TOKENS, so the
    // non-floor total must be capped at 2000 - DIGEST_RESERVE_TOKENS.
    const { DIGEST_RESERVE_TOKENS } = await import("@/context");
    expect(nonFloorPacked).toBeLessThanOrEqual(stageBudget - DIGEST_RESERVE_TOKENS);
  });

  test("AC-6: manifest.usedTokens equals packed chunk tokens plus priorStageDigest tokens", async () => {
    const orch = new ContextOrchestrator([
      makeProvider("p1", makeChunkResult({ id: "c:1", tokens: 300, content: "alpha content" })),
      makeProvider("p2", makeChunkResult({ id: "c:2", tokens: 700, content: "beta content" })),
    ]);
    const priorDigest = "Prior stage summary line.";
    const expectedPriorDigestTokens = Math.ceil(priorDigest.length / 4);
    const bundle = await orch.assemble({ ...BASE_REQUEST, priorStageDigest: priorDigest });
    const tokenMap = bundle.manifest.chunkTokens ?? {};
    const packedSum = Object.values(tokenMap).reduce((a, b) => a + b, 0);
    expect(bundle.manifest.usedTokens).toBe(packedSum + expectedPriorDigestTokens);
  });

  test("AC-7: rendered markdown estimated token count does not exceed request.budgetTokens when no floor overflows", async () => {
    // Small chunks with no floor overage: rendered push markdown must fit within
    // the stage budget (the digest reserve is subtracted before packing, and
    // nothing floor-overflows here, so the rendered output stays within budget).
    const orch = new ContextOrchestrator([
      makeProvider("p1", makeChunkResult({ id: "floor:1", kind: "static", tokens: 200, content: "rules short" })),
      makeProvider("p2", makeChunkResult({ id: "feat:1", kind: "feature", tokens: 200, content: "feature short" })),
      makeProvider("p3", makeChunkResult({ id: "sess:1", kind: "session", tokens: 200, content: "session short" })),
    ]);
    const stageBudget = 5_000;
    const bundle = await orch.assemble({ ...BASE_REQUEST, budgetTokens: stageBudget });
    // No floor overflow → no floorOverageItems.
    expect(bundle.manifest.floorOverageItems ?? []).toEqual([]);
    const renderedTokens = Math.ceil(bundle.pushMarkdown.length / 4);
    expect(renderedTokens).toBeLessThanOrEqual(stageBudget);
  });

  test("AC-7: rendered markdown stays within budget under tight stage budgets with full prior digest", async () => {
    // Tight stage budget with a full prior digest: the rendered markdown (which
    // includes the prior heading, the prior digest body, scope headers, and chunk
    // content) must still fit within the stage budget when no floor overflows.
    // Catches the gap where only DIGEST_RESERVE was subtracted (the markdown
    // framing overhead — prior heading + scope headers — was not reserved).
    //
    // Scenario: stageBudget fits the prior digest (250 tokens), the digest this
    // stage produces (250 tokens), markdown framing overhead, and one non-floor
    // chunk. Without the prior-digest and overhead reserves, the rendered output
    // exceeds the stage budget.
    const priorDigest = "x".repeat(1_000); // full MAX_DIGEST_CHARS digest
    // Session-kind chunk (NOT a floor kind) sized to consume the remaining ceiling.
    const sessionProvider: IContextProvider = {
      id: "p3",
      kind: "feature",
      fetch: async () => ({
        chunks: [
          {
            id: "sess:1",
            kind: "session",
            scope: "feature",
            role: ["implementer"],
            content: "z".repeat(840),
            tokens: 210,
            rawScore: 0.9,
          },
        ],
        pullTools: [],
      }),
    };
    const orch = new ContextOrchestrator([
      makeProvider("p1", makeChunkResult({ id: "floor:1", kind: "static", tokens: 20, content: "x".repeat(80) })),
      makeProvider("p2", makeChunkResult({ id: "feat:1", kind: "feature", tokens: 20, content: "y".repeat(80) })),
      sessionProvider,
    ]);
    // Budget large enough to fit prior (250) + digest reserve (250) + framing
    // overhead (~136) + floor (40) + non-floor chunk (210) = ~886. Use 1000 to
    // give the chunk room and still test the tight case.
    const stageBudget = 1_000;
    const bundle = await orch.assemble({
      ...BASE_REQUEST,
      budgetTokens: stageBudget,
      priorStageDigest: priorDigest,
      providerIds: ["p1", "p2", "p3"],
    });
    expect(bundle.manifest.floorOverageItems ?? []).toEqual([]);
    const renderedTokens = Math.ceil(bundle.pushMarkdown.length / 4);
    expect(renderedTokens).toBeLessThanOrEqual(stageBudget);
  });

  test("AC-7: per-chunk separator overhead is reserved so rendered fits with many same-scope chunks", async () => {
    // Catches the gap where per-chunk separators (\n\n---\n\n between chunks in the
    // same scope) were not reserved. With many small chunks in one scope, the
    // accumulated separator length pushes the rendered markdown over the budget
    // even when packed chunk tokens fit. The reserve must scale with the packing
    // budget so this stays in budget.
    const priorDigest = "x".repeat(1_000);
    // 60 small session chunks in one scope (5 tokens each) → 59 intra-scope
    // separators × 7 chars = 413 chars ≈ 104 tokens of separator overhead on top
    // of packed chunk content and the prior digest.
    const smallChunks = Array.from({ length: 60 }, (_, i) => ({
      id: `sess:${i}`,
      kind: "session" as const,
      scope: "feature" as const,
      role: ["implementer"] as ("implementer")[],
      content: `chunk ${i} bytes ${String.fromCharCode(65 + (i % 26)).repeat(8 + (i % 3))}`,
      tokens: 5,
      rawScore: 0.9 - i * 0.005,
    }));
    const orch = new ContextOrchestrator([
      makeProvider("p1", makeChunkResult({ id: "floor:1", kind: "static", tokens: 10, content: "rules" })),
      { id: "p3", kind: "feature", fetch: async () => ({ chunks: smallChunks, pullTools: [] }) } as IContextProvider,
    ]);
    // Budget sized so prior (250) + digest reserve (250) + framing overhead
    // (~200) + floor (10) + enough non-floor room for many small chunks fits.
    const stageBudget = 1_500;
    const bundle = await orch.assemble({
      ...BASE_REQUEST,
      budgetTokens: stageBudget,
      priorStageDigest: priorDigest,
      providerIds: ["p1", "p3"],
    });
    expect(bundle.manifest.floorOverageItems ?? []).toEqual([]);
    const renderedTokens = Math.ceil(bundle.pushMarkdown.length / 4);
    expect(renderedTokens).toBeLessThanOrEqual(stageBudget);
  });

  test("AC-7: prior-stage digest tokens are reserved from the effective budget (accurate separator overhead)", async () => {
    // The prior-stage digest (250 tokens when full) is subtracted from the effective
    // budget alongside the digest reserve and fixed framing overhead. The per-chunk
    // separator overhead is computed from the ACTUAL kept chunks after min-score
    // filtering (not an assumed minimum), so only 2 chunks in one scope → 2 token
    // separator reserve. With a stage budget of 1000 and the actual overhead, the
    // non-floor session chunk fits, and the rendered markdown stays within budget.
    const priorDigest = "x".repeat(1_000); // full MAX_DIGEST_CHARS digest (250 tokens)
    // Session chunk at 300 tokens fits: prior (250) + digest-reserve (250) + fixed
    // framing (50) + separator overhead (2) + floor (40) + session (300) = 892,
    // leaving 108 tokens of headroom below the 1000-token stage budget.
    const sessionProvider: IContextProvider = {
      id: "p3",
      kind: "feature",
      fetch: async () => ({
        chunks: [
          {
            id: "sess:1",
            kind: "session",
            scope: "feature",
            role: ["implementer"],
            content: "z".repeat(1_200),  // ~300 tokens
            tokens: 300,
            rawScore: 0.9,
          },
        ],
        pullTools: [],
      }),
    };
    const orch = new ContextOrchestrator([
      makeProvider("p1", makeChunkResult({ id: "floor:1", kind: "static", tokens: 20, content: "x".repeat(80) })),
      makeProvider("p2", makeChunkResult({ id: "feat:1", kind: "feature", tokens: 20, content: "y".repeat(80) })),
      sessionProvider,
    ]);
    const stageBudget = 1_000;
    const bundle = await orch.assemble({
      ...BASE_REQUEST,
      budgetTokens: stageBudget,
      priorStageDigest: priorDigest,
      providerIds: ["p1", "p2", "p3"],
    });
    expect(bundle.manifest.floorOverageItems ?? []).toEqual([]);
    // With accurate (actual-chunk) separator overhead the session chunk fits.
    expect(bundle.chunks.some((c) => c.id === "sess:1")).toBe(true);
    // Rendered markdown (in tokens) does not exceed the stage budget.
    const renderedTokens = Math.ceil(bundle.pushMarkdown.length / 4);
    expect(renderedTokens).toBeLessThanOrEqual(stageBudget);
  });
});
