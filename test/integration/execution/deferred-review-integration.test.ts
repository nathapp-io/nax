/**
 * Integration test for DR-003: Deferred plugin review runs once at end of run
 *
 * Verifies that when pluginMode is "deferred":
 * 1. Plugin reviewers are NOT called during per-story review stages
 * 2. Plugin reviewers are called ONCE after all stories complete
 * 3. The diff range covers run-start ref to HEAD (full run diff)
 * 4. Reviewer failures do NOT fail the overall run
 * 5. When no reviewers are registered, deferred review is silently skipped
 *
 * Uses executeUnified directly with mocked deps to avoid spawning real agents.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NaxConfig } from "../../../src/config";
import { _deferredReviewDeps } from "../../../src/execution/deferred-review";
import type { SequentialExecutionContext } from "../../../src/execution/executor-types";
import { executeUnified } from "../../../src/execution/unified-executor";
import type { PluginRegistry } from "../../../src/plugins";
import type { IReviewPlugin } from "../../../src/plugins/extensions";
import type { PRD } from "../../../src/prd/types";
import { makeTempDir } from "../../helpers/temp";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const HEAD_REF = "cafebabe1234567890abcdef1234567890abcdef";

function makeCompletedPRD(): PRD {
  return {
    feature: "test-feature",
    userStories: [
      {
        id: "US-001",
        title: "Test story",
        description: "Already done",
        acceptanceCriteria: [],
        dependencies: [],
        tags: [],
        status: "passed",
        passes: true,
        escalations: [],
        attempts: 1,
      },
    ],
  } as unknown as PRD;
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
  return {
    getReviewers: mock(() => reviewers),
    getReporters: mock(() => []),
    getOptimizers: mock(() => []),
    getRouters: mock(() => []),
    getContextProviders: mock(() => []),
    plugins: [],
  } as unknown as PluginRegistry;
}

function makeStatusWriter() {
  return {
    setPrd: mock(() => {}),
    setRunStatus: mock(() => {}),
    setCurrentStory: mock(() => {}),
    update: mock(async () => {}),
    writeFeatureStatus: mock(async () => {}),
  };
}

function makeConfig(pluginMode?: "per-story" | "deferred"): NaxConfig {
  return {
    autoMode: {
      defaultAgent: "claude-code",
      complexityRouting: { simple: "fast", medium: "balanced", complex: "powerful", expert: "powerful" },
      escalation: { enabled: false, tierOrder: [] },
    },
    models: {
      fast: { provider: "anthropic", modelName: "claude-3-5-haiku-20241022" },
      balanced: { provider: "anthropic", modelName: "claude-3-5-sonnet-20241022" },
      powerful: { provider: "anthropic", modelName: "claude-3-7-sonnet-20250219" },
    },
    execution: { maxIterations: 5, costLimit: 100, iterationDelayMs: 0, maxStoriesPerFeature: 100 },
    routing: { strategy: "simple" },
    tdd: { mode: "standard", testStrategy: "test-after", testCommand: "echo ok" },
    quality: { commands: {} },
    acceptance: { enabled: false, testCommand: "", maxRetries: 0 },
    analyze: { model: "balanced", maxContextTokens: 100000 },
    plugins: [],
    review: {
      enabled: false,
      checks: [],
      commands: {},
      pluginMode,
    },
  } as unknown as NaxConfig;
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
  _deferredReviewDeps.spawn = mock((opts: { cmd: string[] }) => {
    const isRevParse = opts.cmd.includes("rev-parse");
    const output = isRevParse ? HEAD_REF : "src/changed.ts\nsrc/other.ts";
    return {
      exited: Promise.resolve(0),
      stdout: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`${output}\n`));
          c.close();
        },
      }),
      stderr: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
    };
  }) as unknown as typeof _deferredReviewDeps.spawn;
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
    runtime: { outputDir: "/tmp/nax-test-deferred-review-output" } as unknown as SequentialExecutionContext["runtime"],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DR-003 Integration Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Deferred plugin review — integration (DR-003)", () => {
  test("plugin reviewers run exactly once after all stories complete when pluginMode is deferred", async () => {
    await writeCompletedPRD();
    const reviewer = makeReviewer("semgrep", true);
    const registry = makeRegistry([reviewer]);
    const config = makeConfig("deferred");
    const ctx = makeCtx(registry, config);

    const result = await executeUnified(ctx, makeCompletedPRD());

    // Reviewer should be called exactly once (at end, not per-story)
    expect(reviewer.check).toHaveBeenCalledTimes(1);
    expect(result.exitReason).toBe("completed");
  });

  test("plugin reviewers are NOT called during per-story review when pluginMode is deferred", async () => {
    // With a pre-completed PRD, the story loop exits immediately
    // The reviewer should only be called during the deferred phase, not the per-story phase
    await writeCompletedPRD();
    const reviewer = makeReviewer("semgrep", true);
    const registry = makeRegistry([reviewer]);
    const config = makeConfig("deferred");
    const ctx = makeCtx(registry, config);

    await executeUnified(ctx, makeCompletedPRD());

    // Called exactly once (deferred), not 0 or 2+
    expect(reviewer.check).toHaveBeenCalledTimes(1);
  });

  test("reviewer failure in deferred mode does NOT fail the overall run", async () => {
    await writeCompletedPRD();
    const failingReviewer = makeReviewer("semgrep", false);
    const registry = makeRegistry([failingReviewer]);
    const config = makeConfig("deferred");
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
    const config = makeConfig("deferred");
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
    const config = makeConfig("deferred");
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
    const config = makeConfig("deferred");
    const ctx = makeCtx(registry, config);

    const result = await executeUnified(ctx, makeCompletedPRD());

    // Should complete without error
    expect(result.exitReason).toBe("completed");
    // deferredReview should be undefined (silently skipped)
    expect(result.deferredReview).toBeUndefined();
  });

  test("pluginMode per-story does NOT trigger deferred review", async () => {
    await writeCompletedPRD();
    const reviewer = makeReviewer("semgrep", true);
    const registry = makeRegistry([reviewer]);
    const config = makeConfig("per-story");
    const ctx = makeCtx(registry, config);

    const result = await executeUnified(ctx, makeCompletedPRD());

    // deferredReview should not be set for per-story mode
    expect(result.deferredReview).toBeUndefined();
  });

  test("run-start git ref is captured before stories execute", async () => {
    await writeCompletedPRD();
    const captureOrder: string[] = [];

    // Track spawn calls to verify rev-parse happens before diff
    _deferredReviewDeps.spawn = mock((opts: { cmd: string[] }) => {
      if (opts.cmd.includes("rev-parse")) {
        captureOrder.push("rev-parse");
      } else if (opts.cmd.includes("diff")) {
        captureOrder.push("diff");
      }
      const output = opts.cmd.includes("rev-parse") ? HEAD_REF : "src/file.ts";
      return {
        exited: Promise.resolve(0),
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(`${output}\n`));
            c.close();
          },
        }),
        stderr: new ReadableStream({
          start(c) {
            c.close();
          },
        }),
      };
    }) as unknown as typeof _deferredReviewDeps.spawn;

    const reviewer = makeReviewer("semgrep", true);
    const registry = makeRegistry([reviewer]);
    const config = makeConfig("deferred");
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
