/**
 * Unit tests for ReviewOrchestrator — pluginMode deferred behavior (DR-002)
 *
 * Covers:
 * - pluginMode "deferred": plugin reviewers NOT called
 * - pluginMode "deferred": built-in checks still run
 * - pluginMode "deferred": returns success (built-in passes, plugins skipped)
 * - pluginMode "deferred": built-in failure still propagates
 * - pluginMode "per-story": plugin reviewers run (no regression)
 * - pluginMode undefined: plugin reviewers run (no regression)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { NaxConfig } from "../../../src/config";
import type { PluginRegistry } from "../../../src/plugins";
import type { IReviewPlugin } from "../../../src/plugins/extensions";
import { ReviewOrchestrator, _orchestratorDeps } from "../../../src/review/orchestrator";
import type { AdversarialReviewConfig } from "../../../src/review/types";
import { _reviewAdversarialDeps, _reviewGitDeps as _runnerDeps, _reviewSemanticDeps } from "../../../src/review/runner";
import type { ReviewCheckResult, ReviewConfig } from "../../../src/review/types";
import { withDepsRestore } from "../../helpers/deps";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

withDepsRestore(_runnerDeps, ["getUncommittedFiles"]);
withDepsRestore(_orchestratorDeps, ["spawn", "runSemanticReview", "runAdversarialReview"]);
withDepsRestore(_reviewSemanticDeps, ["runSemanticReview"]);
withDepsRestore(_reviewAdversarialDeps, ["runAdversarialReview"]);

function makeReviewConfig(pluginMode?: "per-story" | "deferred"): ReviewConfig {
  // pluginMode is added by DR-001 — cast until the type is updated
  return {
    enabled: true,
    checks: [],
    commands: {},
    pluginMode,
  } as unknown as ReviewConfig;
}

function makeReviewer(name: string, passed = true): IReviewPlugin {
  return {
    name,
    description: `Test reviewer: ${name}`,
    check: mock(async (_workdir: string, _files: string[]) => ({
      passed,
      output: passed ? "" : "findings found",
      exitCode: passed ? 0 : 1,
    })),
  };
}

function makeRegistry(reviewers: IReviewPlugin[]): PluginRegistry {
  return {
    getReviewers: mock(() => reviewers),
  } as unknown as PluginRegistry;
}

const minimalExecConfig = {} as unknown as NaxConfig["execution"];

beforeEach(() => {
  // Stub git dirty check: clean tree → runReview proceeds without blocking
  _runnerDeps.getUncommittedFiles = mock(async () => []);
  // Stub git diff in orchestrator: no changed files (prevents real git calls)
  _orchestratorDeps.spawn = mock(() => ({
    exited: Promise.resolve(0),
    stdout: new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(""));
        c.close();
      },
    }),
    stderr: new ReadableStream({ start(c) { c.close(); } }),
  })) as unknown as typeof _orchestratorDeps.spawn;
});

afterEach(() => {
  mock.restore();
});

// ─────────────────────────────────────────────────────────────────────────────
// pluginMode === "deferred"
// ─────────────────────────────────────────────────────────────────────────────

describe("ReviewOrchestrator — pluginMode deferred", () => {
  test("does NOT call plugin reviewer check() when pluginMode is deferred", async () => {
    const reviewer = makeReviewer("semgrep");
    const registry = makeRegistry([reviewer]);
    const orchestrator = new ReviewOrchestrator();

    await orchestrator.review(makeReviewConfig("deferred"), "/tmp/workdir", minimalExecConfig, registry);

    expect(reviewer.check).not.toHaveBeenCalled();
  });

  test("returns success when built-in checks pass and pluginMode is deferred", async () => {
    const registry = makeRegistry([makeReviewer("semgrep", false)]);
    const orchestrator = new ReviewOrchestrator();

    const result = await orchestrator.review(
      makeReviewConfig("deferred"),
      "/tmp/workdir",
      minimalExecConfig,
      registry,
    );

    expect(result.success).toBe(true);
    expect(result.pluginFailed).toBe(false);
  });

  test("does NOT set pluginFailed when pluginMode is deferred (even with failing reviewers registered)", async () => {
    const registry = makeRegistry([makeReviewer("semgrep", false), makeReviewer("license", false)]);
    const orchestrator = new ReviewOrchestrator();

    const result = await orchestrator.review(
      makeReviewConfig("deferred"),
      "/tmp/workdir",
      minimalExecConfig,
      registry,
    );

    expect(result.pluginFailed).toBe(false);
  });

  test("propagates built-in failure when pluginMode is deferred", async () => {
    // Built-in failure: simulate dirty working tree (triggers runner failure)
    _runnerDeps.getUncommittedFiles = mock(async () => ["src/changed.ts"]);
    const registry = makeRegistry([makeReviewer("semgrep")]);
    const orchestrator = new ReviewOrchestrator();

    const result = await orchestrator.review(
      makeReviewConfig("deferred"),
      "/tmp/workdir",
      minimalExecConfig,
      registry,
    );

    expect(result.success).toBe(false);
    expect(result.pluginFailed).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pluginMode === "per-story" (no regression)
// ─────────────────────────────────────────────────────────────────────────────

describe("ReviewOrchestrator — pluginMode per-story (no regression)", () => {
  test("calls plugin reviewer check() when pluginMode is per-story", async () => {
    const reviewer = makeReviewer("semgrep");
    const registry = makeRegistry([reviewer]);
    const orchestrator = new ReviewOrchestrator();

    await orchestrator.review(makeReviewConfig("per-story"), "/tmp/workdir", minimalExecConfig, registry);

    expect(reviewer.check).toHaveBeenCalledTimes(1);
  });

  test("returns pluginFailed true when reviewer fails and pluginMode is per-story", async () => {
    const registry = makeRegistry([makeReviewer("semgrep", false)]);
    const orchestrator = new ReviewOrchestrator();

    const result = await orchestrator.review(
      makeReviewConfig("per-story"),
      "/tmp/workdir",
      minimalExecConfig,
      registry,
    );

    expect(result.success).toBe(false);
    expect(result.pluginFailed).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pluginMode undefined (no regression — treated as per-story)
// ─────────────────────────────────────────────────────────────────────────────

describe("ReviewOrchestrator — pluginMode undefined (no regression)", () => {
  test("calls plugin reviewer check() when pluginMode is undefined", async () => {
    const reviewer = makeReviewer("license-check");
    const registry = makeRegistry([reviewer]);
    const orchestrator = new ReviewOrchestrator();

    await orchestrator.review(makeReviewConfig(undefined), "/tmp/workdir", minimalExecConfig, registry);

    expect(reviewer.check).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mechanical / LLM isolation (nathapp-io/nax#405)
// ─────────────────────────────────────────────────────────────────────────────

function makeSemanticCheckResult(passed: boolean): ReviewCheckResult {
  return {
    check: "semantic",
    success: passed,
    command: "semantic-review",
    exitCode: passed ? 0 : 1,
    output: passed ? "" : "AC compliance issue",
    durationMs: 100,
  };
}

function makeConfigWithSemantic(mechanicalChecks: string[] = ["lint"]): ReviewConfig {
  return {
    enabled: true,
    checks: [...mechanicalChecks, "semantic"],
    commands: { lint: "biome check" },
    pluginMode: "deferred",
  } as unknown as ReviewConfig;
}

describe("ReviewOrchestrator — mechanical / LLM isolation (#405)", () => {
  beforeEach(() => {
    // Default: semantic passes
    _reviewSemanticDeps.runSemanticReview = mock(async () => makeSemanticCheckResult(true));
    _reviewAdversarialDeps.runAdversarialReview = mock(async () => makeSemanticCheckResult(true));
  });

  test("semantic review runs even when mechanical check fails", async () => {
    // Simulate lint failure via dirty tree (forces runner to fail before running checks)
    // Then override runner so lint actually fails
    _runnerDeps.getUncommittedFiles = mock(async () => []);
    // No lint command configured so it will be skipped — use a failing typecheck instead
    const config: ReviewConfig = {
      enabled: true,
      checks: ["semantic"],
      commands: {},
      pluginMode: "deferred",
    } as unknown as ReviewConfig;

    // With no mechanical checks, semantic should still run
    const orchestrator = new ReviewOrchestrator();
    const result = await orchestrator.review(config, "/tmp/workdir", minimalExecConfig);

    expect(_reviewSemanticDeps.runSemanticReview).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  test("mechanicalFailedOnly is true when mechanical fails but semantic passes", async () => {
    // Dirty tree on the first call (mechanical run) → mechanical fails.
    // Clean on the second call (LLM run) → LLM proceeds and runs semantic.
    let callCount = 0;
    _runnerDeps.getUncommittedFiles = mock(async () => {
      callCount++;
      return callCount === 1 ? ["src/changed.ts"] : [];
    });
    const orchestrator = new ReviewOrchestrator();

    const result = await orchestrator.review(
      makeConfigWithSemantic(["lint"]),
      "/tmp/workdir",
      minimalExecConfig,
    );

    // Mechanical failed (dirty tree), semantic mocked to pass
    expect(result.success).toBe(false);
    expect(result.mechanicalFailedOnly).toBe(true);
    // Semantic should have been attempted despite mechanical failure
    expect(_reviewSemanticDeps.runSemanticReview).toHaveBeenCalledTimes(1);
  });

  test("mechanicalFailedOnly is false when semantic also fails", async () => {
    // Same call-counter trick: dirty for mechanical, clean for LLM so semantic actually runs.
    let callCount = 0;
    _runnerDeps.getUncommittedFiles = mock(async () => {
      callCount++;
      return callCount === 1 ? ["src/changed.ts"] : [];
    });
    _reviewSemanticDeps.runSemanticReview = mock(async () => makeSemanticCheckResult(false));
    const orchestrator = new ReviewOrchestrator();

    const result = await orchestrator.review(
      makeConfigWithSemantic(["lint"]),
      "/tmp/workdir",
      minimalExecConfig,
    );

    expect(result.success).toBe(false);
    expect(result.mechanicalFailedOnly).toBe(false);
  });

  test("mechanicalFailedOnly is undefined when no LLM checks configured", async () => {
    _runnerDeps.getUncommittedFiles = mock(async () => ["src/changed.ts"]);
    const config: ReviewConfig = {
      enabled: true,
      checks: ["lint"],
      commands: { lint: "biome check" },
      pluginMode: "deferred",
    } as unknown as ReviewConfig;
    const orchestrator = new ReviewOrchestrator();

    const result = await orchestrator.review(config, "/tmp/workdir", minimalExecConfig);

    expect(result.mechanicalFailedOnly).toBeUndefined();
  });

  test("both mechanical and semantic results appear in checks array", async () => {
    _runnerDeps.getUncommittedFiles = mock(async () => []);
    // No mechanical commands → mechanical phase produces no checks; semantic passes
    const config: ReviewConfig = {
      enabled: true,
      checks: ["semantic"],
      commands: {},
      pluginMode: "deferred",
    } as unknown as ReviewConfig;
    const orchestrator = new ReviewOrchestrator();

    const result = await orchestrator.review(config, "/tmp/workdir", minimalExecConfig);

    const checkNames = result.builtIn.checks.map((c) => c.check);
    expect(checkNames).toContain("semantic");
    expect(result.success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// retrySkipChecks — parallel LLM dispatch (#136 / issue-9)
// ─────────────────────────────────────────────────────────────────────────────

function makeParallelConfig(): ReviewConfig {
  return {
    enabled: true,
    checks: ["semantic", "adversarial"],
    commands: {},
    pluginMode: "deferred",
    adversarial: {
      enabled: true,
      parallel: true,
      maxConcurrentSessions: 2,
    } as unknown as AdversarialReviewConfig,
  } as unknown as ReviewConfig;
}

function makePassedCheck(check: "semantic" | "adversarial"): ReviewCheckResult {
  return { check, success: true, command: "", exitCode: 0, output: "", durationMs: 50 };
}

function makeFailedCheck(check: "semantic" | "adversarial"): ReviewCheckResult {
  return { check, success: false, command: "", exitCode: 1, output: `${check} failed`, durationMs: 50 };
}

describe("ReviewOrchestrator — retrySkipChecks in parallel LLM dispatch (#136)", () => {
  beforeEach(() => {
    _runnerDeps.getUncommittedFiles = mock(async () => []);
    _orchestratorDeps.runSemanticReview = mock(async () => makePassedCheck("semantic"));
    _orchestratorDeps.runAdversarialReview = mock(async () => makePassedCheck("adversarial"));
  });

  test("skips both LLM reviewers when both are in retrySkipChecks", async () => {
    const orchestrator = new ReviewOrchestrator();
    const retrySkipChecks = new Set(["semantic", "adversarial"]);

    const result = await orchestrator.review(
      makeParallelConfig(),
      "/tmp/workdir",
      minimalExecConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      retrySkipChecks,
    );

    expect(_orchestratorDeps.runSemanticReview).not.toHaveBeenCalled();
    expect(_orchestratorDeps.runAdversarialReview).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  test("skips only semantic when semantic is in retrySkipChecks — adversarial runs via sequential path", async () => {
    // Only adversarial is active → canParallelize condition (needs both) fails → sequential path.
    // Sequential path calls _reviewAdversarialDeps.runAdversarialReview (runner.ts), not _orchestratorDeps.
    _reviewAdversarialDeps.runAdversarialReview = mock(async () => makePassedCheck("adversarial"));
    const orchestrator = new ReviewOrchestrator();
    const retrySkipChecks = new Set(["semantic"]);

    await orchestrator.review(
      makeParallelConfig(),
      "/tmp/workdir",
      minimalExecConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      retrySkipChecks,
    );

    expect(_orchestratorDeps.runSemanticReview).not.toHaveBeenCalled();
    expect(_orchestratorDeps.runAdversarialReview).not.toHaveBeenCalled();
    expect(_reviewAdversarialDeps.runAdversarialReview).toHaveBeenCalledTimes(1);
  });

  test("skips only adversarial when adversarial is in retrySkipChecks — semantic runs via sequential path", async () => {
    // Only semantic is active → canParallelize condition (needs both) fails → sequential path.
    // Sequential path calls _reviewSemanticDeps.runSemanticReview (runner.ts), not _orchestratorDeps.
    _reviewSemanticDeps.runSemanticReview = mock(async () => makePassedCheck("semantic"));
    const orchestrator = new ReviewOrchestrator();
    const retrySkipChecks = new Set(["adversarial"]);

    await orchestrator.review(
      makeParallelConfig(),
      "/tmp/workdir",
      minimalExecConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      retrySkipChecks,
    );

    expect(_orchestratorDeps.runAdversarialReview).not.toHaveBeenCalled();
    expect(_orchestratorDeps.runSemanticReview).not.toHaveBeenCalled();
    expect(_reviewSemanticDeps.runSemanticReview).toHaveBeenCalledTimes(1);
  });

  test("runs both reviewers when retrySkipChecks is empty", async () => {
    const orchestrator = new ReviewOrchestrator();

    await orchestrator.review(
      makeParallelConfig(),
      "/tmp/workdir",
      minimalExecConfig,
    );

    expect(_orchestratorDeps.runSemanticReview).toHaveBeenCalledTimes(1);
    expect(_orchestratorDeps.runAdversarialReview).toHaveBeenCalledTimes(1);
  });

  test("runs both reviewers when retrySkipChecks does not include LLM checks", async () => {
    const orchestrator = new ReviewOrchestrator();
    const retrySkipChecks = new Set(["lint", "build"]);

    await orchestrator.review(
      makeParallelConfig(),
      "/tmp/workdir",
      minimalExecConfig,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      retrySkipChecks,
    );

    expect(_orchestratorDeps.runSemanticReview).toHaveBeenCalledTimes(1);
    expect(_orchestratorDeps.runAdversarialReview).toHaveBeenCalledTimes(1);
  });

  test("aggregates failureReason across multiple failing LLM reviewers", async () => {
    _orchestratorDeps.runSemanticReview = mock(async () => makeFailedCheck("semantic"));
    _orchestratorDeps.runAdversarialReview = mock(async () => makeFailedCheck("adversarial"));
    const orchestrator = new ReviewOrchestrator();

    const result = await orchestrator.review(
      makeParallelConfig(),
      "/tmp/workdir",
      minimalExecConfig,
    );

    expect(result.success).toBe(false);
    expect(result.failureReason).toBe("semantic failed, adversarial failed");
    expect(result.builtIn.failureReason).toBe("semantic failed, adversarial failed");
  });
});
