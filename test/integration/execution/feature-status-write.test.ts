/**
 * Feature-Level Status File Writing Tests (SFC-002)
 *
 * Tests for writing feature-level status.json files on run end.
 * Verifies all three acceptance criteria:
 * - Status 'completed' after successful run
 * - Status 'failed' after unsuccessful run
 * - Status 'crashed' after crash (simulated)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NaxConfig } from "../../../src/config";
import type { NaxStatusFile } from "../../../src/execution/status-file";
import { StatusWriter, type StatusWriterContext } from "../../../src/execution/status-writer";
import type { PRD, UserStory } from "../../../src/prd";

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

function makePrd(count = 1, storyStatus: UserStory["status"] = "pending"): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "feat/test",
    createdAt: "2026-02-25T10:00:00.000Z",
    updatedAt: "2026-02-25T10:00:00.000Z",
    userStories: Array.from({ length: count }, (_, i) => makeStory(`US-00${i + 1}`, storyStatus)),
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

function readFeatureStatus(featureDir: string): NaxStatusFile {
  const path = join(featureDir, "status.json");
  const content = readFileSync(path, "utf8");
  return JSON.parse(content) as NaxStatusFile;
}

// ============================================================================
// Acceptance Criteria Tests
// ============================================================================

describe("SFC-002: Feature-level status writing — Acceptance Criteria", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "sfc-002-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── AC-1: After a completed run, status is 'completed' ─────────────────
  test("After completed run, feature status.json has status 'completed'", async () => {
    const featureDir = join(tmpDir, ".nax", "features", "auth-system");
    const sw = new StatusWriter(join(tmpDir, "status.json"), makeConfig(), makeCtx());

    // Simulate successful run: all stories completed
    const prd = makePrd(3, "passed");
    sw.setPrd(prd);
    sw.setRunStatus("completed");

    // Write feature-level status
    await sw.writeFeatureStatus(featureDir, 2.5, 5);

    // Verify status.json exists in feature directory
    const statusPath = join(featureDir, "status.json");
    expect(existsSync(statusPath)).toBe(true);

    // Verify status is 'completed'
    const status = readFeatureStatus(featureDir);
    expect(status.run.status).toBe("completed");
    expect(status.progress.total).toBe(3);
    expect(status.progress.passed).toBe(3);
  });

  // ── AC-2: After a failed run, status is 'failed' ───────────────────────
  test("After failed run, feature status.json has status 'failed'", async () => {
    const featureDir = join(tmpDir, ".nax", "features", "auth-system");
    const sw = new StatusWriter(join(tmpDir, "status.json"), makeConfig(), makeCtx());

    // Simulate failed run: some stories failed
    const prd = makePrd(3);
    prd.userStories[0].status = "passed";
    prd.userStories[1].status = "failed";
    prd.userStories[2].status = "pending";

    sw.setPrd(prd);
    sw.setRunStatus("failed");

    // Write feature-level status
    await sw.writeFeatureStatus(featureDir, 1.0, 3);

    // Verify status is 'failed'
    const status = readFeatureStatus(featureDir);
    expect(status.run.status).toBe("failed");
    expect(status.progress.passed).toBe(1);
    expect(status.progress.failed).toBe(1);
    expect(status.progress.pending).toBe(1);
  });

  // ── AC-3: After a crash, status is 'crashed' ───────────────────────────
  test("After crash, feature status.json has status 'crashed' with crash metadata", async () => {
    const featureDir = join(tmpDir, ".nax", "features", "auth-system");
    const sw = new StatusWriter(join(tmpDir, "status.json"), makeConfig(), makeCtx());

    const prd = makePrd(2);
    sw.setPrd(prd);
    sw.setRunStatus("crashed");

    const crashTime = new Date().toISOString();
    await sw.writeFeatureStatus(featureDir, 0.5, 1, {
      crashedAt: crashTime,
      crashSignal: "SIGTERM",
    });

    // Verify status is 'crashed' with metadata
    const status = readFeatureStatus(featureDir);
    expect(status.run.status).toBe("crashed");
    expect(status.run.crashedAt).toBe(crashTime);
    expect(status.run.crashSignal).toBe("SIGTERM");
  });

  // ── AC-4: Uses same NaxStatusFile schema as project-level ──────────────
  test("Feature status.json uses same NaxStatusFile schema as project-level", async () => {
    const projectStatusPath = join(tmpDir, "status.json");
    const featureDir = join(tmpDir, ".nax", "features", "auth-system");

    const sw = new StatusWriter(projectStatusPath, makeConfig(), makeCtx());
    const prd = makePrd(2, "passed");
    sw.setPrd(prd);
    sw.setRunStatus("completed");

    // Write both project and feature status
    await sw.update(2.0, 4);
    await sw.writeFeatureStatus(featureDir, 2.0, 4);

    // Read both files
    const projectStatus = JSON.parse(readFileSync(projectStatusPath, "utf8")) as NaxStatusFile;
    const featureStatus = readFeatureStatus(featureDir);

    // Verify same schema structure and version
    expect(projectStatus.version).toBe(1);
    expect(featureStatus.version).toBe(1);

    // Verify key fields are present in both
    expect(projectStatus.run).toBeDefined();
    expect(featureStatus.run).toBeDefined();
    expect(projectStatus.progress).toBeDefined();
    expect(featureStatus.progress).toBeDefined();
    expect(projectStatus.cost).toBeDefined();
    expect(featureStatus.cost).toBeDefined();
    expect(projectStatus.iterations).toBeDefined();
    expect(featureStatus.iterations).toBeDefined();

    // Verify status values match
    expect(projectStatus.run.status).toBe(featureStatus.run.status);
    expect(projectStatus.cost.spent).toBe(featureStatus.cost.spent);
    expect(projectStatus.progress.total).toBe(featureStatus.progress.total);
  });
});

// ============================================================================
// Edge Cases and Error Handling
// ============================================================================

describe("Feature status writing — edge cases", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "sfc-002-edge-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("creates nested feature directory if it doesn't exist", async () => {
    const featureDir = join(tmpDir, ".nax", "features", "deeply", "nested", "feature");
    const sw = new StatusWriter(join(tmpDir, "status.json"), makeConfig(), makeCtx());
    sw.setPrd(makePrd());
    sw.setRunStatus("completed");

    await sw.writeFeatureStatus(featureDir, 1.0, 1);

    expect(existsSync(join(featureDir, "status.json"))).toBe(true);
  });

  test("overwrites existing feature status file on subsequent writes", async () => {
    const featureDir = join(tmpDir, ".nax", "features", "auth-system");
    const sw = new StatusWriter(join(tmpDir, "status.json"), makeConfig(), makeCtx());
    sw.setPrd(makePrd());

    // First write: running
    sw.setRunStatus("running");
    await sw.writeFeatureStatus(featureDir, 1.0, 1);
    let status = readFeatureStatus(featureDir);
    expect(status.run.status).toBe("running");

    // Second write: completed
    sw.setRunStatus("completed");
    await sw.writeFeatureStatus(featureDir, 2.0, 2);
    status = readFeatureStatus(featureDir);
    expect(status.run.status).toBe("completed");
    expect(status.cost.spent).toBe(2.0);
  });

  test("feature status includes accurate progress counts", async () => {
    const featureDir = join(tmpDir, ".nax", "features", "auth-system");
    const sw = new StatusWriter(join(tmpDir, "status.json"), makeConfig(), makeCtx());

    // Create PRD with mixed statuses
    const prd = makePrd(10);
    prd.userStories[0].status = "passed";
    prd.userStories[1].status = "passed";
    prd.userStories[2].status = "failed";
    prd.userStories[3].status = "paused";
    prd.userStories[4].status = "blocked";
    // 5-9 remain pending

    sw.setPrd(prd);
    sw.setRunStatus("failed");
    await sw.writeFeatureStatus(featureDir, 1.5, 2);

    const status = readFeatureStatus(featureDir);
    expect(status.progress.total).toBe(10);
    expect(status.progress.passed).toBe(2);
    expect(status.progress.failed).toBe(1);
    expect(status.progress.paused).toBe(1);
    expect(status.progress.blocked).toBe(1);
    expect(status.progress.pending).toBe(5);
  });

  test("feature status reflects cost limit from config", async () => {
    const featureDir = join(tmpDir, ".nax", "features", "auth-system");
    const config = makeConfig(10.0); // $10 limit
    const sw = new StatusWriter(join(tmpDir, "status.json"), config, makeCtx());

    sw.setPrd(makePrd());
    sw.setRunStatus("completed");
    await sw.writeFeatureStatus(featureDir, 5.0, 1);

    const status = readFeatureStatus(featureDir);
    expect(status.cost.limit).toBe(10.0);
    expect(status.cost.spent).toBe(5.0);
  });

  test("feature status with no cost limit shows null", async () => {
    const featureDir = join(tmpDir, ".nax", "features", "auth-system");
    const config = makeConfig(Number.POSITIVE_INFINITY); // No limit
    const sw = new StatusWriter(join(tmpDir, "status.json"), config, makeCtx());

    sw.setPrd(makePrd());
    sw.setRunStatus("completed");
    await sw.writeFeatureStatus(featureDir, 3.0, 1);

    const status = readFeatureStatus(featureDir);
    expect(status.cost.limit).toBeNull();
  });
});
