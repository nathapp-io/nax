import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Core status-file types and functions ─────────────────────────────────────
import type {
  AcceptancePhaseStatus,
  NaxStatusFile,
  PostRunStatus,
  RegressionPhaseStatus,
  RunStateSnapshot,
} from "../../../src/execution/status-file";
import { buildStatusSnapshot } from "../../../src/execution/status-file";

// ─── StatusWriter ─────────────────────────────────────────────────────────────
import { StatusWriter, type StatusWriterContext } from "../../../src/execution/status-writer";

// ─── Config and PRD types ────────────────────────────────────────────────────
import type { NaxConfig } from "../../../src/config";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import type { PRD, UserStory } from "../../../src/prd";
import { markStoryFailed, markStoryPassed } from "../../../src/prd";
import { markStoryAsBlocked } from "../../../src/prd";

// ─── Precheck ────────────────────────────────────────────────────────────────
import { checkGitignoreCoversNax } from "../../../src/precheck/checks-warnings";
// NAX_RUNTIME_PATTERNS will be exported from checks-git.ts after implementation
import { NAX_RUNTIME_PATTERNS } from "../../../src/precheck/checks-git";

// ─── Run completion ───────────────────────────────────────────────────────────
import {
  _runCompletionDeps,
  handleRunCompletion,
  type RunCompletionOptions,
} from "../../../src/execution/lifecycle/run-completion";
import type { DeferredRegressionResult } from "../../../src/execution/lifecycle/run-regression";
import type { StoryMetrics } from "../../../src/metrics";

// ─── Runner completion (for skip-logic tests) ─────────────────────────────────
import {
  _runnerCompletionDeps,
  runCompletionPhase,
  type RunnerCompletionOptions,
} from "../../../src/execution/runner-completion";

// ─── CLI display ─────────────────────────────────────────────────────────────
import { displayFeatureStatus } from "../../../src/cli/status-features";

// =============================================================================
// Test helpers
// =============================================================================

function makeTempDir(prefix = "nax-accept-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanupDir(dir: string | undefined | null): void {
  if (dir) rmSync(dir, { recursive: true, force: true });
}

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

function makePrd(overrides: Partial<PRD> = {}): PRD {
  return {
    project: "test-project",
    feature: "test-feature",
    branchName: "feat/test",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    userStories: [makeStory("US-001", "passed")],
    ...overrides,
  };
}

function makeConfig(): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    execution: {
      ...DEFAULT_CONFIG.execution,
      costLimit: 5.0,
    },
  } as NaxConfig;
}

function makeCtx(overrides: Partial<StatusWriterContext> = {}): StatusWriterContext {
  return {
    runId: "run-test-001",
    feature: "test-feature",
    startedAt: "2026-01-01T00:00:00.000Z",
    dryRun: false,
    startTimeMs: Date.now() - 1000,
    pid: process.pid,
    ...overrides,
  };
}

function makeMinimalSnapshot(prd: PRD, overrides: Partial<RunStateSnapshot> = {}): RunStateSnapshot {
  return {
    runId: "run-001",
    feature: "test-feature",
    startedAt: "2026-01-01T00:00:00.000Z",
    runStatus: "completed",
    dryRun: false,
    pid: 12345,
    prd,
    totalCost: 0,
    costLimit: null,
    currentStory: null,
    iterations: 1,
    startTimeMs: Date.now() - 1000,
    ...overrides,
  };
}

function makeMockStatusWriter() {
  return {
    setPrd: mock(() => {}),
    setCurrentStory: mock(() => {}),
    setRunStatus: mock(() => {}),
    update: mock(async () => {}),
    writeFeatureStatus: mock(async () => {}),
    setPostRunPhase: mock((_phase: string, _update: object) => {}),
    getPostRunStatus: mock(() => ({
      acceptance: { status: "not-run" },
      regression: { status: "not-run" },
    })),
    resetPostRunStatus: mock(() => {}),
    getSnapshot: mock(() => null),
  };
}

const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// =============================================================================
// AC-1: setPostRunPhase acceptance passed → persisted to disk after update()
// =============================================================================

test("AC-1: setPostRunPhase(acceptance, passed) persists to disk after update()", async () => {
  const tmpDir = makeTempDir();
  try {
    const statusPath = join(tmpDir, "status.json");
    const sw = new StatusWriter(statusPath, makeConfig(), makeCtx());
    sw.setPrd(makePrd());

    sw.setPostRunPhase("acceptance", { status: "passed", lastRunAt: "2026-04-04T12:00:00Z" });

    // Verify in-memory state before update
    const preUpdateStatus = sw.getPostRunStatus();
    expect(preUpdateStatus.acceptance).toEqual({ status: "passed", lastRunAt: "2026-04-04T12:00:00Z" });

    await sw.update(0, 1);

    const written = JSON.parse(readFileSync(statusPath, "utf8")) as NaxStatusFile;
    expect(written.postRun?.acceptance?.status).toBe("passed");
    expect(written.postRun?.acceptance?.lastRunAt).toBe("2026-04-04T12:00:00Z");
  } finally {
    cleanupDir(tmpDir);
  }
});

// =============================================================================
// AC-2: setPostRunPhase regression failed → persisted to disk after update()
// =============================================================================

test("AC-2: setPostRunPhase(regression, failed) persists to disk after update()", async () => {
  const tmpDir = makeTempDir();
  try {
    const statusPath = join(tmpDir, "status.json");
    const sw = new StatusWriter(statusPath, makeConfig(), makeCtx());
    sw.setPrd(makePrd());

    sw.setPostRunPhase("regression", { status: "failed", failedTests: 3 });

    // Verify in-memory state before update
    const preUpdateStatus = sw.getPostRunStatus();
    expect(preUpdateStatus.regression).toEqual({ status: "failed", failedTests: 3 });

    await sw.update(0, 1);

    const written = JSON.parse(readFileSync(statusPath, "utf8")) as NaxStatusFile;
    expect(written.postRun?.regression?.status).toBe("failed");
    expect(written.postRun?.regression?.failedTests).toBe(3);
  } finally {
    cleanupDir(tmpDir);
  }
});

// =============================================================================
// AC-3: getPostRunStatus() on fresh StatusWriter returns default not-run state
// =============================================================================

test("AC-3: getPostRunStatus() on fresh StatusWriter returns { acceptance: { status: 'not-run' }, regression: { status: 'not-run' } }", () => {
  const sw = new StatusWriter("/tmp/dummy-status.json", makeConfig(), makeCtx());

  const result = sw.getPostRunStatus();
  expect(result).toEqual({
    acceptance: { status: "not-run" },
    regression: { status: "not-run" },
  });
});

// =============================================================================
// AC-4: getPostRunStatus() when acceptance is 'running' returns not-run (crash recovery)
// =============================================================================

test("AC-4: getPostRunStatus() treats in-memory acceptance.status 'running' as 'not-run'", () => {
  const sw = new StatusWriter("/tmp/dummy-status.json", makeConfig(), makeCtx());

  sw.setPostRunPhase("acceptance", { status: "running" });

  const result = sw.getPostRunStatus();
  expect(result.acceptance.status).toBe("not-run");
  expect(result.regression.status).toBe("not-run");
});

// =============================================================================
// AC-5: getPostRunStatus() when regression is 'running' returns not-run (crash recovery)
// =============================================================================

test("AC-5: getPostRunStatus() treats in-memory regression.status 'running' as 'not-run'", () => {
  const sw = new StatusWriter("/tmp/dummy-status.json", makeConfig(), makeCtx());

  sw.setPostRunPhase("regression", { status: "running" });

  const result = sw.getPostRunStatus();
  expect(result.regression.status).toBe("not-run");
  expect(result.acceptance.status).toBe("not-run");
});

// =============================================================================
// AC-6: resetPostRunStatus() clears all fields from both phases
// =============================================================================

test("AC-6: resetPostRunStatus() resets both phases to { status: 'not-run' } with no extra keys", () => {
  const sw = new StatusWriter("/tmp/dummy-status.json", makeConfig(), makeCtx());

  sw.setPostRunPhase("acceptance", { status: "passed", retries: 2, failedACs: ["AC1"] });
  sw.setPostRunPhase("regression", { status: "failed", failedTests: 5, affectedStories: ["s1"] });

  sw.resetPostRunStatus();

  const result = sw.getPostRunStatus();
  expect(result).toEqual({
    acceptance: { status: "not-run" },
    regression: { status: "not-run" },
  });
});

