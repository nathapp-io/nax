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
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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

  test("all passed → pending is 0", () => {
    const prd = makePrd([makeStory("US-001", "passed"), makeStory("US-002", "passed")]);
    const progress = countProgress(prd);

    expect(progress.total).toBe(2);
    expect(progress.passed).toBe(2);
    expect(progress.failed).toBe(0);
    expect(progress.paused).toBe(0);
    expect(progress.blocked).toBe(0);
    expect(progress.pending).toBe(0);
  });

  test("all pending → passed/failed/paused/blocked are 0", () => {
    const prd = makePrd([makeStory("US-001", "pending"), makeStory("US-002", "pending")]);
    const progress = countProgress(prd);

    expect(progress.total).toBe(2);
    expect(progress.passed).toBe(0);
    expect(progress.failed).toBe(0);
    expect(progress.paused).toBe(0);
    expect(progress.blocked).toBe(0);
    expect(progress.pending).toBe(2);
  });

  test("empty PRD → all zeros", () => {
    const prd = makePrd([]);
    const progress = countProgress(prd);

    expect(progress.total).toBe(0);
    expect(progress.passed).toBe(0);
    expect(progress.failed).toBe(0);
    expect(progress.paused).toBe(0);
    expect(progress.blocked).toBe(0);
    expect(progress.pending).toBe(0);
  });

  test("pending = total - passed - failed - paused - blocked", () => {
    const stories = [
      makeStory("US-001", "passed"),
      makeStory("US-002", "failed"),
      makeStory("US-003", "paused"),
      makeStory("US-004", "blocked"),
      makeStory("US-005", "pending"),
      makeStory("US-006", "in-progress"),
      makeStory("US-007", "skipped"),
    ];
    const prd = makePrd(stories);
    const p = countProgress(prd);

    expect(p.pending).toBe(p.total - p.passed - p.failed - p.paused - p.blocked);
  });

  test("skipped stories count as pending (not a tracked terminal state)", () => {
    const prd = makePrd([makeStory("US-001", "skipped")]);
    const p = countProgress(prd);

    expect(p.total).toBe(1);
    expect(p.pending).toBe(1);
    expect(p.passed).toBe(0);
  });

  test("in-progress stories count toward pending", () => {
    const prd = makePrd([makeStory("US-001", "in-progress")]);
    const p = countProgress(prd);

    expect(p.pending).toBe(1);
  });
});

// ============================================================================
// buildStatusSnapshot
// ============================================================================

