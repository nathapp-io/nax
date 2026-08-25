/**
 * Selector strategy contract types.
 */

import type { IAgentManager } from "@/agents";
import type { DebateConfig as DebateSelectorConfig } from "@/config/selectors";
import type { CallContext } from "@/operations/types";
import type { SuccessfulProposal } from "../session-helpers";
import type { Debater, DebateStageConfig } from "../types";

export interface SelectorContext {
  readonly storyId: string;
  readonly stage: string;
  readonly stageConfig: DebateStageConfig;
  readonly config: DebateSelectorConfig;
  readonly proposals: SuccessfulProposal[];
  readonly critiques: string[];
  readonly workdir: string;
  readonly featureName: string;
  readonly timeoutMs: number;
  readonly agentManager: IAgentManager;
  readonly promptSuffix?: string;
  readonly debaters: Debater[];
  readonly callContext: CallContext;
}

export interface SelectorResult {
  readonly outcome: "passed" | "failed" | "skipped";
  readonly output?: string;
  /** Optional findings from the selector — consumed by post-debate verifiers (e.g. review-grounding-filter). */
  readonly findings?: unknown[];
}

export type Selector = (ctx: SelectorContext) => Promise<SelectorResult>;