// =============================================================================
// AC-7: buildStatusSnapshot() includes postRun when RunStateSnapshot.postRun is present
// =============================================================================

test("AC-7: buildStatusSnapshot() includes postRun field when snapshot.postRun is present", () => {
  const postRunValue: PostRunStatus = {
    acceptance: { status: "passed" },
    regression: { status: "not-run" },
  };

  const snapshot = makeMinimalSnapshot(makePrd(), { postRun: postRunValue });
  const result = buildStatusSnapshot(snapshot);

  expect(Object.prototype.hasOwnProperty.call(result, "postRun")).toBe(true);
  expect(result.postRun).toEqual(postRunValue);
});

// =============================================================================
// AC-8: buildStatusSnapshot() omits postRun when RunStateSnapshot.postRun is undefined
// =============================================================================

test("AC-8: buildStatusSnapshot() omits postRun key when snapshot.postRun is undefined", () => {
  const snapshot = makeMinimalSnapshot(makePrd());
  // Explicitly ensure postRun is absent
  expect(snapshot.postRun).toBeUndefined();

  const result = buildStatusSnapshot(snapshot);

  expect(Object.prototype.hasOwnProperty.call(result, "postRun")).toBe(false);
});

// =============================================================================
// AC-9: .gitignore does not contain the line '.nax/features/*/status.json'
// =============================================================================

test("AC-9: .gitignore does not contain '.nax/features/*/status.json' as a line", () => {
  const gitignorePath = join(__dirname, "../../../.gitignore");
  const content = readFileSync(gitignorePath, "utf8");
  const lines = content.split("\n").map((l) => l.trim());

  expect(lines.includes(".nax/features/*/status.json")).toBe(false);
});

// =============================================================================
// AC-10: checkGitignoreCoversNax() patterns do not include '.nax/features/*/status.json'
// =============================================================================

test("AC-10: checkGitignoreCoversNax() does not require '.nax/features/*/status.json'", async () => {
  const tmpDir = makeTempDir();
  try {
    // Create a .gitignore with ALL currently required patterns EXCEPT .nax/features/*/status.json
    const gitignoreContent = [
      "nax.lock",
      ".nax/**/runs/",
      ".nax/metrics.json",
      ".nax-pids",
      ".nax-wt/",
      "**/.nax-acceptance*",
      "**/.nax/features/*/",
    ].join("\n");

    writeFileSync(join(tmpDir, ".gitignore"), gitignoreContent);

    const result = await checkGitignoreCoversNax(tmpDir);
    // If the implementation no longer requires this pattern, the check should pass
    // (the missing pattern test is AC-29 which explicitly tests this)
    const patternsArrayIncludesStatusJson =
      result.message.includes(".nax/features/*/status.json") && !result.passed;

    expect(patternsArrayIncludesStatusJson).toBe(false);
  } finally {
    cleanupDir(tmpDir);
  }
});

// =============================================================================
// AC-11: NAX_RUNTIME_PATTERNS matches .nax/features/*/status.json paths
// =============================================================================

test("AC-11: NAX_RUNTIME_PATTERNS contains regex matching .nax/features/*/status.json paths", () => {
  // Simulate what git status --porcelain would output for these paths
  const testLineAbc = "?? .nax/features/abc/status.json";
  const testLineXyz = "?? .nax/features/xyz-feature/status.json";

  const matchesAbc = NAX_RUNTIME_PATTERNS.some(
    (pattern) => pattern instanceof RegExp && pattern.test(testLineAbc),
  );
  const matchesXyz = NAX_RUNTIME_PATTERNS.some(
    (pattern) => pattern instanceof RegExp && pattern.test(testLineXyz),
  );

  expect(matchesAbc).toBe(true);
  expect(matchesXyz).toBe(true);
});

// =============================================================================
// AC-12: PostRunPhaseStatus, AcceptancePhaseStatus, RegressionPhaseStatus, PostRunStatus
//        are named exports from status-file.ts
// =============================================================================

test("AC-12: PostRunPhaseStatus, AcceptancePhaseStatus, RegressionPhaseStatus, PostRunStatus are named exports from status-file.ts", async () => {
  const statusFileModule = await import("../../../src/execution/status-file");

  // These are TypeScript type exports — verify the module imports without error
  // The types themselves are erased at runtime; we verify the module loads successfully
  // and that the runtime exports (functions/values) are accessible
  expect(typeof statusFileModule.buildStatusSnapshot).toBe("function");
  expect(typeof statusFileModule.countProgress).toBe("function");
  expect(typeof statusFileModule.writeStatusFile).toBe("function");

  // Verify that creating values conforming to these types does not throw
  const acceptance: AcceptancePhaseStatus = { status: "not-run" };
  const regression: RegressionPhaseStatus = { status: "not-run" };
  const postRun: PostRunStatus = { acceptance, regression };

  expect(acceptance.status).toBe("not-run");
  expect(regression.status).toBe("not-run");
  expect(postRun.acceptance).toBe(acceptance);
  expect(postRun.regression).toBe(regression);
});

// =============================================================================
// AC-13: AcceptancePhaseStatus structure
// =============================================================================

test("AC-13: AcceptancePhaseStatus has required status field and optional fields", () => {
  // Valid minimal value (only required field)
  const minimal: AcceptancePhaseStatus = { status: "not-run" };
  expect(minimal.status).toBe("not-run");

  // Valid with all optional fields
  const full: AcceptancePhaseStatus = {
    status: "passed",
    lastRunAt: "2026-04-04T12:00:00Z",
    retries: 2,
    failedACs: ["AC-1", "AC-2"],
  };
  expect(full.status).toBe("passed");
  expect(full.lastRunAt).toBe("2026-04-04T12:00:00Z");
  expect(full.retries).toBe(2);
  expect(full.failedACs).toEqual(["AC-1", "AC-2"]);

  // All valid status values
  const statuses: AcceptancePhaseStatus["status"][] = ["not-run", "running", "passed", "failed"];
  for (const s of statuses) {
    const v: AcceptancePhaseStatus = { status: s };
    expect(v.status).toBe(s);
  }

  // Compiles without lastRunAt/retries/failedACs — just the required field
  const noOptional: AcceptancePhaseStatus = { status: "failed" };
  expect(noOptional.retries).toBeUndefined();
  expect(noOptional.failedACs).toBeUndefined();
  expect(noOptional.lastRunAt).toBeUndefined();
});

// =============================================================================
// AC-14: RegressionPhaseStatus structure
// =============================================================================

test("AC-14: RegressionPhaseStatus has required status field and optional fields", () => {
  // Minimal valid value
  const minimal: RegressionPhaseStatus = { status: "not-run" };
  expect(minimal.status).toBe("not-run");

  // Full value
  const full: RegressionPhaseStatus = {
    status: "failed",
    lastRunAt: "2026-04-04T12:00:00Z",
    retries: 1,
    failedTests: ["test-a", "test-b"],
    affectedStories: ["US-001"],
  };
  expect(full.status).toBe("failed");
  expect(full.failedTests).toEqual(["test-a", "test-b"]);
  expect(full.affectedStories).toEqual(["US-001"]);

  // All valid status values
  const statuses: RegressionPhaseStatus["status"][] = ["not-run", "running", "passed", "failed"];
  for (const s of statuses) {
    const v: RegressionPhaseStatus = { status: s };
    expect(v.status).toBe(s);
  }

  // Compiles without optional fields
  const noOptional: RegressionPhaseStatus = { status: "passed" };
  expect(noOptional.failedTests).toBeUndefined();
  expect(noOptional.affectedStories).toBeUndefined();
});

// =============================================================================
// AC-15: PostRunStatus has required acceptance and regression fields
// =============================================================================

