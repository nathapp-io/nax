import type { FindingTrigger } from "@/workflow/blocking-findings";
import type { ConfiguredModel } from "./schema-types";

export interface BotModelsConfig {
  /** Human reply interpretation model; defaults to fast without workflow/finish fallback. */
  rulings?: ConfiguredModel;
  /** Instruction-file check extraction model; defaults to fast. */
  checks?: ConfiguredModel;
  /** Falls back to workflow.models.branchReview, then finish.reviewers.quality. */
  review?: ConfiguredModel;
  /** Falls back to workflow.models.branchFix, then finish.reviewers.fix. */
  fix?: ConfiguredModel;
}

export interface BotConfig {
  gateRepairRounds?: number;
  costLimit?: number;
  /**
   * US-002: the finding trigger classes that can hold readiness. Absent (or empty) reads
   * `DEFAULT_BLOCKING_TRIGGERS`; read it only through `configuredBlockingTriggers(config)`,
   * because `NaxConfig.bot` itself is optional.
   */
  blockingTriggers?: readonly FindingTrigger[];
  /**
   * US-002: the finding generation at which the fix summary reports a fix-induced chain.
   * Absent reads `DEFAULT_CHAIN_NOTICE_GENERATION`; read it only through
   * `configuredChainNoticeGeneration(config)`.
   */
  chainNoticeGeneration?: number;
  models: BotModelsConfig;
}
