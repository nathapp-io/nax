/**
 * Tests for src/execution/escalation/agent-swap.ts
 *
 * Covers: resolveSwapTarget, shouldAttemptSwap, rebuildForSwap
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { ContextOrchestrator } from "../../../../src/context/engine/orchestrator";
import type {
  AdapterFailure,
  ContextBundle,
  ContextProviderResult,
  IContextProvider,
} from "../../../../src/context/engine/types";
import type { ContextV2FallbackConfig } from "../../../../src/config/runtime-types";
import {
  resolveSwapTarget,
  shouldAttemptSwap,
  rebuildForSwap,
  _agentSwapDeps,
} from "../../../../src/execution/escalation/agent-swap";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const QUOTA_FAILURE: AdapterFailure = {
  category: "availability",
  outcome: "fail-quota",
  message: "Quota exhausted",
  retriable: false,
};

const RATE_LIMIT_FAILURE: AdapterFailure = {
  category: "availability",
  outcome: "fail-rate-limit",
  message: "Rate limited",
  retriable: true,
  retryAfterSeconds: 60,
};

const QUALITY_FAILURE: AdapterFailure = {
  category: "quality",
  outcome: "fail-timeout",
  message: "Timed out",
  retriable: true,
};

const FALLBACK_CONFIG: ContextV2FallbackConfig = {
  enabled: true,
  onQualityFailure: false,
  maxHopsPerStory: 2,
  map: { claude: ["codex", "gemini"] },
};

const DISABLED_CONFIG: ContextV2FallbackConfig = {
  enabled: false,
  onQualityFailure: false,
  maxHopsPerStory: 2,
  map: { claude: ["codex"] },
};

function makeProvider(id: string, result: ContextProviderResult): IContextProvider {
  return { id, kind: "feature", fetch: async () => result };
}

function makeChunkResult(): ContextProviderResult {
  return {
    chunks: [
      {
        id: "chunk:abc",
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

async function makeBundle(agentId = "claude"): Promise<ContextBundle> {
  const orch = new ContextOrchestrator([makeProvider("p1", makeChunkResult())]);
  return orch.assemble({
    storyId: "US-001",
    workdir: "/repo",
    stage: "run",
    role: "implementer",
    budgetTokens: 8_000,
    providerIds: [],
    agentId,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveSwapTarget
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveSwapTarget", () => {
  test("returns first candidate on first swap (swapCount=0)", () => {
    expect(resolveSwapTarget("claude", { claude: ["codex", "gemini"] }, 0)).toBe("codex");
  });

  test("returns second candidate on second swap (swapCount=1)", () => {
    expect(resolveSwapTarget("claude", { claude: ["codex", "gemini"] }, 1)).toBe("gemini");
  });

  test("returns null when swapCount exhausts candidates", () => {
    expect(resolveSwapTarget("claude", { claude: ["codex"] }, 1)).toBeNull();
  });

  test("returns null when agent has no fallback entry", () => {
    expect(resolveSwapTarget("codex", { claude: ["codex"] }, 0)).toBeNull();
  });

  test("returns null for empty candidate list", () => {
    expect(resolveSwapTarget("claude", { claude: [] }, 0)).toBeNull();
  });

  test("returns null for empty map", () => {
    expect(resolveSwapTarget("claude", {}, 0)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// shouldAttemptSwap
// ─────────────────────────────────────────────────────────────────────────────

describe("shouldAttemptSwap", () => {
  let bundle: ContextBundle;

  beforeEach(async () => {
    bundle = await makeBundle();
  });

  test("returns true for availability failure when enabled and within hops", () => {
    expect(shouldAttemptSwap(QUOTA_FAILURE, FALLBACK_CONFIG, 0, bundle)).toBe(true);
  });

  test("returns true for rate-limit failure", () => {
    expect(shouldAttemptSwap(RATE_LIMIT_FAILURE, FALLBACK_CONFIG, 0, bundle)).toBe(true);
  });

  test("returns false when config.enabled is false", () => {
    expect(shouldAttemptSwap(QUOTA_FAILURE, DISABLED_CONFIG, 0, bundle)).toBe(false);
  });

  test("returns false when no failure", () => {
    expect(shouldAttemptSwap(undefined, FALLBACK_CONFIG, 0, bundle)).toBe(false);
  });

  test("returns false when swapCount >= maxHopsPerStory", () => {
    expect(shouldAttemptSwap(QUOTA_FAILURE, FALLBACK_CONFIG, 2, bundle)).toBe(false);
  });

  test("returns false for quality failure when onQualityFailure is false", () => {
    expect(shouldAttemptSwap(QUALITY_FAILURE, FALLBACK_CONFIG, 0, bundle)).toBe(false);
  });

  test("returns true for quality failure when onQualityFailure is true", () => {
    const config: ContextV2FallbackConfig = { ...FALLBACK_CONFIG, onQualityFailure: true };
    expect(shouldAttemptSwap(QUALITY_FAILURE, config, 0, bundle)).toBe(true);
  });

  test("returns false when no context bundle exists", () => {
    expect(shouldAttemptSwap(QUOTA_FAILURE, FALLBACK_CONFIG, 0, undefined)).toBe(false);
  });

  test("returns true when swapCount is one less than maxHopsPerStory", () => {
    expect(shouldAttemptSwap(QUOTA_FAILURE, FALLBACK_CONFIG, 1, bundle)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rebuildForSwap
// ─────────────────────────────────────────────────────────────────────────────

describe("rebuildForSwap", () => {
  let bundle: ContextBundle;
  let origRebuildForAgent: typeof _agentSwapDeps.rebuildForAgent;

  beforeEach(async () => {
    bundle = await makeBundle("claude");
    origRebuildForAgent = _agentSwapDeps.rebuildForAgent;
  });

  afterEach(() => {
    _agentSwapDeps.rebuildForAgent = origRebuildForAgent;
  });

  test("returns a ContextBundle with pushMarkdown and chunks", () => {
    const result = rebuildForSwap(bundle, "codex", QUOTA_FAILURE);
    expect(result).toBeDefined();
    expect(typeof result.pushMarkdown).toBe("string");
    expect(Array.isArray(result.chunks)).toBe(true);
  });

  test("result carries rebuildInfo with priorAgentId and newAgentId", () => {
    const result = rebuildForSwap(bundle, "codex", QUOTA_FAILURE);
    expect(result.manifest.rebuildInfo).toBeDefined();
    expect(result.manifest.rebuildInfo?.priorAgentId).toBe("claude");
    expect(result.manifest.rebuildInfo?.newAgentId).toBe("codex");
  });

  test("result contains a failure-note chunk (kind=session, id starts with failure-note:)", () => {
    const result = rebuildForSwap(bundle, "codex", QUOTA_FAILURE);
    const failureChunk = result.chunks.find((c: { id: string }) => c.id.startsWith("failure-note:"));
    expect(failureChunk).toBeDefined();
    expect(failureChunk?.kind).toBe("session");
  });

  test("rebuildInfo carries failure category and outcome", () => {
    const result = rebuildForSwap(bundle, "codex", QUOTA_FAILURE);
    expect(result.manifest.rebuildInfo?.failureCategory).toBe("availability");
    expect(result.manifest.rebuildInfo?.failureOutcome).toBe("fail-quota");
  });

  test("result agentId is set to newAgentId", () => {
    const result = rebuildForSwap(bundle, "codex", QUOTA_FAILURE);
    expect(result.agentId).toBe("codex");
  });

  test("uses injectable rebuildForAgent dep", () => {
    const called: Array<{ prior: ContextBundle; opts: unknown }> = [];
    const fakeBundle: ContextBundle = { ...bundle, agentId: "codex" };
    _agentSwapDeps.rebuildForAgent = (prior: ContextBundle, opts: { newAgentId?: string; failure?: AdapterFailure }) => {
      called.push({ prior, opts });
      return fakeBundle;
    };

    const result = rebuildForSwap(bundle, "codex", QUOTA_FAILURE);

    expect(called).toHaveLength(1);
    expect(called[0]!.opts).toMatchObject({ newAgentId: "codex", failure: QUOTA_FAILURE });
    expect(result).toBe(fakeBundle);
  });
});