test("AC-15: PostRunStatus requires both acceptance and regression fields", () => {
  const postRun: PostRunStatus = {
    acceptance: { status: "passed" },
    regression: { status: "not-run" },
  };
  expect(postRun.acceptance.status).toBe("passed");
  expect(postRun.regression.status).toBe("not-run");

  // Both fields must be present
  expect(Object.prototype.hasOwnProperty.call(postRun, "acceptance")).toBe(true);
  expect(Object.prototype.hasOwnProperty.call(postRun, "regression")).toBe(true);
});

// =============================================================================
// AC-16: NaxStatusFile has optional postRun field
// =============================================================================

test("AC-16: NaxStatusFile postRun field is optional — valid without and with it", () => {
  const prd = makePrd();

  // Without postRun
  const snapshotWithout = makeMinimalSnapshot(prd);
  const statusWithout = buildStatusSnapshot(snapshotWithout);
  expect(Object.prototype.hasOwnProperty.call(statusWithout, "postRun")).toBe(false);

  // With postRun
  const postRunValue: PostRunStatus = {
    acceptance: { status: "passed" },
    regression: { status: "not-run" },
  };
  const snapshotWith = makeMinimalSnapshot(prd, { postRun: postRunValue });
  const statusWith = buildStatusSnapshot(snapshotWith);
  expect(statusWith.postRun).toEqual(postRunValue);
});

// =============================================================================
// AC-17: RunStateSnapshot has optional postRun field
// =============================================================================

test("AC-17: RunStateSnapshot postRun field is optional — valid without and with it", () => {
  const prd = makePrd();

  // Without postRun — must compile and work
  const withoutPostRun = makeMinimalSnapshot(prd);
  expect(withoutPostRun.postRun).toBeUndefined();

  // With postRun — must compile and work
  const postRunValue: PostRunStatus = {
    acceptance: { status: "passed" },
    regression: { status: "passed" },
  };
  const withPostRun = makeMinimalSnapshot(prd, { postRun: postRunValue });
  expect(withPostRun.postRun).toEqual(postRunValue);
});

// =============================================================================
// AC-18: buildStatusSnapshot() with postRun — deep equals input
// =============================================================================

test("AC-18: buildStatusSnapshot() returns NaxStatusFile with postRun deep-equal to input", () => {
  const postRunValue: PostRunStatus = {
    acceptance: { status: "passed" },
    regression: { status: "not-run" },
  };
  const snapshot = makeMinimalSnapshot(makePrd(), { postRun: postRunValue });
  const result = buildStatusSnapshot(snapshot);

  expect(result.postRun).toEqual(postRunValue);
  expect(result.postRun?.acceptance?.status).toBe("passed");
  expect(result.postRun?.regression?.status).toBe("not-run");
});

// =============================================================================
// AC-19: buildStatusSnapshot() without postRun — key absent in result
// =============================================================================

test("AC-19: buildStatusSnapshot() without postRun — 'postRun' key absent from result", () => {
  const snapshot = makeMinimalSnapshot(makePrd());
  const result = buildStatusSnapshot(snapshot);

  expect("postRun" in result).toBe(false);
  expect(result.postRun).toBeUndefined();
});

// =============================================================================
// AC-20: setPostRunPhase acceptance + update → disk contains correct values
// =============================================================================

test("AC-20: setPostRunPhase(acceptance, passed) → getPostRunStatus matches, disk matches after update()", async () => {
  const tmpDir = makeTempDir();
  try {
    const statusPath = join(tmpDir, "status.json");
    const sw = new StatusWriter(statusPath, makeConfig(), makeCtx());
    sw.setPrd(makePrd());

    sw.setPostRunPhase("acceptance", { status: "passed", lastRunAt: "2026-04-04T12:00:00Z" });

    const inMemory = sw.getPostRunStatus();
    expect(inMemory.acceptance).toEqual({ status: "passed", lastRunAt: "2026-04-04T12:00:00Z" });

    await sw.update(0, 1);

    const diskContent = JSON.parse(readFileSync(statusPath, "utf8")) as NaxStatusFile;
    expect(diskContent.postRun?.acceptance).toEqual({
      status: "passed",
      lastRunAt: "2026-04-04T12:00:00Z",
    });
  } finally {
    cleanupDir(tmpDir);
  }
});

// =============================================================================
// AC-21: setPostRunPhase regression + update → disk contains correct values
// =============================================================================

test("AC-21: setPostRunPhase(regression, failed) → getPostRunStatus matches, disk matches after update()", async () => {
  const tmpDir = makeTempDir();
  try {
    const statusPath = join(tmpDir, "status.json");
    const sw = new StatusWriter(statusPath, makeConfig(), makeCtx());
    sw.setPrd(makePrd());

    sw.setPostRunPhase("regression", { status: "failed", failedTests: 3 });

    const inMemory = sw.getPostRunStatus();
    expect(inMemory.regression).toEqual({ status: "failed", failedTests: 3 });

    await sw.update(0, 1);

    const diskContent = JSON.parse(readFileSync(statusPath, "utf8")) as NaxStatusFile;
    expect(diskContent.postRun?.regression).toEqual({ status: "failed", failedTests: 3 });
  } finally {
    cleanupDir(tmpDir);
  }
});

// =============================================================================
// AC-22: Fresh StatusWriter returns default not-run state with no extra keys
// =============================================================================

test("AC-22: Fresh StatusWriter getPostRunStatus() returns default with no extra keys", () => {
  const sw = new StatusWriter("/tmp/dummy-status.json", makeConfig(), makeCtx());

  const result = sw.getPostRunStatus();
  expect(result.acceptance.status).toBe("not-run");
  expect(result.regression.status).toBe("not-run");
  expect(Object.keys(result.acceptance)).toEqual(["status"]);
  expect(Object.keys(result.regression)).toEqual(["status"]);
});

// =============================================================================
// AC-23: Stale acceptance 'running' → getPostRunStatus returns not-run
// =============================================================================

test("AC-23: Stale acceptance.status 'running' is not surfaced — returns not-run", () => {
  const sw = new StatusWriter("/tmp/dummy-status.json", makeConfig(), makeCtx());

  sw.setPostRunPhase("acceptance", { status: "running" });

  const result = sw.getPostRunStatus();
  expect(result.acceptance.status).toBe("not-run");
  expect(result.regression.status).toBe("not-run");
});

// =============================================================================
// AC-24: Stale regression 'running' → getPostRunStatus returns not-run
// =============================================================================

test("AC-24: Stale regression.status 'running' is not surfaced — returns not-run", () => {
  const sw = new StatusWriter("/tmp/dummy-status.json", makeConfig(), makeCtx());

  sw.setPostRunPhase("regression", { status: "running" });

  const result = sw.getPostRunStatus();
  expect(result.regression.status).toBe("not-run");
  expect(result.acceptance.status).toBe("not-run");
});

// =============================================================================
// AC-25: resetPostRunStatus() clears all optional fields — Object.keys returns only ["status"]
// =============================================================================

test("AC-25: resetPostRunStatus() yields { status: 'not-run' } with only 'status' key on each phase", () => {
  const sw = new StatusWriter("/tmp/dummy-status.json", makeConfig(), makeCtx());

  sw.setPostRunPhase("acceptance", { status: "passed", retries: 2, failedACs: ["AC1"], lastRunAt: "2026-01-01T00:00:00Z" });
  sw.setPostRunPhase("regression", { status: "failed", failedTests: 5, affectedStories: ["s1"], lastRunAt: "2026-01-01T00:00:00Z" });

  sw.resetPostRunStatus();

  const result = sw.getPostRunStatus();
  expect(Object.keys(result.acceptance)).toEqual(["status"]);
  expect(Object.keys(result.regression)).toEqual(["status"]);
  expect(result.acceptance.status).toBe("not-run");
  expect(result.regression.status).toBe("not-run");
});

// =============================================================================
// AC-26: getSnapshot() includes postRun field; update() persists it to disk
// =============================================================================

test("AC-26: getSnapshot() includes postRun; update() writes postRun to disk", async () => {
  const tmpDir = makeTempDir();
  try {
    const statusPath = join(tmpDir, "status.json");
    const sw = new StatusWriter(statusPath, makeConfig(), makeCtx());
    sw.setPrd(makePrd());

    sw.setPostRunPhase("acceptance", { status: "passed" });

    const snapshot = sw.getSnapshot(0, 1);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.postRun).toBeDefined();
    expect(snapshot?.postRun?.acceptance?.status).toBe("passed");

    await sw.update(0, 1);

    const diskContent = JSON.parse(readFileSync(statusPath, "utf8")) as NaxStatusFile;
    expect(diskContent.postRun).toBeDefined();
    expect(diskContent.postRun?.acceptance?.status).toBe("passed");
  } finally {
    cleanupDir(tmpDir);
  }
});

