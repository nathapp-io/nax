/**
 * Integration Tests: nax diagnose CLI (AC1-AC2)
 *
 * Tests the diagnose command that reads run artifacts and produces
 * structured diagnosis reports via pure pattern matching.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { diagnoseCommand } from "../../../src/cli/diagnose";
import type { NaxStatusFile } from "../../../src/execution/status-file";
import type { PRD } from "../../../src/prd";
import { savePRD } from "../../../src/prd";
import { makeTempDir } from "../../helpers/temp";

// Test fixture directory
let testDir: string;

beforeEach(() => {
  // Create unique test directory
  testDir = makeTempDir("nax-diagnose-test-");

  // Create nax directory structure
  mkdirSync(join(testDir, ".nax", "features"), { recursive: true });
});

afterEach(() => {
  // Clean up test directory
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

/**
 * Create a minimal PRD fixture
 */
function createPRD(feature: string, stories: Array<Partial<PRD["userStories"][0]>>): PRD {
  return {
    project: "test-project",
    feature,
    branchName: "feature/test",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    userStories: stories.map((s, i) => ({
      id: s.id ?? `US-${String(i + 1).padStart(3, "0")}`,
      title: s.title ?? "Test Story",
      description: s.description ?? "Test description",
      acceptanceCriteria: s.acceptanceCriteria ?? [],
      tags: s.tags ?? [],
      dependencies: s.dependencies ?? [],
      status: s.status ?? "pending",
      passes: s.passes ?? false,
      escalations: s.escalations ?? [],
      attempts: s.attempts ?? 0,
      priorErrors: s.priorErrors ?? [],
      ...s,
    })),
  };
}

/**
 * Create a status.json fixture
 */
async function createStatusFile(dir: string, feature: string, overrides: Partial<NaxStatusFile> = {}): Promise<void> {
  const status: NaxStatusFile = {
    version: 1,
    run: {
      id: "run-001",
      feature,
      startedAt: "2026-01-01T10:00:00Z",
      status: "running",
      dryRun: false,
      pid: process.pid,
      ...overrides.run,
    },
    progress: {
      total: 3,
      passed: 1,
      failed: 1,
      paused: 0,
      blocked: 0,
      pending: 1,
      ...overrides.progress,
    },
    cost: {
      spent: 0.05,
      limit: null,
      ...overrides.cost,
    },
    current: null,
    iterations: 1,
    updatedAt: "2026-01-01T10:30:00Z",
    durationMs: 1800000,
    ...overrides,
  };

  // Ensure nax directory exists
  mkdirSync(join(dir, ".nax"), { recursive: true });
  await Bun.write(join(dir, ".nax", "status.json"), JSON.stringify(status, null, 2));
}

// ============================================================================
// AC1: Basic diagnosis with all 5 sections
// ============================================================================

describe("AC1: nax diagnose reads last run and prints all 5 sections", () => {
  test("prints Run Summary, Story Breakdown (verbose), Failure Analysis, Lock Check, Recommendations", async () => {
    const feature = "test-feature";
    const featureDir = join(testDir, ".nax", "features", feature);
    mkdirSync(featureDir, { recursive: true });

    // Create PRD with mixed stories
    const prd = createPRD(feature, [
      { id: "US-001", title: "Passed Story", status: "passed", passes: true, attempts: 1 },
      {
        id: "US-002",
        title: "Failed Story",
        status: "failed",
        passes: false,
        attempts: 3,
        priorErrors: ["tests-failing", "tests-failing"],
      },
      { id: "US-003", title: "Pending Story", status: "pending", passes: false, attempts: 0 },
    ]);

    await savePRD(prd, join(featureDir, "prd.json"));

    // Create status file
    await createStatusFile(testDir, feature, {
      run: {
        id: "run-001",
        feature,
        startedAt: "2026-01-01T10:00:00Z",
        status: "running",
        dryRun: false,
        pid: process.pid,
      },
      progress: {
        total: 3,
        passed: 1,
        failed: 1,
        paused: 0,
        blocked: 0,
        pending: 1,
      },
      cost: {
        spent: 0.05,
        limit: null,
      },
    });

    // Capture console output
    let output = "";
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output += `${args.join(" ")}\n`;
    };

    try {
      await diagnoseCommand({
        feature,
        workdir: testDir,
        verbose: true,
      });

      // Verify all sections present
      expect(output).toContain("Diagnosis Report");
      expect(output).toContain("Run Summary");
      expect(output).toContain("Story Breakdown");
      expect(output).toContain("Failure Analysis");
      expect(output).toContain("Lock Check");
      expect(output).toContain("Recommendations");

      // Verify counts
      expect(output).toContain("Passed:      1");
      expect(output).toContain("Failed:      1");
      expect(output).toContain("Pending:     1");
    } finally {
      console.log = originalLog;
    }
  });
});

