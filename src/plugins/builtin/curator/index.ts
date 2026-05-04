/**
 * Curator Plugin — Built-in Post-Run Action
 *
 * Collects observations from run artifacts and writes observations.jsonl.
 */

import type { IPostRunAction, PluginLogger, PostRunActionResult, PostRunContext } from "../../types";
import type { NaxPlugin } from "../../types";
import { collectObservations } from "./collect";
import { resolveCuratorOutputs } from "./paths";
import type { CuratorPostRunContext } from "./types";

const PLUGIN_NAME = "nax-curator";
const PLUGIN_VERSION = "0.1.0";

/**
 * Curator post-run action implementation.
 */
const curatorAction: IPostRunAction = {
  name: PLUGIN_NAME,
  description: "Collects observations from run artifacts for curator aggregation",

  /**
   * Determine whether curator should run.
   *
   * Curator runs when:
   * - curator.enabled is not explicitly false
   * - At least one story completed
   *
   * Warns if review.audit.enabled is false.
   */
  async shouldRun(context: PostRunContext): Promise<boolean> {
    // TODO: Implement shouldRun logic
    // - Check config.curator.enabled !== false
    // - Check context.storySummary.completed > 0
    // - Warn if config.review.audit.enabled is false
    return false;
  },

  /**
   * Execute curator collection.
   *
   * Collects observations and writes observations.jsonl.
   * Never throws — logs warnings for missing sources.
   */
  async execute(context: PostRunContext): Promise<PostRunActionResult> {
    // TODO: Implement execute logic
    // - Cast context to CuratorPostRunContext
    // - Call collectObservations()
    // - Resolve output paths
    // - Write observations.jsonl
    // - Return success or failure result
    return {
      success: false,
      message: "Not implemented",
    };
  },
};

/**
 * Built-in curator plugin.
 */
export const curatorPlugin: NaxPlugin = {
  name: PLUGIN_NAME,
  version: PLUGIN_VERSION,
  provides: ["post-run-action"],

  async setup(_config: Record<string, unknown>, _logger: PluginLogger): Promise<void> {
    // TODO: Initialize curator plugin if needed
  },

  async teardown(): Promise<void> {
    // TODO: Cleanup if needed
  },

  extensions: {
    postRunAction: curatorAction,
  },
};

// Re-export types for use in tests and other modules
export type {
  CuratorPostRunContext,
  Observation,
  ChunkIncludedObservation,
  ChunkExcludedObservation,
  ProviderEmptyObservation,
  ReviewFindingObservation,
  RectifyCycleObservation,
  EscalationObservation,
  AcceptanceVerdictObservation,
  PullCallObservation,
  CoChangeObservation,
  VerdictObservation,
  FixCycleIterationObservation,
  FixCycleExitObservation,
  FixCycleValidatorRetryObservation,
} from "./types";
export { collectObservations, resolveCuratorOutputs };
