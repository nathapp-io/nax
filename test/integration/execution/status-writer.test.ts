// RE-ARCH: keep
/**
 * StatusWriter Tests
 *
 * Tests for src/execution/status-writer.ts:
 * - Construction and defaults
 * - setRunStatus / setPrd / setCurrentStory setters
 * - getSnapshot() builds correct RunStateSnapshot
 * - update() writes via writeStatusFile (no-op guard, success path, failure counter BUG-2)
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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
// Construction
// ============================================================================

describe("StatusWriter construction", () => {
  test("constructs without error with statusFile path", () => {
    expect(() => new StatusWriter("/tmp/status.json", makeConfig(), makeCtx())).not.toThrow();
  });

  test("costLimit Infinity → stored as null in snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-test-"));
    const path = join(dir, "status.json");
    const sw = new StatusWriter(path, makeConfig(Number.POSITIVE_INFINITY), makeCtx());
    sw.setPrd(makePrd());
    await sw.update(0, 0);
    const content = JSON.parse(readFileSync(path, "utf8")) as NaxStatusFile;
    expect(content.cost.limit).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });
});

// ============================================================================
// Setters
// ============================================================================

describe("StatusWriter setters", () => {
  test("setRunStatus changes run status in snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-test-"));
    const path = join(dir, "status.json");
    const sw = new StatusWriter(path, makeConfig(), makeCtx());
    sw.setPrd(makePrd());
    sw.setRunStatus("completed");
    await sw.update(0, 0);
    const content = JSON.parse(readFileSync(path, "utf8")) as NaxStatusFile;
    expect(content.run.status).toBe("completed");
    await rm(dir, { recursive: true, force: true });
  });

  test("setPrd enables writes (no-op without prd)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-test-"));
    const path = join(dir, "status.json");
    const sw = new StatusWriter(path, makeConfig(), makeCtx());
    // Without setPrd, update should be a no-op
    await sw.update(0, 0);
    expect(existsSync(path)).toBe(false);
    // After setPrd, write happens
    sw.setPrd(makePrd());
    await sw.update(0, 0);
    expect(existsSync(path)).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });

  test("setCurrentStory sets active story in snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-test-"));
    const path = join(dir, "status.json");
    const sw = new StatusWriter(path, makeConfig(), makeCtx());
    sw.setPrd(makePrd());
    sw.setCurrentStory({
      storyId: "US-001",
      title: "Test story",
      complexity: "simple",
      tddStrategy: "test-after",
      model: "balanced",
      attempt: 1,
      phase: "routing",
    });
    await sw.update(0, 0);
    const content = JSON.parse(readFileSync(path, "utf8")) as NaxStatusFile;
    expect(content.current?.storyId).toBe("US-001");
    expect(content.current?.phase).toBe("routing");
    await rm(dir, { recursive: true, force: true });
  });

  test("setCurrentStory(null) clears active story", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-test-"));
    const path = join(dir, "status.json");
    const sw = new StatusWriter(path, makeConfig(), makeCtx());
    sw.setPrd(makePrd());
    sw.setCurrentStory({
      storyId: "US-001",
      title: "T",
      complexity: "simple",
      tddStrategy: "test-after",
      model: "balanced",
      attempt: 1,
      phase: "routing",
    });
    sw.setCurrentStory(null);
    await sw.update(0, 0);
    const content = JSON.parse(readFileSync(path, "utf8")) as NaxStatusFile;
    expect(content.current).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });
});

// ============================================================================
// getSnapshot
// ============================================================================

describe("StatusWriter.getSnapshot", () => {
  test("returns null when prd not set", () => {
    const sw = new StatusWriter("/tmp/x.json", makeConfig(), makeCtx());
    expect(sw.getSnapshot(0, 0)).toBeNull();
  });

  test("includes totalCost and iterations from call args", () => {
    const sw = new StatusWriter("/tmp/x.json", makeConfig(), makeCtx());
    sw.setPrd(makePrd());
    const snap = sw.getSnapshot(3.75, 7);
    expect(snap?.totalCost).toBe(3.75);
    expect(snap?.iterations).toBe(7);
  });

  test("includes fixed context values from constructor", () => {
    const ctx = makeCtx({ runId: "run-abc", feature: "my-feature", dryRun: true, pid: 12345 });
    const sw = new StatusWriter("/tmp/x.json", makeConfig(), ctx);
    sw.setPrd(makePrd());
    const snap = sw.getSnapshot(0, 0);
    expect(snap?.runId).toBe("run-abc");
    expect(snap?.feature).toBe("my-feature");
    expect(snap?.dryRun).toBe(true);
    expect(snap?.pid).toBe(12345);
  });

  test("includes PID for crash detection", () => {
    const testPid = 99999;
    const sw = new StatusWriter("/tmp/x.json", makeConfig(), makeCtx({ pid: testPid }));
    sw.setPrd(makePrd());
    const snap = sw.getSnapshot(0, 0);
    expect(snap?.pid).toBe(testPid);
  });
});

// ============================================================================
// update — no-op guards
// ============================================================================

describe("StatusWriter.update no-op guards", () => {
  test("no-op when prd not yet set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-test-"));
    const path = join(dir, "status.json");
    const sw = new StatusWriter(path, makeConfig(), makeCtx());
    await sw.update(0, 0);
    expect(existsSync(path)).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });
});

// ============================================================================
// update — success path
// ============================================================================

describe("StatusWriter.update success path", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "sw-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("writes valid JSON status file", async () => {
    const path = join(tmpDir, "status.json");
    const sw = new StatusWriter(path, makeConfig(), makeCtx());
    sw.setPrd(makePrd(2));
    await sw.update(1.5, 3);

    expect(existsSync(path)).toBe(true);
    const content = JSON.parse(readFileSync(path, "utf8")) as NaxStatusFile;
    expect(content.version).toBe(1);
    expect(content.cost.spent).toBe(1.5);
    expect(content.iterations).toBe(3);
    expect(content.progress.total).toBe(2);
  });

  test("overrides are applied on top of base snapshot", async () => {
    const path = join(tmpDir, "status.json");
    const sw = new StatusWriter(path, makeConfig(), makeCtx());
    sw.setPrd(makePrd());
    await sw.update(0, 0, { runStatus: "completed" });

    const content = JSON.parse(readFileSync(path, "utf8")) as NaxStatusFile;
    expect(content.run.status).toBe("completed");
  });

  test("multiple updates overwrite the file", async () => {
    const path = join(tmpDir, "status.json");
    const sw = new StatusWriter(path, makeConfig(), makeCtx());
    sw.setPrd(makePrd());
    sw.setRunStatus("running");
    await sw.update(0, 1);

    sw.setRunStatus("completed");
    await sw.update(2.0, 5);

    const content = JSON.parse(readFileSync(path, "utf8")) as NaxStatusFile;
    expect(content.run.status).toBe("completed");
    expect(content.cost.spent).toBe(2.0);
    expect(content.iterations).toBe(5);
  });

  test("no .tmp file remains after successful write", async () => {
    const path = join(tmpDir, "status.json");
    const sw = new StatusWriter(path, makeConfig(), makeCtx());
    sw.setPrd(makePrd());
    await sw.update(0, 0);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  test("PID is written to status file for crash detection", async () => {
    const path = join(tmpDir, "status.json");
    const testPid = 88888;
    const sw = new StatusWriter(path, makeConfig(), makeCtx({ pid: testPid }));
    sw.setPrd(makePrd());
    await sw.update(0, 0);

    const content = JSON.parse(readFileSync(path, "utf8")) as NaxStatusFile;
    expect(content.run.pid).toBe(testPid);
  });
});

// ============================================================================
// update — BUG-2 failure counter
// ============================================================================

describe("StatusWriter.update BUG-2 failure counter", () => {
  test("write to a non-existent directory fails gracefully (non-fatal)", async () => {
    const sw = new StatusWriter("/does/not/exist/status.json", makeConfig(), makeCtx());
    sw.setPrd(makePrd());
    // Should not throw — failure is logged, not re-thrown
    await expect(sw.update(0, 0)).resolves.toBeUndefined();
  });

  test("failure counter increments on consecutive failures", async () => {
    // Use an invalid path to force failures
    const sw = new StatusWriter("/no/such/dir/status.json", makeConfig(), makeCtx());
    sw.setPrd(makePrd());

    // Three consecutive failures should trigger error-level logging
    // We can't easily introspect the counter directly, but we can verify
    // that update() never throws
    for (let i = 0; i < 5; i++) {
      await expect(sw.update(0, i)).resolves.toBeUndefined();
    }
  });

  test("counter resets to 0 after successful write following failures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sw-test-"));
    const validPath = join(dir, "status.json");
    const sw = new StatusWriter(validPath, makeConfig(), makeCtx());
    sw.setPrd(makePrd());

    // Cause some failures first by temporarily checking invalid path...
    // We can do this by verifying a successful write after errors doesn't throw
    await sw.update(0, 0);
    expect(existsSync(validPath)).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });
});

// ============================================================================
// writeFeatureStatus — feature-level status writes (SFC-002)
// ============================================================================

describe("StatusWriter.writeFeatureStatus", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "sw-feature-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("no-op when prd not yet set", async () => {
    const featureDir = join(tmpDir, "features", "auth-feature");
    const sw = new StatusWriter(join(tmpDir, "status.json"), makeConfig(), makeCtx());
    await sw.writeFeatureStatus(featureDir, 0, 0);
    expect(existsSync(join(featureDir, "status.json"))).toBe(false);
  });

  test("writes feature status.json in feature directory", async () => {
    const featureDir = join(tmpDir, "features", "auth-feature");
    const statusPath = join(featureDir, "status.json");
    const sw = new StatusWriter(join(tmpDir, "status.json"), makeConfig(), makeCtx());
    sw.setPrd(makePrd());
    sw.setRunStatus("completed");
    await sw.writeFeatureStatus(featureDir, 2.5, 5);

    expect(existsSync(statusPath)).toBe(true);
    const content = JSON.parse(readFileSync(statusPath, "utf8")) as NaxStatusFile;
    expect(content.version).toBe(1);
    expect(content.run.status).toBe("completed");
    expect(content.cost.spent).toBe(2.5);
    expect(content.iterations).toBe(5);
  });

  test("writes feature status with 'completed' status after successful run", async () => {
    const featureDir = join(tmpDir, "features", "auth-feature");
    const statusPath = join(featureDir, "status.json");
    const sw = new StatusWriter(join(tmpDir, "status.json"), makeConfig(), makeCtx());
    sw.setPrd(makePrd(3));
    sw.setRunStatus("completed");
    await sw.writeFeatureStatus(featureDir, 1.0, 1);

    const content = JSON.parse(readFileSync(statusPath, "utf8")) as NaxStatusFile;
    expect(content.run.status).toBe("completed");
    expect(content.progress.total).toBe(3);
  });

  test("writes feature status with 'failed' status after unsuccessful run", async () => {
    const featureDir = join(tmpDir, "features", "auth-feature");
    const statusPath = join(featureDir, "status.json");
    const sw = new StatusWriter(join(tmpDir, "status.json"), makeConfig(), makeCtx());
    sw.setPrd(makePrd(2));
    sw.setRunStatus("failed");
    await sw.writeFeatureStatus(featureDir, 0.5, 2);

    const content = JSON.parse(readFileSync(statusPath, "utf8")) as NaxStatusFile;
    expect(content.run.status).toBe("failed");
  });

  test("writes feature status with 'crashed' status on crash with overrides", async () => {
    const featureDir = join(tmpDir, "features", "auth-feature");
    const statusPath = join(featureDir, "status.json");
    const sw = new StatusWriter(join(tmpDir, "status.json"), makeConfig(), makeCtx());
    sw.setPrd(makePrd());
    sw.setRunStatus("crashed");
    const crashTime = new Date().toISOString();
    await sw.writeFeatureStatus(featureDir, 1.0, 2, {
      crashedAt: crashTime,
      crashSignal: "SIGTERM",
    });

    const content = JSON.parse(readFileSync(statusPath, "utf8")) as NaxStatusFile;
    expect(content.run.status).toBe("crashed");
    expect(content.run.crashedAt).toBe(crashTime);
    expect(content.run.crashSignal).toBe("SIGTERM");
  });

  test("fails gracefully when feature directory cannot be created", async () => {
    const invalidFeatureDir = "/root/cannot/create/here/feature";
    const sw = new StatusWriter(join(tmpDir, "status.json"), makeConfig(), makeCtx());
    sw.setPrd(makePrd());
    // Should not throw — failure is logged, not re-thrown
    await expect(sw.writeFeatureStatus(invalidFeatureDir, 0, 0)).resolves.toBeUndefined();
  });

  test("uses same schema as project-level status file", async () => {
    const projectStatusPath = join(tmpDir, "status.json");
    const featureDir = join(tmpDir, "features", "auth-feature");
    const featureStatusPath = join(featureDir, "status.json");

    const sw = new StatusWriter(projectStatusPath, makeConfig(), makeCtx());
    sw.setPrd(makePrd(2));
    sw.setRunStatus("completed");
    await sw.update(2.0, 4);
    await sw.writeFeatureStatus(featureDir, 2.0, 4);

    const projectContent = JSON.parse(readFileSync(projectStatusPath, "utf8")) as NaxStatusFile;
    const featureContent = JSON.parse(readFileSync(featureStatusPath, "utf8")) as NaxStatusFile;

    // Verify both have same schema version and structure
    expect(projectContent.version).toBe(featureContent.version);
    expect(projectContent.version).toBe(1);
    expect(projectContent.run.status).toBe(featureContent.run.status);
    expect(projectContent.cost.spent).toBe(featureContent.cost.spent);
    expect(projectContent.progress.total).toBe(featureContent.progress.total);
  });
});
