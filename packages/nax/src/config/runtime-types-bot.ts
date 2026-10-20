import type { ConfiguredModel } from "./schema-types";

export interface BotModelsConfig {
  /** Falls back to workflow.models.branchReview, then finish.reviewers.quality. */
  review?: ConfiguredModel;
  /** Falls back to workflow.models.branchFix, then finish.reviewers.fix. */
  fix?: ConfiguredModel;
}

export interface BotConfig {
  models: BotModelsConfig;
}
