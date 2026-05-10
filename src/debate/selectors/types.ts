/**
 * Selector strategy contract types.
 */

import type { IAgentManager } from "@/agents";
import type { ReviewerSession } from "../../review/dialogue";
import type { ResolverContextInput, SuccessfulProposal } from "../session-helpers";
import type { DebateConfig, DebateStageConfig, Debater } from "../types";

export interface SelectorContext {
  readonly storyId: string;
  readonly stage: string;
  readonly stageConfig: DebateStageConfig;
  readonly config: DebateConfig;
  readonly proposals: SuccessfulProposal[];
  readonly critiques: string[];
  readonly workdir: string;
  readonly featureName: string;
  readonly timeoutMs: number;
  readonly agentManager: IAgentManager;
  readonly reviewerSession?: ReviewerSession;
  readonly resolverContextInput?: ResolverContextInput;
  readonly promptSuffix?: string;
  readonly debaters: Debater[];
}

export interface SelectorResult {
  readonly outcome: "passed" | "failed" | "skipped";
  readonly output?: string;
  readonly resolverCostUsd: number;
  /** Optional findings from the selector — consumed by post-debate verifiers (e.g. review-grounding-filter). */
  readonly findings?: unknown[];
}

export type Selector = (ctx: SelectorContext) => Promise<SelectorResult>;
