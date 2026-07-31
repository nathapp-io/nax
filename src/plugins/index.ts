/**
 * Plugin System — Public API
 *
 * Exports all plugin types, interfaces, and loading utilities.
 */

export type {
  NaxPlugin,
  PluginType,
  PluginExtensions,
  PluginConfigEntry,
  PluginLogger,
  IReviewPlugin,
  ReviewCheckResult,
  IContextProvider,
  ContextProviderResult,
  IReporter,
  RunStartEvent,
  StoryCompleteEvent,
  RunEndEvent,
  IPostRunAction,
  PostRunContext,
  PostRunActionResult,
} from "./types";

// Re-export optimizer types from optimizer module (via types.ts)
export type {
  IPromptOptimizer,
  PromptOptimizerInput,
  PromptOptimizerResult,
} from "./types";

export { validatePlugin } from "./validator";
export { loadPlugins } from "./loader";
export { PluginRegistry, type PostRunActionRegistration } from "./registry";
export { createPluginLogger } from "./plugin-logger";

// Built-in auto-route plugin (US-005) — exposed for test injection (`_autoRouteDeps`)
export { autoRoutePlugin, _autoRouteDeps } from "./builtin/auto-route";
export type { AutoRouteDeps } from "./builtin/auto-route/types";

// Built-in reporter helpers (Task 2)
export { interpolateHeaders, postJson, _postJsonDeps } from "./builtin/reporter-shared";
export type { PostJsonDeps } from "./builtin/reporter-shared";

// Built-in webhook-reporter plugin (Task 3)
export { createWebhookReporterPlugin } from "./builtin/webhook-reporter";

// Built-in otel-reporter plugin (Task 5)
export { createOtelReporterPlugin } from "./builtin/otel-reporter";

// OTLP log encoder used by the otel-reporter (US-004)
export { buildLogsPayload, toLogRecord } from "./builtin/otel-reporter/logs";
export type { LogRecord, LogsResourceInput } from "./builtin/otel-reporter/logs";

// Built-in nax-finish post-run action (Task 8) — exposed for test injection (`_naxFinishDeps`)
export { naxFinishPlugin, _naxFinishDeps, buildFlowArgv, resolveFlowPath } from "./builtin/nax-finish";
export { getFinishAutoFlowConfig, isTelegramConfigured, telegramCreds } from "./builtin/nax-finish/config";
