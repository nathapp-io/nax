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
import { ContextOrchestrator } from "../../../../src/context/engine/orchestrator";
import type {
  AdapterFailure,
  ContextBundle,
  ContextRequest,
  ContextProviderResult,
  IContextProvider,
} from "../../../../src/context/engine/types";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const BASE_REQUEST: ContextRequest = {
  storyId: "US-001",
  repoRoot: "/repo",
  packageDir: "/repo",
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

// ─────────────────────────────────────────────────────────────────────────────
// #508-M2: AC-42 re-neutralize session-scratch chunks on agent-swap rebuild
// ─────────────────────────────────────────────────────────────────────────────

describe("rebuildForAgent — #508-M2 session-chunk re-neutralization on swap", () => {
  function makeSessionBundle(sessionContent: string, priorAgentId = "claude"): ContextBundle {
    return {
      pushMarkdown: "",
      pullTools: [],
      digest: "",
      agentId: priorAgentId,
      chunks: [
        {
          id: "session-scratch:abc123",
          providerId: "session-scratch",
          kind: "session" as const,
          scope: "session" as const,
          role: ["all"],
          content: sessionContent,
          tokens: 20,
          score: 0.9,
        },
      ],
      manifest: {
        requestId: "req-prior",
        stage: "tdd-implementer",
        totalBudgetTokens: 8_000,
        usedTokens: 100,
        includedChunks: ["session-scratch:abc123"],
        excludedChunks: [],
        floorItems: [],
        digestTokens: 10,
        buildMs: 5,
      },
    };
  }

  test("session chunk content is re-neutralized when swapping from claude to codex", () => {
    const orch = new ContextOrchestrator([]);
    const prior = makeSessionBundle("I used the Read tool to inspect and the Bash tool to run tests.");
    const rebuilt = orch.rebuildForAgent(prior, { newAgentId: "codex", failure: AVAILABILITY_FAILURE });
    expect(rebuilt.pushMarkdown).not.toContain("the Read tool");
    expect(rebuilt.pushMarkdown).not.toContain("the Bash tool");
    expect(rebuilt.pushMarkdown).toContain("a file read");
    expect(rebuilt.pushMarkdown).toContain("a shell command");
  });

  test("session chunk is not re-neutralized on same-agent rebuild (claude → claude)", () => {
    const orch = new ContextOrchestrator([]);
    const prior = makeSessionBundle("I used the Read tool to inspect.", "claude");
    const rebuilt = orch.rebuildForAgent(prior, { newAgentId: "claude", failure: AVAILABILITY_FAILURE });
    expect(rebuilt.pushMarkdown).toContain("the Read tool");
  });

  test("non-session (feature) chunks are not touched by re-neutralization", () => {
    const orch = new ContextOrchestrator([]);
    const prior: ContextBundle = {
      pushMarkdown: "",
      pullTools: [],
      digest: "",
      agentId: "claude",
      chunks: [
        {
          id: "feature:abc",
          providerId: "feature-context",
          kind: "feature" as const,
          scope: "feature" as const,
          role: ["all"],
          content: "Feature: use the Read tool pattern.",
          tokens: 10,
          score: 0.8,
        },
      ],
      manifest: {
        requestId: "req-x",
        stage: "tdd-implementer",
        totalBudgetTokens: 8_000,
        usedTokens: 50,
        includedChunks: ["feature:abc"],
        excludedChunks: [],
        floorItems: [],
        digestTokens: 5,
        buildMs: 1,
      },
    };
    const rebuilt = orch.rebuildForAgent(prior, { newAgentId: "codex", failure: AVAILABILITY_FAILURE });
    // Feature chunks are not session history — must not be altered
    expect(rebuilt.pushMarkdown).toContain("the Read tool");
  });

  test("no re-neutralization when no newAgentId (plain re-render)", () => {
    const orch = new ContextOrchestrator([]);
    const prior = makeSessionBundle("I used the Read tool to inspect.", "claude");
    const rebuilt = orch.rebuildForAgent(prior);
    // no newAgentId → no swap → no re-neutralization
    expect(rebuilt.pushMarkdown).toContain("the Read tool");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #508-M5: AC-39 rebuildInfo chunk ID correlation
// ─────────────────────────────────────────────────────────────────────────────

describe("rebuildForAgent — #508-M5 rebuildInfo chunk ID correlation", () => {
  test("rebuildInfo contains priorChunkIds on agent-swap rebuild", async () => {
    const provider = makeProvider("p1", makeChunkResult("chunk:abc"));
    const orch = new ContextOrchestrator([provider]);
    const original = await orch.assemble({ ...BASE_REQUEST, providerIds: ["p1"] });
    const priorBundle = { ...original, agentId: "claude" };

    const rebuilt = orch.rebuildForAgent(priorBundle, {
      newAgentId: "codex",
      failure: AVAILABILITY_FAILURE,
    });

    expect(rebuilt.manifest.rebuildInfo?.priorChunkIds).toEqual(["chunk:abc"]);
  });

  test("rebuildInfo contains newChunkIds including failure-note chunk", async () => {
    const provider = makeProvider("p1", makeChunkResult("chunk:abc"));
    const orch = new ContextOrchestrator([provider]);
    const original = await orch.assemble({ ...BASE_REQUEST, providerIds: ["p1"] });
    const priorBundle = { ...original, agentId: "claude" };

    const rebuilt = orch.rebuildForAgent(priorBundle, {
      newAgentId: "codex",
      failure: AVAILABILITY_FAILURE,
    });

    const newIds = rebuilt.manifest.rebuildInfo?.newChunkIds ?? [];
    expect(newIds).toContain("chunk:abc");
    // failure-note chunk is added on swap → newChunkIds has more than priorChunkIds
    expect(newIds.length).toBeGreaterThan(1);
  });

  test("rebuildInfo has no chunk ID fields when no failure (plain re-render)", async () => {
    const orch = new ContextOrchestrator([]);
    const original = await orch.assemble(BASE_REQUEST);
    const rebuilt = orch.rebuildForAgent(original);
    expect(rebuilt.manifest.rebuildInfo).toBeUndefined();
  });
});
