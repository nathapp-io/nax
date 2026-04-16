/**
 * ContextOrchestrator.rebuildForAgent() — Phase 5.5 unit tests
 *
 * Covers the agent-swap overload: RebuildOptions with newAgentId + failure,
 * failure-note chunk injection, manifest.rebuildInfo population, agentId
 * threading, and rendering style dispatch (markdown-sections vs xml-tagged).
 *
 * Kept in a separate file from orchestrator.test.ts to stay within the
 * 400-line file limit; split is by describe block concern.
 */

import { describe, test, expect } from "bun:test";
import { ContextOrchestrator } from "../../../../src/context/v2/orchestrator";
import type {
  AdapterFailure,
  ContextRequest,
  ContextProviderResult,
  IContextProvider,
} from "../../../../src/context/v2/types";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const BASE_REQUEST: ContextRequest = {
  storyId: "US-001",
  workdir: "/repo",
  stage: "tdd-implementer",
  role: "implementer",
  budgetTokens: 8_000,
  providerIds: [],
};

function makeProvider(id: string, result: ContextProviderResult): IContextProvider {
  return {
    id,
    kind: "feature",
    fetch: async () => result,
  };
}

function makeChunkResult(id = "chunk:abc"): ContextProviderResult {
  return {
    chunks: [
      {
        id,
        kind: "feature",
        scope: "project",
        role: ["all"],
        content: "Feature rule: use async/await.",
        tokens: 20,
        rawScore: 0.8,
      },
    ],
  };
}

const AVAILABILITY_FAILURE: AdapterFailure = {
  category: "availability",
  outcome: "fail-quota",
  message: "daily token quota exhausted",
  retriable: false,
};