// ============================================================================
// AC2: Pattern classification for failed stories
// ============================================================================

describe("AC2: Each failed story shows pattern classification", () => {
  test("classifies GREENFIELD_TDD pattern", async () => {
    const feature = "greenfield-feature";
    const featureDir = join(testDir, ".nax", "features", feature);
    mkdirSync(featureDir, { recursive: true });

    const prd = createPRD(feature, [
      {
        id: "US-001",
        title: "Greenfield Story",
        status: "failed",
        failureCategory: "greenfield-no-tests",
        priorErrors: ["greenfield-no-tests: no existing tests found"],
        attempts: 1,
      },
    ]);

    await savePRD(prd, join(featureDir, "prd.json"));

    let output = "";
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output += `${args.join(" ")}\n`;
    };

    try {
      await diagnoseCommand({ feature, workdir: testDir });

      expect(output).toContain("GREENFIELD_TDD");
      expect(output).toContain("greenfield project with no existing tests");
    } finally {
      console.log = originalLog;
    }
  });

  test("classifies TEST_MISMATCH pattern", async () => {
    const feature = "test-mismatch-feature";
    const featureDir = join(testDir, ".nax", "features", feature);
    mkdirSync(featureDir, { recursive: true });

    const prd = createPRD(feature, [
      {
        id: "US-001",
        title: "Test Mismatch Story",
        status: "failed",
        priorErrors: ["tests-failing: AC-1", "tests-failing: AC-1", "tests-failing: AC-2"],
        attempts: 3,
      },
    ]);

    await savePRD(prd, join(featureDir, "prd.json"));

    let output = "";
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output += `${args.join(" ")}\n`;
    };

    try {
      await diagnoseCommand({ feature, workdir: testDir });

      expect(output).toContain("TEST_MISMATCH");
      expect(output).toContain("Multiple test failures");
    } finally {
      console.log = originalLog;
    }
  });

  test("classifies AUTO_RECOVERED pattern (INFO level)", async () => {
    const feature = "auto-recovered-feature";
    const featureDir = join(testDir, ".nax", "features", feature);
    mkdirSync(featureDir, { recursive: true });

    const prd = createPRD(feature, [
      {
        id: "US-001",
        title: "Auto Recovered Story",
        status: "passed",
        passes: true,
        priorErrors: ["greenfield-no-tests: no existing tests found"],
        attempts: 2,
      },
    ]);

    await savePRD(prd, join(featureDir, "prd.json"));

    let output = "";
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output += `${args.join(" ")}\n`;
    };

    try {
      await diagnoseCommand({ feature, workdir: testDir });

      expect(output).toContain("AUTO_RECOVERED");
      expect(output).toContain("INFO"); // Not ERROR
      expect(output).toContain("S5 successfully handled");
    } finally {
      console.log = originalLog;
    }
  });

  test("classifies UNKNOWN pattern when no match", async () => {
    const feature = "unknown-feature";
    const featureDir = join(testDir, ".nax", "features", feature);
    mkdirSync(featureDir, { recursive: true });

    const prd = createPRD(feature, [
      {
        id: "US-001",
        title: "Unknown Failure",
        status: "failed",
        priorErrors: ["some weird error"],
        attempts: 1,
      },
    ]);

    await savePRD(prd, join(featureDir, "prd.json"));

    let output = "";
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output += `${args.join(" ")}\n`;
    };

    try {
      await diagnoseCommand({ feature, workdir: testDir, verbose: true });

      expect(output).toContain("UNKNOWN");
    } finally {
      console.log = originalLog;
    }
  });
});
