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
