/**
 * Diagnose Command
 *
 * Reads run artifacts and produces structured diagnosis report.
 * Pure pattern matching — no LLM calls, no agents.
 *
 * Reads from:
 * - ~/.nax/events/<project>/events.jsonl
 * - <workdir>/.nax-status.json
 * - <workdir>/nax/features/<feature>/prd.json
 * - <workdir>/nax.lock
 * - git log
 *
 * Outputs:
 * 1. Run Summary
 * 2. Story Breakdown
 * 3. Failure Analysis
 * 4. Lock Check
 * 5. Recommendations
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { findProjectDir } from "../config";
import type { NaxStatusFile } from "../execution/status-file";
import { getLogger } from "../logger";
import type { PRD, UserStory } from "../prd";
import { loadPRD } from "../prd";

/**
 * Diagnose command options
 */
export interface DiagnoseOptions {
  /** Feature name (optional — defaults to current feature) */
  feature?: string;
  /** Working directory (optional — defaults to cwd) */
  workdir?: string;
  /** JSON output mode */
  json?: boolean;
  /** Verbose mode */
  verbose?: boolean;
}

/**
 * Failure pattern classifications
 */
export type FailurePattern =
  | "GREENFIELD_TDD"
  | "TEST_MISMATCH"
  | "ENVIRONMENTAL"
  | "RATE_LIMITED"
  | "ISOLATION_VIOLATION"
  | "MAX_TIERS_EXHAUSTED"
  | "SESSION_CRASH"
  | "STALLED"
  | "LOCK_STALE"
  | "AUTO_RECOVERED"
  | "UNKNOWN";

/**
 * Story diagnosis result
 */
export interface StoryDiagnosis {
  storyId: string;
  title: string;
  status: string;
  attempts: number;
  tier?: string;
  strategy?: string;
  pattern: FailurePattern;
  symptom?: string;
  fixSuggestion?: string;
}

/**
 * Lock check result
 */
export interface LockCheck {
  lockPresent: boolean;
  pidAlive?: boolean;
  pid?: number;
  fixCommand?: string;
}

/**
 * Diagnosis report (structured output)
 */
export interface DiagnosisReport {
  runSummary: {
    feature: string;
    lastRunTime?: string;
    status: string;
    storiesPassed: number;
    storiesFailed: number;
    storiesPending: number;
    cost?: number;
    commitsProduced: number;
  };
  storyBreakdown: StoryDiagnosis[];
  failureAnalysis: StoryDiagnosis[];
  lockCheck: LockCheck;
  recommendations: string[];
  dataSources: {
    prdFound: boolean;
    statusFound: boolean;
    eventsFound: boolean;
    gitLogFound: boolean;
  };
}

/**
 * Check if process is alive via PID
 *
 * @param pid - Process ID to check
 * @returns true if process is running
 */
