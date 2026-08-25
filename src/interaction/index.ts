/**
 * Interaction System — Barrel Exports (v0.15.0)
 */

export type { BridgeContext, InteractionBridge } from "./bridge-builder";
export { buildInteractionBridge } from "./bridge-builder";
export type { ChainConfig } from "./chain";
// Chain
export { InteractionChain } from "./chain";
// Initialization
export { initInteractionChain } from "./init";
// Plugins
export { CLIInteractionPlugin } from "./plugins/cli";
export { _telegramPluginDeps, TelegramInteractionPlugin } from "./plugins/telegram";
export { normalizeChatId } from "./plugins/telegram-config";
export {
  buildBody,
  buildHeader,
  buildKeyboard,
  getStageEmoji,
  type InlineKeyboard,
  MAX_MESSAGE_CHARS,
  sanitizeMarkdown,
  splitText,
  TELEGRAM_CALLBACK_DATA_MAX_BYTES,
  truncateIdForCallbackData,
  truncateUtf8Bytes,
} from "./plugins/telegram-format";
export { WebhookInteractionPlugin } from "./plugins/webhook";
export type { TriggerContext } from "./triggers";
// Triggers
export {
  checkCostExceeded,
  checkCostWarning,
  checkMaxRetries,
  checkMergeConflict,
  checkPreMerge,
  checkReviewGate,
  checkSecurityReview,
  createTriggerRequest,
  executeTrigger,
  isTriggerEnabled,
} from "./triggers";
// Types
export type {
  InteractionAction,
  InteractionFallback,
  InteractionPlugin,
  InteractionRequest,
  InteractionResponse,
  InteractionStage,
  InteractionType,
  TriggerConfig,
  TriggerMetadata,
  TriggerName,
  TriggerSafety,
} from "./types";
export { TRIGGER_METADATA } from "./types";
