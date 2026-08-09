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

  test("rebuild recomputes chunkTokens so the injected failure note is not counted as 0 (#1421)", async () => {
    // The rebuild adds a synthetic failure-note chunk. Inheriting the prior
    // manifest's chunkTokens would leave that chunk with no entry, and the
    // curator would record tokens:0 for it — the placeholder #1421 removed.
    const provider = makeProvider("p1", makeChunkResult());
    const orch = new ContextOrchestrator([provider]);
    const original = await orch.assemble(BASE_REQUEST);

    const rebuilt = orch.rebuildForAgent(
      { ...original, agentId: "claude" },
      { newAgentId: "codex", failure: AVAILABILITY_FAILURE },
    );

    const tokenMap = rebuilt.manifest.chunkTokens ?? {};
    expect(Object.keys(tokenMap).sort()).toEqual([...rebuilt.manifest.includedChunks].sort());
    for (const id of rebuilt.manifest.includedChunks) {
      expect(tokenMap[id]).toBeGreaterThan(0);
    }
  });

  test("failure note includes prior and new agent id", async () => {
    const orch = new ContextOrchestrator([]);
    const original = await orch.assemble(BASE_REQUEST);
    const rebuilt = orch.rebuildForAgent({ ...original, agentId: "claude" }, { newAgentId: "codex", failure: AVAILABILITY_FAILURE });
    expect(rebuilt.pushMarkdown).toContain("claude");
    expect(rebuilt.pushMarkdown).toContain("codex");
  });

  test("no failure note when failure absent or no newAgentId; no rebuildInfo in both cases", async () => {
    const provider = makeProvider("p1", makeChunkResult());
    const orch = new ContextOrchestrator([provider]);
    const original = await orch.assemble(BASE_REQUEST);

    // Plain re-render (no failure)
    const rebuilt1 = orch.rebuildForAgent(original);
    expect(rebuilt1.pushMarkdown).not.toContain("Agent swap");

    // Failure but no newAgentId — guard requires both fields
    const orch2 = new ContextOrchestrator([]);
    const original2 = await orch2.assemble(BASE_REQUEST);
    const rebuilt2 = orch2.rebuildForAgent(original2, { failure: AVAILABILITY_FAILURE });
    expect(rebuilt2.pushMarkdown).not.toContain("Agent swap");
    expect(rebuilt2.manifest.rebuildInfo).toBeUndefined();
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

  test("bundle.agentId defaults to claude when no prior; uses prior.agentId when set", async () => {
    const orch = new ContextOrchestrator([]);
    const original = await orch.assemble(BASE_REQUEST);
    expect(orch.rebuildForAgent(original).agentId).toBe("claude");
    expect(orch.rebuildForAgent({ ...original, agentId: "codex" }).agentId).toBe("codex");
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

  test("no re-neutralization on same-agent rebuild, non-session chunks, or plain re-render", () => {
    const orch = new ContextOrchestrator([]);
    const prior = makeSessionBundle("I used the Read tool to inspect.", "claude");

    // Same-agent rebuild
    expect(orch.rebuildForAgent(prior, { newAgentId: "claude", failure: AVAILABILITY_FAILURE }).pushMarkdown).toContain("the Read tool");
    // Plain re-render (no newAgentId)
    expect(orch.rebuildForAgent(prior).pushMarkdown).toContain("the Read tool");

    // Non-session (feature) chunks not altered
    const featurePrior: ContextBundle = { pushMarkdown: "", pullTools: [], digest: "", agentId: "claude", chunks: [{ id: "feature:abc", providerId: "feature-context", kind: "feature" as const, scope: "feature" as const, role: ["all"], content: "Feature: use the Read tool pattern.", tokens: 10, score: 0.8 }], manifest: { requestId: "req-x", stage: "tdd-implementer", totalBudgetTokens: 8_000, usedTokens: 50, includedChunks: ["feature:abc"], excludedChunks: [], floorItems: [], digestTokens: 5, buildMs: 1 } };
    expect(orch.rebuildForAgent(featurePrior, { newAgentId: "codex", failure: AVAILABILITY_FAILURE }).pushMarkdown).toContain("the Read tool");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #508-M5: AC-39 rebuildInfo chunk ID correlation
// ─────────────────────────────────────────────────────────────────────────────

describe("rebuildForAgent — #508-M5 rebuildInfo chunk ID correlation", () => {
  test("rebuildInfo chunk IDs: priorChunkIds, newChunkIds, chunkIdMap on agent-swap; undefined on plain re-render", async () => {
    const provider = makeProvider("p1", makeChunkResult("chunk:abc"));
    const orch = new ContextOrchestrator([provider]);
    const original = await orch.assemble({ ...BASE_REQUEST, providerIds: ["p1"] });
    const priorBundle = { ...original, agentId: "claude" };
    const rebuilt = orch.rebuildForAgent(priorBundle, { newAgentId: "codex", failure: AVAILABILITY_FAILURE });

    expect(rebuilt.manifest.rebuildInfo?.priorChunkIds).toEqual(["chunk:abc"]);

    const newIds = rebuilt.manifest.rebuildInfo?.newChunkIds ?? [];
    expect(newIds).toContain("chunk:abc");
    expect(newIds.length).toBeGreaterThan(1);

    expect(rebuilt.manifest.rebuildInfo?.chunkIdMap).toEqual([
      { priorChunkId: "chunk:abc", newChunkId: "chunk:abc" },
      { priorChunkId: "failure-note:claude:codex:fail-quota", newChunkId: "failure-note:claude:codex:fail-quota" },
    ]);

    // Plain re-render (no failure) → undefined
    const orch2 = new ContextOrchestrator([]);
    const original2 = await orch2.assemble(BASE_REQUEST);
    expect(orch2.rebuildForAgent(original2).manifest.rebuildInfo).toBeUndefined();
  });
});
