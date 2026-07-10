/**
 * `nax resume` command — orchestrator and commander wiring.
 *
 * Thin layer that:
 *   1. Probes the feature's `checkpoint.jsonl` (injected via deps)
 *   2. Either prints the "no checkpoint" line (AC-2) or a summary line
 *      naming the feature and the story count (AC-3)
 *   3. Always falls through to the underlying run invocation, inheriting its
 *      exit code and the orchestrator's seeded skip state.
 *
 * All I/O flows through `ResumeCommandDeps` so the orchestrator is hermetic.
 */

import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { Command } from "commander";
import { globalConfigDir } from "../config/paths";
import { NaxError } from "../errors";
import { type StoryCheckpoint, buildResumePlan, loadCheckpoints } from "../execution/checkpoint";
import { projectOutputDir } from "../runtime";

/** Options accepted by the `nax resume` command. */
export interface ResumeCommandOptions {
  /** Feature directory (where `checkpoint.jsonl` lives). */
  featureDir?: string;
}

/**
 * The actual run invocation — the CLI layer wires this to `run()` from
 * `@/execution`. Tests inject a mock invocation.
 */
export type ResumeRunInvocation = (feature: string, options: ResumeCommandOptions) => Promise<number>;

/** Swappable dependencies — keeps the orchestrator hermetic for tests. */
export interface ResumeCommandDeps {
  checkpointExists: (featureDir: string) => Promise<boolean>;
  loadCheckpoints: (featureDir: string) => Promise<Map<string, StoryCheckpoint>>;
  runInvocation: ResumeRunInvocation;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

async function defaultCheckpointExists(featureDir: string): Promise<boolean> {
  if (!featureDir || !existsSync(featureDir)) return false;
  return existsSync(join(featureDir, "checkpoint.jsonl"));
}

async function defaultLoadCheckpoints(featureDir: string): Promise<Map<string, StoryCheckpoint>> {
  return loadCheckpoints(featureDir);
}

/**
 * Default deps — wired against the real filesystem. Tests inject their own.
 *
 * `runInvocation` is intentionally left as a throwing stub in production: the
 * CLI action supplies a closure that calls `run()` directly. Tests inject a
 * mock invocation.
 */
export const _resumeCmdDeps: ResumeCommandDeps = {
  checkpointExists: defaultCheckpointExists,
  loadCheckpoints: defaultLoadCheckpoints,
  runInvocation: async () => {
    throw new NaxError("resume: runInvocation must be supplied by the CLI layer", "RESUME_INVOCATION_MISSING", {
      stage: "resume",
    });
  },
  stdout: (text: string) => process.stdout.write(text),
  stderr: (text: string) => process.stderr.write(text),
};

/**
 * Aggregate the phases that will be elided across every loaded checkpoint.
 * Compares each `StoryCheckpoint` against its own recorded tree state (not a
 * freshly captured one) — the orchestrator's real git-tree guard runs later,
 * per story, against the tree at that point in the run. This aggregate is an
 * upper bound: the phases available to skip if the tree has not moved since
 * the checkpoint was written, keeping the resume command's deps hermetic
 * (no real git calls) for the informational summary line.
 */
function aggregateSkipPhases(checkpoints: Map<string, StoryCheckpoint>): string[] {
  const skip = new Set<string>();
  for (const cp of checkpoints.values()) {
    const plan = buildResumePlan(cp, cp.tree);
    for (const phase of plan.skipPhases) skip.add(phase);
  }
  return [...skip];
}

/**
 * Build a one-line resume summary that names the feature, the count of
 * stories with a checkpoint, and the phases being skipped (AC-3).
 */
export function renderResumeSummary(feature: string, storyCount: number, skipPhases: readonly string[]): string {
  const noun = storyCount === 1 ? "story" : "stories";
  const phasesText = skipPhases.length > 0 ? skipPhases.join(", ") : "none";
  return `Resume: feature="${feature}" — ${storyCount} ${noun} with checkpoint (skipping: ${phasesText})\n`;
}

/**
 * Orchestrator — prints the appropriate line and then dispatches the
 * underlying run invocation. Returns the run's exit code (0 on success).
 *
 * - Missing checkpoint → "No checkpoint found — running from scratch" + exit 0.
 * - Existing checkpoint → "Resume: feature=… — N stories with checkpoint" + run.
 */
export async function runResume(
  feature: string,
  options: ResumeCommandOptions = {},
  deps: ResumeCommandDeps = _resumeCmdDeps,
): Promise<number> {
  const featureDir = options.featureDir ?? "";

  const hasCheckpoint = await deps.checkpointExists(featureDir);

  if (!hasCheckpoint) {
    deps.stdout("No checkpoint found — running from scratch\n");
  } else {
    const map = await deps.loadCheckpoints(featureDir);
    deps.stdout(renderResumeSummary(feature, map.size, aggregateSkipPhases(map)));
  }

  return deps.runInvocation(feature, {
    ...(options.featureDir !== undefined ? { featureDir: options.featureDir } : {}),
  });
}

/**
 * Register the `resume` subcommand on a commander `Command` instance.
 *
 * The action handler delegates to `runResume`, wiring `runInvocation` to the
 * canonical `run()` entry point so resume inherits the orchestrator's
 * auto-resume behaviour and exit codes. The CLI shell resolves the workdir
 * and feature directory before invoking `runResume`.
 */
export function registerResumeCommand(program: Command): void {
  program
    .command("resume")
    .description("Resume an interrupted run for a feature (auto-detects checkpoint)")
    .requiredOption("-f, --feature <name>", "Feature name")
    .option("-d, --dir <path>", "Working directory", process.cwd())
    .action(async (cmdOpts: { feature: string; dir: string }) => {
      const { findProjectDir } = await import("../config");
      const { run } = await import("../execution");
      const { applyResumeModeDeps } = await import("../execution/checkpoint");
      const { existsSync } = await import("node:fs");
      const { loadConfig } = await import("../config");
      const { loadPRD } = await import("../prd");
      const { loadHooksConfig } = await import("../hooks");

      const naxDir = findProjectDir(cmdOpts.dir);
      if (!naxDir) {
        process.stderr.write("nax not initialized. Run: nax init\n");
        process.exit(1);
      }
      const featureDir = join(naxDir, "features", cmdOpts.feature);

      const deps: ResumeCommandDeps = {
        ..._resumeCmdDeps,
        runInvocation: async (feature, opts): Promise<number> => {
          const config = await loadConfig(naxDir ?? undefined);
          const prdPath = join(opts.featureDir ?? "", "prd.json");
          if (!existsSync(prdPath)) {
            process.stderr.write(`Feature "${feature}" not found or missing prd.json\n`);
            return 1;
          }
          await loadPRD(prdPath);
          const globalNaxDir = globalConfigDir();
          const hooks = await loadHooksConfig(naxDir, globalNaxDir);

          // Force auto-resume — that's what `nax resume` means. The runner also
          // applies resumeMode internally, so we could omit this, but doing it
          // here makes the intent explicit and avoids any chance of a stale dep.
          applyResumeModeDeps(opts.featureDir ?? "", "auto");

          // Mirror `bin/nax.ts`'s `nax run` status-file resolution — an empty
          // path resolves to `process.cwd()` inside `StatusWriter`, so every
          // write fails silently and consumers of status.json (TUI, `nax
          // status`) see nothing for the whole resumed run.
          const projectKey = config.name?.trim() || basename(cmdOpts.dir);
          const outputDir = projectOutputDir(projectKey, config.outputDir);
          const statusFilePath = join(outputDir, "status.json");

          const result = await run({
            prdPath,
            workdir: cmdOpts.dir,
            config,
            hooks,
            feature,
            ...(opts.featureDir !== undefined ? { featureDir: opts.featureDir } : {}),
            dryRun: false,
            useBatch: true,
            statusFile: statusFilePath,
            logFilePath: undefined,
            formatterMode: "normal",
            headless: true,
            skipPrecheck: false,
            resumeMode: "auto",
          });

          return result.success ? 0 : 1;
        },
      };

      try {
        const exit = await runResume(cmdOpts.feature, { featureDir }, deps);
        process.exit(exit);
      } catch (err) {
        process.stderr.write(`Error: ${(err as Error).message}\n`);
        process.exit(1);
      }
    });
}
