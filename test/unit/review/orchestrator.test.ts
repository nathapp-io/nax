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
import { _reviewGitDeps as _runnerDeps } from "../../../src/review/runner";
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
