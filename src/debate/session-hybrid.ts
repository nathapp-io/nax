/**
 * session-hybrid.ts
 *
 * runHybrid() implementation for hybrid-mode debate sessions.
 * Proposal round runs all debaters in parallel via allSettledBounded.
 * The rebuttal loop is implemented in US-004-B.
 */

import type { NaxConfig } from "../config";
import type { DebateResult, DebateStageConfig } from "./types";

export interface HybridCtx {
  readonly storyId: string;
  readonly stage: string;
  readonly stageConfig: DebateStageConfig;
  readonly config: NaxConfig | undefined;
  readonly workdir: string;
  readonly featureName: string;
  readonly timeoutSeconds: number;
}

/**
 * Run a hybrid-mode debate session.
 *
 * Proposal phase: all debaters run in parallel via allSettledBounded with
 * sessionRole 'debate-hybrid-{debaterIndex}' and keepSessionOpen: true.
 * If fewer than 2 proposals succeed, returns the single-agent fallback result.
 * The rebuttal loop is a stub (TODO: implement in US-004-B).
 *
 * @param ctx    - Hybrid session context
 * @param prompt - The debate prompt
 */
export async function runHybrid(ctx: HybridCtx, prompt: string): Promise<DebateResult> {
  throw new Error("Not implemented");
}
