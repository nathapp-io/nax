/**
 * Integration Tests: nax diagnose CLI (AC5-AC7)
 *
 * Tests the diagnose command for graceful degradation, flag targeting,
 * and AUTO_RECOVERED display behavior.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { diagnoseCommand, _diagnoseDeps } from "../../../src/cli/diagnose";
import type { PRD } from "../../../src/prd";
import { savePRD } from "../../../src/prd";
import { makeTempDir } from "../../helpers/temp";

// Test fixture directory
let testDir: string;
let origProjectOutputDir: typeof _diagnoseDeps.projectOutputDir;

beforeEach(() => {
  // Create unique test directory
  testDir = makeTempDir("nax-diagnose-ac5-test-");

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

// ============================================================================
// AC5: Graceful degradation when events.jsonl missing
// ============================================================================

describe("AC5: Works gracefully when events.jsonl missing", () => {
  test("uses PRD + git log only and prints note", async () => {
    const feature = "no-events-feature";
    const featureDir = join(testDir, ".nax", "features", feature);
    mkdirSync(featureDir, { recursive: true });

    const prd = createPRD(feature, [{ id: "US-001", title: "Test Story", status: "passed", passes: true }]);

    await savePRD(prd, join(featureDir, "prd.json"));

    // Do NOT create events.jsonl or status.json

    let output = "";
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output += `${args.join(" ")}\n`;
    };

    try {
      await diagnoseCommand({ feature, workdir: testDir });

      // Should not crash
      expect(output).toContain("Diagnosis Report");
      expect(output).toContain("events.jsonl not found");
    } finally {
      console.log = originalLog;
    }
  });
});

// ============================================================================
// AC6: -f and -d flags for targeting
// ============================================================================

describe("AC6: -f <feature> and -d <workdir> flags work", () => {
  test("diagnoses specific feature with -f flag", async () => {
    const feature = "specific-feature";
    const featureDir = join(testDir, ".nax", "features", feature);
    mkdirSync(featureDir, { recursive: true });

    const prd = createPRD(feature, [{ id: "US-001", title: "Specific Story", status: "passed", passes: true }]);

    await savePRD(prd, join(featureDir, "prd.json"));

    let output = "";
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output += `${args.join(" ")}\n`;
    };

    try {
      await diagnoseCommand({ feature, workdir: testDir, verbose: true });

      expect(output).toContain(feature);
      expect(output).toContain("Specific Story");
    } finally {
      console.log = originalLog;
    }
  });

  test("uses specified workdir with -d flag", async () => {
    const feature = "workdir-feature";
    const featureDir = join(testDir, ".nax", "features", feature);
    mkdirSync(featureDir, { recursive: true });

    const prd = createPRD(feature, [{ id: "US-001", title: "Workdir Story", status: "passed", passes: true }]);

    await savePRD(prd, join(featureDir, "prd.json"));

    let output = "";
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      output += `${args.join(" ")}\n`;
    };

    try {
      await diagnoseCommand({ feature, workdir: testDir, verbose: true });

      expect(output).toContain("Workdir Story");
    } finally {
      console.log = originalLog;
    }
  });
});

// ============================================================================
// AC7: AUTO_RECOVERED shown as INFO not ERROR
// ============================================================================

describe("AC7: AUTO_RECOVERED stories shown as INFO", () => {
  test("displays AUTO_RECOVERED with INFO level, not ERROR", async () => {
    const feature = "recovered-feature";
    const featureDir = join(testDir, ".nax", "features", feature);
    mkdirSync(featureDir, { recursive: true });

    const prd = createPRD(feature, [
      {
        id: "US-001",
        title: "Recovered Story",
        status: "passed",
        passes: true,
        priorErrors: ["greenfield-no-tests"],
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

      // Check that AUTO_RECOVERED appears with INFO
      const lines = output.split("\n");
      const recoveredLine = lines.find((line) => line.includes("US-001"));

      expect(recoveredLine).toBeDefined();
      expect(output).toContain("INFO");
      expect(output).toContain("AUTO_RECOVERED");
      expect(output).not.toContain("ERROR US-001");
    } finally {
      console.log = originalLog;
    }
  });
});

// ============================================================================
// AC8: TypeScript compiles cleanly
// ============================================================================

// This is validated by running `bun run typecheck` separately
// No test needed here — the entire test file compiling is the test
