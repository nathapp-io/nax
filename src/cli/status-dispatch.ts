/**
 * Status View Dispatch
 *
 * Routes `nax status` flag combinations to the right view function. JSON mode
 * (`--cost --json`) wins over `--last` and `--model` because the JSON report
 * always includes aggregate, last-run, and model-efficiency sections.
 *
 * Pure routing logic — every view function is injected so tests can assert
 * the exact call shape without touching the filesystem or stdout.
 */

import chalk from "chalk";
import type { Command } from "commander";
import { findProjectDir, validateDirectory } from "../config";
import type { FeatureStatusOptions } from "./status-features";

/** CLI options parsed from commander for `nax status`. */
export interface StatusViewOptions {
  cost?: boolean;
  json?: boolean;
  last?: boolean;
  model?: boolean;
  feature?: string;
  dir?: string;
}

/** Swappable view functions — keeps the dispatcher hermetic for tests. */
export interface StatusViewDeps {
  displayCostMetrics: (workdir: string) => Promise<void>;
  displayLastRunMetrics: (workdir: string) => Promise<void>;
  displayModelEfficiency: (workdir: string) => Promise<void>;
  emitCostReportJson: (workdir: string) => Promise<void>;
  displayFeatureStatus: (options: FeatureStatusOptions) => Promise<void>;
}

export const _statusViewDeps: StatusViewDeps = {
  displayCostMetrics: async (workdir: string) => {
    const { displayCostMetrics } = await import("./status-cost");
    await displayCostMetrics(workdir);
  },
  displayLastRunMetrics: async (workdir: string) => {
    const { displayLastRunMetrics } = await import("./status-cost");
    await displayLastRunMetrics(workdir);
  },
  displayModelEfficiency: async (workdir: string) => {
    const { displayModelEfficiency } = await import("./status-cost");
    await displayModelEfficiency(workdir);
  },
  emitCostReportJson: async (workdir: string) => {
    const { emitCostReportJson } = await import("./status-cost");
    await emitCostReportJson(workdir);
  },
  displayFeatureStatus: async (options: FeatureStatusOptions) => {
    const { displayFeatureStatus } = await import("./status-features");
    await displayFeatureStatus(options);
  },
};

/**
 * Route `nax status` flags to the appropriate view function. JSON mode wins
 * over `--last`/`--model`; otherwise the cost-mode flags branch into the
 * human view functions; otherwise the feature-status view runs.
 */
export async function dispatchStatusView(
  workdir: string,
  options: StatusViewOptions,
  deps: StatusViewDeps = _statusViewDeps,
): Promise<void> {
  if (options.cost && options.json) {
    await deps.emitCostReportJson(workdir);
    return;
  }
  if (options.cost) {
    if (options.last) {
      await deps.displayLastRunMetrics(workdir);
      return;
    }
    if (options.model) {
      await deps.displayModelEfficiency(workdir);
      return;
    }
    await deps.displayCostMetrics(workdir);
    return;
  }
  const featureOpts: FeatureStatusOptions = {
    ...(options.feature !== undefined ? { feature: options.feature } : {}),
    ...(options.dir !== undefined ? { dir: options.dir } : {}),
  };
  await deps.displayFeatureStatus(featureOpts);
}

/**
 * Status command action dependencies. The action calls into the dispatcher
 * with a stable `StatusViewOptions` shape and forwards failures to stderr +
 * exit(1). The action is injectable so commander-level tests can assert the
 * exact dispatch behavior without touching the filesystem or `process.exit`.
 */
export interface StatusCommandActionDeps {
  validateDirectory: (dir: string) => string;
  findProjectDir: (workdir: string) => string | null;
  dispatchStatusView: typeof dispatchStatusView;
}

export const _statusCommandActionDeps: StatusCommandActionDeps = {
  validateDirectory,
  findProjectDir,
  dispatchStatusView,
};

/**
 * Run the `status` subcommand action against the dispatcher. Extracted so
 * commander-level tests can exercise the real bin/nax.ts wiring (including
 * the new `--json` option) without spinning up a child process.
 */
export async function runStatusAction(
  options: {
    cost?: boolean;
    json?: boolean;
    last?: boolean;
    model?: boolean;
    feature?: string;
    dir?: string;
  },
  deps: StatusCommandActionDeps = _statusCommandActionDeps,
): Promise<void> {
  const workdir = deps.validateDirectory(options.dir ?? process.cwd());
  const naxDir = deps.findProjectDir(workdir);
  if (!naxDir) {
    process.stderr.write(`${chalk.red("nax not initialized.")}\n`);
    process.exit(1);
  }
  await deps.dispatchStatusView(workdir, {
    cost: options.cost === true,
    json: options.json === true,
    last: options.last === true,
    model: options.model === true,
    ...(options.feature !== undefined ? { feature: options.feature } : {}),
    ...(options.dir !== undefined ? { dir: options.dir } : {}),
  });
}

/**
 * Register the `status` subcommand on a commander `Command` instance.
 *
 * The option surface mirrors what `bin/nax.ts` exposes; the action delegates
 * to `runStatusAction` so the routing logic is independently testable.
 */
export function registerStatusCommand(
  program: Command,
  deps: StatusCommandActionDeps = _statusCommandActionDeps,
): void {
  program
    .command("status")
    .description("Show current run status")
    .option("-f, --feature <name>", "Feature name")
    .option("-d, --dir <path>", "Project directory", process.cwd())
    .option("--cost", "Show cost metrics across all runs", false)
    .option("--last", "Show last run metrics (requires --cost)", false)
    .option("--model", "Show per-model efficiency (requires --cost)", false)
    .option("-j, --json", "Emit cost report as JSON (requires --cost)", false)
    .action(
      async (options: {
        cost?: boolean;
        json?: boolean;
        last?: boolean;
        model?: boolean;
        feature?: string;
        dir?: string;
      }) => {
        try {
          await runStatusAction(options, deps);
        } catch (err) {
          process.stderr.write(`${chalk.red(`Error: ${(err as Error).message}`)}\n`);
          process.exit(1);
        }
      },
    );
}
