/**
 * Routing Stage — SD-004: Pipeline decompose integration
 *
 * Tests for oversized story detection, trigger modes (auto / confirm / disabled),
 * and fallback behavior when decomposition fails.
 *
 * These tests are RED until the routing stage is extended with decompose logic.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../../src/config/defaults";
import type { NaxConfig } from "../../../../src/config";
import type { PRD, UserStory } from "../../../../src/prd";
import type { PipelineContext } from "../../../../src/pipeline/types";
import type { DecomposeResult } from "../../../../src/decompose/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStory(overrides?: Partial<UserStory>): UserStory {
  return {
    id: "US-001",
    title: "Oversized Story",
    description: "A story with too many acceptance criteria",
    acceptanceCriteria: [],
    tags: [],
    dependencies: [],
    status: "in-progress",
    passes: false,
    escalations: [],
    attempts: 0,
    ...overrides,
  };
}

function makePRD(story: UserStory): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "feat/test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userStories: [story],
  };
}

function makeConfig(decomposeOverrides?: Partial<NaxConfig["decompose"]>): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    tdd: { ...DEFAULT_CONFIG.tdd, greenfieldDetection: false },
    decompose: {
      trigger: "auto",
      maxAcceptanceCriteria: 6,
      maxSubstories: 5,
      maxSubstoryComplexity: "medium",
      maxRetries: 2,
      model: "balanced",
      ...decomposeOverrides,
    },
  };
}

function makeCtx(
  story: UserStory,
  config?: NaxConfig,
  overrides?: Partial<PipelineContext>,
): PipelineContext & { prdPath: string } {
  const prd = makePRD(story);
  return {
    config: config ?? makeConfig(),
    prd,
    story,
    stories: [story],
    routing: {
      complexity: "complex",
      modelTier: "powerful",
      testStrategy: "three-session-tdd",
      reasoning: "classified",
    },
    workdir: "/tmp/nax-decompose-routing-test",
    hooks: { hooks: {} },
    prdPath: "/tmp/nax-decompose-routing-test/nax/prd.json",
    ...overrides,
  } as PipelineContext & { prdPath: string };
}

/** Story with 7 ACs (> default threshold of 6), classified as complex */
function makeOversizedStory(): UserStory {
  return makeStory({
    acceptanceCriteria: ["AC-1", "AC-2", "AC-3", "AC-4", "AC-5", "AC-6", "AC-7"],
    routing: {
      complexity: "complex",
      testStrategy: "three-session-tdd",
      reasoning: "cached",
      contentHash: "stale-hash",
    },
  });
}

function makeSuccessfulDecomposeResult(): DecomposeResult {
  return {
    subStories: [
      {
        id: "US-001-1",
        parentStoryId: "US-001",
        title: "Sub-story 1",
        description: "First part",
        acceptanceCriteria: ["AC-1", "AC-2"],
        tags: [],
        dependencies: [],
        complexity: "medium",
        nonOverlapJustification: "Handles only part 1",
      },
      {
        id: "US-001-2",
        parentStoryId: "US-001",
        title: "Sub-story 2",
        description: "Second part",
        acceptanceCriteria: ["AC-3", "AC-4"],
        tags: [],
        dependencies: ["US-001-1"],
        complexity: "simple",
        nonOverlapJustification: "Handles only part 2",
      },
    ],
    validation: { valid: true, errors: [], warnings: [] },
  };
}

