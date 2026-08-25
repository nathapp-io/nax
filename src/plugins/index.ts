/**
 * Plugin System — Public API
 *
 * Exports all plugin types, interfaces, and loading utilities.
 */

// Built-in auto-route plugin (US-005) — exposed for test injection (`_autoRouteDeps`)
export { _autoRouteDeps, autoRoutePlugin } from "./builtin/auto-route";
export type { AutoRouteDeps } from "./builtin/auto-route/types";
// Built-in otel-reporter plugin (Task 5)
export { createOtelReporterPlugin } from "./builtin/otel-reporter";
export type { LogRecord, LogsResourceInput } from "./builtin/otel-reporter/logs";
// OTLP log encoder used by the otel-reporter (US-004)
export { buildLogsPayload, toLogRecord } from "./builtin/otel-reporter/logs";
export type { PostJsonDeps } from "./builtin/reporter-shared";
// Built-in reporter helpers (Task 2)
export { _postJsonDeps, interpolateHeaders, postJson } from "./builtin/reporter-shared";
// Built-in webhook-reporter plugin (Task 3)
export { createWebhookReporterPlugin } from "./builtin/webhook-reporter";
export { loadPlugins } from "./loader";
export { createPluginLogger } from "./plugin-logger";
export { PluginRegistry, type PostRunActionRegistration } from "./registry";
// Re-export optimizer types from optimizer module (via types.ts)
export type {
  ContextProviderResult,
  IContextProvider,
  IPostRunAction,
  IPromptOptimizer,
  IReporter,
  IReviewPlugin,
  NaxPlugin,
  PluginConfigEntry,
  PluginExtensions,
  PluginLogger,
  PluginType,
  PostRunActionResult,
  PostRunContext,
  PromptOptimizerInput,
  PromptOptimizerResult,
  ReviewCheckResult,
  RunEndEvent,
  RunStartEvent,
  StoryCompleteEvent,
} from "./types";
export { validatePlugin } from "./validator";
