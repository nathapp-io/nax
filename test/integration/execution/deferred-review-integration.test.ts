/**
 * Integration test for DR-003: Deferred plugin review runs once at end of run
 *
 * Deferred IS the plugin-review timing — per-story plugin gating was removed in
 * ADR-023 / #1146, and `review.pluginMode` now selects only whether findings gate
 * the run ("gating") or are observational ("observational"). There is no mode in
 * which reviewers run per-story, so these tests no longer parameterise on one.
 *
 * Verifies:
 * 1. Plugin reviewers are NOT called during per-story review stages
 * 2. Plugin reviewers are called ONCE after all stories complete
 * 3. The diff range covers run-start ref to HEAD (full run diff)
 * 4. Under the default "observational" mode, reviewer failures do NOT fail the run
 * 5. When no reviewers are registered, deferred review is silently skipped
 *
 * Uses executeUnified directly with mocked deps to avoid spawning real agents.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NaxConfig } from "@/config";
import { _deferredReviewDeps } from "@/execution/deferred-review";
import type { SequentialExecutionContext } from "@/execution/executor-types";
import { executeUnified } from "@/execution/unified-executor";
import type { PluginRegistry } from "@/plugins";
import type { IReviewPlugin } from "@/plugins/extensions";
import type { PRD } from "@/prd/types";
import {
  makeNaxConfig,
  makePRD,
  makePluginRegistry,
  makeSpawn,
  makeStatusWriter,
  makeStory,
  makeTempDir,
  makeTestRuntime,
} from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const HEAD_REF = "cafebabe1234567890abcdef1234567890abcdef";

function makeCompletedPRD(): PRD {
  return makePRD({
    feature: "test-feature",
    userStories: [
      makeStory({
        id: "US-001",
        title: "Test story",
        description: "Already done",
        status: "passed",
        passes: true,
        attempts: 1,
      }),
    ],
  });
}

function makeReviewer(name: string, passed = true): IReviewPlugin {
  return {
    name,
    description: `Reviewer: ${name}`,
    check: mock(async () => ({
      passed,
      output: passed ? "" : `findings from ${name}`,
      exitCode: passed ? 0 : 1,
    })),
  };
}

function makeRegistry(reviewers: IReviewPlugin[]): PluginRegistry {
  return makePluginRegistry({ getReviewers: mock(() => reviewers) });
}

function makeConfig(pluginMode?: NaxConfig["review"]["pluginMode"]): NaxConfig {
  return makeNaxConfig({
    execution: { maxIterations: 5, costLimit: 100, iterationDelayMs: 0, maxStoriesPerFeature: 100 },
    // The whole `tdd` block the cast used to carry was fictional — TddConfig has
    // none of `mode`, `testStrategy`, or `testCommand` (it has `strategy`, with
    // different values). Nothing read it, so it is gone rather than translated.
    // AcceptanceConfig likewise has no `testCommand` (it has `command`).
    acceptance: { enabled: false, maxRetries: 0 },
    review: { enabled: false, checks: [], commands: {}, ...(pluginMode ? { pluginMode } : {}) },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup & teardown
// ─────────────────────────────────────────────────────────────────────────────

let workdir: string;
let prdPath: string;
const originalDeferredSpawn = _deferredReviewDeps.spawn;

beforeEach(() => {
  workdir = makeTempDir("nax-deferred-review-integration-");
  prdPath = join(workdir, "prd.json");

  // Default: spawn always returns the HEAD ref for git rev-parse, and diff files for getChangedFiles
  _deferredReviewDeps.spawn = makeSpawn(({ cmd }) =>
    cmd.includes("rev-parse") ? `${HEAD_REF}\n` : "src/changed.ts\nsrc/other.ts\n",
  ).spawn;
});

afterEach(() => {
  mock.restore();
  _deferredReviewDeps.spawn = originalDeferredSpawn;
  try {
    rmSync(workdir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

async function writeCompletedPRD() {
  await Bun.write(prdPath, JSON.stringify(makeCompletedPRD(), null, 2));
}

function makeCtx(registry: PluginRegistry, config: NaxConfig): SequentialExecutionContext {
  const runtime = makeTestRuntime({ config });
  return {
    prdPath,
    workdir,
    config,
    hooks: { hooks: {} },
    feature: "test-feature",
    dryRun: false,
    useBatch: false,
    pluginRegistry: registry,
    statusWriter: makeStatusWriter(),
    runId: "run-test-123",
    startTime: Date.now(),
    batchPlan: [],
    interactionChain: null,
    runtime,
    agentManager: runtime.agentManager,
    sessionManager: runtime.sessionManager,
    abortSignal: new AbortController().signal,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DR-003 Integration Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Deferred plugin review — integration (DR-003)", () => {
  test("plugin reviewers run exactly once after all stories complete", async () => {
    await writeCompletedPRD();
    const reviewer = makeReviewer("semgrep", true);
    const registry = makeRegistry([reviewer]);
    const config = makeConfig();
    const ctx = makeCtx(registry, config);

    const result = await executeUnified(ctx, makeCompletedPRD());

    // Reviewer should be called exactly once (at end, not per-story)
    expect(reviewer.check).toHaveBeenCalledTimes(1);
    expect(result.exitReason).toBe("completed");
  });

  test("plugin reviewers are NOT called during the per-story review stage", async () => {
    // With a pre-completed PRD, the story loop exits immediately
    // The reviewer should only be called during the deferred phase, not the per-story phase
    await writeCompletedPRD();
    const reviewer = makeReviewer("semgrep", true);
    const registry = makeRegistry([reviewer]);
    const config = makeConfig();
    const ctx = makeCtx(registry, config);

    await executeUnified(ctx, makeCompletedPRD());

    // Called exactly once (deferred), not 0 or 2+
    expect(reviewer.check).toHaveBeenCalledTimes(1);
  });

  test("reviewer failure does NOT fail the run under the default observational mode", async () => {
    await writeCompletedPRD();
    const failingReviewer = makeReviewer("semgrep", false);
    const registry = makeRegistry([failingReviewer]);
    // Pinned explicitly: it is "observational", not the deferred timing, that keeps
    // a failing reviewer from failing the run. "gating" would fail it.
    const config = makeConfig("observational");
    const ctx = makeCtx(registry, config);

    const result = await executeUnified(ctx, makeCompletedPRD());

    // Run should still complete successfully despite reviewer failure
    expect(result.exitReason).toBe("completed");
    // deferredReview result records the failure
    expect(result.deferredReview).toBeDefined();
    expect(result.deferredReview?.anyFailed).toBe(true);
  });

  test("deferred review result is available in SequentialExecutionResult for reporters", async () => {
    await writeCompletedPRD();
    const reviewer = makeReviewer("semgrep", true);
    const registry = makeRegistry([reviewer]);
    const config = makeConfig();
    const ctx = makeCtx(registry, config);

    const result = await executeUnified(ctx, makeCompletedPRD());

    expect(result.deferredReview).toBeDefined();
    expect(result.deferredReview?.reviewerResults).toHaveLength(1);
    expect(result.deferredReview?.reviewerResults[0].name).toBe("semgrep");
    expect(result.deferredReview?.anyFailed).toBe(false);
  });

  test("deferred review uses run-start ref as baseRef for full diff range", async () => {
    await writeCompletedPRD();
    const reviewer = makeReviewer("semgrep", true);
    const registry = makeRegistry([reviewer]);
    const config = makeConfig();
    const ctx = makeCtx(registry, config);

    await executeUnified(ctx, makeCompletedPRD());

    // Verify a git diff call was made using a ref as baseRef
    const spawnCalls = (_deferredReviewDeps.spawn as ReturnType<typeof mock>).mock.calls;
    const diffCallWithRef = spawnCalls.find((call) => {
      const cmd = (call[0] as { cmd: string[] }).cmd;
      return cmd.includes("diff") && cmd.some((arg: string) => arg.includes("...HEAD"));
    });
    expect(diffCallWithRef).toBeDefined();
  });

  test("deferred review is silently skipped when no plugin reviewers are registered", async () => {
    await writeCompletedPRD();
    const registry = makeRegistry([]); // no reviewers
    const config = makeConfig();
    const ctx = makeCtx(registry, config);

    const result = await executeUnified(ctx, makeCompletedPRD());

    // Should complete without error
    expect(result.exitReason).toBe("completed");
    // deferredReview should be undefined (silently skipped)
    expect(result.deferredReview).toBeUndefined();
  });

  test("run-start git ref is captured before stories execute", async () => {
    await writeCompletedPRD();
    const captureOrder: string[] = [];

    // Track spawn calls to verify rev-parse happens before diff
    _deferredReviewDeps.spawn = makeSpawn(({ cmd }) => {
      if (cmd.includes("rev-parse")) {
        captureOrder.push("rev-parse");
      } else if (cmd.includes("diff")) {
        captureOrder.push("diff");
      }
      return cmd.includes("rev-parse") ? `${HEAD_REF}\n` : "src/file.ts\n";
    }).spawn;

    const reviewer = makeReviewer("semgrep", true);
    const registry = makeRegistry([reviewer]);
    const config = makeConfig();
    const ctx = makeCtx(registry, config);

    await executeUnified(ctx, makeCompletedPRD());

    // rev-parse (capture ref) must come before diff (use ref for deferred review)
    const revParseIdx = captureOrder.indexOf("rev-parse");
    const diffIdx = captureOrder.indexOf("diff");
    expect(revParseIdx).toBeGreaterThanOrEqual(0);
    expect(diffIdx).toBeGreaterThanOrEqual(0);
    expect(revParseIdx).toBeLessThan(diffIdx);
  });
});