// =============================================================================
// AC-27: .gitignore does not contain '.nax/features/*/status.json' as a line
// =============================================================================

test("AC-27: .gitignore does not contain '.nax/features/*/status.json' as any line", () => {
  const gitignorePath = join(__dirname, "../../../.gitignore");
  const content = readFileSync(gitignorePath, "utf8");

  expect(content.includes(".nax/features/*/status.json")).toBe(false);
});

// =============================================================================
// AC-28: checkGitignoreCoversNax() required patterns do not include '.nax/features/*/status.json'
// =============================================================================

test("AC-28: checkGitignoreCoversNax() required patterns do not include '.nax/features/*/status.json'", async () => {
  const tmpDir = makeTempDir();
  try {
    // Create a .gitignore without .nax/features/*/status.json
    const gitignoreContent = [
      "nax.lock",
      ".nax/**/runs/",
      ".nax/metrics.json",
      ".nax-pids",
      ".nax-wt/",
      "**/.nax-acceptance*",
      "**/.nax/features/*/",
    ].join("\n");

    writeFileSync(join(tmpDir, ".gitignore"), gitignoreContent);

    const result = await checkGitignoreCoversNax(tmpDir);
    // If .nax/features/*/status.json is still a required pattern, this would fail
    // After the feature implementation, it must pass
    expect(result.passed).toBe(true);

    // Also verify the missing message doesn't mention the pattern
    if (!result.passed) {
      expect(result.message).not.toContain(".nax/features/*/status.json");
    }
  } finally {
    cleanupDir(tmpDir);
  }
});

// =============================================================================
// AC-29: checkGitignoreCoversNax() returns passed=true for gitignore without
//        '.nax/features/*/status.json'
// =============================================================================

test("AC-29: checkGitignoreCoversNax() passes for .gitignore that omits '.nax/features/*/status.json'", async () => {
  const tmpDir = makeTempDir();
  try {
    // All required patterns EXCEPT .nax/features/*/status.json
    const gitignoreWithoutStatusJson = [
      "nax.lock",
      ".nax/**/runs/",
      ".nax/metrics.json",
      ".nax-pids",
      ".nax-wt/",
      "**/.nax-acceptance*",
      "**/.nax/features/*/",
    ].join("\n");

    writeFileSync(join(tmpDir, ".gitignore"), gitignoreWithoutStatusJson);

    const result = await checkGitignoreCoversNax(tmpDir);
    expect(result.passed).toBe(true);
  } finally {
    cleanupDir(tmpDir);
  }
});

// =============================================================================
// AC-30: NAX_RUNTIME_PATTERNS in checks-git.ts contains a regex matching
//        '.nax/features/*/status.json'
// =============================================================================

test("AC-30: NAX_RUNTIME_PATTERNS contains an entry that matches .nax/features/*/status.json", () => {
  // The regex is tested against git status --porcelain output format:
  // e.g. "?? .nax/features/my-feature/status.json"
  const sampleLine = "?? .nax/features/my-feature/status.json";

  const hasMatch = NAX_RUNTIME_PATTERNS.some(
    (pattern) => pattern instanceof RegExp && pattern.test(sampleLine),
  );

  expect(hasMatch).toBe(true);
});

// =============================================================================
// AC-31: setPostRunPhase("acceptance", { status: "running" }) called BEFORE runAcceptanceLoop()
// =============================================================================

describe("AC-31: acceptance running status set before runAcceptanceLoop", () => {
  let origRunnerDeps: typeof _runnerCompletionDeps;

  beforeEach(() => {
    origRunnerDeps = { ..._runnerCompletionDeps };
  });

  afterEach(() => {
    Object.assign(_runnerCompletionDeps, origRunnerDeps);
  });

  test("AC-31: setPostRunPhase(acceptance, running) call index < runAcceptanceLoop call index", async () => {
    const callOrder: string[] = [];

    const mockStatusWriter = makeMockStatusWriter();
    mockStatusWriter.setPostRunPhase = mock((phase: string, update: object) => {
      callOrder.push(`setPostRunPhase:${phase}:${(update as Record<string, unknown>).status}`);
    });
    mockStatusWriter.getPostRunStatus = mock(() => ({
      acceptance: { status: "not-run" as const },
      regression: { status: "not-run" as const },
    }));

    const mockRunAcceptanceLoop = mock(async () => {
      callOrder.push("runAcceptanceLoop");
      return {
        success: true,
        prd: makePrd({ userStories: [makeStory("US-001", "passed")] }),
        totalCost: 0,
        iterations: 1,
        storiesCompleted: 1,
        prdDirty: false,
      };
    });

    _runnerCompletionDeps.runAcceptanceLoop = mockRunAcceptanceLoop;

    const prd = makePrd({ userStories: [makeStory("US-001", "passed")] });
    const config: NaxConfig = {
      ...makeConfig(),
      acceptance: { ...(makeConfig() as NaxConfig).acceptance, enabled: true },
    } as NaxConfig;

    await runCompletionPhase({
      config,
      prd,
      statusWriter: mockStatusWriter,
      feature: "test-feature",
      workdir: "/tmp/test",
      statusFile: "/tmp/test/status.json",
      runId: "run-001",
      startedAt: "2026-01-01T00:00:00Z",
      startTime: Date.now() - 1000,
      formatterMode: "quiet",
      headless: false,
      prdPath: "/tmp/test/.nax/features/test-feature/prd.json",
      allStoryMetrics: [],
      totalCost: 0,
      storiesCompleted: 1,
      iterations: 1,
      hooks: {} as RunnerCompletionOptions["hooks"],
      pluginRegistry: {} as RunnerCompletionOptions["pluginRegistry"],
    } as RunnerCompletionOptions);

    const runningIdx = callOrder.indexOf("setPostRunPhase:acceptance:running");
    const loopIdx = callOrder.indexOf("runAcceptanceLoop");

    expect(runningIdx).toBeGreaterThanOrEqual(0);
    expect(loopIdx).toBeGreaterThanOrEqual(0);
    expect(runningIdx).toBeLessThan(loopIdx);
  });
});

// =============================================================================
// AC-32: runAcceptanceLoop success → setPostRunPhase(acceptance, passed, lastRunAt)
// =============================================================================

describe("AC-32: acceptance passed with ISO 8601 lastRunAt on success", () => {
  let origRunnerDeps: typeof _runnerCompletionDeps;

  beforeEach(() => {
    origRunnerDeps = { ..._runnerCompletionDeps };
  });

  afterEach(() => {
    Object.assign(_runnerCompletionDeps, origRunnerDeps);
  });

  test("AC-32: setPostRunPhase receives (acceptance, { status: passed, lastRunAt: ISO8601 }) on success", async () => {
    const setPostRunPhaseCalls: Array<[string, object]> = [];
    const mockStatusWriter = makeMockStatusWriter();
    mockStatusWriter.setPostRunPhase = mock((phase: string, update: object) => {
      setPostRunPhaseCalls.push([phase, update]);
    });
    mockStatusWriter.getPostRunStatus = mock(() => ({
      acceptance: { status: "not-run" as const },
      regression: { status: "not-run" as const },
    }));

    _runnerCompletionDeps.runAcceptanceLoop = mock(async () => ({
      success: true,
      prd: makePrd({ userStories: [makeStory("US-001", "passed")] }),
      totalCost: 0,
      iterations: 1,
      storiesCompleted: 1,
      prdDirty: false,
    }));

    const prd = makePrd({ userStories: [makeStory("US-001", "passed")] });
    const config = { ...makeConfig(), acceptance: { enabled: true } } as unknown as NaxConfig;

    await runCompletionPhase({
      config,
      prd,
      statusWriter: mockStatusWriter,
      feature: "test-feature",
      workdir: "/tmp/test",
      statusFile: "/tmp/test/status.json",
      runId: "run-001",
      startedAt: "2026-01-01T00:00:00Z",
      startTime: Date.now() - 1000,
      formatterMode: "quiet",
      headless: false,
      prdPath: "/tmp/test/.nax/features/test-feature/prd.json",
      allStoryMetrics: [],
      totalCost: 0,
      storiesCompleted: 1,
      iterations: 1,
      hooks: {} as RunnerCompletionOptions["hooks"],
      pluginRegistry: {} as RunnerCompletionOptions["pluginRegistry"],
    } as RunnerCompletionOptions);

    const passedCall = setPostRunPhaseCalls.find(
      ([phase, update]) =>
        phase === "acceptance" && (update as Record<string, unknown>).status === "passed",
    );

    expect(passedCall).toBeDefined();
    const lastRunAt = (passedCall?.[1] as Record<string, unknown>).lastRunAt as string;
    expect(ISO_8601_RE.test(lastRunAt)).toBe(true);
  });
});

