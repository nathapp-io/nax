/**
 * Barrel for the loop-event seam (spec 4.5): the single-file `loop-events.ts`
 * module became a directory, and this re-exports every name it exported, so
 * no importer churns.
 */
export { type BuildToolResultArgs, buildToolResult, type DenialInfo, type ToolResultMessage } from "../tool-result";
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
