/**
 * Integration Tests: nax diagnose CLI (AC3-AC4)
 *
 * Tests the diagnose command for stale lock detection and JSON output mode.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { diagnoseCommand, _diagnoseDeps } from "../../../src/cli/diagnose";
import type { PRD } from "../../../src/prd";
import { savePRD } from "../../../src/prd";
import { fullTest } from "../../helpers/env";
import { makeTempDir } from "../../helpers/temp";

// Skip PID-sensitive tests in CI: container PIDs are ephemeral and low-numbered
// Requires real PID checks — skipped by default, run with FULL=1.
const skipInCI = fullTest;

// Test fixture directory
let testDir: string;
let origProjectOutputDir: typeof _diagnoseDeps.projectOutputDir;

beforeEach(() => {
  // Create unique test directory
  testDir = makeTempDir("nax-diagnose-ac3-test-");

  // Create nax directory structure
  mkdirSync(join(testDir, ".nax", "features"), { recursive: true });

  // Redirect outputDir to testDir/.nax for isolation
  origProjectOutputDir = _diagnoseDeps.projectOutputDir;
  _diagnoseDeps.projectOutputDir = () => join(testDir, ".nax");
});

afterEach(() => {
  _diagnoseDeps.projectOutputDir = origProjectOutputDir;

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
 * Create a lock file fixture
 */
async function createLockFile(dir: string, pid: number): Promise<void> {
  await Bun.write(
    join(dir, "nax.lock"),
    JSON.stringify({
      pid,
      timestamp: Date.now(),
    }),
  );
}

// ============================================================================
// AC3: Stale lock detection
// ============================================================================

describe("AC3: Stale nax.lock detection", () => {
  test("detects stale lock (PID dead) and shows fix command", async () => {
    const feature = "locked-feature";
    const featureDir = join(testDir, ".nax", "features", feature);
    mkdirSync(featureDir, { recursive: true });

    const prd = createPRD(feature, [{ id: "US-001", title: "Test Story", status: "pending" }]);

    await savePRD(prd, join(featureDir, "prd.json"));

    // Create lock with dead PID
    await createLockFile(testDir, 999999);

    let output = "";
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output += `${args.join(" ")}\n`;
    };

    try {
      await diagnoseCommand({ feature, workdir: testDir });

      expect(output).toContain("Stale lock detected");
      expect(output).toContain("PID 999999 is dead");
      expect(output).toContain("rm nax.lock");
    } finally {
      console.log = originalLog;
    }
  });

  skipInCI("shows active lock when PID alive", async () => {
    const feature = "active-lock-feature";
    const featureDir = join(testDir, ".nax", "features", feature);
    mkdirSync(featureDir, { recursive: true });

    const prd = createPRD(feature, [{ id: "US-001", title: "Test Story", status: "pending" }]);

    await savePRD(prd, join(featureDir, "prd.json"));

    // Create lock with current process PID (alive)
    await createLockFile(testDir, process.pid);

    let output = "";
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output += `${args.join(" ")}\n`;
    };

    try {
      await diagnoseCommand({ feature, workdir: testDir });

      expect(output).toContain("Active lock");
      expect(output).toContain(`PID ${process.pid}`);
      expect(output).not.toContain("rm nax.lock");
    } finally {
      console.log = originalLog;
    }
  });
});

// ============================================================================
// AC4: JSON output mode
// ============================================================================

describe("AC4: --json flag outputs machine-readable JSON", () => {
  test("outputs valid JSON with all report fields", async () => {
    const feature = "json-feature";
    const featureDir = join(testDir, ".nax", "features", feature);
    mkdirSync(featureDir, { recursive: true });

    const prd = createPRD(feature, [
      { id: "US-001", title: "Passed Story", status: "passed", passes: true },
      { id: "US-002", title: "Failed Story", status: "failed", attempts: 2 },
    ]);

    await savePRD(prd, join(featureDir, "prd.json"));

    let output = "";
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output += `${args.join(" ")}\n`;
    };

    try {
      await diagnoseCommand({ feature, workdir: testDir, json: true });

      const report = JSON.parse(output);

      // Verify structure
      expect(report).toHaveProperty("runSummary");
      expect(report).toHaveProperty("storyBreakdown");
      expect(report).toHaveProperty("failureAnalysis");
      expect(report).toHaveProperty("lockCheck");
      expect(report).toHaveProperty("recommendations");
      expect(report).toHaveProperty("dataSources");

      // Verify counts
      expect(report.runSummary.storiesPassed).toBe(1);
      expect(report.runSummary.storiesFailed).toBe(1);
      expect(report.runSummary.storiesPending).toBe(0);
    } finally {
      console.log = originalLog;
    }
  });
});
