/**
 * Selector strategy contract types.
 */

import type { IAgentManager } from "@/agents";
import type { DebateConfig as DebateSelectorConfig } from "@/config/selectors";
import type { CallContext } from "@/operations/types";
import type { ReviewDialogueResult, ReviewerSession } from "@/review/dialogue";
import type { ResolverContext, ResolverContextInput, SuccessfulProposal } from "../session-helpers";
import type { DebateStageConfig, Debater } from "../types";

export interface SelectorContext {
  readonly storyId: string;
  readonly stage: string;
  readonly stageConfig: DebateStageConfig;
  readonly config: DebateSelectorConfig;
  readonly proposals: SuccessfulProposal[];
  readonly labeledProposals?: ResolverContext["labeledProposals"];
  readonly critiques: string[];
  readonly workdir: string;
  readonly featureName: string;
  readonly timeoutMs: number;
  readonly agentManager: IAgentManager;
  readonly reviewerSession?: ReviewerSession;
  readonly resolverContextInput?: ResolverContextInput;
  readonly promptSuffix?: string;
  readonly debaters: Debater[];
  readonly callContext: CallContext;
}

export interface SelectorResult {
  readonly outcome: "passed" | "failed" | "skipped";
  readonly output?: string;
  readonly resolverCostUsd: number;
  /** Optional findings from the selector — consumed by post-debate verifiers (e.g. review-grounding-filter). */
  readonly findings?: unknown[];
  /** Structured dialogue result from ReviewerSession resolver (debate+dialogue mode only). */
  readonly dialogueResult?: ReviewDialogueResult;
}

export type Selector = (ctx: SelectorContext) => Promise<SelectorResult>;
