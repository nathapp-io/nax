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
  models: BotModelsConfig;
}
