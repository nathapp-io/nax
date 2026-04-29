import type { IAgentManager } from "../agents";
import type { ISessionManager } from "../session";
import type { NaxRuntime } from "./index";

/**
 * Base contract for any context that dispatches agent work. Required fields
 * mean every consumer (pipeline stage, operation, lifecycle, CLI command,
 * routing, debate, review, acceptance, plan) must thread these by
 * construction. Closes the wrapAdapterAsManager-fallback class structurally
 * (wrapAdapterAsManager was previously exported from src/agents/utils.ts and
 * deleted in ADR-020 Wave 2): there is nowhere a nullable agentManager exists
 * in code that dispatches.
 *
 * Future cross-cutting fields (e.g. traceId, resolvedPermissions slice,
 * packageId) go here once; the compiler then surfaces every consumer that
 * must thread them.
 *
 * @see docs/adr/ADR-020-dispatch-boundary-ssot.md §D3
 */
export interface DispatchContext {
  readonly agentManager: IAgentManager;
  readonly sessionManager: ISessionManager;
  readonly runtime: NaxRuntime;
  readonly abortSignal: AbortSignal;
}