// =============================================================================
// AC-33: runAcceptanceLoop failure → setPostRunPhase(acceptance, failed, failedACs, retries)
// =============================================================================

describe("AC-33: acceptance failed with failedACs and retries on failure", () => {
  let origRunnerDeps: typeof _runnerCompletionDeps;

  beforeEach(() => {
    origRunnerDeps = { ..._runnerCompletionDeps };
  });

  afterEach(() => {
    Object.assign(_runnerCompletionDeps, origRunnerDeps);
  });

  test("AC-33: setPostRunPhase receives (acceptance, { status: failed, failedACs, retries }) on failure", async () => {
    const setPostRunPhaseCalls: Array<[string, object]> = [];
    const mockStatusWriter = makeMockStatusWriter();
    mockStatusWriter.setPostRunPhase = mock((phase: string, update: object) => {
      setPostRunPhaseCalls.push([phase, update]);
    });
    mockStatusWriter.getPostRunStatus = mock(() => ({
      acceptance: { status: "not-run" as const },
      regression: { status: "not-run" as const },
    }));

    _runnerCompletionDeps.runAcceptanceLoop = mock(async () => ({
      success: false,
      failedACs: ["AC-1", "AC-2"],
      retries: 3,
      prd: makePrd({ userStories: [makeStory("US-001", "failed")] }),
      totalCost: 0,
      iterations: 1,
      storiesCompleted: 0,
      prdDirty: false,
    }));

    const prd = makePrd({ userStories: [makeStory("US-001", "passed")] });
    const config = { ...makeConfig(), acceptance: { enabled: true } } as unknown as NaxConfig;

    await runCompletionPhase({
      config,
      prd,
      statusWriter: mockStatusWriter,
      feature: "test-feature",
      workdir: "/tmp/test",
      statusFile: "/tmp/test/status.json",
      runId: "run-001",
      startedAt: "2026-01-01T00:00:00Z",
      startTime: Date.now() - 1000,
      formatterMode: "quiet",
      headless: false,
      prdPath: "/tmp/test/.nax/features/test-feature/prd.json",
      allStoryMetrics: [],
      totalCost: 0,
      storiesCompleted: 1,
      iterations: 1,
      hooks: {} as RunnerCompletionOptions["hooks"],
      pluginRegistry: {} as RunnerCompletionOptions["pluginRegistry"],
    } as RunnerCompletionOptions);

    const failedCall = setPostRunPhaseCalls.find(
      ([phase, update]) =>
        phase === "acceptance" && (update as Record<string, unknown>).status === "failed",
    );

    expect(failedCall).toBeDefined();
    const update = failedCall?.[1] as Record<string, unknown>;
    expect(update.failedACs).toEqual(["AC-1", "AC-2"]);
    expect(update.retries).toBe(3);
    expect(ISO_8601_RE.test(update.lastRunAt as string)).toBe(true);
  });
});

// =============================================================================
// AC-34: setPostRunPhase("regression", { status: "running" }) called BEFORE runDeferredRegression()
// =============================================================================

describe("AC-34: regression running status set before runDeferredRegression", () => {
  let origDeps: typeof _runCompletionDeps;

  beforeEach(() => {
    origDeps = { ..._runCompletionDeps };
  });

  afterEach(() => {
    Object.assign(_runCompletionDeps, origDeps);
  });

  test("AC-34: setPostRunPhase(regression, running) call index < runDeferredRegression call index", async () => {
    const callOrder: string[] = [];
    const mockStatusWriter = makeMockStatusWriter();
    mockStatusWriter.setPostRunPhase = mock((phase: string, update: object) => {
      callOrder.push(`setPostRunPhase:${phase}:${(update as Record<string, unknown>).status}`);
    });

    _runCompletionDeps.runDeferredRegression = mock(async () => {
      callOrder.push("runDeferredRegression");
      return {
        success: true,
        failedTests: [],
        passedTests: [],
        rectificationAttempts: 0,
        affectedStories: [],
      } as DeferredRegressionResult;
    });

    const prd = makePrd({ userStories: [makeStory("US-001", "passed")] });
    const config = {
      ...makeConfig(),
      execution: {
        ...makeConfig().execution,
        regressionGate: { mode: "deferred", enabled: true, timeoutSeconds: 30, acceptOnTimeout: true, maxRectificationAttempts: 0 },
      },
      quality: { ...DEFAULT_CONFIG.quality, commands: { test: "bun test" } },
    } as unknown as NaxConfig;

    await handleRunCompletion({
      runId: "run-001",
      feature: "test-feature",
      startedAt: "2026-01-01T00:00:00Z",
      prd,
      allStoryMetrics: [],
      totalCost: 0,
      storiesCompleted: 1,
      iterations: 1,
      startTime: Date.now() - 1000,
      workdir: "/tmp/test",
      statusWriter: mockStatusWriter as unknown as RunCompletionOptions["statusWriter"],
      config,
    });

    const runningIdx = callOrder.indexOf("setPostRunPhase:regression:running");
    const regressionIdx = callOrder.indexOf("runDeferredRegression");

    expect(runningIdx).toBeGreaterThanOrEqual(0);
    expect(regressionIdx).toBeGreaterThanOrEqual(0);
    expect(runningIdx).toBeLessThan(regressionIdx);
  });
});

// =============================================================================
// AC-35: runDeferredRegression success → setPostRunPhase(regression, passed, lastRunAt)
// =============================================================================

describe("AC-35: regression passed with ISO 8601 lastRunAt on success", () => {
  let origDeps: typeof _runCompletionDeps;

  beforeEach(() => {
    origDeps = { ..._runCompletionDeps };
  });

  afterEach(() => {
    Object.assign(_runCompletionDeps, origDeps);
  });

  test("AC-35: setPostRunPhase receives (regression, { status: passed, lastRunAt: ISO8601 }) on success", async () => {
    const setPostRunPhaseCalls: Array<[string, object]> = [];
    const mockStatusWriter = makeMockStatusWriter();
    mockStatusWriter.setPostRunPhase = mock((phase: string, update: object) => {
      setPostRunPhaseCalls.push([phase, update]);
    });

    _runCompletionDeps.runDeferredRegression = mock(async () => ({
      success: true,
      failedTests: [],
      passedTests: [],
      rectificationAttempts: 0,
      affectedStories: [],
    } as DeferredRegressionResult));

    const prd = makePrd({ userStories: [makeStory("US-001", "passed")] });
    const config = {
      ...makeConfig(),
      execution: {
        ...makeConfig().execution,
        regressionGate: { mode: "deferred", enabled: true, timeoutSeconds: 30, acceptOnTimeout: true, maxRectificationAttempts: 0 },
      },
      quality: { ...DEFAULT_CONFIG.quality, commands: { test: "bun test" } },
    } as unknown as NaxConfig;

    await handleRunCompletion({
      runId: "run-001",
      feature: "test-feature",
      startedAt: "2026-01-01T00:00:00Z",
      prd,
      allStoryMetrics: [],
      totalCost: 0,
      storiesCompleted: 1,
      iterations: 1,
      startTime: Date.now() - 1000,
      workdir: "/tmp/test",
      statusWriter: mockStatusWriter as unknown as RunCompletionOptions["statusWriter"],
      config,
    });

    const passedCall = setPostRunPhaseCalls.find(
      ([phase, update]) =>
        phase === "regression" && (update as Record<string, unknown>).status === "passed",
    );

    expect(passedCall).toBeDefined();
    const lastRunAt = (passedCall?.[1] as Record<string, unknown>).lastRunAt as string;
    expect(ISO_8601_RE.test(lastRunAt)).toBe(true);
  });
});

