/**
 * Status File Tests
 *
 * Tests for NaxStatusFile types, writeStatusFile (atomic write),
 * countProgress, and buildStatusSnapshot.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type NaxStatusFile,
  type RunState,
  buildStatusSnapshot,
  countProgress,
  writeStatusFile,
} from "../src/execution/status-file";
import type { PRD, UserStory } from "../src/prd";

// ============================================================================
// Helpers
// ============================================================================

const TEST_TMP_DIR = path.join(import.meta.dir, "__tmp_status_file_tests__");

function makeStory(id: string, status: UserStory["status"] = "pending"): UserStory {
  return {
    id,
    title: `Story ${id}`,
    description: `Description for ${id}`,
    acceptanceCriteria: ["AC-1"],
    tags: [],
    dependencies: [],
    status,
    passes: status === "passed",
    escalations: [],
    attempts: 0,
  };
}

function makePrd(stories: UserStory[]): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "feat/test",
    createdAt: "2026-02-25T10:00:00.000Z",
    updatedAt: "2026-02-25T10:00:00.000Z",
    userStories: stories,
  };
}

function makeRunState(overrides: Partial<RunState> = {}): RunState {
  const prd = overrides.prd ?? makePrd([makeStory("US-001"), makeStory("US-002")]);
  return {
    runId: "run-2026-02-25T10-00-00-000Z",
    feature: "auth-refactor",
    startedAt: "2026-02-25T10:00:00.000Z",
    status: "running",
    dryRun: false,
    prd,
    costSpent: 0,
    costLimit: null,
    iterations: 0,
    current: null,
    startTime: Date.now() - 5000, // 5 seconds ago
    ...overrides,
  };
}

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(() => {
  mkdirSync(TEST_TMP_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_TMP_DIR, { recursive: true, force: true });
});

// ============================================================================
// countProgress
// ============================================================================

describe("countProgress", () => {
  test("all stories pending", () => {
    const prd = makePrd([makeStory("US-001"), makeStory("US-002"), makeStory("US-003")]);
    const progress = countProgress(prd);
    expect(progress).toEqual({ total: 3, passed: 0, failed: 0, paused: 0, blocked: 0, pending: 3 });
  });

  test("counts passed stories", () => {
    const prd = makePrd([makeStory("US-001", "passed"), makeStory("US-002"), makeStory("US-003")]);
    const progress = countProgress(prd);
    expect(progress).toEqual({ total: 3, passed: 1, failed: 0, paused: 0, blocked: 0, pending: 2 });
  });

  test("counts failed stories", () => {
    const prd = makePrd([makeStory("US-001", "failed"), makeStory("US-002"), makeStory("US-003")]);
    const progress = countProgress(prd);
    expect(progress).toEqual({ total: 3, passed: 0, failed: 1, paused: 0, blocked: 0, pending: 2 });
  });

  test("counts paused stories", () => {
    const prd = makePrd([makeStory("US-001", "paused"), makeStory("US-002"), makeStory("US-003")]);
    const progress = countProgress(prd);
    expect(progress).toEqual({ total: 3, passed: 0, failed: 0, paused: 1, blocked: 0, pending: 2 });
  });

  test("counts blocked stories", () => {
    const prd = makePrd([makeStory("US-001", "blocked"), makeStory("US-002"), makeStory("US-003")]);
    const progress = countProgress(prd);
    expect(progress).toEqual({ total: 3, passed: 0, failed: 0, paused: 0, blocked: 1, pending: 2 });
  });

  test("counts skipped stories as pending (not in pass/fail/paused/blocked)", () => {
    const prd = makePrd([makeStory("US-001", "skipped"), makeStory("US-002")]);
    const progress = countProgress(prd);
    // skipped stories are not in the named categories, so they count toward pending
    expect(progress.total).toBe(2);
    expect(progress.passed).toBe(0);
    expect(progress.failed).toBe(0);
    expect(progress.paused).toBe(0);
    expect(progress.blocked).toBe(0);
    expect(progress.pending).toBe(2); // skipped + pending
  });

  test("counts all statuses together", () => {
    const prd = makePrd([
      makeStory("US-001", "passed"),
      makeStory("US-002", "passed"),
      makeStory("US-003", "failed"),
      makeStory("US-004", "paused"),
      makeStory("US-005", "blocked"),
      makeStory("US-006", "pending"),
      makeStory("US-007", "in-progress"),
    ]);
    const progress = countProgress(prd);
    expect(progress.total).toBe(7);
    expect(progress.passed).toBe(2);
    expect(progress.failed).toBe(1);
    expect(progress.paused).toBe(1);
    expect(progress.blocked).toBe(1);
    // pending = 7 - 2 - 1 - 1 - 1 = 2 (pending + in-progress)
    expect(progress.pending).toBe(2);
  });

  test("empty PRD returns all zeros", () => {
    const prd = makePrd([]);
    const progress = countProgress(prd);
    expect(progress).toEqual({ total: 0, passed: 0, failed: 0, paused: 0, blocked: 0, pending: 0 });
  });

  test("pending is always total minus the four named statuses", () => {
    const stories = [
      makeStory("1", "passed"),
      makeStory("2", "failed"),
      makeStory("3", "paused"),
      makeStory("4", "blocked"),
      makeStory("5", "pending"),
    ];
    const prd = makePrd(stories);
    const progress = countProgress(prd);
    expect(progress.pending).toBe(progress.total - progress.passed - progress.failed - progress.paused - progress.blocked);
  });
});

// ============================================================================
// buildStatusSnapshot
// ============================================================================

describe("buildStatusSnapshot", () => {
  test("returns valid NaxStatusFile with version 1", () => {
    const snapshot = buildStatusSnapshot(makeRunState());
    expect(snapshot.version).toBe(1);
  });

  test("includes run metadata from state", () => {
    const state = makeRunState({
      runId: "run-test-id",
      feature: "my-feature",
      startedAt: "2026-02-25T10:00:00.000Z",
      status: "running",
      dryRun: true,
    });
    const snapshot = buildStatusSnapshot(state);
    expect(snapshot.run.id).toBe("run-test-id");
    expect(snapshot.run.feature).toBe("my-feature");
    expect(snapshot.run.startedAt).toBe("2026-02-25T10:00:00.000Z");
    expect(snapshot.run.status).toBe("running");
    expect(snapshot.run.dryRun).toBe(true);
  });

  test("includes progress derived from PRD", () => {
    const prd = makePrd([
      makeStory("US-001", "passed"),
      makeStory("US-002", "failed"),
      makeStory("US-003", "pending"),
    ]);
    const state = makeRunState({ prd });
    const snapshot = buildStatusSnapshot(state);
    expect(snapshot.progress.total).toBe(3);
    expect(snapshot.progress.passed).toBe(1);
    expect(snapshot.progress.failed).toBe(1);
    expect(snapshot.progress.pending).toBe(1);
  });

  test("includes cost info", () => {
    const state = makeRunState({ costSpent: 1.23, costLimit: 5.0 });
    const snapshot = buildStatusSnapshot(state);
    expect(snapshot.cost.spent).toBe(1.23);
    expect(snapshot.cost.limit).toBe(5.0);
  });

  test("cost limit can be null", () => {
    const state = makeRunState({ costLimit: null });
    const snapshot = buildStatusSnapshot(state);
    expect(snapshot.cost.limit).toBeNull();
  });

  test("current is null when between stories", () => {
    const state = makeRunState({ current: null });
    const snapshot = buildStatusSnapshot(state);
    expect(snapshot.current).toBeNull();
  });

  test("current is populated when processing a story", () => {
    const current: NaxStatusFile["current"] = {
      storyId: "US-008",
      title: "Add retry logic",
      complexity: "medium",
      tddStrategy: "tdd-lite",
      model: "claude-sonnet-4-5",
      attempt: 1,
      phase: "implement",
    };
    const state = makeRunState({ current });
    const snapshot = buildStatusSnapshot(state);
    expect(snapshot.current).toEqual(current);
  });

  test("iterations is passed through", () => {
    const state = makeRunState({ iterations: 42 });
    const snapshot = buildStatusSnapshot(state);
    expect(snapshot.iterations).toBe(42);
  });

  test("updatedAt is a valid ISO 8601 string", () => {
    const snapshot = buildStatusSnapshot(makeRunState());
    expect(() => new Date(snapshot.updatedAt)).not.toThrow();
    expect(new Date(snapshot.updatedAt).toISOString()).toBe(snapshot.updatedAt);
  });

  test("durationMs is non-negative and roughly correct", () => {
    const startTime = Date.now() - 10000; // 10 seconds ago
    const state = makeRunState({ startTime });
    const snapshot = buildStatusSnapshot(state);
    expect(snapshot.durationMs).toBeGreaterThanOrEqual(9000);
    expect(snapshot.durationMs).toBeLessThan(15000);
  });

  test("status 'completed' is propagated", () => {
    const snapshot = buildStatusSnapshot(makeRunState({ status: "completed" }));
    expect(snapshot.run.status).toBe("completed");
  });

  test("status 'failed' is propagated", () => {
    const snapshot = buildStatusSnapshot(makeRunState({ status: "failed" }));
    expect(snapshot.run.status).toBe("failed");
  });

  test("status 'stalled' is propagated", () => {
    const snapshot = buildStatusSnapshot(makeRunState({ status: "stalled" }));
    expect(snapshot.run.status).toBe("stalled");
  });

  test("dryRun false is propagated", () => {
    const snapshot = buildStatusSnapshot(makeRunState({ dryRun: false }));
    expect(snapshot.run.dryRun).toBe(false);
  });
});

// ============================================================================
// writeStatusFile — normal write
// ============================================================================

describe("writeStatusFile", () => {
  test("writes valid JSON to the target path", async () => {
    const filePath = path.join(TEST_TMP_DIR, "nax-status.json");
    const state = makeRunState();
    const snapshot = buildStatusSnapshot(state);

    await writeStatusFile(filePath, snapshot);

    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as NaxStatusFile;
    expect(parsed.version).toBe(1);
    expect(parsed.run.feature).toBe("auth-refactor");
  });

  test("written JSON matches the snapshot exactly", async () => {
    const filePath = path.join(TEST_TMP_DIR, "nax-status.json");
    const snapshot = buildStatusSnapshot(makeRunState());

    await writeStatusFile(filePath, snapshot);

    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as NaxStatusFile;

    // Deep-compare all fields (updatedAt may differ slightly but we passed snapshot directly)
    expect(parsed).toEqual(snapshot);
  });

  test("output file is pretty-printed (human-readable)", async () => {
    const filePath = path.join(TEST_TMP_DIR, "nax-status.json");
    await writeStatusFile(filePath, buildStatusSnapshot(makeRunState()));

    const raw = await readFile(filePath, "utf-8");
    // Pretty-printed JSON has newlines
    expect(raw).toContain("\n");
  });

  test("atomic: .tmp file does not exist after successful write", async () => {
    const filePath = path.join(TEST_TMP_DIR, "nax-status.json");
    const tmpPath = `${filePath}.tmp`;

    await writeStatusFile(filePath, buildStatusSnapshot(makeRunState()));

    expect(existsSync(tmpPath)).toBe(false);
    expect(existsSync(filePath)).toBe(true);
  });

  test("atomic: renames from .tmp to target", async () => {
    // This test verifies the atomic rename pattern by checking that:
    // 1. The final file exists after the call
    // 2. No .tmp file is left behind
    const filePath = path.join(TEST_TMP_DIR, "sub", "nax-status.json");
    mkdirSync(path.dirname(filePath), { recursive: true });

    await writeStatusFile(filePath, buildStatusSnapshot(makeRunState()));

    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(`${filePath}.tmp`)).toBe(false);
  });

  test("overwrites existing file", async () => {
    const filePath = path.join(TEST_TMP_DIR, "nax-status.json");

    // First write
    const snap1 = buildStatusSnapshot(makeRunState({ costSpent: 1.0 }));
    await writeStatusFile(filePath, snap1);

    // Second write
    const snap2 = buildStatusSnapshot(makeRunState({ costSpent: 2.5 }));
    await writeStatusFile(filePath, snap2);

    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as NaxStatusFile;
    expect(parsed.cost.spent).toBe(2.5);
  });

  test("written file contains progress fields", async () => {
    const prd = makePrd([
      makeStory("US-001", "passed"),
      makeStory("US-002", "failed"),
      makeStory("US-003", "paused"),
      makeStory("US-004", "blocked"),
      makeStory("US-005", "pending"),
    ]);
    const filePath = path.join(TEST_TMP_DIR, "nax-status.json");
    await writeStatusFile(filePath, buildStatusSnapshot(makeRunState({ prd })));

    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as NaxStatusFile;
    expect(parsed.progress.total).toBe(5);
    expect(parsed.progress.passed).toBe(1);
    expect(parsed.progress.failed).toBe(1);
    expect(parsed.progress.paused).toBe(1);
    expect(parsed.progress.blocked).toBe(1);
    expect(parsed.progress.pending).toBe(1);
  });

  test("written file has null current when between stories", async () => {
    const filePath = path.join(TEST_TMP_DIR, "nax-status.json");
    await writeStatusFile(filePath, buildStatusSnapshot(makeRunState({ current: null })));

    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as NaxStatusFile;
    expect(parsed.current).toBeNull();
  });

  test("written file captures current story info", async () => {
    const current: NaxStatusFile["current"] = {
      storyId: "US-008",
      title: "Add retry logic to queue handler",
      complexity: "medium",
      tddStrategy: "tdd-lite",
      model: "claude-sonnet-4-5-20250514",
      attempt: 1,
      phase: "implement",
    };
    const filePath = path.join(TEST_TMP_DIR, "nax-status.json");
    await writeStatusFile(filePath, buildStatusSnapshot(makeRunState({ current })));

    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as NaxStatusFile;
    expect(parsed.current).toEqual(current);
  });
});