function makeFailedDecomposeResult(): DecomposeResult {
  return {
    subStories: [],
    validation: {
      valid: false,
      errors: ["Decomposition failed after all retries"],
      warnings: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: get _routingDeps as a mutable record (avoids TS errors on new keys)
// ---------------------------------------------------------------------------
async function getDeps() {
  const mod = await import("../../../../src/pipeline/stages/routing");
  return {
    routingStage: mod.routingStage,
    deps: mod._routingDeps as unknown as Record<string, unknown>,
    origDeps: { ...(mod._routingDeps as unknown as Record<string, unknown>) },
  };
}

function restoreDeps(deps: Record<string, unknown>, orig: Record<string, unknown>) {
  for (const key of Object.keys(orig)) {
    deps[key] = orig[key];
  }
}

// ---------------------------------------------------------------------------
// Sanity: _routingDeps exposes decompose-related deps
// ---------------------------------------------------------------------------

describe("routingStage - _routingDeps exposes decompose deps (SD-004)", () => {
  test("_routingDeps has applyDecomposition function", async () => {
    const { deps } = await getDeps();
    expect(typeof deps.applyDecomposition).toBe("function");
  });

  test("_routingDeps has runDecompose function", async () => {
    const { deps } = await getDeps();
    expect(typeof deps.runDecompose).toBe("function");
  });

  test("_routingDeps has checkStoryOversized function", async () => {
    const { deps } = await getDeps();
    expect(typeof deps.checkStoryOversized).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Oversized detection: no decompose for stories below threshold
// ---------------------------------------------------------------------------

describe("routingStage - does not decompose when below threshold", () => {
  afterEach(() => {
    mock.restore();
  });

  test("continues normally when story has fewer ACs than threshold", async () => {
    const { routingStage, deps, origDeps } = await getDeps();

    const applyMock = mock(() => {});
    deps.applyDecomposition = applyMock;
    deps.routeStory = mock(() =>
      Promise.resolve({ complexity: "complex" as const, modelTier: "powerful" as const, testStrategy: "three-session-tdd" as const, reasoning: "r" })
    );
    deps.isGreenfieldStory = mock(() => Promise.resolve(false));
    deps.savePRD = mock(() => Promise.resolve());
    deps.computeStoryContentHash = mock(() => "h1");

    try {
      const story = makeStory({ acceptanceCriteria: ["AC-1", "AC-2", "AC-3"] }); // 3 < threshold 6
      const ctx = makeCtx(story, makeConfig({ trigger: "auto", maxAcceptanceCriteria: 6 }));

      const result = await routingStage.execute(ctx);

      expect(result.action).toBe("continue");
      expect(applyMock).not.toHaveBeenCalled();
    } finally {
      restoreDeps(deps, origDeps);
    }
  });

  test("does not decompose when many ACs but simple complexity", async () => {
    const { routingStage, deps, origDeps } = await getDeps();

    const runDecomposeMock = mock(() => Promise.resolve(makeSuccessfulDecomposeResult()));
    deps.runDecompose = runDecomposeMock;
    deps.routeStory = mock(() =>
      Promise.resolve({ complexity: "simple" as const, modelTier: "fast" as const, testStrategy: "test-after" as const, reasoning: "r" })
    );
    deps.isGreenfieldStory = mock(() => Promise.resolve(false));
    deps.savePRD = mock(() => Promise.resolve());
    deps.computeStoryContentHash = mock(() => "h2");

    try {
      const story = makeStory({
        acceptanceCriteria: ["AC-1", "AC-2", "AC-3", "AC-4", "AC-5", "AC-6", "AC-7", "AC-8"],
      });
      const ctx = makeCtx(story, makeConfig({ trigger: "auto", maxAcceptanceCriteria: 6 }));

      const result = await routingStage.execute(ctx);

      expect(result.action).toBe("continue");
      expect(runDecomposeMock).not.toHaveBeenCalled();
    } finally {
      restoreDeps(deps, origDeps);
    }
  });
});

// ---------------------------------------------------------------------------
// disabled trigger mode
// ---------------------------------------------------------------------------

describe("routingStage - disabled trigger mode", () => {
  afterEach(() => {
    mock.restore();
  });

  test("logs warning and returns continue without decomposing", async () => {
    const { routingStage, deps, origDeps } = await getDeps();

    const applyMock = mock(() => {});
    const runDecomposeMock = mock(() => Promise.resolve(makeSuccessfulDecomposeResult()));
    deps.applyDecomposition = applyMock;
    deps.runDecompose = runDecomposeMock;
    deps.routeStory = mock(() =>
      Promise.resolve({ complexity: "complex" as const, modelTier: "powerful" as const, testStrategy: "three-session-tdd" as const, reasoning: "r" })
    );
    deps.isGreenfieldStory = mock(() => Promise.resolve(false));
    deps.savePRD = mock(() => Promise.resolve());
    deps.computeStoryContentHash = mock(() => "h3");

    try {
      const story = makeOversizedStory();
      const ctx = makeCtx(story, makeConfig({ trigger: "disabled" }));

      const result = await routingStage.execute(ctx);

      expect(result.action).toBe("continue");
      expect(applyMock).not.toHaveBeenCalled();
      expect(runDecomposeMock).not.toHaveBeenCalled();
    } finally {
      restoreDeps(deps, origDeps);
    }
  });
});

// ---------------------------------------------------------------------------
// auto trigger mode
// ---------------------------------------------------------------------------

describe("routingStage - auto trigger mode", () => {
  afterEach(() => {
    mock.restore();
  });

  test("decomposes oversized story without firing interaction trigger", async () => {
    const { routingStage, deps, origDeps } = await getDeps();

    const applyMock = mock(() => {});
    const saveMock = mock(() => Promise.resolve());
    const runDecomposeMock = mock(() => Promise.resolve(makeSuccessfulDecomposeResult()));
    const checkOversizedMock = mock(() => Promise.resolve("decompose"));

    deps.applyDecomposition = applyMock;
    deps.savePRD = saveMock;
    deps.runDecompose = runDecomposeMock;
    deps.checkStoryOversized = checkOversizedMock;
    deps.routeStory = mock(() =>
      Promise.resolve({ complexity: "complex" as const, modelTier: "powerful" as const, testStrategy: "three-session-tdd" as const, reasoning: "r" })
    );
    deps.isGreenfieldStory = mock(() => Promise.resolve(false));
    deps.computeStoryContentHash = mock(() => "h4");

    try {
      const story = makeOversizedStory();
      const ctx = makeCtx(story, makeConfig({ trigger: "auto" }));

      const result = await routingStage.execute(ctx);

      // auto mode must NOT prompt user
      expect(checkOversizedMock).not.toHaveBeenCalled();
      // decompose must be attempted
      expect(runDecomposeMock).toHaveBeenCalled();
      // PRD must be mutated and saved
      expect(applyMock).toHaveBeenCalledWith(ctx.prd, expect.objectContaining({ subStories: expect.any(Array) }));
      expect(saveMock).toHaveBeenCalled();
      // Signal runner to skip original story so it picks up first substory
      expect(result.action).toBe("skip");
    } finally {
      restoreDeps(deps, origDeps);
    }
  });

  test("falls back to continue when decompose fails after retries", async () => {
    const { routingStage, deps, origDeps } = await getDeps();

    const applyMock = mock(() => {});
    const runDecomposeMock = mock(() => Promise.resolve(makeFailedDecomposeResult()));

    deps.applyDecomposition = applyMock;
    deps.runDecompose = runDecomposeMock;
    deps.routeStory = mock(() =>
      Promise.resolve({ complexity: "expert" as const, modelTier: "powerful" as const, testStrategy: "three-session-tdd" as const, reasoning: "r" })
    );
    deps.isGreenfieldStory = mock(() => Promise.resolve(false));
    deps.savePRD = mock(() => Promise.resolve());
    deps.computeStoryContentHash = mock(() => "h5");

    try {
      const story = makeOversizedStory();
      const ctx = makeCtx(story, makeConfig({ trigger: "auto" }));

      const result = await routingStage.execute(ctx);

      expect(runDecomposeMock).toHaveBeenCalled();
      // applyDecomposition NOT called on failed result
      expect(applyMock).not.toHaveBeenCalled();
      // Falls back gracefully
      expect(result.action).toBe("continue");
    } finally {
      restoreDeps(deps, origDeps);
    }
  });

  test("passes correct prd and result to applyDecomposition", async () => {
    const { routingStage, deps, origDeps } = await getDeps();

    const decomposeResult = makeSuccessfulDecomposeResult();
    let capturedPrd: PRD | undefined;
    let capturedResult: DecomposeResult | undefined;

    deps.applyDecomposition = mock((prd: PRD, result: DecomposeResult) => {
      capturedPrd = prd;
      capturedResult = result;
    });
    deps.runDecompose = mock(() => Promise.resolve(decomposeResult));
    deps.savePRD = mock(() => Promise.resolve());
    deps.routeStory = mock(() =>
      Promise.resolve({ complexity: "complex" as const, modelTier: "powerful" as const, testStrategy: "three-session-tdd" as const, reasoning: "r" })
    );
    deps.isGreenfieldStory = mock(() => Promise.resolve(false));
    deps.computeStoryContentHash = mock(() => "h6");

    try {
      const story = makeOversizedStory();
      const ctx = makeCtx(story, makeConfig({ trigger: "auto" }));

      await routingStage.execute(ctx);

      expect(capturedPrd).toBe(ctx.prd);
      expect(capturedResult).toEqual(decomposeResult);
    } finally {
      restoreDeps(deps, origDeps);
    }
  });
});

// ---------------------------------------------------------------------------
// confirm trigger mode
// ---------------------------------------------------------------------------

describe("routingStage - confirm trigger mode", () => {
  afterEach(() => {
    mock.restore();
  });

  test("fires story-oversized trigger and decomposes when user approves", async () => {
    const { routingStage, deps, origDeps } = await getDeps();

    const checkOversizedMock = mock(() => Promise.resolve("decompose" as const));
    const applyMock = mock(() => {});
    const runDecomposeMock = mock(() => Promise.resolve(makeSuccessfulDecomposeResult()));

    deps.checkStoryOversized = checkOversizedMock;
    deps.applyDecomposition = applyMock;
    deps.runDecompose = runDecomposeMock;
    deps.savePRD = mock(() => Promise.resolve());
    deps.routeStory = mock(() =>
      Promise.resolve({ complexity: "complex" as const, modelTier: "powerful" as const, testStrategy: "three-session-tdd" as const, reasoning: "r" })
    );
    deps.isGreenfieldStory = mock(() => Promise.resolve(false));
    deps.computeStoryContentHash = mock(() => "h7");

    try {
      const mockChain = { prompt: mock(() => Promise.resolve({ action: "approve" })) };
      const story = makeOversizedStory();
      const ctx = makeCtx(story, makeConfig({ trigger: "confirm" }), {
        interaction: mockChain as unknown as import("../../../../src/interaction/chain").InteractionChain,
      });

      const result = await routingStage.execute(ctx);

      // Confirm mode MUST fire trigger
      expect(checkOversizedMock).toHaveBeenCalled();
      expect(runDecomposeMock).toHaveBeenCalled();
      expect(applyMock).toHaveBeenCalled();
      expect(result.action).toBe("skip");
    } finally {
      restoreDeps(deps, origDeps);
    }
  });

  test("continues without decomposing when user rejects", async () => {
    const { routingStage, deps, origDeps } = await getDeps();

    const checkOversizedMock = mock(() => Promise.resolve("continue" as const));
    const applyMock = mock(() => {});
    const runDecomposeMock = mock(() => Promise.resolve(makeSuccessfulDecomposeResult()));

    deps.checkStoryOversized = checkOversizedMock;
    deps.applyDecomposition = applyMock;
    deps.runDecompose = runDecomposeMock;
    deps.savePRD = mock(() => Promise.resolve());
    deps.routeStory = mock(() =>
      Promise.resolve({ complexity: "expert" as const, modelTier: "powerful" as const, testStrategy: "three-session-tdd" as const, reasoning: "r" })
    );
    deps.isGreenfieldStory = mock(() => Promise.resolve(false));
    deps.computeStoryContentHash = mock(() => "h8");

    try {
      const story = makeOversizedStory();
      const ctx = makeCtx(story, makeConfig({ trigger: "confirm" }));

      const result = await routingStage.execute(ctx);

      expect(checkOversizedMock).toHaveBeenCalled();
      expect(runDecomposeMock).not.toHaveBeenCalled();
      expect(applyMock).not.toHaveBeenCalled();
      expect(result.action).toBe("continue");
    } finally {
      restoreDeps(deps, origDeps);
    }
  });
});
