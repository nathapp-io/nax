/**
 * `nax resume` command — orchestrator and commander wiring.
 *
 * A thin layer over the run invocation: it hands the feature (and its resolved
 * feature directory) to `run()` with `resumeMode: "auto"` and inherits the
 * run's exit code. It no longer probes or summarises `checkpoint.jsonl` — that
 * store's reader and writer are gone, so there is nothing to print.
 *
 * All I/O flows through `ResumeCommandDeps` so the orchestrator is hermetic.
 */

import { basename, join } from "node:path";
import type { Command } from "commander";
import { globalConfigDir } from "../config/paths";
import { NaxError } from "../errors";
import { buildRunId } from "../execution/run-id";
import { projectOutputDir } from "../runtime";
import { validateFeatureName } from "../utils/feature-name";

/** Options accepted by the `nax resume` command. */
export interface ResumeCommandOptions {
  /** Feature directory the run is bound to. */
  featureDir?: string;
}

/**
 * The actual run invocation — the CLI layer wires this to `run()` from
 * `@/execution`. Tests inject a mock invocation.
 */
export type ResumeRunInvocation = (feature: string, options: ResumeCommandOptions) => Promise<number>;

/** Swappable dependencies — keeps the orchestrator hermetic for tests. */
export interface ResumeCommandDeps {
  runInvocation: ResumeRunInvocation;
}

/**
 * Default deps.
 *
 * `runInvocation` is intentionally left as a throwing stub in production: the
 * CLI action supplies a closure that calls `run()` directly. Tests inject a
 * mock invocation.
 */
export const _resumeCmdDeps: ResumeCommandDeps = {
  runInvocation: async () => {
    throw new NaxError("resume: runInvocation must be supplied by the CLI layer", "RESUME_INVOCATION_MISSING", {
      stage: "resume",
    });
  },
};

/**
 * Dispatch the underlying run invocation for `feature` and return its exit
 * code. `featureDir` is forwarded exactly as given: absent means the key is
 * omitted entirely, so the run invocation keeps its own default.
 */
export async function runResume(
  feature: string,
  options: ResumeCommandOptions = {},
  deps: ResumeCommandDeps = _resumeCmdDeps,
): Promise<number> {
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
    .description("Resume an interrupted run for a feature (auto-resumes the run's workflow record)")
    .requiredOption("-f, --feature <name>", "Feature name")
    .option("-d, --dir <path>", "Working directory", process.cwd())
    .action(async (cmdOpts: { feature: string; dir: string }) => {
      // US-003: refuse an untrusted project before anything in this action
      // reads it — first statement, ahead of every dynamic import below.
      const { runTrustGate } = await import("../cli");
      await runTrustGate(cmdOpts.dir);

      const { findProjectDir, validateDirectory } = await import("../config");
      const { run } = await import("../execution");
      const { existsSync, mkdirSync } = await import("node:fs");
      const { loadConfig } = await import("../config");
      const { loadPRD } = await import("../prd");
      const { loadHooksConfig } = await import("../hooks");
      const { initLogger } = await import("../logger");

      // Resolve `-d` exactly as `nax run` does (`bin/nax.ts` →
      // `validateDirectory`): absolute, symlinks resolved. US-005 hashes this
      // value into the run id and stamps it onto status.json as
      // `run.workdir`, whose contract is "the absolute working directory the
      // run was bound to" (`buildRunId`/`NaxStatusFile`). Hashing and
      // persisting the raw command-line value made `nax resume -d .` record a
      // relative workdir — unattributable to a checkout, and never the same
      // string a sibling `nax run -d <abs>` records for that same directory.
      let dir: string;
      try {
        dir = validateDirectory(cmdOpts.dir);
      } catch (err) {
        process.stderr.write(`Invalid directory: ${(err as Error).message}\n`);
        process.exit(1);
      }

      const naxDir = findProjectDir(dir);
      if (!naxDir) {
        process.stderr.write("nax not initialized. Run: nax init\n");
        process.exit(1);
      }
      // SEC-28: validate the feature name before joining it into a path —
      // unvalidated input lets `nax resume -f ../../x` escape the .nax
      // directory (mirror the guard at src/commands/common.ts:112 and the
      // SEC-08/18 pattern).
      try {
        validateFeatureName(cmdOpts.feature);
      } catch (error) {
        process.stderr.write(`${(error as Error).message}\n`);
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

          // Mirror `bin/nax.ts`'s `nax run` status-file resolution — an empty
          // path resolves to `process.cwd()` inside `StatusWriter`, so every
          // write fails silently and consumers of status.json (TUI, `nax
          // status`) see nothing for the whole resumed run.
          const projectKey = config.name?.trim() || basename(dir);
          const outputDir = projectOutputDir(projectKey, config.outputDir);
          const statusFilePath = join(outputDir, "status.json");

          // Mirror bin/nax.ts's `nax run` logger init — without it, `getLogger()`
          // returns the silent noopLogger for the whole resumed run: no console
          // output, no runs/<id>.jsonl, so crash-recovery/replay have nothing to
          // read for a resumed run (BUG-38).
          const runsDir = join(outputDir, "features", feature, "runs");
          mkdirSync(runsDir, { recursive: true });
          // US-005: route the resumed run's id through `buildRunId` so the
          // resumed log file matches the run it records (the same id flows
          // back into `run()` as `runId`, keeping log filename and the run
          // record in sync — AC-9). `dir` is the resolved absolute workdir —
          // the same normalization `nax run` applies before its own
          // `buildRunId` call.
          const runId = buildRunId(dir, new Date());
          const logFilePath = join(runsDir, `${runId}.jsonl`);
          initLogger({ level: "info", filePath: logFilePath, useChalk: true, headless: true, suppressConsole: false });

          const result = await run({
            prdPath,
            // US-005: the absolute workdir the run is attributed to — both
            // hashed into `runId` above and persisted as
            // `NaxStatusFile.run.workdir` below. Never the raw `-d` argument.
            workdir: dir,
            config,
            hooks,
            feature,
            ...(opts.featureDir !== undefined ? { featureDir: opts.featureDir } : {}),
            dryRun: false,
            useBatch: true,
            statusFile: statusFilePath,
            logFilePath,
            formatterMode: "normal",
            headless: true,
            skipPrecheck: false,
            // Force auto-resume — that's what `nax resume` means, and this is
            // the only seam the runner still reads it from.
            resumeMode: "auto",
            // Pin the same id so the runner doesn't generate a second one
            // (and so the resumed run's status.json reads back the same id
            // it logs under — AC-7 + AC-9).
            runId,
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
