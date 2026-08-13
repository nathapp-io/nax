/**
 * Unit tests for fragment capture in completionStage (US-002)
 *
 * Covers:
 * - AC1: writeFragment invoked exactly once for a passing non-batch story with v2 + fragments.enabled
 * - AC2: writeFragment NOT invoked when context.v2.fragments.enabled is false
 * - AC3: writeFragment NOT invoked when context.v2.enabled is false
 * - AC4: body includes the story title
 * - AC5: body includes each story acceptance criterion
 * - AC6: body names each changed file reported by the diff
 * - AC7: writeFragment raising → execute resolves with { action: "continue" } and story marked passed
 * - AC8: completionStage runs twice → writeFragment invoked twice with same story ID
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { getLogger } from "@/logger";
import { _completionDeps, completionStage } from "@/pipeline/stages";
import type { PipelineContext } from "@/pipeline/types";
import type { PRD, UserStory } from "@/prd/types";
import { errorMessage } from "@/utils/errors";
import {
  makeMockRuntime,
  makeNaxConfig,
  makePRD,
  makeStory,
  withTempDir,
} from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Save originals for restoration
// ─────────────────────────────────────────────────────────────────────────────

const origWriteFragment = _completionDeps.writeFragment;
const origRenderFragmentBody = _completionDeps.renderFragmentBody;
const origGetDiffText = _completionDeps.getDiffText;
const origSavePRD = _completionDeps.savePRD;
const origCheckReviewGate = _completionDeps.checkReviewGate;
const origSpawn = _completionDeps.spawn;

// ─────────────────────────────────────────────────────────────────────────────
// Per-test factory wrappers — each one composes the shared helpers
// (makeStory / makePRD / makeNaxConfig) with the specific shape this
// story needs.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_STORY = {
  id: "US-001",
  title: "Add the fragment store",
  description: "Implement feature-scoped fragment persistence.",
  acceptanceCriteria: ["writeFragment persists body", "readFragment returns null for missing"],
  status: "in-progress" as const,
  attempts: 1,
};

/** Local wrapper around the shared `makeStory` helper that applies this
 *  story's defaults. Each test passes its own overrides on top. */
function makeStoryWithDefaults(overrides: Partial<UserStory> = {}): UserStory {
  return makeStory({ ...DEFAULT_STORY, ...overrides });
}

function makePRDWithStory(story: UserStory): PRD {
  return makePRD({ feature: "my-feature", userStories: [story] });
}

/** Builds the v2 + fragments config this story exercises. Uses the shared
 *  makeNaxConfig helper under the hood; not a wrapper around it. */
const fragmentCaptureConfig = ({
  v2Enabled = true,
  fragmentsEnabled = true,
}: {
  v2Enabled?: boolean;
  fragmentsEnabled?: boolean;
} = {}) =>
  makeNaxConfig({
    context: {
      v2: {
        enabled: v2Enabled,
        fragments: { enabled: fragmentsEnabled, decay: 0.6, maxTokens: 400, extractor: "deterministic" },
      },
    },
  });

function makeCtx(
  config: ReturnType<typeof fragmentCaptureConfig>,
  prd: PRD,
  tempDir: string,
  overrides: Partial<PipelineContext> = {},
): PipelineContext {
  const story = prd.userStories[0]!;
  return {
    config,
    rootConfig: makeNaxConfig(),
    prd,
    story,
    stories: [story],
    routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
    workdir: tempDir,
    projectDir: tempDir,
    featureDir: tempDir,
    prdPath: `${tempDir}/prd.json`,
    agentResult: { success: true, estimatedCostUsd: 0.01, output: "", stderr: "", exitCode: 0, rateLimited: false },
    hooks: {} as PipelineContext["hooks"],
    storyStartTime: new Date().toISOString(),
    runtime: makeMockRuntime(),
    ...overrides,
  } as unknown as PipelineContext;
}

beforeEach(() => {
  _completionDeps.writeFragment = origWriteFragment;
  _completionDeps.renderFragmentBody = origRenderFragmentBody;
  _completionDeps.getDiffText = origGetDiffText;
  _completionDeps.savePRD = origSavePRD;
  _completionDeps.checkReviewGate = origCheckReviewGate;
  _completionDeps.spawn = origSpawn;
});

