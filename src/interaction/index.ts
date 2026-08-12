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

// Plugins
export { CLIInteractionPlugin } from "./plugins/cli";
export { TelegramInteractionPlugin, _telegramPluginDeps } from "./plugins/telegram";
export { normalizeChatId } from "./plugins/telegram-config";
export {
  MAX_MESSAGE_CHARS,
  TELEGRAM_CALLBACK_DATA_MAX_BYTES,
  buildBody,
  buildHeader,
  buildKeyboard,
  getStageEmoji,
  sanitizeMarkdown,
  splitText,
  truncateIdForCallbackData,
  truncateUtf8Bytes,
  type InlineKeyboard,
} from "./plugins/telegram-format";
export { WebhookInteractionPlugin } from "./plugins/webhook";

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
  checkReviewGate,
} from "./triggers";
export type { TriggerContext } from "./triggers";

// Initialization
export { initInteractionChain } from "./init";
export { buildInteractionBridge } from "./bridge-builder";
export type { InteractionBridge, BridgeContext } from "./bridge-builder";
