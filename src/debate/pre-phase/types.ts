/**
 * Pre-debate phase strategy contract types.
 */

import type { CallContext } from "@/operations/types";
import type { DebateStageConfig } from "../types";

export interface PreDebatePhaseContext {
  readonly ctx: CallContext;
  readonly stage: string;
  readonly stageConfig: DebateStageConfig;
  readonly workdir: string;
  readonly featureName: string;
  readonly storyId: string;
  readonly specContent?: string;
}

export interface PreDebatePhaseResult {
  readonly manifestSection: string;
  readonly costUsd: number;
}

export type PreDebatePhase = (ctx: PreDebatePhaseContext) => Promise<PreDebatePhaseResult>;