describe("buildStatusSnapshot", () => {
  test("builds valid NaxStatusFile with version 1", () => {
    const snapshot = buildStatusSnapshot(makeRunState());
    expect(snapshot.version).toBe(1);
  });

  test("run metadata matches run state", () => {
    const state = makeRunState({
      runId: "run-test-id",
      feature: "my-feature",
      startedAt: "2026-02-25T10:00:00.000Z",
      runStatus: "running",
      dryRun: true,
      pid: 12345,
    });
    const snapshot = buildStatusSnapshot(state);

    expect(snapshot.run.id).toBe("run-test-id");
    expect(snapshot.run.feature).toBe("my-feature");
    expect(snapshot.run.startedAt).toBe("2026-02-25T10:00:00.000Z");
    expect(snapshot.run.status).toBe("running");
    expect(snapshot.run.dryRun).toBe(true);
    expect(snapshot.run.pid).toBe(12345);
  });

  test("PID is included for crash detection", () => {
    const testPid = 99999;
    const snapshot = buildStatusSnapshot(makeRunState({ pid: testPid }));

    expect(snapshot.run.pid).toBe(testPid);
    expect(typeof snapshot.run.pid).toBe("number");
  });

  test("PID defaults to process.pid when not overridden", () => {
    const snapshot = buildStatusSnapshot(makeRunState());

    expect(snapshot.run.pid).toBe(process.pid);
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

  test("cost limit is null when not set", () => {
    const snapshot = buildStatusSnapshot(makeRunState({ costLimit: null }));
    expect(snapshot.cost.limit).toBeNull();
  });

  test("current is null when no story active", () => {
    const snapshot = buildStatusSnapshot(makeRunState({ currentStory: null }));
    expect(snapshot.current).toBeNull();
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
    const statuses: NaxStatusFile["run"]["status"][] = ["running", "completed", "failed", "stalled"];
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

  test("writes valid JSON to the target path", async () => {
    const outPath = join(tmpDir, "status.json");
    const snapshot = buildStatusSnapshot(makeRunState());

    await writeStatusFile(outPath, snapshot);

    expect(existsSync(outPath)).toBe(true);
    const raw = readFileSync(outPath, "utf8");
    const parsed = JSON.parse(raw) as NaxStatusFile;
    expect(parsed.version).toBe(1);
    expect(parsed.run.id).toBe(snapshot.run.id);
  });

  test("does NOT leave a .tmp file after successful write", async () => {
    const outPath = join(tmpDir, "status.json");
    await writeStatusFile(outPath, buildStatusSnapshot(makeRunState()));

    expect(existsSync(`${outPath}.tmp`)).toBe(false);
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

  test("PID is persisted to status file for crash detection", async () => {
    const outPath = join(tmpDir, "status.json");
    const testPid = 54321;
    const snapshot = buildStatusSnapshot(makeRunState({ pid: testPid }));

    await writeStatusFile(outPath, snapshot);

    const content = JSON.parse(readFileSync(outPath, "utf8")) as NaxStatusFile;
    expect(content.run.pid).toBe(testPid);
  });
});

// ============================================================================
// PostRunStatus type hierarchy
// ============================================================================

describe("PostRunStatus type hierarchy", () => {
  test("AcceptancePhaseStatus accepts all valid status values", () => {
    const statuses: AcceptancePhaseStatus["status"][] = ["not-run", "running", "passed", "failed"];
    for (const status of statuses) {
      const s: AcceptancePhaseStatus = { status };
      expect(s.status).toBe(status);
    }
  });

  test("AcceptancePhaseStatus optional fields are assignable", () => {
    const s: AcceptancePhaseStatus = {
      status: "failed",
      lastRunAt: "2026-04-04T10:00:00.000Z",
      retries: 2,
      failedACs: ["AC-1", "AC-2"],
    };
    expect(s.lastRunAt).toBe("2026-04-04T10:00:00.000Z");
    expect(s.retries).toBe(2);
    expect(s.failedACs).toEqual(["AC-1", "AC-2"]);
  });

  test("RegressionPhaseStatus accepts all valid status values", () => {
    const statuses: RegressionPhaseStatus["status"][] = ["not-run", "running", "passed", "failed"];
    for (const status of statuses) {
      const s: RegressionPhaseStatus = { status };
      expect(s.status).toBe(status);
    }
  });

  test("RegressionPhaseStatus optional fields are assignable", () => {
    const s: RegressionPhaseStatus = {
      status: "failed",
      lastRunAt: "2026-04-04T10:00:00.000Z",
      retries: 1,
      failedTests: ["test-a", "test-b"],
      affectedStories: ["US-001", "US-002"],
    };
    expect(s.lastRunAt).toBe("2026-04-04T10:00:00.000Z");
    expect(s.retries).toBe(1);
    expect(s.failedTests).toEqual(["test-a", "test-b"]);
    expect(s.affectedStories).toEqual(["US-001", "US-002"]);
  });

  test("PostRunStatus has required acceptance and regression fields", () => {
    const s: PostRunStatus = {
      acceptance: { status: "passed" },
      regression: { status: "not-run" },
    };
    expect(s.acceptance.status).toBe("passed");
    expect(s.regression.status).toBe("not-run");
  });
});

// ============================================================================
// buildStatusSnapshot — postRun field
// ============================================================================

describe("buildStatusSnapshot postRun field", () => {
  test("omits postRun from snapshot when RunStateSnapshot.postRun is undefined", () => {
    const snapshot = buildStatusSnapshot(makeRunState());
    expect(Object.prototype.hasOwnProperty.call(snapshot, "postRun")).toBe(false);
  });

  test("includes postRun in snapshot when RunStateSnapshot.postRun is present", () => {
    const postRun: PostRunStatus = {
      acceptance: { status: "passed", lastRunAt: "2026-04-04T10:00:00.000Z", retries: 0 },
      regression: { status: "not-run" },
    };
    const snapshot = buildStatusSnapshot(makeRunState({ postRun }));
    expect(snapshot.postRun).toBeDefined();
    expect(snapshot.postRun?.acceptance.status).toBe("passed");
    expect(snapshot.postRun?.regression.status).toBe("not-run");
  });

  test("postRun is preserved with all fields intact in snapshot", () => {
    const postRun: PostRunStatus = {
      acceptance: {
        status: "failed",
        lastRunAt: "2026-04-04T11:00:00.000Z",
        retries: 2,
        failedACs: ["AC-1"],
      },
      regression: {
        status: "failed",
        lastRunAt: "2026-04-04T11:00:00.000Z",
        retries: 1,
        failedTests: ["test-x"],
        affectedStories: ["US-001"],
      },
    };
    const snapshot = buildStatusSnapshot(makeRunState({ postRun }));
    expect(snapshot.postRun?.acceptance.failedACs).toEqual(["AC-1"]);
    expect(snapshot.postRun?.regression.failedTests).toEqual(["test-x"]);
    expect(snapshot.postRun?.regression.affectedStories).toEqual(["US-001"]);
  });
});
