import { describe, test, expect, beforeEach } from "bun:test";
import { ContextOrchestrator, _orchestratorDeps } from "../../../../src/context/engine/orchestrator";
import { QUERY_NEIGHBOR_DESCRIPTOR, QUERY_FEATURE_CONTEXT_DESCRIPTOR } from "../../../../src/context/engine/pull-tools";
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
  workdir: "/project",
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

  test("provider with chunks: bundle has pushMarkdown and digest", async () => {
    const provider = makeProvider("test-provider", makeChunkResult({ id: "c:1" }));
    const orch = new ContextOrchestrator([provider]);
    const bundle = await orch.assemble(BASE_REQUEST);
    expect(bundle.pushMarkdown).toContain("feature context content");
    expect(bundle.digest).toBeTruthy();
    expect(bundle.chunks).toHaveLength(1);
  });

  test("manifest records included chunk IDs", async () => {
    const provider = makeProvider("p1", makeChunkResult({ id: "chunk:abc" }));
    const orch = new ContextOrchestrator([provider]);
    const bundle = await orch.assemble(BASE_REQUEST);
    expect(bundle.manifest.includedChunks).toContain("chunk:abc");
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

  test("manifest stage matches request.stage", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({ ...BASE_REQUEST, stage: "review" });
    expect(bundle.manifest.stage).toBe("review");
  });

  test("pullTools is empty when pullConfig is absent", async () => {
    // Phase 4: provider-level pullTools are no longer aggregated;
    // descriptors come from PULL_TOOL_REGISTRY via stage config.
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble(BASE_REQUEST); // BASE_REQUEST has no pullConfig
    expect(bundle.pullTools).toEqual([]);
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
      fetch: async () => {
        fetchCount++;
        return makeChunkResult({ id: "c:1" });
      },
    };
    const orch = new ContextOrchestrator([provider]);
    const original = await orch.assemble(BASE_REQUEST);
    expect(fetchCount).toBe(1);

    const rebuilt = orch.rebuildForAgent(original);
    // No additional fetch
    expect(fetchCount).toBe(1);
    // Same chunks
    expect(rebuilt.chunks).toHaveLength(original.chunks.length);
  });

  test("rebuilt bundle has same chunks as original", async () => {
    const provider = makeProvider("p1", makeChunkResult({ id: "chunk:xyz" }));
    const orch = new ContextOrchestrator([provider]);
    const original = await orch.assemble(BASE_REQUEST);
    const rebuilt = orch.rebuildForAgent(original);
    expect(rebuilt.chunks.map((c) => c.id)).toEqual(original.chunks.map((c) => c.id));
  });

  test("priorStageDigest updated in rebuilt pushMarkdown", async () => {
    const provider = makeProvider("p1", makeChunkResult({ id: "c:1" }));
    const orch = new ContextOrchestrator([provider]);
    const original = await orch.assemble(BASE_REQUEST);
    const rebuilt = orch.rebuildForAgent(original, { priorStageDigest: "Updated prior digest." });
    expect(rebuilt.pushMarkdown).toContain("Updated prior digest.");
  });

  test("rebuilt manifest has a new requestId", async () => {
    const provider = makeProvider("p1", makeChunkResult({ id: "c:1" }));
    const orch = new ContextOrchestrator([provider]);
    const original = await orch.assemble(BASE_REQUEST);
    const rebuilt = orch.rebuildForAgent(original);
    expect(rebuilt.manifest.requestId).not.toBe(original.manifest.requestId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4: pull tools
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 4: pull tools", () => {
  const TDD_IMPLEMENTER_REQUEST: ContextRequest = {
    storyId: "US-001",
    workdir: "/project",
    stage: "tdd-implementer",
    role: "implementer",
    budgetTokens: 8_000,
    providerIds: [],
  };

  test("pullTools is empty when pullConfig is absent", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({ ...TDD_IMPLEMENTER_REQUEST, pullConfig: undefined });
    expect(bundle.pullTools).toEqual([]);
  });

  test("pullTools is empty when pullConfig.enabled is false", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({
      ...TDD_IMPLEMENTER_REQUEST,
      pullConfig: { enabled: false, allowedTools: [], maxCallsPerSession: 5 },
    });
    expect(bundle.pullTools).toEqual([]);
  });

  test("pullTools contains query_neighbor descriptor for tdd-implementer when enabled", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({
      ...TDD_IMPLEMENTER_REQUEST,
      pullConfig: { enabled: true, allowedTools: [], maxCallsPerSession: 5 },
    });
    expect(bundle.pullTools).toHaveLength(1);
    expect(bundle.pullTools[0]?.name).toBe("query_neighbor");
  });

  test("pullTools items are ToolDescriptor objects with required fields", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({
      ...TDD_IMPLEMENTER_REQUEST,
      pullConfig: { enabled: true, allowedTools: [], maxCallsPerSession: 5 },
    });
    const tool = bundle.pullTools[0]!;
    expect(typeof tool.name).toBe("string");
    expect(typeof tool.description).toBe("string");
    expect(typeof tool.inputSchema).toBe("object");
    expect(typeof tool.maxCallsPerSession).toBe("number");
    expect(typeof tool.maxTokensPerCall).toBe("number");
  });

  test("maxCallsPerSession on descriptor reflects pullConfig override", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({
      ...TDD_IMPLEMENTER_REQUEST,
      pullConfig: { enabled: true, allowedTools: [], maxCallsPerSession: 3 },
    });
    expect(bundle.pullTools[0]?.maxCallsPerSession).toBe(3);
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

  test("empty allowedTools means all stage-configured tools are allowed", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({
      ...TDD_IMPLEMENTER_REQUEST,
      pullConfig: { enabled: true, allowedTools: [], maxCallsPerSession: 5 },
    });
    expect(bundle.pullTools.length).toBeGreaterThan(0);
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
    workdir: "/project",
    stage: "review-semantic",
    role: "reviewer",
    budgetTokens: 6_000,
    providerIds: [],
  };

  test("review-semantic with pullConfig enabled returns query_feature_context", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({
      ...REVIEW_REQUEST,
      pullConfig: { enabled: true, allowedTools: [], maxCallsPerSession: 5 },
    });
    expect(bundle.pullTools).toHaveLength(1);
    expect(bundle.pullTools[0]?.name).toBe("query_feature_context");
  });

  test("review-adversarial with pullConfig enabled returns query_feature_context", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({
      ...REVIEW_REQUEST,
      stage: "review-adversarial",
      pullConfig: { enabled: true, allowedTools: [], maxCallsPerSession: 5 },
    });
    expect(bundle.pullTools).toHaveLength(1);
    expect(bundle.pullTools[0]?.name).toBe("query_feature_context");
  });

  test("review-semantic pull tool descriptor matches QUERY_FEATURE_CONTEXT_DESCRIPTOR name", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({
      ...REVIEW_REQUEST,
      pullConfig: { enabled: true, allowedTools: [], maxCallsPerSession: 5 },
    });
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

  test("tdd-implementer stage does not return query_feature_context", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({
      storyId: "US-001",
      workdir: "/project",
      stage: "tdd-implementer",
      role: "implementer",
      budgetTokens: 8_000,
      providerIds: [],
      pullConfig: { enabled: true, allowedTools: [], maxCallsPerSession: 5 },
    });
    const names = bundle.pullTools.map((t) => t.name);
    expect(names).not.toContain("query_feature_context");
  });

  test("review-semantic does not return query_neighbor", async () => {
    const orch = new ContextOrchestrator([]);
    const bundle = await orch.assemble({
      ...REVIEW_REQUEST,
      pullConfig: { enabled: true, allowedTools: [], maxCallsPerSession: 5 },
    });
    const names = bundle.pullTools.map((t) => t.name);
    expect(names).not.toContain("query_neighbor");
  });
});
