/**
 * Unit tests for ReviewOrchestrator — pluginMode deferred behavior (DR-002)
 * and featureName forwarding (US-002 AC-3)
 *
 * Covers:
 * - pluginMode "deferred": plugin reviewers NOT called
 * - pluginMode "deferred": built-in checks still run
 * - pluginMode "deferred": returns success (built-in passes, plugins skipped)
 * - pluginMode "deferred": built-in failure still propagates
 * - pluginMode "per-story": plugin reviewers run (no regression)
 * - pluginMode undefined: plugin reviewers run (no regression)
 * - AC-3: review() signature includes featureName? and forwards it to runReview/runSemanticReview
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { NaxConfig } from "../../../src/config";
import type { PluginRegistry } from "../../../src/plugins";
import type { IReviewPlugin } from "../../../src/plugins/extensions";
import { ReviewOrchestrator, _orchestratorDeps } from "../../../src/review/orchestrator";
import { _reviewGitDeps as _runnerDeps, _reviewSemanticDeps as _semanticDeps } from "../../../src/review/runner";
import type { ReviewConfig } from "../../../src/review/types";
import { withDepsRestore } from "../../helpers/deps";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

withDepsRestore(_runnerDeps, ["getUncommittedFiles"]);
withDepsRestore(_orchestratorDeps, ["spawn"]);

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
// featureName forwarding — US-002 AC-3
// ─────────────────────────────────────────────────────────────────────────────

describe("ReviewOrchestrator.review — featureName forwarding (US-002 AC-3)", () => {
  let origRunSemanticReview: typeof _semanticDeps.runSemanticReview;

  const PASSING_SEMANTIC_RESULT = {
    check: "semantic" as const,
    success: true,
    command: "",
    exitCode: 0,
    output: "passed",
    durationMs: 0,
  };

  function makeSemanticReviewConfig(): ReviewConfig {
    return {
      enabled: true,
      checks: ["semantic"],
      commands: {},
    } as unknown as ReviewConfig;
  }

  beforeEach(() => {
    origRunSemanticReview = _semanticDeps.runSemanticReview;
    // Clean tree so runReview proceeds past dirty-tree guard
    _runnerDeps.getUncommittedFiles = mock(async () => []);
  });

  afterEach(() => {
    _semanticDeps.runSemanticReview = origRunSemanticReview;
  });

  test("forwards featureName to runSemanticReview when provided", async () => {
    const semanticMock = mock(async () => PASSING_SEMANTIC_RESULT);
    _semanticDeps.runSemanticReview = semanticMock;

    const orchestrator = new ReviewOrchestrator();
    await orchestrator.review(
      makeSemanticReviewConfig(),
      "/tmp/workdir",
      minimalExecConfig,
      undefined, // plugins
      undefined, // storyGitRef
      undefined, // scopePrefix
      undefined, // qualityCommands
      "US-002",  // storyId
      undefined, // story
      undefined, // modelResolver
      undefined, // naxConfig
      undefined, // retrySkipChecks
      "my-feature", // featureName
    );

    expect(semanticMock).toHaveBeenCalled();
    // runSemanticReview(workdir, storyGitRef, story, semanticCfg, modelResolver, naxConfig, featureName)
    // featureName is the 7th arg (index 6)
    const callArgs = semanticMock.mock.calls[0] as unknown[];
    expect(callArgs[6]).toBe("my-feature");
  });

  test("forwards undefined featureName to runSemanticReview when not provided", async () => {
    const semanticMock = mock(async () => PASSING_SEMANTIC_RESULT);
    _semanticDeps.runSemanticReview = semanticMock;

    const orchestrator = new ReviewOrchestrator();
    await orchestrator.review(
      makeSemanticReviewConfig(),
      "/tmp/workdir",
      minimalExecConfig,
    );

    expect(semanticMock).toHaveBeenCalled();
    const callArgs = semanticMock.mock.calls[0] as unknown[];
    expect(callArgs[6]).toBeUndefined();
  });
});