function isProcessAlive(pid: number): boolean {
  try {
    const result = Bun.spawnSync(["ps", "-p", String(pid)], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Load status.json if it exists
 *
 * @param workdir - Working directory
 * @returns Status file or null
 */
async function loadStatusFile(workdir: string): Promise<NaxStatusFile | null> {
  const statusPath = join(workdir, ".nax-status.json");
  if (!existsSync(statusPath)) {
    return null;
  }
  try {
    const content = Bun.file(statusPath);
    return (await content.json()) as NaxStatusFile;
  } catch {
    return null;
  }
}

/**
 * Count commits produced during the last run via git log
 *
 * @param workdir - Working directory
 * @param since - ISO timestamp to count commits since
 * @returns Number of commits
 */
async function countCommitsSince(workdir: string, since?: string): Promise<number> {
  if (!since) {
    return 0;
  }

  try {
    const result = Bun.spawnSync(["git", "log", "--oneline", `--since=${since}`, "--all"], {
      cwd: workdir,
      stdout: "pipe",
      stderr: "ignore",
    });

    if (result.exitCode !== 0) {
      return 0;
    }

    const output = new TextDecoder().decode(result.stdout);
    const lines = output
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
    return lines.length;
  } catch {
    return 0;
  }
}

/**
 * Detect failure pattern for a story
 *
 * @param story - User story
 * @param prd - Full PRD
 * @param status - Status file (if available)
 * @returns Detected failure pattern
 */
function detectFailurePattern(story: UserStory, prd: PRD, status: NaxStatusFile | null): FailurePattern {
  // Check for AUTO_RECOVERED first (greenfield but passed)
  if (
    story.status === "passed" &&
    story.priorErrors?.some((err) => err.toLowerCase().includes("greenfield-no-tests"))
  ) {
    return "AUTO_RECOVERED";
  }

  // Only diagnose failed stories from this point
  if (story.status !== "failed" && story.status !== "blocked" && story.status !== "paused") {
    return "UNKNOWN";
  }

  // GREENFIELD_TDD: failureCategory === greenfield-no-tests
  if (
    story.failureCategory === "greenfield-no-tests" ||
    story.priorErrors?.some((err) => err.toLowerCase().includes("greenfield-no-tests"))
  ) {
    return "GREENFIELD_TDD";
  }

  // TEST_MISMATCH: 2+ consecutive tests-failing errors
  const testFailingCount = story.priorErrors?.filter((err) => err.toLowerCase().includes("tests-failing")).length || 0;
  if (testFailingCount >= 2) {
    return "TEST_MISMATCH";
  }

  // ENVIRONMENTAL: precheck-failed or blocker in status
  if (
    story.priorErrors?.some((err) => err.toLowerCase().includes("precheck-failed")) ||
    (status?.progress.blocked ?? 0) > 0
  ) {
    return "ENVIRONMENTAL";
  }

  // RATE_LIMITED: rateLimited in errors
  if (story.priorErrors?.some((err) => err.toLowerCase().includes("ratelimited"))) {
    return "RATE_LIMITED";
  }

  // ISOLATION_VIOLATION: failureCategory
  if (story.failureCategory === "isolation-violation") {
    return "ISOLATION_VIOLATION";
  }

  // STALLED: isStalled flag or blocked dependencies
  if (status?.run.status === "stalled") {
    return "STALLED";
  }

  // SESSION_CRASH: session-failure category + no commits
  if (story.priorErrors?.some((err) => err.toLowerCase().includes("session-failure"))) {
    return "SESSION_CRASH";
  }

  // MAX_TIERS_EXHAUSTED: TODO - would need config to check all tiers
  // For now, if attempts > 3, likely exhausted
  if (story.attempts > 3) {
    return "MAX_TIERS_EXHAUSTED";
  }

  return "UNKNOWN";
}

/**
 * Get symptom description for a pattern
 *
 * @param pattern - Failure pattern
 * @returns Human-readable symptom
 */
function getPatternSymptom(pattern: FailurePattern): string {
  switch (pattern) {
    case "GREENFIELD_TDD":
      return "Story attempted in greenfield project with no existing tests";
    case "TEST_MISMATCH":
      return "Multiple test failures across attempts";
    case "ENVIRONMENTAL":
      return "Environment prechecks failed or blockers detected";
    case "RATE_LIMITED":
      return "API rate limit exceeded";
    case "ISOLATION_VIOLATION":
      return "Story modified files outside its scope";
    case "MAX_TIERS_EXHAUSTED":
      return "Story attempted at all configured model tiers without success";
    case "SESSION_CRASH":
      return "Agent session crashed without producing commits";
    case "STALLED":
      return "All stories blocked or paused — no forward progress possible";
    case "LOCK_STALE":
      return "Lock file present but process is dead";
    case "AUTO_RECOVERED":
      return "Greenfield issue detected but S5 auto-recovery succeeded";
    default:
      return "Unknown failure pattern";
  }
}

/**
 * Get fix suggestion for a pattern
 *
 * @param pattern - Failure pattern
 * @param story - Story context
 * @returns Fix suggestion
 */
function getPatternFixSuggestion(pattern: FailurePattern, story: UserStory): string {
  switch (pattern) {
    case "GREENFIELD_TDD":
      return "Add --greenfield flag or bootstrap with scaffolding tests first";
    case "TEST_MISMATCH":
      return "Review acceptance criteria; tests may be too strict or story underspecified";
    case "ENVIRONMENTAL":
      return "Fix precheck issues (deps, env, build) before re-running";
    case "RATE_LIMITED":
      return "Wait for rate limit to reset or increase tier limits";
    case "ISOLATION_VIOLATION":
      return "Narrow story scope or adjust expectedFiles to allow cross-file changes";
    case "MAX_TIERS_EXHAUSTED":
      return "Simplify story or split into smaller sub-stories";
    case "SESSION_CRASH":
      return "Check agent logs for crash details; may need manual intervention";
    case "STALLED":
      return "Resolve blocked stories or skip them to unblock dependencies";
    case "LOCK_STALE":
      return "Run: rm nax.lock";
    case "AUTO_RECOVERED":
      return "No action needed — S5 successfully handled greenfield scenario";
    default:
      return "Review logs and prior errors for clues";
  }
}

/**
 * Check lock status
 *
 * @param workdir - Working directory
 * @returns Lock check result
 */
async function checkLock(workdir: string): Promise<LockCheck> {
  const lockPath = join(workdir, "nax.lock");
  const lockFile = Bun.file(lockPath);

  if (!(await lockFile.exists())) {
    return { lockPresent: false };
  }

  try {
    const lockContent = await lockFile.text();
    const lockData = JSON.parse(lockContent);
    const pid = lockData.pid;
    const pidAlive = isProcessAlive(pid);

    if (!pidAlive) {
      return {
        lockPresent: true,
        pidAlive: false,
        pid,
        fixCommand: "rm nax.lock",
      };
    }

    return {
      lockPresent: true,
      pidAlive: true,
      pid,
    };
  } catch {
    return { lockPresent: true };
  }
}

/**
 * Generate recommendations based on diagnosis
 *
 * @param report - Diagnosis report
 * @returns Ordered list of recommendations
 */
function generateRecommendations(report: DiagnosisReport): string[] {
  const recommendations: string[] = [];

  // Stale lock fix
  if (report.lockCheck.lockPresent && report.lockCheck.pidAlive === false) {
    recommendations.push(`Remove stale lock: ${report.lockCheck.fixCommand}`);
  }

  // Critical failures first
  const criticalPatterns = report.failureAnalysis.filter((f) =>
    ["ENVIRONMENTAL", "STALLED", "SESSION_CRASH"].includes(f.pattern),
  );

  if (criticalPatterns.length > 0) {
    recommendations.push(
      `Fix ${criticalPatterns.length} critical blocker(s): ${criticalPatterns.map((f) => f.storyId).join(", ")}`,
    );
  }

  // Rate limiting
  const rateLimited = report.failureAnalysis.filter((f) => f.pattern === "RATE_LIMITED");
  if (rateLimited.length > 0) {
    recommendations.push("Wait for rate limits to reset before re-running");
  }

  // Greenfield issues
  const greenfield = report.failureAnalysis.filter((f) => f.pattern === "GREENFIELD_TDD");
  if (greenfield.length > 0) {
    recommendations.push("Consider adding --greenfield flag or bootstrap tests for greenfield stories");
  }

  // General re-run
  if (report.runSummary.storiesFailed > 0 && recommendations.length === 0) {
    recommendations.push(`Re-run with: nax run -f ${report.runSummary.feature}`);
  }

  // Success case
  if (report.runSummary.storiesFailed === 0 && report.runSummary.storiesPending === 0) {
    recommendations.push("All stories passed — feature is complete!");
  }

  return recommendations;
}

/**
 * Format diagnosis report as human-readable text
 *
 * @param report - Diagnosis report
 * @param verbose - Verbose mode
 * @returns Formatted text output
 */
function formatReport(report: DiagnosisReport, verbose: boolean): string {
  const lines: string[] = [];

  // Header
  lines.push(chalk.bold(`\n🔍 Diagnosis Report: ${report.runSummary.feature}\n`));

  // Data sources warning
  if (!report.dataSources.eventsFound) {
    lines.push(chalk.yellow("⚠️  events.jsonl not found — diagnosis limited to PRD + git log\n"));
  }

  // 1. Run Summary
  lines.push(chalk.bold("📊 Run Summary\n"));
  if (report.runSummary.lastRunTime) {
    lines.push(chalk.dim(`   Last Run:    ${report.runSummary.lastRunTime}`));
  }
  lines.push(chalk.dim(`   Status:      ${report.runSummary.status}`));
  lines.push(chalk.green(`   Passed:      ${report.runSummary.storiesPassed}`));
  lines.push(chalk.red(`   Failed:      ${report.runSummary.storiesFailed}`));
  lines.push(chalk.dim(`   Pending:     ${report.runSummary.storiesPending}`));
  if (report.runSummary.cost !== undefined) {
    lines.push(chalk.dim(`   Cost:        $${report.runSummary.cost.toFixed(4)}`));
  }
  lines.push(chalk.dim(`   Commits:     ${report.runSummary.commitsProduced}`));
  lines.push("");

  // 2. Story Breakdown
  if (verbose && report.storyBreakdown.length > 0) {
    lines.push(chalk.bold("📋 Story Breakdown\n"));
    for (const story of report.storyBreakdown) {
      const icon = story.status === "passed" ? "✅" : story.status === "failed" ? "❌" : "⬜";
      const pattern = story.pattern !== "UNKNOWN" ? chalk.yellow(` [${story.pattern}]`) : "";
      lines.push(`   ${icon} ${story.storyId}: ${story.title}${pattern}`);
      if (verbose && story.tier) {
        lines.push(chalk.dim(`      Tier: ${story.tier}, Strategy: ${story.strategy}, Attempts: ${story.attempts}`));
      }
    }
    lines.push("");
  }

  // 3. Failure Analysis
  if (report.failureAnalysis.length > 0) {
    lines.push(chalk.bold("❌ Failure Analysis\n"));
    for (const failure of report.failureAnalysis) {
      const level = failure.pattern === "AUTO_RECOVERED" ? chalk.green("INFO") : chalk.red("ERROR");
      lines.push(`   ${level} ${failure.storyId}: ${failure.title}`);
      lines.push(chalk.dim(`      Pattern:     ${failure.pattern}`));
      if (failure.symptom) {
        lines.push(chalk.dim(`      Symptom:     ${failure.symptom}`));
      }
      if (failure.fixSuggestion) {
        lines.push(chalk.yellow(`      Fix:         ${failure.fixSuggestion}`));
      }
      lines.push("");
    }
  }

  // 4. Lock Check
  lines.push(chalk.bold("🔒 Lock Check\n"));
  if (!report.lockCheck.lockPresent) {
    lines.push(chalk.dim("   No lock file present\n"));
  } else if (report.lockCheck.pidAlive === false) {
    lines.push(chalk.red(`   ❌ Stale lock detected (PID ${report.lockCheck.pid} is dead)`));
    lines.push(chalk.yellow(`   Fix: ${report.lockCheck.fixCommand}\n`));
  } else {
    lines.push(chalk.green(`   ✅ Active lock (PID ${report.lockCheck.pid})\n`));
  }

  // 5. Recommendations
  if (report.recommendations.length > 0) {
    lines.push(chalk.bold("💡 Recommendations\n"));
    for (let i = 0; i < report.recommendations.length; i++) {
      lines.push(`   ${i + 1}. ${report.recommendations[i]}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Run diagnose command
 *
 * @param options - Command options
 */
export async function diagnoseCommand(options: DiagnoseOptions = {}): Promise<void> {
  const logger = getLogger();

  // Resolve working directory
  const workdir = options.workdir ?? process.cwd();

  // findProjectDir returns the nax/ subdirectory (e.g. <root>/nax/).
  // We need the project ROOT (parent of nax/), not the nax/ dir itself.
  const naxSubdir = findProjectDir(workdir);
  let projectDir: string | null = naxSubdir ? join(naxSubdir, "..") : null;

  // Fallback for test environments: if nax/ exists directly in workdir, use it
  if (!projectDir && existsSync(join(workdir, "nax"))) {
    projectDir = workdir;
  }

  if (!projectDir) {
    throw new Error("Not in a nax project directory");
  }

  // Find feature
  let feature = options.feature;
  if (!feature) {
    // Attempt to find most recent feature from status.json
    const status = await loadStatusFile(projectDir);
    if (status) {
      feature = status.run.feature;
    } else {
      // Fallback: list features and pick the one with most recent prd.json update
      const featuresDir = join(projectDir, "nax", "features");
      if (!existsSync(featuresDir)) {
        throw new Error("No features found in project");
      }

      const features = readdirSync(featuresDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);

      if (features.length === 0) {
        throw new Error("No features found");
      }

      // Use first feature as fallback
      feature = features[0];
      logger.info("diagnose", "No feature specified, using first found", { feature });
    }
  }

  // Load PRD
  const featureDir = join(projectDir, "nax", "features", feature);
  const prdPath = join(featureDir, "prd.json");

  if (!existsSync(prdPath)) {
    throw new Error(`Feature not found: ${feature}`);
  }

  const prd = await loadPRD(prdPath);

  // Load status file
  const status = await loadStatusFile(projectDir);

  // Load lock check
  const lockCheck = await checkLock(projectDir);

  // Count commits
  const commitCount = await countCommitsSince(projectDir, status?.run.startedAt);

  // Diagnose each story
  const storyBreakdown: StoryDiagnosis[] = [];
  const failureAnalysis: StoryDiagnosis[] = [];

  for (const story of prd.userStories) {
    const pattern = detectFailurePattern(story, prd, status);
    const diagnosis: StoryDiagnosis = {
      storyId: story.id,
      title: story.title,
      status: story.status,
      attempts: story.attempts,
      tier: story.routing?.modelTier,
      strategy: story.routing?.testStrategy,
      pattern,
    };

    storyBreakdown.push(diagnosis);

    // Add to failure analysis if failed, blocked, paused, or informational (AUTO_RECOVERED)
    if (
      story.status === "failed" ||
      story.status === "blocked" ||
      story.status === "paused" ||
      pattern === "AUTO_RECOVERED"
    ) {
      diagnosis.symptom = getPatternSymptom(pattern);
      diagnosis.fixSuggestion = getPatternFixSuggestion(pattern, story);
      failureAnalysis.push(diagnosis);
    }
  }

  // Build report
  const report: DiagnosisReport = {
    runSummary: {
      feature,
      lastRunTime: status?.run.startedAt,
      status: status?.run.status ?? "unknown",
      storiesPassed: prd.userStories.filter((s) => s.status === "passed").length,
      storiesFailed: prd.userStories.filter((s) => s.status === "failed").length,
      storiesPending: prd.userStories.filter(
        (s) => s.status !== "passed" && s.status !== "failed" && s.status !== "skipped",
      ).length,
      cost: status?.cost.spent,
      commitsProduced: commitCount,
    },
    storyBreakdown,
    failureAnalysis,
    lockCheck,
    recommendations: [],
    dataSources: {
      prdFound: true,
      statusFound: status !== null,
      eventsFound: false, // TODO: implement events.jsonl reading
      gitLogFound: commitCount > 0,
    },
  };

  // Generate recommendations
  report.recommendations = generateRecommendations(report);

  // Output
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report, options.verbose ?? false));
  }
}
