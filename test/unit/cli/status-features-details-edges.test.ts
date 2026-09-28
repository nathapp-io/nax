/**
 * Characterisation tests for displayFeatureDetails branches the existing
 * suites do not pin, recorded before the cognitive-complexity drain of
 * src/cli/status-features.ts (batch B6).
 *
 * The mirror suites (status-features.test.ts, cli-status.test.ts) pin the
 * postRun acceptance/regression flows, the crashed-run headline, recovery
 * hints, and the "No active run" arm. Nothing pins: the missing-prd.json
 * guard, the Progress section's per-count lines (incl. the conditional
 * Skipped line), the story-table icon selection and routing suffix, the
 * acceptance running/not-run arms, the regression passed-without-skip /
 * running / not-run arms, the numeric failedTests count shape, the
 * failedACs count suffix, the trailing last-run block, the explicit
 * status:"crashed" arm's detail lines, or the active-run section's detail
 * lines. Each test below pins one of those exactly as the code prints it
 * today — these are records of current behaviour, not endorsements.
 *
 * Fixtures deliberately avoid cast expressions: where a fixture needs a
 * shape the status-file types do not describe (the legacy numeric
 * failedTests), the value is attached with Object.assign after construction.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "@test/helpers";
import { _statusFeaturesDeps, displayFeatureStatus } from "@/cli/status-features";
import type { NaxStatusFile, RegressionPhaseStatus } from "@/execution/status-file";
import type { PRD, UserStory } from "@/prd";

describe("displayFeatureDetails — unpinned branches (B6 characterisation)", () => {
  let testDir: string;
  let originalCwd: string;
  let consoleOutput: string[];
  let featureDir: string;
  const originalLog = console.log;
  let origProjectOutputDir: typeof _statusFeaturesDeps.projectOutputDir;

  beforeEach(() => {
    const rawTestDir = makeTempDir("nax-test-");
    testDir = realpathSync(rawTestDir);
    originalCwd = process.cwd();

    origProjectOutputDir = _statusFeaturesDeps.projectOutputDir;
    _statusFeaturesDeps.projectOutputDir = () => join(testDir, ".nax");

    const naxDir = join(testDir, ".nax");
    featureDir = join(naxDir, "features", "test-feature");
    mkdirSync(featureDir, { recursive: true });
    writeFileSync(join(naxDir, "config.json"), "{}");

    consoleOutput = [];
    console.log = mock((message: string) => {
      consoleOutput.push(message);
    });
  });

  afterEach(() => {
    _statusFeaturesDeps.projectOutputDir = origProjectOutputDir;
    process.chdir(originalCwd);
    console.log = originalLog;

    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  function story(overrides: Partial<UserStory> & { id: string; title: string }): UserStory {
    return {
      description: `desc ${overrides.id}`,
      acceptanceCriteria: [`AC for ${overrides.id}`],
      tags: [],
      dependencies: [],
      status: "pending",
      passes: false,
      escalations: [],
      attempts: 0,
      ...overrides,
    };
  }

  function writePrd(stories: UserStory[]): void {
    const prd: PRD = {
      project: "test-project",
      feature: "prd-feature-name",
      branchName: "feat/test-feature",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-02T00:00:00.000Z",
      userStories: stories,
    };
    writeFileSync(join(featureDir, "prd.json"), JSON.stringify(prd, null, 2));
  }

  function buildStatus(overrides: Partial<NaxStatusFile> = {}): NaxStatusFile {
    return {
      version: 1,
      run: {
        id: "run-2026-06-03T00-00-00-000Z",
        feature: "test-feature",
        startedAt: "2026-06-03T00:00:00.000Z",
        status: "completed",
        dryRun: false,
        pid: 999999,
      },
      progress: { total: 4, passed: 1, failed: 1, paused: 0, blocked: 0, pending: 1 },
      cost: { spent: 0.1234, limit: null },
      current: null,
      iterations: 5,
      updatedAt: "2026-06-03T01:00:00.000Z",
      durationMs: 3600000,
      ...overrides,
    };
  }

  function writeStatus(overrides: Partial<NaxStatusFile> = {}): void {
    writeFileSync(join(featureDir, "status.json"), JSON.stringify(buildStatus(overrides), null, 2));
  }

  test("missing prd.json prints the plan hint and nothing else", async () => {
    // No prd.json written — feature dir exists but is empty.
    await displayFeatureStatus({ feature: "test-feature", dir: testDir });

    const output = consoleOutput.join("\n");
    expect(output).toContain("📊 test-feature");
    expect(output).toContain("No prd.json found. Run: nax plan -f test-feature --from <spec>");
    expect(output).not.toContain("Progress:");
    expect(output).not.toContain("Stories:");
    expect(output).not.toContain("No active run");
  });

  test("progress section prints every count line, including Skipped only when non-zero", async () => {
    writePrd([
      story({ id: "US-001", title: "Passed story", status: "passed", passes: true }),
      story({ id: "US-002", title: "Failed story", status: "failed" }),
      story({ id: "US-003", title: "Pending story", status: "pending" }),
      story({ id: "US-004", title: "Skipped story", status: "skipped" }),
    ]);
    writeStatus();

    await displayFeatureStatus({ feature: "test-feature", dir: testDir });

    const output = consoleOutput.join("\n");
    expect(output).toContain("Progress:");
    expect(output).toContain("Branch:     feat/test-feature");
    expect(output).toContain("Updated:    2026-06-02T00:00:00.000Z");
    expect(output).toContain("Total:      4");
    expect(output).toContain("Passed:     1");
    expect(output).toContain("Failed:     1");
    expect(output).toContain("Pending:    1");
    expect(output).toContain("Skipped:    1");
  });

  test("progress section omits the Skipped line when the skipped count is zero", async () => {
    writePrd([
      story({ id: "US-001", title: "Passed story", status: "passed", passes: true }),
      story({ id: "US-002", title: "Pending story", status: "pending" }),
    ]);
    writeStatus();

    await displayFeatureStatus({ feature: "test-feature", dir: testDir });

    const output = consoleOutput.join("\n");
    expect(output).toContain("Pending:    1");
    expect(output).not.toContain("Skipped:");
  });

  test("sections print in order: header, run status, progress, stories, post-run, last run", async () => {
    writePrd([story({ id: "US-001", title: "Only story", status: "skipped" })]);
    writeStatus({
      run: {
        id: "run-2026-06-03T00-00-00-000Z",
        feature: "test-feature",
        startedAt: "2026-06-03T00:00:00.000Z",
        status: "crashed",
        dryRun: false,
        pid: 999999,
      },
      postRun: {
        acceptance: { status: "passed" },
        regression: { status: "not-run" },
      },
    });

    await displayFeatureStatus({ feature: "test-feature", dir: testDir });

    const output = consoleOutput.join("\n");
    const markers = [
      "📊 prd-feature-name",
      "Crashed Run Detected:",
      "Recovery Hints:",
      "Progress:\n",
      "Branch:",
      "Updated:",
      "Total:",
      "Passed:",
      "Failed:",
      "Pending:",
      "Skipped:",
      "Stories:",
      "US-001: Only story",
      "Post-Run Status:",
      "Acceptance: passed",
      "Regression: not-run",
      "Last run:",
      "Cost: $0.1234",
    ];
    const positions = markers.map((marker) => output.indexOf(marker));
    expect(positions).not.toContain(-1);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  test("story table picks icons from passes/status and appends the routing suffix", async () => {
    writePrd([
      story({ id: "US-001", title: "Passed story", status: "passed", passes: true }),
      story({ id: "US-002", title: "Failed story", status: "failed" }),
      story({ id: "US-003", title: "Skipped story", status: "skipped" }),
      story({
        id: "US-004",
        title: "Routed story",
        status: "pending",
        routing: { complexity: "medium", modelTier: "balanced", testStrategy: "test-after", reasoning: "test" },
      }),
    ]);
    writeStatus();

    await displayFeatureStatus({ feature: "test-feature", dir: testDir });

    const output = consoleOutput.join("\n");
    expect(output).toContain("✅ US-001: Passed story");
    expect(output).toContain("❌ US-002: Failed story");
    expect(output).toContain("⏭️ US-003: Skipped story");
    expect(output).toContain("⬜ US-004: Routed story");
    expect(output).toContain("[medium/balanced/test-after]");
  });

  test("acceptance running and regression not-run arms print their dim lines", async () => {
    writePrd([story({ id: "US-001", title: "Only story" })]);
    writeStatus({
      progress: { total: 1, passed: 0, failed: 0, paused: 0, blocked: 0, pending: 1 },
      postRun: {
        acceptance: { status: "running" },
        regression: { status: "not-run" },
      },
    });

    await displayFeatureStatus({ feature: "test-feature", dir: testDir });

    const output = consoleOutput.join("\n");
    expect(output).toContain("Acceptance: running");
    expect(output).toContain("Regression: not-run");
  });

  test("acceptance not-run arm prints the dim line", async () => {
    writePrd([story({ id: "US-001", title: "Only story" })]);
    writeStatus({
      postRun: {
        acceptance: { status: "not-run" },
        regression: { status: "passed" },
      },
    });

    await displayFeatureStatus({ feature: "test-feature", dir: testDir });

    const output = consoleOutput.join("\n");
    expect(output).toContain("Acceptance: not-run");
    expect(output).toContain("Regression: passed");
    // The non-skipped passed arm carries the lastRunAt timestamp; without one it stays bare.
    expect(output).not.toContain("smart-skip");
  });

  test("regression passed without smart-skip carries the timestamp in parens", async () => {
    writePrd([story({ id: "US-001", title: "Only story" })]);
    writeStatus({
      postRun: {
        acceptance: { status: "passed" },
        regression: { status: "passed", lastRunAt: "2026-06-04T09:00:00.000Z" },
      },
    });

    await displayFeatureStatus({ feature: "test-feature", dir: testDir });

    const output = consoleOutput.join("\n");
    expect(output).toContain("Regression: passed (2026-06-04T09:00:00.000Z)");
  });

  test("regression running arm prints its line", async () => {
    writePrd([story({ id: "US-001", title: "Only story" })]);
    writeStatus({
      postRun: {
        acceptance: { status: "passed" },
        regression: { status: "running" },
      },
    });

    await displayFeatureStatus({ feature: "test-feature", dir: testDir });

    const output = consoleOutput.join("\n");
    expect(output).toContain("Regression: running");
  });

  test("regression failed renders a numeric failedTests count (legacy shape)", async () => {
    writePrd([story({ id: "US-001", title: "Only story" })]);
    const regression: RegressionPhaseStatus = { status: "failed", lastRunAt: "2026-06-04T10:00:00.000Z" };
    Object.assign(regression, { failedTests: 2 });
    writeStatus({
      postRun: {
        acceptance: { status: "passed" },
        regression,
      },
    });

    await displayFeatureStatus({ feature: "test-feature", dir: testDir });

    const output = consoleOutput.join("\n");
    // The failed arm's timestamp is space-separated, without parens (unlike the passed arm).
    expect(output).toContain("Regression: failed (2 test(s)) 2026-06-04T10:00:00.000Z");
  });

  test("acceptance failed with failedACs renders the AC count suffix", async () => {
    writePrd([story({ id: "US-001", title: "Only story" })]);
    writeStatus({
      postRun: {
        acceptance: { status: "failed", failedACs: ["AC-1", "AC-2"] },
        regression: { status: "not-run" },
      },
    });

    await displayFeatureStatus({ feature: "test-feature", dir: testDir });

    const output = consoleOutput.join("\n");
    expect(output).toContain("Acceptance: failed (2 AC(s))");
  });

  test("a completed run prints the trailing last-run block", async () => {
    writePrd([story({ id: "US-001", title: "Only story" })]);
    writeStatus();

    await displayFeatureStatus({ feature: "test-feature", dir: testDir });

    const output = consoleOutput.join("\n");
    expect(output).toContain("Last run: run-2026-06-03T00-00-00-000Z");
    expect(output).toContain("Cost: $0.1234");
    expect(output).not.toContain("Active Run:");
    expect(output).not.toContain("Crashed Run Detected");
  });

  test("an explicitly crashed run prints the detail lines, not just the headline", async () => {
    writePrd([story({ id: "US-001", title: "Only story" })]);
    writeStatus({
      run: {
        id: "run-2026-06-03T00-00-00-000Z",
        feature: "test-feature",
        startedAt: "2026-06-03T00:00:00.000Z",
        status: "crashed",
        dryRun: false,
        pid: 999999,
        crashedAt: "2026-06-03T00:42:00.000Z",
        crashSignal: "SIGKILL",
      },
    });

    await displayFeatureStatus({ feature: "test-feature", dir: testDir });

    const output = consoleOutput.join("\n");
    expect(output).toContain("Crashed Run Detected:");
    expect(output).toContain("Run ID:     run-2026-06-03T00-00-00-000Z");
    expect(output).toContain("PID:        999999 (dead)");
    expect(output).toContain("Started:    2026-06-03T00:00:00.000Z");
    expect(output).toContain("Crashed:    2026-06-03T00:42:00.000Z");
    expect(output).toContain("Signal:     SIGKILL");
    expect(output).toContain("Progress:   1/4 stories (at crash)");
  });

  test("a crashed run without crashedAt/crashSignal omits those detail lines", async () => {
    writePrd([story({ id: "US-001", title: "Only story" })]);
    writeStatus({
      run: {
        id: "run-2026-06-03T00-00-00-000Z",
        feature: "test-feature",
        startedAt: "2026-06-03T00:00:00.000Z",
        status: "crashed",
        dryRun: false,
        pid: 999999,
      },
    });

    await displayFeatureStatus({ feature: "test-feature", dir: testDir });

    const output = consoleOutput.join("\n");
    expect(output).toContain("Crashed Run Detected:");
    expect(output).not.toContain("Crashed:");
    expect(output).not.toContain("Signal:");
  });

  test("an active run prints the run detail lines including the current story", async () => {
    writePrd([story({ id: "US-001", title: "Only story" })]);
    writeStatus({
      run: {
        id: "run-2026-06-03T00-00-00-000Z",
        feature: "test-feature",
        startedAt: "2026-06-03T00:00:00.000Z",
        status: "running",
        dryRun: false,
        pid: process.pid,
      },
      current: {
        storyId: "US-001",
        title: "Only story",
        complexity: "medium",
        tddStrategy: "test-after",
        model: "claude-sonnet-4.5",
        attempt: 1,
        phase: "execution",
      },
    });

    await displayFeatureStatus({ feature: "test-feature", dir: testDir });

    const output = consoleOutput.join("\n");
    expect(output).toContain("Active Run:");
    expect(output).toContain("Run ID:     run-2026-06-03T00-00-00-000Z");
    expect(output).toContain(`PID:        ${process.pid}`);
    expect(output).toContain("Started:    2026-06-03T00:00:00.000Z");
    expect(output).toContain("Progress:   1/4 stories");
    expect(output).toContain("Cost:       $0.1234");
    expect(output).toContain("Current:    US-001 - Only story");
    // A running run suppresses the trailing last-run block.
    expect(output).not.toContain("Last run:");
  });
});
