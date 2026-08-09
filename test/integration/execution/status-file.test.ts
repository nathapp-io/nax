// RE-ARCH: keep
/**
 * Status File Tests
 *
 * Tests for src/execution/status-file.ts:
 * - NaxStatusFile interface shape
 * - writeStatusFile(): atomic write via .tmp + rename
 * - countProgress(): correct PRD story status counts
 * - buildStatusSnapshot(): valid NaxStatusFile from run state
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import {
  type AcceptancePhaseStatus,
  type NaxStatusFile,
  type PostRunStatus,
  type RegressionPhaseStatus,
  type RunStateSnapshot,
  buildStatusSnapshot,
  countProgress,
  writeStatusFile,
} from "../../../src/execution/status-file";
import type { PRD, UserStory } from "../../../src/prd";
import { makeTempDir } from "../../helpers/temp";

// ============================================================================
// Helpers
// ============================================================================

function makeStory(id: string, status: UserStory["status"]): UserStory {
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

function makeRunState(overrides: Partial<RunStateSnapshot> = {}): RunStateSnapshot {
  return {
    runId: "run-2026-02-25T10-00-00-000Z",
    feature: "auth-refactor",
    startedAt: "2026-02-25T10:00:00.000Z",
    runStatus: "running",
    dryRun: false,
    pid: process.pid,
    prd: makePrd([makeStory("US-001", "pending")]),
    totalCost: 0,
    costLimit: 5.0,
    currentStory: null,
    iterations: 0,
    startTimeMs: Date.now() - 1000,
    ...overrides,
  };
}

// ============================================================================
// countProgress
// ============================================================================

describe("countProgress", () => {
  test("counts all story statuses correctly", () => {
    const stories = [
      makeStory("US-001", "passed"),
      makeStory("US-002", "passed"),
      makeStory("US-003", "failed"),
      makeStory("US-004", "paused"),
      makeStory("US-005", "blocked"),
      makeStory("US-006", "pending"),
      makeStory("US-007", "in-progress"),
    ];
    const prd = makePrd(stories);
    const progress = countProgress(prd);

    expect(progress.total).toBe(7);
    expect(progress.passed).toBe(2);
    expect(progress.failed).toBe(1);
    expect(progress.paused).toBe(1);
    expect(progress.blocked).toBe(1);
    // pending = 7 - 2 - 1 - 1 - 1 = 2 (pending + in-progress)
    expect(progress.pending).toBe(2);
  });

  test("all-same status and empty PRD give expected counts", () => {
    const allPassed = countProgress(makePrd([makeStory("US-001", "passed"), makeStory("US-002", "passed")]));
    expect(allPassed.total).toBe(2);
    expect(allPassed.passed).toBe(2);
    expect(allPassed.failed + allPassed.paused + allPassed.blocked + allPassed.pending).toBe(0);

    const allPending = countProgress(makePrd([makeStory("US-001", "pending"), makeStory("US-002", "pending")]));
    expect(allPending.total).toBe(2);
    expect(allPending.pending).toBe(2);
    expect(allPending.passed + allPending.failed + allPending.paused + allPending.blocked).toBe(0);

    const empty = countProgress(makePrd([]));
    expect(empty.total).toBe(0);
    expect(empty.passed + empty.failed + empty.paused + empty.blocked + empty.pending).toBe(0);
  });

  test("pending = total - passed - failed - paused - blocked; skipped and in-progress count as pending", () => {
    const stories = [
      makeStory("US-001", "passed"), makeStory("US-002", "failed"), makeStory("US-003", "paused"),
      makeStory("US-004", "blocked"), makeStory("US-005", "pending"), makeStory("US-006", "in-progress"),
      makeStory("US-007", "skipped"),
    ];
    const p = countProgress(makePrd(stories));
    expect(p.pending).toBe(p.total - p.passed - p.failed - p.paused - p.blocked);

    const skipped = countProgress(makePrd([makeStory("US-001", "skipped")]));
    expect(skipped.total).toBe(1);
    expect(skipped.pending).toBe(1);
    expect(skipped.passed).toBe(0);
    expect(countProgress(makePrd([makeStory("US-001", "in-progress")])).pending).toBe(1);
  });

  test("regression-failed counts as failed, not pending", () => {
    // A story that passed acceptance but was later flipped to regression-failed
    // in-memory by the deferred regression gate (run-completion.ts) must be
    // classified the same way countStories() in src/prd/index.ts classifies it.
    const stories = [
      makeStory("US-001", "passed"),
      makeStory("US-002", "passed"),
      makeStory("US-003", "passed"),
      makeStory("US-004", "regression-failed"),
    ];
    const progress = countProgress(makePrd(stories));

    expect(progress.total).toBe(4);
    expect(progress.passed).toBe(3);
    expect(progress.failed).toBe(1);
    expect(progress.pending).toBe(0);
  });

  test("failed and regression-failed both contribute to the failed bucket", () => {
    const stories = [
      makeStory("US-001", "passed"),
      makeStory("US-002", "failed"),
      makeStory("US-003", "regression-failed"),
      makeStory("US-004", "pending"),
    ];
    const progress = countProgress(makePrd(stories));

    expect(progress.total).toBe(4);
    expect(progress.passed).toBe(1);
    expect(progress.failed).toBe(2);
    expect(progress.pending).toBe(1);
    expect(progress.pending).toBe(
      progress.total - progress.passed - progress.failed - progress.paused - progress.blocked,
    );
  });
});

// ============================================================================
// buildStatusSnapshot
// ============================================================================

describe("buildStatusSnapshot", () => {
  test("version 1; run metadata (id, feature, startedAt, status, dryRun, pid) matches state", () => {
    expect(buildStatusSnapshot(makeRunState()).version).toBe(1);
    const state = makeRunState({ runId: "run-test-id", feature: "my-feature", startedAt: "2026-02-25T10:00:00.000Z", runStatus: "running", dryRun: true, pid: 12345 });
    const snapshot = buildStatusSnapshot(state);
    expect(snapshot.run.id).toBe("run-test-id");
    expect(snapshot.run.feature).toBe("my-feature");
    expect(snapshot.run.startedAt).toBe("2026-02-25T10:00:00.000Z");
    expect(snapshot.run.status).toBe("running");
    expect(snapshot.run.dryRun).toBe(true);
    expect(snapshot.run.pid).toBe(12345);
  });

  test("PID is a number, uses provided value, defaults to process.pid", () => {
    const testPid = 99999;
    const withPid = buildStatusSnapshot(makeRunState({ pid: testPid }));
    expect(withPid.run.pid).toBe(testPid);
    expect(typeof withPid.run.pid).toBe("number");

    const defaultPid = buildStatusSnapshot(makeRunState());
    expect(defaultPid.run.pid).toBe(process.pid);
  });

  test("progress is derived from PRD stories", () => {
    const prd = makePrd([makeStory("US-001", "passed"), makeStory("US-002", "failed"), makeStory("US-003", "pending")]);
    const snapshot = buildStatusSnapshot(makeRunState({ prd }));

    expect(snapshot.progress.total).toBe(3);
    expect(snapshot.progress.passed).toBe(1);
    expect(snapshot.progress.failed).toBe(1);
    expect(snapshot.progress.pending).toBe(1);
  });

  test("cost fields populated from state", () => {
    const snapshot = buildStatusSnapshot(makeRunState({ totalCost: 2.5, costLimit: 10.0 }));

    expect(snapshot.cost.spent).toBe(2.5);
    expect(snapshot.cost.limit).toBe(10.0);
  });

  test("cost limit is null when not set and current is null when no story active", () => {
    expect(buildStatusSnapshot(makeRunState({ costLimit: null })).cost.limit).toBeNull();
    expect(buildStatusSnapshot(makeRunState({ currentStory: null })).current).toBeNull();
  });

  test("current story info populated when story is active", () => {
    const current = {
      storyId: "US-008",
      title: "Add retry logic",
      complexity: "medium",
      tddStrategy: "tdd-lite",
      model: "claude-sonnet-4-5-20250514",
      attempt: 1,
      phase: "implement",
    };
    const snapshot = buildStatusSnapshot(makeRunState({ currentStory: current }));

    expect(snapshot.current).not.toBeNull();
    expect(snapshot.current?.storyId).toBe("US-008");
    expect(snapshot.current?.title).toBe("Add retry logic");
    expect(snapshot.current?.complexity).toBe("medium");
    expect(snapshot.current?.tddStrategy).toBe("tdd-lite");
    expect(snapshot.current?.model).toBe("claude-sonnet-4-5-20250514");
    expect(snapshot.current?.attempt).toBe(1);
    expect(snapshot.current?.phase).toBe("implement");
  });

  test("iterations and timing fields are set", () => {
    const startTimeMs = Date.now() - 5000;
    const snapshot = buildStatusSnapshot(makeRunState({ iterations: 7, startTimeMs }));

    expect(snapshot.iterations).toBe(7);
    expect(snapshot.durationMs).toBeGreaterThanOrEqual(5000);
    expect(snapshot.updatedAt).toBeTruthy();
    // updatedAt should be a valid ISO 8601 string
    expect(() => new Date(snapshot.updatedAt)).not.toThrow();
  });

  test("all run status values are accepted", () => {
    const statuses: NaxStatusFile["run"]["status"][] = ["running", "completed", "failed", "stalled", "cost-limit"];
    for (const runStatus of statuses) {
      const snapshot = buildStatusSnapshot(makeRunState({ runStatus }));
      expect(snapshot.run.status).toBe(runStatus);
    }
  });
});

// ============================================================================
// writeStatusFile
// ============================================================================

describe("writeStatusFile", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = makeTempDir("nax-status-test-");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("writes valid JSON to target path; no .tmp leftover; PID persisted", async () => {
    const outPath = join(tmpDir, "status.json");
    const testPid = 54321;
    const snapshot = buildStatusSnapshot(makeRunState({ pid: testPid }));
    await writeStatusFile(outPath, snapshot);
    expect(existsSync(outPath)).toBe(true);
    expect(existsSync(`${outPath}.tmp`)).toBe(false);
    const parsed = JSON.parse(readFileSync(outPath, "utf8")) as NaxStatusFile;
    expect(parsed.version).toBe(1);
    expect(parsed.run.id).toBe(snapshot.run.id);
    expect(parsed.run.pid).toBe(testPid);
  });

  test("atomic rename: final file appears complete", async () => {
    const outPath = join(tmpDir, "status.json");
    const state = makeRunState({
      prd: makePrd([makeStory("US-001", "passed"), makeStory("US-002", "failed"), makeStory("US-003", "pending")]),
      totalCost: 1.5,
      costLimit: 5.0,
      iterations: 3,
    });
    const snapshot = buildStatusSnapshot(state);
    await writeStatusFile(outPath, snapshot);

    const content = JSON.parse(readFileSync(outPath, "utf8")) as NaxStatusFile;
    expect(content.progress.passed).toBe(1);
    expect(content.progress.failed).toBe(1);
    expect(content.progress.pending).toBe(1);
    expect(content.cost.spent).toBe(1.5);
    expect(content.iterations).toBe(3);
  });

  test("overwrites an existing status file", async () => {
    const outPath = join(tmpDir, "status.json");

    // First write
    await writeStatusFile(outPath, buildStatusSnapshot(makeRunState({ runStatus: "running", iterations: 1 })));

    // Second write with updated state
    await writeStatusFile(outPath, buildStatusSnapshot(makeRunState({ runStatus: "completed", iterations: 5 })));

    const content = JSON.parse(readFileSync(outPath, "utf8")) as NaxStatusFile;
    expect(content.run.status).toBe("completed");
    expect(content.iterations).toBe(5);
  });

  test("writes null current when no active story", async () => {
    const outPath = join(tmpDir, "status.json");
    await writeStatusFile(outPath, buildStatusSnapshot(makeRunState({ currentStory: null })));

    const content = JSON.parse(readFileSync(outPath, "utf8")) as NaxStatusFile;
    expect(content.current).toBeNull();
  });

  test("written JSON is pretty-printed (2-space indent)", async () => {
    const outPath = join(tmpDir, "status.json");
    await writeStatusFile(outPath, buildStatusSnapshot(makeRunState()));

    const raw = readFileSync(outPath, "utf8");
    // Pretty-printed JSON has lines beyond just a single line
    expect(raw.split("\n").length).toBeGreaterThan(1);
    // Check for 2-space indent on top-level keys
    expect(raw).toContain('  "version"');
  });

});

// ============================================================================
// PostRunStatus type hierarchy
// ============================================================================

describe("PostRunStatus type hierarchy", () => {
  test("AcceptancePhaseStatus/RegressionPhaseStatus/PostRunStatus: valid statuses + optional fields + required fields", () => {
    for (const status of ["not-run", "running", "passed", "failed"] as AcceptancePhaseStatus["status"][]) {
      expect(({ status } as AcceptancePhaseStatus).status).toBe(status);
      expect(({ status } as RegressionPhaseStatus).status).toBe(status);
    }
    const acc: AcceptancePhaseStatus = { status: "failed", lastRunAt: "2026-04-04T10:00:00.000Z", retries: 2, failedACs: ["AC-1", "AC-2"] };
    expect(acc.lastRunAt).toBe("2026-04-04T10:00:00.000Z");
    expect(acc.retries).toBe(2);
    expect(acc.failedACs).toEqual(["AC-1", "AC-2"]);
    const reg: RegressionPhaseStatus = { status: "failed", lastRunAt: "2026-04-04T10:00:00.000Z", retries: 1, failedTests: ["test-a", "test-b"], affectedStories: ["US-001", "US-002"] };
    expect(reg.retries).toBe(1);
    expect(reg.failedTests).toEqual(["test-a", "test-b"]);
    expect(reg.affectedStories).toEqual(["US-001", "US-002"]);
    const postRun: PostRunStatus = { acceptance: { status: "passed" }, regression: { status: "not-run" } };
    expect(postRun.acceptance.status).toBe("passed");
    expect(postRun.regression.status).toBe("not-run");
  });
});

// ============================================================================
// buildStatusSnapshot — postRun field
// ============================================================================

describe("buildStatusSnapshot postRun field", () => {
  test("omitted when undefined; present with all fields intact when set", () => {
    expect(Object.prototype.hasOwnProperty.call(buildStatusSnapshot(makeRunState()), "postRun")).toBe(false);

    const postRun: PostRunStatus = {
      acceptance: { status: "passed", lastRunAt: "2026-04-04T10:00:00.000Z", retries: 0 },
      regression: { status: "not-run" },
    };
    const basic = buildStatusSnapshot(makeRunState({ postRun }));
    expect(basic.postRun?.acceptance.status).toBe("passed");
    expect(basic.postRun?.regression.status).toBe("not-run");

    const full: PostRunStatus = {
      acceptance: { status: "failed", lastRunAt: "2026-04-04T11:00:00.000Z", retries: 2, failedACs: ["AC-1"] },
      regression: { status: "failed", lastRunAt: "2026-04-04T11:00:00.000Z", retries: 1, failedTests: ["test-x"], affectedStories: ["US-001"] },
    };
    const fullSnap = buildStatusSnapshot(makeRunState({ postRun: full }));
    expect(fullSnap.postRun?.acceptance.failedACs).toEqual(["AC-1"]);
    expect(fullSnap.postRun?.regression.failedTests).toEqual(["test-x"]);
    expect(fullSnap.postRun?.regression.affectedStories).toEqual(["US-001"]);
  });
});
