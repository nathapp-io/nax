/**
 * Curator Plugin Path Resolution
 *
 * Resolves output paths for observations and proposals.
 */

import type { CuratorPostRunContext } from "./types";

export interface CuratorOutputs {
  observationsPath: string;
  proposalsPath: string;
  rollupPath: string;
}

/**
 * Resolve curator output paths for a given run context.
 *
 * @param context - Extended post-run context with curator fields
 * @returns Paths for observations, proposals, and rollup files
 */
export function resolveCuratorOutputs(context: CuratorPostRunContext): CuratorOutputs {
  const runDir = `${context.outputDir}/runs/${context.runId}`;
  return {
    observationsPath: `${runDir}/observations.jsonl`,
    proposalsPath: `${runDir}/proposals.jsonl`,
    rollupPath: context.curatorRollupPath,
  };
}
