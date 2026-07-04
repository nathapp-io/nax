/**
 * `nax replay` command — orchestrator and commander wiring.
 *
 * Thin layer that:
 *   1. Discovers a run from the central registry
 *   2. Loads JSONL + metrics + status.json (injected via deps)
 *   3. Reconstructs the timeline
 *   4. Renders either a human report or a JSON serialization
 *   5. Resolves to a numeric exit code
 *
 * All I/O flows through `ReplayCommandDeps` so the orchestrator is hermetic.
 */

import { existsSync } from "node:fs";
import type { Command } from "commander";
import { NaxError } from "../errors";
import type { NaxStatusFile } from "../execution/status-file";
import type { LogEntry } from "../logger/types";
import type { RunMetrics } from "../metrics/types";
import { type DiscoveredRun, discoverRun } from "../replay/discovery";
import { toReplayJson } from "../replay/json";
import { reconstructTimeline } from "../replay/reconstruct";
import { type RenderOptions, renderReport } from "../replay/report";
import type { RunTimeline } from "../replay/types";

/** Options accepted by the `nax replay` command. */
export interface ReplayCommandOptions {
  /** Emit JSON instead of the human-readable report. */
  json?: boolean;
  /** Show all stories (passed too), not just failed. */
  all?: boolean;
  /** Filter to a single story id. */
  story?: string;
}

/** Swappable dependencies — keeps the orchestrator hermetic for tests. */
export interface ReplayCommandDeps {
  discoverRun: (query?: string) => Promise<DiscoveredRun>;
  readJsonl: (path: string) => Promise<LogEntry[]>;
  readMetrics: (meta: { runId: string; project: string; workdir: string }) => Promise<RunMetrics | undefined>;
  readStatus: (statusPath: string) => Promise<NaxStatusFile | undefined>;
  reconstructTimeline: typeof reconstructTimeline;
  renderReport: (timeline: RunTimeline, options?: RenderOptions) => string;
  toReplayJson: (timeline: RunTimeline) => RunTimeline;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

async function readJsonlLenient(path: string): Promise<LogEntry[]> {
  if (!existsSync(path)) return [];
  const content = await Bun.file(path).text();
  const lines = content.split("\n");
  const entries: LogEntry[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as LogEntry);
    } catch {
      // skip malformed JSONL line — see AC-9
    }
  }
  return entries;
}

async function readJsonOrUndefined<T>(path: string): Promise<T | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    return (await Bun.file(path).json()) as T;
  } catch {
    return undefined;
  }
}

async function readMetricsFromProject(meta: {
  runId: string;
  project: string;
  workdir: string;
}): Promise<RunMetrics | undefined> {
  const { loadRunMetrics } = await import("../metrics/tracker");
  const { projectOutputDir } = await import("../runtime/paths");
  const outputDir = projectOutputDir(meta.project, undefined);
  const all = await loadRunMetrics(outputDir);
  return all.find((m) => m.runId === meta.runId);
}

/**
 * Default deps — wired against the real filesystem. Tests inject their own.
 */
export const _replayCmdDeps: ReplayCommandDeps = {
  discoverRun,
  readJsonl: readJsonlLenient,
  readMetrics: readMetricsFromProject,
  readStatus: async (statusPath: string) => readJsonOrUndefined<NaxStatusFile>(statusPath),
  reconstructTimeline,
  renderReport,
  toReplayJson,
  stdout: (text: string) => process.stdout.write(text),
  stderr: (text: string) => process.stderr.write(text),
};

/**
 * Orchestrator — discovers, loads, reconstructs, and renders the replay
 * report (or its JSON form) for a run.
 *
 * Returns a numeric exit code:
 *   - `0` — report/JSON written successfully
 *   - `1` — discovery failed (e.g. run not found / ambiguous prefix)
 */
export async function runReplay(
  query: string | undefined,
  options: ReplayCommandOptions = {},
  deps: ReplayCommandDeps = _replayCmdDeps,
): Promise<number> {
  let discovered: DiscoveredRun;
  try {
    discovered = await deps.discoverRun(query);
  } catch (err) {
    if (err instanceof NaxError && err.code === "RUN_NOT_FOUND") {
      deps.stderr(`${err.message}\n`);
      return 1;
    }
    throw err;
  }

  const entries = await deps.readJsonl(discovered.jsonlPath);
  const metrics = await deps.readMetrics({
    runId: discovered.meta.runId,
    project: discovered.meta.project,
    workdir: discovered.meta.workdir,
  });
  const status = await deps.readStatus(discovered.meta.statusPath);

  const timeline = deps.reconstructTimeline({
    entries,
    ...(metrics !== undefined ? { runMetrics: metrics } : {}),
    ...(status !== undefined ? { status } : {}),
    meta: { runId: discovered.meta.runId, feature: discovered.meta.feature },
  });

  if (options.json === true) {
    const json = JSON.stringify(deps.toReplayJson(timeline), null, 2);
    deps.stdout(`${json}\n`);
  } else {
    const renderOpts: RenderOptions = {
      ...(options.all === true ? { all: true } : {}),
      ...(options.story !== undefined ? { story: options.story } : {}),
    };
    const report = deps.renderReport(timeline, renderOpts);
    deps.stdout(`${report}\n`);
  }

  return 0;
}

/**
 * Register the `replay` subcommand on a commander `Command` instance.
 */
export function registerReplayCommand(program: Command): void {
  program
    .command("replay [run-id]")
    .description("Reconstruct and display a post-mortem timeline for a previous run")
    .option("-j, --json", "Emit JSON instead of the human-readable report", false)
    .option("--all", "Show passed stories too (default: failure-focused)", false)
    .option("-s, --story <id>", "Show only the named story", "")
    .action(async (runId: string | undefined, cmdOpts: { json?: boolean; all?: boolean; story?: string }) => {
      const opts: ReplayCommandOptions = {
        ...(cmdOpts.json === true ? { json: true } : {}),
        ...(cmdOpts.all === true ? { all: true } : {}),
        ...(cmdOpts.story !== undefined && cmdOpts.story !== "" ? { story: cmdOpts.story } : {}),
      };
      try {
        const exit = await runReplay(runId, opts);
        if (exit !== 0) process.exit(exit);
      } catch (err) {
        process.stderr.write(`Error: ${(err as Error).message}\n`);
        process.exit(1);
      }
    });
}
