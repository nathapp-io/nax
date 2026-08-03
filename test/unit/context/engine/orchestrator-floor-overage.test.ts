/**
 * US-003 AC-4 — ContextOrchestrator.assemble() emits a warn-level floor-overage
 * log carrying storyId, stage, effectiveBudget, and the count of excluded
 * non-floor chunks whenever floor chunks pushed the bundle past the effective
 * budget.
 *
 * Lives in its own file to keep `orchestrator.test.ts` under the 800-line limit.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ContextOrchestrator, DIGEST_RESERVE_TOKENS, FIXED_RENDER_OVERHEAD_TOKENS, _orchestratorDeps } from "@/context";
import type { ContextProviderResult, ContextRequest, IContextProvider } from "@/context/engine/types";
import { makeLogger, type MockLogger } from "@test/helpers";

const BASE_REQUEST: ContextRequest = {
  storyId: "US-001",
  repoRoot: "/project",
  packageDir: "/project",
  stage: "execution",
  role: "implementer",
  budgetTokens: 10_000,
  providerIds: ["test-provider"],
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
  kind?: string;
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
    _orchestratorDeps.getLogger = () => mockLogger as unknown as ReturnType<typeof _orchestratorDeps.getLogger>;
  });

  afterEach(() => {
    _orchestratorDeps.getLogger = origGetLogger;
  });

  test("emits warn-level log with storyId/stage/effectiveBudget/excludedNonFloorChunkCount when floor overage occurs", async () => {
    // A 9k feature chunk overflows the conservative 8k ceiling, pushing the bundle past budget.
    // One 200-token session chunk competes with the floor and is excluded as a non-floor chunk.
    const orch = new ContextOrchestrator([
      makeProvider("test-provider", {
        chunks: [
          { id: "feat:big", kind: "feature", scope: "feature", role: ["implementer"], content: "x".repeat(36_000), tokens: 9_000, rawScore: 1.0 },
          { id: "sess:1", kind: "session", scope: "feature", role: ["implementer"], content: "y".repeat(800), tokens: 200, rawScore: 0.9 },
        ],
        pullTools: [],
      }),
    ]);

    await orch.assemble({
      ...BASE_REQUEST,
      budgetTokens: 50_000,
      agentId: "some-unknown-agent", // conservative 8k profile — forces floor overage
      providerIds: ["test-provider"],
    });

    const warnCalls = mockLogger.calls.filter((c) => c.level === "warn");
    const floorWarn = warnCalls.find((c) => c.message.includes("floor") || c.stage.includes("floor"));
    expect(floorWarn).toBeDefined();
    expect(floorWarn!.stage).toBe("context-v2");
    const data = floorWarn!.data as Record<string, unknown>;
    // storyId is the first key.
    const firstKey = Object.keys(data)[0];
    expect(firstKey).toBe("storyId");
    expect(data.storyId).toBe("US-001");
    expect(data.stage).toBe("execution");
    expect(typeof data.effectiveBudget).toBe("number");
    expect(data.effectiveBudget).toBeGreaterThanOrEqual(0);
    expect(typeof data.excludedNonFloorChunkCount).toBe("number");
    expect(data.excludedNonFloorChunkCount).toBe(1);
  });

  test("does NOT emit a floor-overage warn log when floor fits within budget", async () => {
    // Small floor chunks fit; no overage; no floor warn.
    const orch = new ContextOrchestrator([
      makeProvider("p1", makeChunkResult({ id: "feat:1", kind: "feature", tokens: 200, content: "tiny" })),
    ]);

    await orch.assemble({ ...BASE_REQUEST, budgetTokens: 10_000, providerIds: ["p1"] });

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
      makeProvider("test-provider", {
        chunks: [
          { id: "feat:1", kind: "feature", scope: "feature", role: ["implementer"], content: "x".repeat(1200), tokens: 300, rawScore: 1.0 },
        ],
        pullTools: [],
      }),
    ]);

    await orch.assemble({
      ...BASE_REQUEST,
      budgetTokens: 50_000,
      availableBudgetTokens: 400,
      providerIds: ["test-provider"],
    });

    const warnCalls = mockLogger.calls.filter((c) => c.level === "warn");
    const floorWarn = warnCalls.find((c) => c.message.includes("floor") || c.stage.includes("floor"));
    expect(floorWarn).toBeDefined();
    const data = floorWarn!.data as Record<string, unknown>;
    // Single chunk, no prior digest → no separator overhead, no prior-digest reserve.
    const expectedEffectiveBudget = 400 - DIGEST_RESERVE_TOKENS - FIXED_RENDER_OVERHEAD_TOKENS;
    expect(data.effectiveBudget).toBe(expectedEffectiveBudget);
    expect(data.effectiveBudget).toBeLessThan(400);
  });
});