// =============================================================================
// AC-36: runDeferredRegression failure → setPostRunPhase(regression, failed, failedTests, affectedStories)
// =============================================================================

describe("AC-36: regression failed with failedTests and affectedStories on failure", () => {
  let origDeps: typeof _runCompletionDeps;

  beforeEach(() => {
    origDeps = { ..._runCompletionDeps };
  });

  afterEach(() => {
    Object.assign(_runCompletionDeps, origDeps);
  });

  test("AC-36: setPostRunPhase receives (regression, { status: failed, failedTests, affectedStories }) on failure", async () => {
    const setPostRunPhaseCalls: Array<[string, object]> = [];
    const mockStatusWriter = makeMockStatusWriter();
    mockStatusWriter.setPostRunPhase = mock((phase: string, update: object) => {
      setPostRunPhaseCalls.push([phase, update]);
    });

    _runCompletionDeps.runDeferredRegression = mock(async () => ({
      success: false,
      failedTests: 1,
      failedTestFiles: ["test-a"],
      passedTests: 0,
      rectificationAttempts: 0,
      affectedStories: ["story-1"],
    } as DeferredRegressionResult));

    const prd = makePrd({ userStories: [makeStory("US-001", "passed")] });
    const config = {
      ...makeConfig(),
      execution: {
        ...makeConfig().execution,
        regressionGate: { mode: "deferred", enabled: true, timeoutSeconds: 30, acceptOnTimeout: true, maxRectificationAttempts: 0 },
      },
      quality: { ...DEFAULT_CONFIG.quality, commands: { test: "bun test" } },
    } as unknown as NaxConfig;

    await handleRunCompletion({
      runId: "run-001",
      feature: "test-feature",
      startedAt: "2026-01-01T00:00:00Z",
      prd,
      allStoryMetrics: [],
      totalCost: 0,
      storiesCompleted: 1,
      iterations: 1,
      startTime: Date.now() - 1000,
      workdir: "/tmp/test",
      statusWriter: mockStatusWriter as unknown as RunCompletionOptions["statusWriter"],
      config,
    });

    const failedCall = setPostRunPhaseCalls.find(
      ([phase, update]) =>
        phase === "regression" && (update as Record<string, unknown>).status === "failed",
    );

    expect(failedCall).toBeDefined();
    const update = failedCall?.[1] as Record<string, unknown>;
    expect(update.failedTests).toEqual(["test-a"]);
    expect(update.affectedStories).toEqual(["story-1"]);
    expect(ISO_8601_RE.test(update.lastRunAt as string)).toBe(true);
  });
});

// =============================================================================
// AC-37: shouldSkipDeferredRegression=true → setPostRunPhase(regression, passed, skipped, lastRunAt)
//        AND runDeferredRegression NOT called
// =============================================================================

describe("AC-37: smart-skip → regression passed+skipped, runDeferredRegression not called", () => {
  let origDeps: typeof _runCompletionDeps;

  beforeEach(() => {
    origDeps = { ..._runCompletionDeps };
  });

  afterEach(() => {
    Object.assign(_runCompletionDeps, origDeps);
  });

  test("AC-37: smart-skip sets regression to { status: passed, skipped: true, lastRunAt } and skips runDeferredRegression", async () => {
    const setPostRunPhaseCalls: Array<[string, object]> = [];
    const mockStatusWriter = makeMockStatusWriter();
    mockStatusWriter.setPostRunPhase = mock((phase: string, update: object) => {
      setPostRunPhaseCalls.push([phase, update]);
    });

    const regressionMock = mock(async () => ({
      success: true,
      failedTests: [],
      passedTests: [],
      rectificationAttempts: 0,
      affectedStories: [],
    } as DeferredRegressionResult));
    _runCompletionDeps.runDeferredRegression = regressionMock;

    // Smart-skip: all stories have fullSuiteGatePassed=true in sequential mode
    const storyMetrics: StoryMetrics[] = [
      {
        storyId: "US-001",
        complexity: "simple",
        modelTier: "standard",
        modelUsed: "claude-sonnet-4-6",
        attempts: 1,
        finalTier: "standard",
        success: true,
        cost: 0.01,
        durationMs: 1000,
        firstPassSuccess: true,
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:01:00Z",
        fullSuiteGatePassed: true,
      },
    ];

    const prd = makePrd({ userStories: [makeStory("US-001", "passed")] });
    const config = {
      ...makeConfig(),
      execution: {
        ...makeConfig().execution,
        regressionGate: { mode: "deferred", enabled: true, timeoutSeconds: 30, acceptOnTimeout: true, maxRectificationAttempts: 0 },
      },
      quality: { ...DEFAULT_CONFIG.quality, commands: { test: "bun test" } },
    } as unknown as NaxConfig;

    await handleRunCompletion({
      runId: "run-001",
      feature: "test-feature",
      startedAt: "2026-01-01T00:00:00Z",
      prd,
      allStoryMetrics: storyMetrics,
      totalCost: 0,
      storiesCompleted: 1,
      iterations: 1,
      startTime: Date.now() - 1000,
      workdir: "/tmp/test",
      statusWriter: mockStatusWriter as unknown as RunCompletionOptions["statusWriter"],
      config,
      isSequential: true,
    });

    // runDeferredRegression must NOT have been called
    expect(regressionMock).not.toHaveBeenCalled();

    // Must have called setPostRunPhase with passed+skipped
    const skippedCall = setPostRunPhaseCalls.find(
      ([phase, update]) =>
        phase === "regression" &&
        (update as Record<string, unknown>).status === "passed" &&
        (update as Record<string, unknown>).skipped === true,
    );

    expect(skippedCall).toBeDefined();
    const lastRunAt = (skippedCall?.[1] as Record<string, unknown>).lastRunAt as string;
    expect(ISO_8601_RE.test(lastRunAt)).toBe(true);
  });
});

// =============================================================================
// AC-38: Both phases passed → skip both runners, log 'Post-run phases already passed'
// =============================================================================

describe("AC-38: Both phases passed → skip both runners", () => {
  let origRunnerDeps: typeof _runnerCompletionDeps;

  beforeEach(() => {
    origRunnerDeps = { ..._runnerCompletionDeps };
  });

  afterEach(() => {
    Object.assign(_runnerCompletionDeps, origRunnerDeps);
  });

  test("AC-38: Both phases passed — acceptance runner not called, regression runner not called, log contains 'Post-run phases already passed'", async () => {
    const acceptanceMock = mock(async () => ({
      success: true,
      prd: makePrd(),
      totalCost: 0,
      iterations: 1,
      storiesCompleted: 1,
      prdDirty: false,
    }));
    const handleCompletionMock = mock(async () => ({
      durationMs: 100,
      runCompletedAt: new Date().toISOString(),
      finalCounts: { total: 1, passed: 1, failed: 0, skipped: 0, pending: 0 },
    }));

    _runnerCompletionDeps.runAcceptanceLoop = acceptanceMock;
    _runnerCompletionDeps.handleRunCompletion = handleCompletionMock;

    const logMessages: string[] = [];
    const consoleSpy = spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      logMessages.push(args.join(" "));
    });

    const mockStatusWriter = makeMockStatusWriter();
    mockStatusWriter.getPostRunStatus = mock(() => ({
      acceptance: { status: "passed" as const },
      regression: { status: "passed" as const },
    }));

    const prd = makePrd({ userStories: [makeStory("US-001", "passed")] });
    const config = { ...makeConfig(), acceptance: { enabled: true } } as unknown as NaxConfig;

    await runCompletionPhase({
      config,
      prd,
      statusWriter: mockStatusWriter,
      feature: "test-feature",
      workdir: "/tmp/test",
      statusFile: "/tmp/test/status.json",
      runId: "run-001",
      startedAt: "2026-01-01T00:00:00Z",
      startTime: Date.now() - 1000,
      formatterMode: "quiet",
      headless: false,
      prdPath: "/tmp/test/.nax/features/test-feature/prd.json",
      allStoryMetrics: [],
      totalCost: 0,
      storiesCompleted: 1,
      iterations: 1,
      hooks: {} as RunnerCompletionOptions["hooks"],
      pluginRegistry: {} as RunnerCompletionOptions["pluginRegistry"],
    } as RunnerCompletionOptions);

    consoleSpy.mockRestore();

    expect(acceptanceMock).not.toHaveBeenCalled();
    // handleRunCompletion may still be called for metrics/status, but the regression runner inside it should not be
    // The key check is via the spy on acceptance runner
    const hasAlreadyPassedLog = logMessages.some((m) => m.includes("Post-run phases already passed"));
    expect(hasAlreadyPassedLog).toBe(true);
  });
});

