/**
 * StatusWriter Post-Run Phase Methods Tests (US-001-B)
 *
 * Tests for new post-run methods on StatusWriter:
 * - setPostRunPhase(phase, update) — merges partial update into in-memory postRun state
 * - getPostRunStatus() — returns current postRun state with crash recovery
 * - resetPostRunStatus() — resets both phases to { status: "not-run" }
 * - getSnapshot() — includes postRun field in RunStateSnapshot
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { NaxConfig } from "../../../src/config";
import type { NaxStatusFile } from "../../../src/execution/status-file";
import { StatusWriter, type StatusWriterContext } from "../../../src/execution/status-writer";
import type { PRD, UserStory } from "../../../src/prd";
import { cleanupTempDir, makeTempDir } from "../../helpers/temp";

// ============================================================================
// Helpers
// ============================================================================

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

function makePrd(count = 1): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "feat/test",
    createdAt: "2026-02-25T10:00:00.000Z",
    updatedAt: "2026-02-25T10:00:00.000Z",
    userStories: Array.from({ length: count }, (_, i) => makeStory(`US-00${i + 1}`)),
  };
}

function makeConfig(costLimit = 5.0): NaxConfig {
  return {
    execution: {
      costLimit,
      maxIterations: 10,
      maxStoriesPerFeature: 50,
      iterationDelayMs: 0,
    },
  } as unknown as NaxConfig;
}

function makeCtx(overrides: Partial<StatusWriterContext> = {}): StatusWriterContext {
  return {
    runId: "run-test-001",
    feature: "auth-feature",
    startedAt: "2026-02-25T10:00:00.000Z",
    dryRun: false,
    startTimeMs: Date.now() - 1000,
    pid: process.pid,
    ...overrides,
  };
}

// ============================================================================
// setPostRunPhase — acceptance
// ============================================================================

describe("StatusWriter.setPostRunPhase acceptance", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("sw-postrun-test-");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  test("merges acceptance update into in-memory postRun state", async () => {
    const path = join(tmpDir, "status.json");
    const sw = new StatusWriter(path, makeConfig(), makeCtx());
    sw.setPrd(makePrd());

    sw.setPostRunPhase("acceptance", { status: "passed", lastRunAt: "2026-04-04T12:00:00Z" });
    await sw.update(0, 0);

    const content = JSON.parse(readFileSync(path, "utf8")) as NaxStatusFile;
    expect(content.postRun).toBeDefined();
    expect(content.postRun?.acceptance.status).toBe("passed");
    expect(content.postRun?.acceptance.lastRunAt).toBe("2026-04-04T12:00:00Z");
  });

  test("merges partial update without overwriting unrelated fields", async () => {
    const path = join(tmpDir, "status.json");
    const sw = new StatusWriter(path, makeConfig(), makeCtx());
    sw.setPrd(makePrd());

    // Set initial acceptance state
    sw.setPostRunPhase("acceptance", { status: "running", retries: 1 });
    // Merge in a completion update
    sw.setPostRunPhase("acceptance", { status: "passed", lastRunAt: "2026-04-04T12:00:00Z" });
    await sw.update(0, 0);

    const content = JSON.parse(readFileSync(path, "utf8")) as NaxStatusFile;
    expect(content.postRun?.acceptance.status).toBe("passed");
    expect(content.postRun?.acceptance.lastRunAt).toBe("2026-04-04T12:00:00Z");
    // retries should be preserved from earlier merge
    expect(content.postRun?.acceptance.retries).toBe(1);
  });

  test("does not overwrite regression state when updating acceptance", async () => {
    const path = join(tmpDir, "status.json");
    const sw = new StatusWriter(path, makeConfig(), makeCtx());
    sw.setPrd(makePrd());

    sw.setPostRunPhase("regression", { status: "passed" });
    sw.setPostRunPhase("acceptance", { status: "failed" });
    await sw.update(0, 0);

    const content = JSON.parse(readFileSync(path, "utf8")) as NaxStatusFile;
    expect(content.postRun?.regression.status).toBe("passed");
    expect(content.postRun?.acceptance.status).toBe("failed");
  });
});

// ============================================================================
// setPostRunPhase — regression
// ============================================================================

describe("StatusWriter.setPostRunPhase regression", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("sw-postrun-test-");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  test("merges regression update into in-memory postRun state and writes to disk", async () => {
    const path = join(tmpDir, "status.json");
    const sw = new StatusWriter(path, makeConfig(), makeCtx());
    sw.setPrd(makePrd());

    sw.setPostRunPhase("regression", {
      status: "failed",
      failedTests: ["test-1", "test-2", "test-3"],
    });
    await sw.update(0, 0);

    const content = JSON.parse(readFileSync(path, "utf8")) as NaxStatusFile;
    expect(content.postRun).toBeDefined();
    expect(content.postRun?.regression.status).toBe("failed");
    expect(content.postRun?.regression.failedTests).toEqual(["test-1", "test-2", "test-3"]);
  });

  test("does not overwrite acceptance state when updating regression", async () => {
    const path = join(tmpDir, "status.json");
    const sw = new StatusWriter(path, makeConfig(), makeCtx());
    sw.setPrd(makePrd());

    sw.setPostRunPhase("acceptance", { status: "passed" });
    sw.setPostRunPhase("regression", { status: "running" });
    await sw.update(0, 0);

    const content = JSON.parse(readFileSync(path, "utf8")) as NaxStatusFile;
    expect(content.postRun?.acceptance.status).toBe("passed");
    expect(content.postRun?.regression.status).toBe("running");
  });
});

// ============================================================================
// getPostRunStatus — defaults and crash recovery
// ============================================================================

describe("StatusWriter.getPostRunStatus", () => {
  test("returns default not-run state when no setPostRunPhase has been called", () => {
    const sw = new StatusWriter("/tmp/x.json", makeConfig(), makeCtx());
    sw.setPrd(makePrd());

    const status = sw.getPostRunStatus();
    expect(status).toEqual({
      acceptance: { status: "not-run" },
      regression: { status: "not-run" },
    });
  });

  test("returns not-run for acceptance when in-memory acceptance.status is 'running' (stale crash recovery)", () => {
    const sw = new StatusWriter("/tmp/x.json", makeConfig(), makeCtx());
    sw.setPrd(makePrd());

    sw.setPostRunPhase("acceptance", { status: "running" });

    const status = sw.getPostRunStatus();
    expect(status.acceptance.status).toBe("not-run");
  });

  test("returns not-run for regression when in-memory regression.status is 'running' (stale crash recovery)", () => {
    const sw = new StatusWriter("/tmp/x.json", makeConfig(), makeCtx());
    sw.setPrd(makePrd());

    sw.setPostRunPhase("regression", { status: "running" });

    const status = sw.getPostRunStatus();
    expect(status.regression.status).toBe("not-run");
  });

  test("returns not-run for both phases when both have status 'running' (stale crash recovery)", () => {
    const sw = new StatusWriter("/tmp/x.json", makeConfig(), makeCtx());
    sw.setPrd(makePrd());

    sw.setPostRunPhase("acceptance", { status: "running" });
    sw.setPostRunPhase("regression", { status: "running" });

    const status = sw.getPostRunStatus();
    expect(status.acceptance.status).toBe("not-run");
    expect(status.regression.status).toBe("not-run");
  });

  test("returns actual status when acceptance is 'passed' (no crash recovery applied)", () => {
    const sw = new StatusWriter("/tmp/x.json", makeConfig(), makeCtx());
    sw.setPrd(makePrd());

    sw.setPostRunPhase("acceptance", { status: "passed" });

    const status = sw.getPostRunStatus();
    expect(status.acceptance.status).toBe("passed");
  });

  test("returns actual status when regression is 'failed' (no crash recovery applied)", () => {
    const sw = new StatusWriter("/tmp/x.json", makeConfig(), makeCtx());
    sw.setPrd(makePrd());

    sw.setPostRunPhase("regression", { status: "failed" });

    const status = sw.getPostRunStatus();
    expect(status.regression.status).toBe("failed");
  });

  test("crash recovery does not clear optional fields on the non-running phase", () => {
    const sw = new StatusWriter("/tmp/x.json", makeConfig(), makeCtx());
    sw.setPrd(makePrd());

    sw.setPostRunPhase("acceptance", { status: "passed", lastRunAt: "2026-04-04T12:00:00Z" });
    sw.setPostRunPhase("regression", { status: "running" });

    const status = sw.getPostRunStatus();
    // acceptance is passed — keep as is
    expect(status.acceptance.status).toBe("passed");
    expect(status.acceptance.lastRunAt).toBe("2026-04-04T12:00:00Z");
    // regression is running — treat as not-run
    expect(status.regression.status).toBe("not-run");
  });
});

// ============================================================================
// resetPostRunStatus
// ============================================================================

describe("StatusWriter.resetPostRunStatus", () => {
  test("resets both phases to { status: 'not-run' } and clears optional fields", () => {
    const sw = new StatusWriter("/tmp/x.json", makeConfig(), makeCtx());
    sw.setPrd(makePrd());

    sw.setPostRunPhase("acceptance", {
      status: "failed",
      lastRunAt: "2026-04-04T12:00:00Z",
      retries: 2,
      failedACs: ["AC-1"],
    });
    sw.setPostRunPhase("regression", {
      status: "failed",
      lastRunAt: "2026-04-04T12:00:00Z",
      retries: 1,
      failedTests: ["test-1"],
      affectedStories: ["US-001"],
    });

    sw.resetPostRunStatus();

    const status = sw.getPostRunStatus();
    expect(status.acceptance).toEqual({ status: "not-run" });
    expect(status.regression).toEqual({ status: "not-run" });
  });

  test("clears lastRunAt from both phases", () => {
    const sw = new StatusWriter("/tmp/x.json", makeConfig(), makeCtx());
    sw.setPrd(makePrd());

    sw.setPostRunPhase("acceptance", { status: "passed", lastRunAt: "2026-04-04T12:00:00Z" });
    sw.setPostRunPhase("regression", { status: "passed", lastRunAt: "2026-04-04T12:00:00Z" });

    sw.resetPostRunStatus();

    const status = sw.getPostRunStatus();
    expect(status.acceptance.lastRunAt).toBeUndefined();
    expect(status.regression.lastRunAt).toBeUndefined();
  });

  test("clears retries from both phases", () => {
    const sw = new StatusWriter("/tmp/x.json", makeConfig(), makeCtx());
    sw.setPrd(makePrd());

    sw.setPostRunPhase("acceptance", { status: "failed", retries: 3 });
    sw.setPostRunPhase("regression", { status: "failed", retries: 2 });

    sw.resetPostRunStatus();

    const status = sw.getPostRunStatus();
    expect(status.acceptance.retries).toBeUndefined();
    expect(status.regression.retries).toBeUndefined();
  });

  test("clears failedACs from acceptance phase", () => {
    const sw = new StatusWriter("/tmp/x.json", makeConfig(), makeCtx());
    sw.setPrd(makePrd());

    sw.setPostRunPhase("acceptance", { status: "failed", failedACs: ["AC-1", "AC-2"] });

    sw.resetPostRunStatus();

    const status = sw.getPostRunStatus();
    expect(status.acceptance.failedACs).toBeUndefined();
  });

  test("clears failedTests and affectedStories from regression phase", () => {
    const sw = new StatusWriter("/tmp/x.json", makeConfig(), makeCtx());
    sw.setPrd(makePrd());

    sw.setPostRunPhase("regression", {
      status: "failed",
      failedTests: ["test-1"],
      affectedStories: ["US-001"],
    });

    sw.resetPostRunStatus();

    const status = sw.getPostRunStatus();
    expect(status.regression.failedTests).toBeUndefined();
    expect(status.regression.affectedStories).toBeUndefined();
  });

  test("after reset, setPostRunPhase can set new state cleanly", () => {
    const sw = new StatusWriter("/tmp/x.json", makeConfig(), makeCtx());
    sw.setPrd(makePrd());

    sw.setPostRunPhase("acceptance", { status: "failed", retries: 2 });
    sw.resetPostRunStatus();
    sw.setPostRunPhase("acceptance", { status: "passed" });

    const status = sw.getPostRunStatus();
    expect(status.acceptance.status).toBe("passed");
    expect(status.acceptance.retries).toBeUndefined();
  });
});

// ============================================================================
// getSnapshot — includes postRun field
// ============================================================================

describe("StatusWriter.getSnapshot includes postRun", () => {
  test("returns snapshot with postRun field after setPostRunPhase", () => {
    const sw = new StatusWriter("/tmp/x.json", makeConfig(), makeCtx());
    sw.setPrd(makePrd());

    sw.setPostRunPhase("acceptance", { status: "passed" });
    const snap = sw.getSnapshot(0, 0);

    expect(snap?.postRun).toBeDefined();
    expect(snap?.postRun?.acceptance.status).toBe("passed");
  });

  test("returns snapshot with postRun.regression field after setPostRunPhase regression", () => {
    const sw = new StatusWriter("/tmp/x.json", makeConfig(), makeCtx());
    sw.setPrd(makePrd());

    sw.setPostRunPhase("regression", { status: "failed", failedTests: ["t-1"] });
    const snap = sw.getSnapshot(0, 0);

    expect(snap?.postRun).toBeDefined();
    expect(snap?.postRun?.regression.status).toBe("failed");
    expect(snap?.postRun?.regression.failedTests).toEqual(["t-1"]);
  });

  test("postRun in snapshot propagates to status file via update()", async () => {
    const tmpDir = makeTempDir("sw-snapshot-postrun-");
    const path = join(tmpDir, "status.json");
    const sw = new StatusWriter(path, makeConfig(), makeCtx());
    sw.setPrd(makePrd());

    sw.setPostRunPhase("acceptance", { status: "passed", lastRunAt: "2026-04-04T12:00:00Z" });
    sw.setPostRunPhase("regression", { status: "not-run" });
    await sw.update(0, 0);

    const content = JSON.parse(readFileSync(path, "utf8")) as NaxStatusFile;
    expect(content.postRun).toBeDefined();
    expect(content.postRun?.acceptance.status).toBe("passed");
    expect(content.postRun?.regression.status).toBe("not-run");

    cleanupTempDir(tmpDir);
  });

  test("snapshot postRun is absent when no setPostRunPhase has been called", () => {
    const sw = new StatusWriter("/tmp/x.json", makeConfig(), makeCtx());
    sw.setPrd(makePrd());

    const snap = sw.getSnapshot(0, 0);
    // postRun should be absent (undefined) when no phase has been set
    expect(snap?.postRun).toBeUndefined();
  });
});
