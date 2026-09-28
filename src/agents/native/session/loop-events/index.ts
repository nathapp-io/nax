/**
 * Barrel for the loop-event seam (spec 4.5): the single-file `loop-events.ts`
 * module became a directory, and this re-exports every name it exported, so
 * no importer churns.
 */
export { type BuildToolResultArgs, buildToolResult, type DenialInfo, type ToolResultMessage } from "../tool-result";
/**
 * The external-handler surface (US-002). It is re-exported rather than reached
 * through `./external-handler` because `check:alias-internals` rejects a VALUE
 * import of `@/<dir>/<internal>` from `src/`, so the barrel is the only route
 * US-003's installer and US-004's delivery code can take. Identity matters:
 * `_externalHandlerDeps` is the object the wrapper reads at dispatch time.
 */
export { _externalHandlerDeps, LOOP_HANDLER_TIMEOUT_MS, wrapExternalHandler } from "./external-handler";
export { createLoopEventRegistry, LOOP_EVENTS, type LoopEventRegistry } from "./registry";
export type {
  AfterToolPatch,
  AfterToolPayload,
  BeforeToolOutcome,
  CompleteCallOptions,
  ExternalHandlerOf,
  LoopHandlerContext,
  LoopHandlerEntry,
  LoopHandlerSet,
} from "./types";
