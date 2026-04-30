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
  validateInteractionId,
} from "./state";
export type { RunState } from "./state";

// Plugins
export { CLIInteractionPlugin } from "./plugins/cli";
export { TelegramInteractionPlugin } from "./plugins/telegram";
export { WebhookInteractionPlugin } from "./plugins/webhook";
export { AutoInteractionPlugin } from "./plugins/auto";

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
export type { TriggerContext, InteractionConfig } from "./triggers";

// Initialization
export { initInteractionChain } from "./init";
export { buildInteractionBridge } from "./bridge-builder";
export type { InteractionBridge, BridgeContext } from "./bridge-builder";
