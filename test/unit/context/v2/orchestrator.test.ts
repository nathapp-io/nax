import { describe, test, expect, beforeEach } from "bun:test";
import { ContextOrchestrator, _orchestratorDeps } from "../../../../src/context/v2/orchestrator";
import type { ContextRequest, IContextProvider, ContextProviderResult } from "../../../../src/context/v2/types";

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

  test("pullTools aggregated from all providers", async () => {
    const p1: IContextProvider = {
      id: "p1",
      kind: "feature",
      fetch: async () => ({ chunks: [], pullTools: ["query_feature_context"] }),
    };
    const p2: IContextProvider = {
      id: "p2",
      kind: "rag",
      fetch: async () => ({ chunks: [], pullTools: ["query_rag"] }),
    };
    const orch = new ContextOrchestrator([p1, p2]);
    const bundle = await orch.assemble(BASE_REQUEST);
    expect(bundle.pullTools).toContain("query_feature_context");
    expect(bundle.pullTools).toContain("query_rag");
    // Deduplicated
    expect(bundle.pullTools.length).toBe(new Set(bundle.pullTools).size);
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
    const rebuilt = orch.rebuildForAgent(original, "Updated prior digest.");
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
