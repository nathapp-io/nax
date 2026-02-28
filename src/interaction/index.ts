/**
 * Interaction System — Barrel Exports (v0.15.0)
 */

// Types
export type {
  InteractionType,
  InteractionStage,
  InteractionFallback,
  InteractionRequest,
  InteractionAction,
  InteractionResponse,
  InteractionPlugin,
  TriggerName,
  TriggerConfig,
  TriggerSafety,
  TriggerMetadata,
} from "./types";
export { TRIGGER_METADATA } from "./types";

// Chain
export { InteractionChain } from "./chain";
export type { ChainConfig } from "./chain";

// State persistence
export {
  serializeRunState,
  deserializeRunState,
  clearRunState,
  savePendingInteraction,
  loadPendingInteraction,
  deletePendingInteraction,
  listPendingInteractions,
} from "./state";
export type { RunState } from "./state";

// CLI plugin
export { CLIInteractionPlugin } from "./plugins/cli";

// Triggers
export {
  isTriggerEnabled,
  createTriggerRequest,
  executeTrigger,
  checkSecurityReview,
  checkCostExceeded,
  checkMergeConflict,
  checkCostWarning,
  checkMaxRetries,
  checkPreMerge,
  checkStoryAmbiguity,
  checkReviewGate,
} from "./triggers";
export type { TriggerContext } from "./triggers";
