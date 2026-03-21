/**
 * Diagnose Command
 *
 * Reads run artifacts and produces structured diagnosis report.
 * Pure pattern matching -- no LLM calls, no agents.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { findProjectDir } from "../config";
import type { NaxStatusFile } from "../execution/status-file";
import { getLogger } from "../logger";
import { loadPRD } from "../prd";
import { diagnoseStories, generateRecommendations } from "./diagnose-analysis";
import { formatReport } from "./diagnose-formatter";

export interface DiagnoseOptions {
  feature?: string;
  workdir?: string;
  json?: boolean;
  verbose?: boolean;
}

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

export interface LockCheck {
  lockPresent: boolean;
  pidAlive?: boolean;
  pid?: number;
  fixCommand?: string;
}

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

function isProcessAlive(pid: number): boolean {
  try {
    const result = Bun.spawnSync(["ps", "-p", String(pid)], { stdout: "ignore", stderr: "ignore" });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

async function loadStatusFile(workdir: string): Promise<NaxStatusFile | null> {
  const statusPath = join(workdir, ".nax", "status.json");
  if (!existsSync(statusPath)) return null;
  try {
    return (await Bun.file(statusPath).json()) as NaxStatusFile;
  } catch {
    return null;
  }
}

async function countCommitsSince(workdir: string, since?: string): Promise<number> {
  if (!since) return 0;
  try {
    const result = Bun.spawnSync(["git", "log", "--oneline", `--since=${since}`, "--all"], {
      cwd: workdir,
      stdout: "pipe",
      stderr: "ignore",
    });
    if (result.exitCode !== 0) return 0;
    const output = new TextDecoder().decode(result.stdout);
    return output
      .trim()
      .split("\n")
      .filter((line) => line.length > 0).length;
  } catch {
    return 0;
  }
}

async function checkLock(workdir: string): Promise<LockCheck> {
  const lockFile = Bun.file(join(workdir, "nax.lock"));
  if (!(await lockFile.exists())) return { lockPresent: false };
  try {
    const lockData = JSON.parse(await lockFile.text());
    const pid = lockData.pid;
    const pidAlive = isProcessAlive(pid);
    if (!pidAlive) return { lockPresent: true, pidAlive: false, pid, fixCommand: "rm nax.lock" };
    return { lockPresent: true, pidAlive: true, pid };
  } catch {
    return { lockPresent: true };
  }
}

/** Run diagnose command */
export async function diagnoseCommand(options: DiagnoseOptions = {}): Promise<void> {
  const logger = getLogger();
  const workdir = options.workdir ?? process.cwd();

  const naxSubdir = findProjectDir(workdir);
  let projectDir: string | null = naxSubdir ? join(naxSubdir, "..") : null;
  if (!projectDir && existsSync(join(workdir, ".nax"))) {
    projectDir = workdir;
  }
  if (!projectDir) throw new Error("Not in a nax project directory");

  let feature = options.feature;
  if (!feature) {
    const status = await loadStatusFile(projectDir);
    if (status) {
      feature = status.run.feature;
    } else {
      const featuresDir = join(projectDir, ".nax", "features");
      if (!existsSync(featuresDir)) throw new Error("No features found in project");
      const features = readdirSync(featuresDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      if (features.length === 0) throw new Error("No features found");
      feature = features[0];
      logger.info("diagnose", "No feature specified, using first found", { feature });
    }
  }

  const featureDir = join(projectDir, ".nax", "features", feature);
  const prdPath = join(featureDir, "prd.json");
  if (!existsSync(prdPath)) throw new Error(`Feature not found: ${feature}`);

  const prd = await loadPRD(prdPath);
  const status = await loadStatusFile(projectDir);
  const lockCheck = await checkLock(projectDir);
  const commitCount = await countCommitsSince(projectDir, status?.run.startedAt);

  const { storyBreakdown, failureAnalysis } = diagnoseStories(prd, status);

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
      eventsFound: false,
      gitLogFound: commitCount > 0,
    },
  };

  report.recommendations = generateRecommendations(report);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report, options.verbose ?? false));
  }
}
