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
const origGetDiffFilePaths = _completionDeps.getDiffFilePaths;
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
  _completionDeps.getDiffFilePaths = origGetDiffFilePaths;
  _completionDeps.savePRD = origSavePRD;
  _completionDeps.checkReviewGate = origCheckReviewGate;
  _completionDeps.spawn = origSpawn;
});

afterEach(() => {
  _completionDeps.writeFragment = origWriteFragment;
  _completionDeps.renderFragmentBody = origRenderFragmentBody;
  _completionDeps.getDiffText = origGetDiffText;
  _completionDeps.getDiffFilePaths = origGetDiffFilePaths;
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
      _completionDeps.getDiffFilePaths = mock(async () => new Set<string>());

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
      _completionDeps.getDiffFilePaths = mock(async () => new Set<string>());

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
      _completionDeps.getDiffFilePaths = mock(async () => new Set<string>());

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
      _completionDeps.getDiffFilePaths = mock(async () => new Set<string>());

      await completionStage.execute(ctx);

      expect(writeMock).toHaveBeenCalledTimes(1);
      const calls = (writeMock.mock.calls as any[]);
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
      _completionDeps.getDiffFilePaths = mock(async () => new Set<string>());

      await completionStage.execute(ctx);

      expect(writeMock).toHaveBeenCalledTimes(1);
      const calls = (writeMock.mock.calls as any[]);
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

      const writeMock = mock(async () => {});
      _completionDeps.writeFragment = writeMock;
      _completionDeps.getDiffFilePaths = mock(async () => new Set(["src/foo.ts", "src/bar.ts"]));

      await completionStage.execute(ctx);

      expect(writeMock).toHaveBeenCalledTimes(1);
      const calls = (writeMock.mock.calls as any[]);
      const body = calls[0]?.[3];
      expect(body).toContain("src/foo.ts");
      expect(body).toContain("src/bar.ts");
    });
  });

  test("body names each deleted file reported by the diff (AC6)", async () => {
    // `git diff --name-only` includes deleted files alongside modified and new
    // ones — the fragment body must surface the deleted path (US-002 AC6).
    await withTempDir(async (tempDir) => {
      const story = makeStoryWithDefaults({ id: "US-001", title: "Story", acceptanceCriteria: ["c"] });
      const prd = makePRDWithStory(story);
      const ctx = makeCtx(fragmentCaptureConfig(), prd, tempDir);
      _completionDeps.savePRD = mock(async () => {});

      const writeMock = mock(async () => {});
      _completionDeps.writeFragment = writeMock;
      _completionDeps.getDiffFilePaths = mock(
        async () => new Set(["src/foo.ts", "src/gone.ts", "src/new.ts"]),
      );

      await completionStage.execute(ctx);

      expect(writeMock).toHaveBeenCalledTimes(1);
      const calls = (writeMock.mock.calls as any[]);
      const body = calls[0]?.[3];
      expect(body).toContain("src/foo.ts");
      expect(body).toContain("src/gone.ts");
      expect(body).toContain("src/new.ts");
    });
  });

  test("body names every changed file for arbitrarily large diffs (AC6)", async () => {
    // Earlier revisions read the full diff text under a per-stream prefix
    // (8 KiB, then 1 MiB), and the reviewer correctly noted that any finite
    // character cap can drop file headers. US-002 now uses
    // `git diff --name-only` for fragment capture, so the only bound is
    // file count — AC6 is satisfied regardless of how large the diff is.
    // This test exercises that contract with a multi-thousand-file diff.
    await withTempDir(async (tempDir) => {
      const story = makeStoryWithDefaults({ id: "US-001", title: "Story", acceptanceCriteria: ["c"] });
      const prd = makePRDWithStory(story);
      const ctx = makeCtx(fragmentCaptureConfig(), prd, tempDir);
      _completionDeps.savePRD = mock(async () => {});

      // 5,000 changed paths — far beyond any plausible character cap and
      // bigger than any realistic story diff.
      const paths = new Set<string>();
      for (let i = 0; i < 5_000; i++) {
        paths.add(`src/file-${i.toString().padStart(4, "0")}.ts`);
      }

      const writeMock = mock(async () => {});
      _completionDeps.writeFragment = writeMock;
      _completionDeps.getDiffFilePaths = mock(async () => paths);

      await completionStage.execute(ctx);

      expect(writeMock).toHaveBeenCalledTimes(1);
      const calls = (writeMock.mock.calls as any[]);
      const body = calls[0]?.[3] as string;
      // Spot-check the first and last file paths appear in the body.
      expect(body).toContain("src/file-0000.ts");
      expect(body).toContain("src/file-4999.ts");
      // And a middle one, to make sure iteration didn't stop early.
      expect(body).toContain("src/file-2500.ts");
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
      const infoSpy = spyOn(logger, "info").mockImplementation(() => {});
      const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
      const errorSpy = spyOn(logger, "error").mockImplementation(() => {});

      try {
        const boom = new Error("disk full");
        _completionDeps.writeFragment = mock(async () => {
          throw boom;
        });
        _completionDeps.getDiffFilePaths = mock(async () => new Set<string>());

        const result = await completionStage.execute(ctx);

        expect(result.action).toBe("continue");
        expect(ctx.prd.userStories[0]!.status).toBe("passed");
        const debugCalls = debugSpy.mock.calls;
        const fragmentCall = debugCalls.find((c) => typeof c[1] === "string" && c[1].includes("Fragment"));
        expect(fragmentCall).toBeDefined();
        const data = fragmentCall?.[2] as Record<string, unknown> | undefined;
        expect(data?.error).toBe(errorMessage(boom));
      } finally {
        debugSpy.mockRestore();
        infoSpy.mockRestore();
        warnSpy.mockRestore();
        errorSpy.mockRestore();
      }
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
      _completionDeps.getDiffFilePaths = mock(async () => new Set<string>());

      await completionStage.execute(ctx);
      // Reset story status so the second run exercises the same code path.
      ctx.prd.userStories[0]!.status = "in-progress";
      ctx.prd.userStories[0]!.passes = false;

      await completionStage.execute(ctx);

      expect(writeMock).toHaveBeenCalledTimes(2);
      const calls = (writeMock.mock.calls as any[]);
      expect(calls[0]?.[2]).toBe("US-001");
      expect(calls[1]?.[2]).toBe("US-001");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC6 (rectification) — getDiffFilePaths reads `--name-only` output in full.
// The semantic reviewer flagged that a 1 MiB character cap on the --name-only
// stream drops paths past the prefix, breaking AC6's "every changed file"
// contract. This test proves the read is bounded by file count, not content.
// ─────────────────────────────────────────────────────────────────────────────

describe("completionStage — getDiffFilePaths reads --name-only output in full (AC6)", () => {
  test("retains every path when --name-only output exceeds MAX_DIFF_TEXT_CHARS (1 MiB)", async () => {
    const encoder = new TextEncoder();
    // 60,000 paths × 18 chars ≈ 1.08 MiB — past the 1 MiB diff-text cap. A
    // capped read would drop every path after ~58,250 lines; the full read
    // keeps all 60,000.
    const pathCount = 60_000;
    const output = Array.from({ length: pathCount }, (_, i) => `src/file-${i.toString().padStart(5, "0")}.ts\n`).join("");
    expect(output.length).toBeGreaterThan(1_048_576);

    _completionDeps.spawn = (() => ({
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(output));
          controller.close();
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      exited: Promise.resolve(0),
    })) as unknown as typeof _completionDeps.spawn;

    const paths = await _completionDeps.getDiffFilePaths("/repo", "base-ref");

    expect(paths.size).toBe(pathCount);
    expect(paths.has("src/file-00000.ts")).toBe(true);
    expect(paths.has(`src/file-${pathCount - 1}.ts`)).toBe(true);
  });

  test("parses paths split across stream chunk boundaries", async () => {
    const encoder = new TextEncoder();
    const paths = ["src/foo.ts", "src/bar.ts", "src/baz.ts"];
    const bytes = encoder.encode(paths.map((p) => `${p}\n`).join(""));
    // Emit 7-byte chunks so every path is split across at least one read,
    // exercising the partial-line carry-over in the streaming reader.
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 7) chunks.push(bytes.slice(i, i + 7));

    let chunkIndex = 0;
    _completionDeps.spawn = (() => ({
      stdout: new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks[chunkIndex++];
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      exited: Promise.resolve(0),
    })) as unknown as typeof _completionDeps.spawn;

    const result = await _completionDeps.getDiffFilePaths("/repo", "base-ref");

    expect(result).toEqual(new Set(paths));
  });
});