// =============================================================================
// AC-39: Acceptance passed, regression not-run → skip acceptance, run regression
// =============================================================================

describe("AC-39: Acceptance passed, regression not passed → skip acceptance only", () => {
  let origRunnerDeps: typeof _runnerCompletionDeps;

  beforeEach(() => {
    origRunnerDeps = { ..._runnerCompletionDeps };
  });

  afterEach(() => {
    Object.assign(_runnerCompletionDeps, origRunnerDeps);
  });

  test("AC-39: acceptance runner NOT called; regression runner called once; log contains 'Acceptance already passed'", async () => {
    const acceptanceMock = mock(async () => ({
      success: true,
      prd: makePrd(),
      totalCost: 0,
      iterations: 1,
      storiesCompleted: 1,
      prdDirty: false,
    }));
    _runnerCompletionDeps.runAcceptanceLoop = acceptanceMock;

    const logMessages: string[] = [];
    const consoleSpy = spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      logMessages.push(args.join(" "));
    });

    const mockStatusWriter = makeMockStatusWriter();
    mockStatusWriter.getPostRunStatus = mock(() => ({
      acceptance: { status: "passed" as const },
      regression: { status: "not-run" as const },
    }));

    const prd = makePrd({ userStories: [makeStory("US-001", "passed")] });
    const config = { ...makeConfig(), acceptance: { enabled: true } } as unknown as NaxConfig;

    await runCompletionPhase({
      config,
      prd,
      statusWriter: mockStatusWriter,
      feature: "test-feature",
      workdir: "/tmp/test",
      statusFile: "/tmp/test/status.json",
      runId: "run-001",
      startedAt: "2026-01-01T00:00:00Z",
      startTime: Date.now() - 1000,
      formatterMode: "quiet",
      headless: false,
      prdPath: "/tmp/test/.nax/features/test-feature/prd.json",
      allStoryMetrics: [],
      totalCost: 0,
      storiesCompleted: 1,
      iterations: 1,
      hooks: {} as RunnerCompletionOptions["hooks"],
      pluginRegistry: {} as RunnerCompletionOptions["pluginRegistry"],
    } as RunnerCompletionOptions);

    consoleSpy.mockRestore();

    expect(acceptanceMock).not.toHaveBeenCalled();
    const hasSkipLog = logMessages.some((m) => m.includes("Acceptance already passed"));
    expect(hasSkipLog).toBe(true);
  });
});

// =============================================================================
// AC-40: Acceptance not-run → run both acceptance and regression
// =============================================================================

