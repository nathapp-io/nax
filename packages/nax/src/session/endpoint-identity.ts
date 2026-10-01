/**
 * Should an open request reuse the live handle cached under its session name?
 *
 * Its own module because `manager.ts` is a grandfathered oversized file that may
 * not grow, and because the decision is pure over its inputs — which is what makes
 * it testable without a SessionManager, an adapter, or a descriptor store.
 *
 * nax#1965: the cache was keyed on session name + agent name only, so a same-agent
 * hop (a `{agent: native, tier: powerful}` fallback rung, or an op inheriting a
 * story's sticky endpoint) got back the handle the PREVIOUS endpoint opened and
 * dispatched that model. A cross-agent hop escaped only because the agent name
 * differed — which is why the defect looked transport-specific in the field.
 */

import type { SessionHandle } from "../agents/session-types";
import type { ModelDef } from "../config/schema-types";
import type { SessionDescriptor } from "./types";

export type ReuseDecision =
  /** Serve the cached handle — same agent, same endpoint, session still live. */
  | "reuse"
  /** Tear the live session down first: a different agent or a different endpoint. */
  | "close-then-reopen"
  /** Nothing live to tear down (or the adapter session is already gone). */
  | "reopen";

/**
 * Endpoint identity is provider + model id. `pricing`, `contextWindow` and `env`
 * are attribution/transport metadata that two dispatches to the same endpoint may
 * legitimately differ on. An absent `modelDef` never matches a present one: an
 * unrecorded endpoint is unknown, not equal.
 */
export function sameEndpoint(a: ModelDef | undefined, b: ModelDef | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return a.provider === b.provider && a.model === b.model;
}

export function decideReuse(
  live: SessionHandle | undefined,
  descriptor: SessionDescriptor | undefined,
  requested: { readonly agentName: string; readonly modelDef: ModelDef },
): ReuseDecision {
  if (!live) return "reopen";
  // Terminal descriptor: `keepOpen` left the handle cached but closeSession already
  // ran, so the adapter session is gone. Drop the handle, do NOT close it again.
  if (descriptor && (descriptor.state === "COMPLETED" || descriptor.state === "FAILED")) return "reopen";
  if (live.agentName !== requested.agentName) return "close-then-reopen";
  return sameEndpoint(live.modelDef, requested.modelDef) ? "reuse" : "close-then-reopen";
}