afterEach(() => {
  _completionDeps.writeFragment = origWriteFragment;
  _completionDeps.renderFragmentBody = origRenderFragmentBody;
  _completionDeps.getDiffText = origGetDiffText;
  _completionDeps.savePRD = origSavePRD;
  _completionDeps.checkReviewGate = origCheckReviewGate;
  _completionDeps.spawn = origSpawn;
});

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("completionStage — fragment capture (AC1)", () => {
  test("writeFragment is invoked exactly once with that story's ID when v2 + fragments.enabled, non-batch, passing story", async () => {
    await withTempDir(async (tempDir) => {
      const story = makeStoryWithDefaults({ id: "US-001" });
      const prd = makePRDWithStory(story);
      const ctx = makeCtx(fragmentCaptureConfig({ v2Enabled: true, fragmentsEnabled: true }), prd, tempDir);
      _completionDeps.savePRD = mock(async () => {});
      const writeMock = mock(async () => {});
      _completionDeps.writeFragment = writeMock;
      _completionDeps.getDiffText = mock(async () => "");

      const result = await completionStage.execute(ctx);

      expect(result.action).toBe("continue");
      expect(writeMock).toHaveBeenCalledTimes(1);
      expect(writeMock).toHaveBeenCalledWith(tempDir, "my-feature", "US-001", expect.any(String), 400);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — fragments.enabled = false
// ─────────────────────────────────────────────────────────────────────────────

describe("completionStage — fragment capture (AC2)", () => {
  test("writeFragment is NOT invoked when context.v2.fragments.enabled is false", async () => {
    await withTempDir(async (tempDir) => {
      const story = makeStoryWithDefaults({ id: "US-001" });
      const prd = makePRDWithStory(story);
      const ctx = makeCtx(fragmentCaptureConfig({ v2Enabled: true, fragmentsEnabled: false }), prd, tempDir);
      _completionDeps.savePRD = mock(async () => {});
      const writeMock = mock(async () => {});
      _completionDeps.writeFragment = writeMock;
      _completionDeps.getDiffText = mock(async () => "");

      await completionStage.execute(ctx);

      expect(writeMock).not.toHaveBeenCalled();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3 — v2.enabled = false
// ─────────────────────────────────────────────────────────────────────────────

describe("completionStage — fragment capture (AC3)", () => {
  test("writeFragment is NOT invoked when context.v2.enabled is false", async () => {
    await withTempDir(async (tempDir) => {
      const story = makeStoryWithDefaults({ id: "US-001" });
      const prd = makePRDWithStory(story);
      const ctx = makeCtx(fragmentCaptureConfig({ v2Enabled: false, fragmentsEnabled: true }), prd, tempDir);
      _completionDeps.savePRD = mock(async () => {});
      const writeMock = mock(async () => {});
      _completionDeps.writeFragment = writeMock;
      _completionDeps.getDiffText = mock(async () => "");

      await completionStage.execute(ctx);

      expect(writeMock).not.toHaveBeenCalled();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC4–6 — body contents
// ─────────────────────────────────────────────────────────────────────────────

describe("completionStage — fragment capture body (AC4–6)", () => {
  test("body includes the story title", async () => {
    await withTempDir(async (tempDir) => {
      const story = makeStoryWithDefaults({
        id: "US-001",
        title: "Add the fragment store",
        acceptanceCriteria: ["AC1", "AC2"],
      });
      const prd = makePRDWithStory(story);
      const ctx = makeCtx(fragmentCaptureConfig(), prd, tempDir);
      _completionDeps.savePRD = mock(async () => {});
      const writeMock = mock(async () => {});
      _completionDeps.writeFragment = writeMock;
      _completionDeps.getDiffText = mock(async () => "");

      await completionStage.execute(ctx);

      expect(writeMock).toHaveBeenCalledTimes(1);
      const calls = writeMock.mock.calls as unknown as Array<[string, string, string, string, number]>;
      const body = calls[0]?.[3];
      expect(body).toContain("Add the fragment store");
    });
  });

  test("body includes each acceptance criterion", async () => {
    await withTempDir(async (tempDir) => {
      const story = makeStoryWithDefaults({
        id: "US-001",
        title: "Story",
        acceptanceCriteria: ["First criterion", "Second criterion", "Third criterion"],
      });
      const prd = makePRDWithStory(story);
      const ctx = makeCtx(fragmentCaptureConfig(), prd, tempDir);
      _completionDeps.savePRD = mock(async () => {});
      const writeMock = mock(async () => {});
      _completionDeps.writeFragment = writeMock;
      _completionDeps.getDiffText = mock(async () => "");

      await completionStage.execute(ctx);

      expect(writeMock).toHaveBeenCalledTimes(1);
      const calls = writeMock.mock.calls as unknown as Array<[string, string, string, string, number]>;
      const body = calls[0]?.[3];
      expect(body).toContain("First criterion");
      expect(body).toContain("Second criterion");
      expect(body).toContain("Third criterion");
    });
  });

  test("body names each changed file reported by the diff", async () => {
    await withTempDir(async (tempDir) => {
      const story = makeStoryWithDefaults({ id: "US-001", title: "Story", acceptanceCriteria: ["c"] });
      const prd = makePRDWithStory(story);
      const ctx = makeCtx(fragmentCaptureConfig(), prd, tempDir);
      _completionDeps.savePRD = mock(async () => {});

      const diff = [
        "diff --git a/src/foo.ts b/src/foo.ts",
        "index 1234..5678 100644",
        "--- a/src/foo.ts",
        "+++ b/src/foo.ts",
        "@@ -1,3 +1,4 @@",
        " line",
        "+added",
        "diff --git a/src/bar.ts b/src/bar.ts",
        "index 1234..5678 100644",
        "--- a/src/bar.ts",
        "+++ b/src/bar.ts",
        "@@ -1,3 +1,4 @@",
        " line",
        "+added",
      ].join("\n");

      const writeMock = mock(async () => {});
      _completionDeps.writeFragment = writeMock;
      _completionDeps.getDiffText = mock(async () => diff);

      await completionStage.execute(ctx);

      expect(writeMock).toHaveBeenCalledTimes(1);
      const calls = writeMock.mock.calls as unknown as Array<[string, string, string, string, number]>;
      const body = calls[0]?.[3];
      expect(body).toContain("src/foo.ts");
      expect(body).toContain("src/bar.ts");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC7 — writeFragment failures fail open
// ─────────────────────────────────────────────────────────────────────────────

describe("completionStage — fragment capture fail-open (AC7)", () => {
  test("writeFragment raising → execute resolves with { action: 'continue' } and marks the story passed", async () => {
    await withTempDir(async (tempDir) => {
      const story = makeStoryWithDefaults({ id: "US-001" });
      const prd = makePRDWithStory(story);
      const ctx = makeCtx(fragmentCaptureConfig(), prd, tempDir);
      _completionDeps.savePRD = mock(async () => {});

      const logger = getLogger();
      const debugSpy = spyOn(logger, "debug").mockImplementation(() => {});
      spyOn(logger, "info").mockImplementation(() => {});
      spyOn(logger, "warn").mockImplementation(() => {});
      spyOn(logger, "error").mockImplementation(() => {});

      const boom = new Error("disk full");
      _completionDeps.writeFragment = mock(async () => {
        throw boom;
      });
      _completionDeps.getDiffText = mock(async () => "");

      const result = await completionStage.execute(ctx);

      expect(result.action).toBe("continue");
      expect(ctx.prd.userStories[0]!.status).toBe("passed");
      const debugCalls = debugSpy.mock.calls;
      const fragmentCall = debugCalls.find((c) => typeof c[1] === "string" && c[1].includes("Fragment"));
      expect(fragmentCall).toBeDefined();
      const data = fragmentCall?.[2] as Record<string, unknown> | undefined;
      expect(data?.error).toBe(errorMessage(boom));

      debugSpy.mockRestore();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC8 — running twice captures twice
// ─────────────────────────────────────────────────────────────────────────────

describe("completionStage — fragment capture on re-run (AC8)", () => {
  test("writeFragment is invoked twice when completionStage runs twice for the same story", async () => {
    await withTempDir(async (tempDir) => {
      const story = makeStoryWithDefaults({ id: "US-001" });
      const prd = makePRDWithStory(story);
      const ctx = makeCtx(fragmentCaptureConfig(), prd, tempDir);
      _completionDeps.savePRD = mock(async () => {});
      const writeMock = mock(async () => {});
      _completionDeps.writeFragment = writeMock;
      _completionDeps.getDiffText = mock(async () => "");

      await completionStage.execute(ctx);
      // Reset story status so the second run exercises the same code path.
      ctx.prd.userStories[0]!.status = "in-progress";
      ctx.prd.userStories[0]!.passes = false;

      await completionStage.execute(ctx);

      expect(writeMock).toHaveBeenCalledTimes(2);
      const calls = writeMock.mock.calls as unknown as Array<[string, string, string, string, number]>;
      expect(calls[0]?.[2]).toBe("US-001");
      expect(calls[1]?.[2]).toBe("US-001");
    });
  });
});