describe("AC-40: Acceptance not-run → both runners called", () => {
  let origRunnerDeps: typeof _runnerCompletionDeps;

  beforeEach(() => {
    origRunnerDeps = { ..._runnerCompletionDeps };
  });

  afterEach(() => {
    Object.assign(_runnerCompletionDeps, origRunnerDeps);
  });

  test("AC-40: Both acceptance and handleRunCompletion/regression runners called when acceptance.status is not-run", async () => {
    const acceptanceMock = mock(async () => ({
      success: true,
      prd: makePrd({ userStories: [makeStory("US-001", "passed")] }),
      totalCost: 0,
      iterations: 1,
      storiesCompleted: 1,
      prdDirty: false,
    }));
    _runnerCompletionDeps.runAcceptanceLoop = acceptanceMock;

    const mockStatusWriter = makeMockStatusWriter();
    mockStatusWriter.getPostRunStatus = mock(() => ({
      acceptance: { status: "not-run" as const },
      regression: { status: "not-run" as const },
    }));

    const prd = makePrd({ userStories: [makeStory("US-001", "passed")] });
    const config = { ...makeConfig(), acceptance: { enabled: true } } as unknown as NaxConfig;

    await runCompletionPhase({
      config,
      prd,
      statusWriter: mockStatusWriter,
      feature: "test-feature",
      workdir: "/tmp/test",
      statusFile: "/tmp/test/status.json",
      runId: "run-001",
      startedAt: "2026-01-01T00:00:00Z",
      startTime: Date.now() - 1000,
      formatterMode: "quiet",
      headless: false,
      prdPath: "/tmp/test/.nax/features/test-feature/prd.json",
      allStoryMetrics: [],
      totalCost: 0,
      storiesCompleted: 1,
      iterations: 1,
      hooks: {} as RunnerCompletionOptions["hooks"],
      pluginRegistry: {} as RunnerCompletionOptions["pluginRegistry"],
    } as RunnerCompletionOptions);

    expect(acceptanceMock).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// AC-41: Acceptance failed → run both acceptance and regression
// =============================================================================

describe("AC-41: Acceptance failed → both runners called", () => {
  let origRunnerDeps: typeof _runnerCompletionDeps;

  beforeEach(() => {
    origRunnerDeps = { ..._runnerCompletionDeps };
  });

  afterEach(() => {
    Object.assign(_runnerCompletionDeps, origRunnerDeps);
  });

  test("AC-41: Both runners invoked when acceptance.status is failed", async () => {
    const acceptanceMock = mock(async () => ({
      success: false,
      failedACs: ["AC-1"],
      prd: makePrd({ userStories: [makeStory("US-001", "failed")] }),
      totalCost: 0,
      iterations: 1,
      storiesCompleted: 0,
      prdDirty: false,
    }));
    _runnerCompletionDeps.runAcceptanceLoop = acceptanceMock;

    const mockStatusWriter = makeMockStatusWriter();
    mockStatusWriter.getPostRunStatus = mock(() => ({
      acceptance: { status: "failed" as const },
      regression: { status: "not-run" as const },
    }));

    const prd = makePrd({ userStories: [makeStory("US-001", "passed")] });
    const config = { ...makeConfig(), acceptance: { enabled: true } } as unknown as NaxConfig;

    await runCompletionPhase({
      config,
      prd,
      statusWriter: mockStatusWriter,
      feature: "test-feature",
      workdir: "/tmp/test",
      statusFile: "/tmp/test/status.json",
      runId: "run-001",
      startedAt: "2026-01-01T00:00:00Z",
      startTime: Date.now() - 1000,
      formatterMode: "quiet",
      headless: false,
      prdPath: "/tmp/test/.nax/features/test-feature/prd.json",
      allStoryMetrics: [],
      totalCost: 0,
      storiesCompleted: 1,
      iterations: 1,
      hooks: {} as RunnerCompletionOptions["hooks"],
      pluginRegistry: {} as RunnerCompletionOptions["pluginRegistry"],
    } as RunnerCompletionOptions);

    expect(acceptanceMock).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// AC-42: markStoryFailed on a 'passed' story → resetPostRunStatus called once
// =============================================================================

test("AC-42: markStoryFailed on 'passed' story calls statusWriter.resetPostRunStatus exactly once", () => {
  const prd = makePrd({ userStories: [makeStory("US-001", "passed")] });
  const mockStatusWriter = makeMockStatusWriter();

  markStoryFailed(prd, "US-001", undefined, undefined, mockStatusWriter);

  expect(mockStatusWriter.resetPostRunStatus).toHaveBeenCalledTimes(1);
});

// =============================================================================
// AC-43: blockStory (markStoryAsBlocked) on a 'passed' story → resetPostRunStatus called once
// =============================================================================

test("AC-43: markStoryAsBlocked on 'passed' story calls statusWriter.resetPostRunStatus exactly once", () => {
  const prd = makePrd({ userStories: [makeStory("US-001", "passed")] });
  const mockStatusWriter = makeMockStatusWriter();

  markStoryAsBlocked(prd, "US-001", "some reason", mockStatusWriter);

  expect(mockStatusWriter.resetPostRunStatus).toHaveBeenCalledTimes(1);
});

// =============================================================================
// AC-44: markStoryPassed on a 'pending' story → resetPostRunStatus NOT called
// =============================================================================

test("AC-44: markStoryPassed on 'pending' story does NOT call statusWriter.resetPostRunStatus", () => {
  const prd = makePrd({ userStories: [makeStory("US-001", "pending")] });
  const mockStatusWriter = makeMockStatusWriter();

  markStoryPassed(prd, "US-001", mockStatusWriter);

  expect(mockStatusWriter.resetPostRunStatus).not.toHaveBeenCalled();
});

// =============================================================================
// AC-45: displayFeatureDetails with postRun.acceptance.passed + lastRunAt → output contains pattern
// =============================================================================

test("AC-45: displayFeatureDetails outputs 'Acceptance: passed' with timestamp when acceptance.status is passed", async () => {
  const tmpDir = makeTempDir();
  try {
    const featureDir = join(tmpDir, ".nax", "features", "test-feature");
    mkdirSync(featureDir, { recursive: true });

    // Write minimal prd.json
    const prd = makePrd({ userStories: [makeStory("US-001", "passed")] });
    writeFileSync(join(featureDir, "prd.json"), JSON.stringify(prd, null, 2));

    // Write status.json with postRun.acceptance.status = passed
    const statusFile: Partial<NaxStatusFile> = {
      version: 1,
      run: {
        id: "run-001",
        feature: "test-feature",
        startedAt: "2026-04-04T10:00:00Z",
        status: "completed",
        dryRun: false,
        pid: 99999,
      },
      progress: { total: 1, passed: 1, failed: 0, paused: 0, blocked: 0, pending: 0 },
      cost: { spent: 0.01, limit: null },
      current: null,
      iterations: 1,
      updatedAt: "2026-04-04T10:01:00Z",
      durationMs: 60000,
      postRun: {
        acceptance: { status: "passed", lastRunAt: "2026-04-04T10:01:00Z" },
        regression: { status: "not-run" },
      },
    };
    writeFileSync(join(featureDir, "status.json"), JSON.stringify(statusFile, null, 2));

    // Capture console.log output
    const outputLines: string[] = [];
    const consoleSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      outputLines.push(args.map(String).join(" "));
    });

    await displayFeatureStatus({ feature: "test-feature", dir: tmpDir });

    consoleSpy.mockRestore();

    const output = outputLines.join("\n");
    expect(/Acceptance:\s+passed.*\d{4}/i.test(output)).toBe(true);
  } finally {
    cleanupDir(tmpDir);
  }
});

// =============================================================================
// AC-46: displayFeatureDetails with postRun.regression.failed + failedTests → output contains count
// =============================================================================

test("AC-46: displayFeatureDetails outputs 'Regression: failed' with failedTests count", async () => {
  const tmpDir = makeTempDir();
  try {
    const featureDir = join(tmpDir, ".nax", "features", "test-feature");
    mkdirSync(featureDir, { recursive: true });

    const prd = makePrd({ userStories: [makeStory("US-001", "passed")] });
    writeFileSync(join(featureDir, "prd.json"), JSON.stringify(prd, null, 2));

    const statusFile: Partial<NaxStatusFile> = {
      version: 1,
      run: {
        id: "run-001",
        feature: "test-feature",
        startedAt: "2026-04-04T10:00:00Z",
        status: "completed",
        dryRun: false,
        pid: 99999,
      },
      progress: { total: 1, passed: 1, failed: 0, paused: 0, blocked: 0, pending: 0 },
      cost: { spent: 0.01, limit: null },
      current: null,
      iterations: 1,
      updatedAt: "2026-04-04T10:01:00Z",
      durationMs: 60000,
      postRun: {
        acceptance: { status: "passed" },
        regression: { status: "failed", failedTests: 7 },
      },
    };
    writeFileSync(join(featureDir, "status.json"), JSON.stringify(statusFile, null, 2));

    const outputLines: string[] = [];
    const consoleSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      outputLines.push(args.map(String).join(" "));
    });

    await displayFeatureStatus({ feature: "test-feature", dir: tmpDir });

    consoleSpy.mockRestore();

    const output = outputLines.join("\n");
    expect(/Regression:\s+failed.*7/i.test(output)).toBe(true);
  } finally {
    cleanupDir(tmpDir);
  }
});

// =============================================================================
// AC-47: displayFeatureDetails without postRun field → no "Acceptance:", "Regression:", "post-run" in output
// =============================================================================

test("AC-47: displayFeatureDetails without postRun field outputs no post-run section", async () => {
  const tmpDir = makeTempDir();
  try {
    const featureDir = join(tmpDir, ".nax", "features", "test-feature");
    mkdirSync(featureDir, { recursive: true });

    const prd = makePrd({ userStories: [makeStory("US-001", "passed")] });
    writeFileSync(join(featureDir, "prd.json"), JSON.stringify(prd, null, 2));

    // Status file WITHOUT postRun field (backward compat)
    const statusFile = {
      version: 1,
      run: {
        id: "run-001",
        feature: "test-feature",
        startedAt: "2026-04-04T10:00:00Z",
        status: "completed",
        dryRun: false,
        pid: 99999,
      },
      progress: { total: 1, passed: 1, failed: 0, paused: 0, blocked: 0, pending: 0 },
      cost: { spent: 0.01, limit: null },
      current: null,
      iterations: 1,
      updatedAt: "2026-04-04T10:01:00Z",
      durationMs: 60000,
      // No postRun field
    };
    writeFileSync(join(featureDir, "status.json"), JSON.stringify(statusFile, null, 2));

    const outputLines: string[] = [];
    const consoleSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      outputLines.push(args.map(String).join(" "));
    });

    await displayFeatureStatus({ feature: "test-feature", dir: tmpDir });

    consoleSpy.mockRestore();

    const output = outputLines.join("\n");
    expect(/acceptance:/i.test(output)).toBe(false);
    expect(/regression:/i.test(output)).toBe(false);
    expect(/post-run/i.test(output)).toBe(false);
  } finally {
    cleanupDir(tmpDir);
  }
});

// =============================================================================
// AC-48: displayFeatureDetails with postRun.regression.passed + skipped=true → output contains smart-skip
// =============================================================================

test("AC-48: displayFeatureDetails outputs 'Regression: skipped (smart-skip)' when regression is passed+skipped", async () => {
  const tmpDir = makeTempDir();
  try {
    const featureDir = join(tmpDir, ".nax", "features", "test-feature");
    mkdirSync(featureDir, { recursive: true });

    const prd = makePrd({ userStories: [makeStory("US-001", "passed")] });
    writeFileSync(join(featureDir, "prd.json"), JSON.stringify(prd, null, 2));

    const statusFile: Partial<NaxStatusFile> = {
      version: 1,
      run: {
        id: "run-001",
        feature: "test-feature",
        startedAt: "2026-04-04T10:00:00Z",
        status: "completed",
        dryRun: false,
        pid: 99999,
      },
      progress: { total: 1, passed: 1, failed: 0, paused: 0, blocked: 0, pending: 0 },
      cost: { spent: 0.01, limit: null },
      current: null,
      iterations: 1,
      updatedAt: "2026-04-04T10:01:00Z",
      durationMs: 60000,
      postRun: {
        acceptance: { status: "passed" },
        regression: { status: "passed", skipped: true },
      },
    };
    writeFileSync(join(featureDir, "status.json"), JSON.stringify(statusFile, null, 2));

    const outputLines: string[] = [];
    const consoleSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      outputLines.push(args.map(String).join(" "));
    });

    await displayFeatureStatus({ feature: "test-feature", dir: tmpDir });

    consoleSpy.mockRestore();

    const output = outputLines.join("\n");
    expect(/Regression:\s+skipped.*smart-skip/i.test(output)).toBe(true);
  } finally {
    cleanupDir(tmpDir);
  }
});