const QUALITY_FAILURE: AdapterFailure = {
  category: "quality",
  outcome: "fail-quality",
  message: "review rejected output",
  retriable: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// Agent-swap rebuild — failure note injection
// ─────────────────────────────────────────────────────────────────────────────

describe("rebuildForAgent — failure note injection", () => {
  test("failure note chunk is included in pushMarkdown on agent swap", async () => {
    const provider = makeProvider("p1", makeChunkResult());
    const orch = new ContextOrchestrator([provider]);
    const original = await orch.assemble(BASE_REQUEST);
    const priorBundle = { ...original, agentId: "claude" };

    const rebuilt = orch.rebuildForAgent(priorBundle, {
      newAgentId: "codex",
      failure: AVAILABILITY_FAILURE,
    });

    expect(rebuilt.pushMarkdown).toContain("Agent swap");
    expect(rebuilt.pushMarkdown).toContain("fail-quota");
  });

  test("failure note includes prior agent id", async () => {
    const orch = new ContextOrchestrator([]);
    const original = await orch.assemble(BASE_REQUEST);
    const priorBundle = { ...original, agentId: "claude" };

    const rebuilt = orch.rebuildForAgent(priorBundle, {
      newAgentId: "codex",
      failure: AVAILABILITY_FAILURE,
    });

    expect(rebuilt.pushMarkdown).toContain("claude");
  });

  test("failure note includes new agent id", async () => {
    const orch = new ContextOrchestrator([]);
    const original = await orch.assemble(BASE_REQUEST);
    const priorBundle = { ...original, agentId: "claude" };

    const rebuilt = orch.rebuildForAgent(priorBundle, {
      newAgentId: "codex",
      failure: AVAILABILITY_FAILURE,
    });

    expect(rebuilt.pushMarkdown).toContain("codex");
  });

  test("no failure note when failure is absent (plain re-render)", async () => {
    const provider = makeProvider("p1", makeChunkResult());
    const orch = new ContextOrchestrator([provider]);
    const original = await orch.assemble(BASE_REQUEST);

    const rebuilt = orch.rebuildForAgent(original);

    expect(rebuilt.pushMarkdown).not.toContain("Agent swap");
  });

  test("failure without newAgentId produces no failure note and no rebuildInfo", async () => {
    // The guard `if (failure && newAgentId)` requires both fields.
    // Providing failure alone must not inject the chunk or populate rebuildInfo.
    const orch = new ContextOrchestrator([]);
    const original = await orch.assemble(BASE_REQUEST);

    const rebuilt = orch.rebuildForAgent(original, { failure: AVAILABILITY_FAILURE });

    expect(rebuilt.pushMarkdown).not.toContain("Agent swap");
    expect(rebuilt.manifest.rebuildInfo).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Agent-swap rebuild — manifest.rebuildInfo
// ─────────────────────────────────────────────────────────────────────────────

describe("rebuildForAgent — manifest.rebuildInfo", () => {
  test("rebuildInfo is set on agent-swap rebuild", async () => {
    const orch = new ContextOrchestrator([]);
    const original = await orch.assemble(BASE_REQUEST);
    const priorBundle = { ...original, agentId: "claude" };

    const rebuilt = orch.rebuildForAgent(priorBundle, {
      newAgentId: "codex",
      failure: AVAILABILITY_FAILURE,
    });

    expect(rebuilt.manifest.rebuildInfo).toBeDefined();
    expect(rebuilt.manifest.rebuildInfo?.priorAgentId).toBe("claude");
    expect(rebuilt.manifest.rebuildInfo?.newAgentId).toBe("codex");
    expect(rebuilt.manifest.rebuildInfo?.failureCategory).toBe("availability");
    expect(rebuilt.manifest.rebuildInfo?.failureOutcome).toBe("fail-quota");
  });

  test("rebuildInfo is undefined when no failure is provided", async () => {
    const orch = new ContextOrchestrator([]);
    const original = await orch.assemble(BASE_REQUEST);

    const rebuilt = orch.rebuildForAgent(original);

    expect(rebuilt.manifest.rebuildInfo).toBeUndefined();
  });

  test("rebuildInfo records quality failure outcome", async () => {
    const orch = new ContextOrchestrator([]);
    const original = await orch.assemble(BASE_REQUEST);
    const priorBundle = { ...original, agentId: "claude" };

    const rebuilt = orch.rebuildForAgent(priorBundle, {
      newAgentId: "codex",
      failure: QUALITY_FAILURE,
    });

    expect(rebuilt.manifest.rebuildInfo?.failureCategory).toBe("quality");
    expect(rebuilt.manifest.rebuildInfo?.failureOutcome).toBe("fail-quality");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Agent-swap rebuild — agentId on returned bundle
// ─────────────────────────────────────────────────────────────────────────────

describe("rebuildForAgent — agentId on bundle", () => {
  test("bundle.agentId reflects the new agent on swap", async () => {
    const orch = new ContextOrchestrator([]);
    const original = await orch.assemble(BASE_REQUEST);

    const rebuilt = orch.rebuildForAgent(original, {
      newAgentId: "codex",
      failure: AVAILABILITY_FAILURE,
    });

    expect(rebuilt.agentId).toBe("codex");
  });

  test("bundle.agentId defaults to claude when no newAgentId and no prior agentId", async () => {
    const orch = new ContextOrchestrator([]);
    const original = await orch.assemble(BASE_REQUEST);

    const rebuilt = orch.rebuildForAgent(original);

    expect(rebuilt.agentId).toBe("claude");
  });

  test("bundle.agentId uses prior.agentId when no newAgentId provided", async () => {
    const orch = new ContextOrchestrator([]);
    const original = await orch.assemble(BASE_REQUEST);
    const priorBundle = { ...original, agentId: "codex" };

    const rebuilt = orch.rebuildForAgent(priorBundle);

    expect(rebuilt.agentId).toBe("codex");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Agent-swap rebuild — rendering style dispatch
// ─────────────────────────────────────────────────────────────────────────────

describe("rebuildForAgent — rendering style dispatch", () => {
  test("codex swap produces xml-tagged push markdown", async () => {
    const provider = makeProvider("p1", makeChunkResult());
    const orch = new ContextOrchestrator([provider]);
    const original = await orch.assemble(BASE_REQUEST);
    const priorBundle = { ...original, agentId: "claude" };

    const rebuilt = orch.rebuildForAgent(priorBundle, {
      newAgentId: "codex",
      failure: AVAILABILITY_FAILURE,
    });

    expect(rebuilt.pushMarkdown).toContain("<context_section");
  });

  test("no-swap re-render produces markdown-sections push markdown for claude bundle", async () => {
    const provider = makeProvider("p1", makeChunkResult());
    const orch = new ContextOrchestrator([provider]);
    const original = await orch.assemble({ ...BASE_REQUEST, providerIds: ["p1"] });
    const priorBundle = { ...original, agentId: "claude" };

    // No newAgentId — keeps current renderChunks (markdown-sections by default)
    const rebuilt = orch.rebuildForAgent(priorBundle);

    expect(rebuilt.pushMarkdown).toContain("##");
    expect(rebuilt.pushMarkdown).not.toContain("<context_section");
  });

  test("priorStageDigest from RebuildOptions appears in rebuilt pushMarkdown", async () => {
    const orch = new ContextOrchestrator([]);
    const original = await orch.assemble(BASE_REQUEST);

    const rebuilt = orch.rebuildForAgent(original, {
      newAgentId: "codex",
      failure: AVAILABILITY_FAILURE,
      priorStageDigest: "Plan completed: touched src/review/semantic.ts.",
    });

    expect(rebuilt.pushMarkdown).toContain("Plan completed:");
  });

  test("original chunks are preserved on swap (no provider re-fetch)", async () => {
    let fetchCount = 0;
    const provider: IContextProvider = {
      id: "p1",
      kind: "feature",
      fetch: async () => { fetchCount++; return makeChunkResult(); },
    };
    const orch = new ContextOrchestrator([provider]);
    const original = await orch.assemble({ ...BASE_REQUEST, providerIds: ["p1"] });
    expect(fetchCount).toBe(1);

    orch.rebuildForAgent(original, { newAgentId: "codex", failure: AVAILABILITY_FAILURE });
    expect(fetchCount).toBe(1); // no additional fetch
  });
});
