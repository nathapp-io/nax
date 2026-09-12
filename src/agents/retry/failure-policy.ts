/**
 * The single source of truth for what an AdapterFailure decides.
 *
 * Before this table, four decisions were spread across four modules and keyed
 * on `AdapterFailure.category` — a two-value field asked to carry more cases
 * than it has values. Two rows were therefore written to steer behaviour
 * rather than describe the fault: `fail-timeout` filed `quality` purely to
 * dodge pruning (nax#1371), and a context overflow filed `availability` though
 * nothing was down. Keying on `outcome` removes the motive for both.
 *
 * `category` is now an observability tag only. Nothing here reads it.
 */

import type { AdapterFailure } from "@/context/engine";

/** How long an agent stays excluded after a failure. */
export type FailureCooldown = "none" | "run" | { readonly ms: number };

export interface FailurePolicy {
  /** Which same-agent retry lane in `trySameAgentRetry` admits this failure. */
  readonly sameAgentRetry: "none" | "stale" | "timeout" | "adapter-error";
  /**
   * Swap eligibility. `after-retry-lane` documents an invariant rather than
   * adding a check: `trySameAgentRetry` runs before `decideSwap` and returns
   * null once its lane is spent, so the lane is spent by construction by the
   * time the swap decision sees the failure. Do not add a second flag.
   */
  readonly swap: "never" | "immediate" | "after-retry-lane" | "quality-gated";
  readonly cooldown: FailureCooldown;
  /**
   * What the cooldown applies to. `"agent"` is a fault of the agent itself —
   * credentials, an exhausted account quota — which every model it serves shares,
   * so parking one tier while its siblings look healthy only buys a second
   * identical failure. `"model"` is a fault of the model/provider actually
   * dispatched (a 429, that provider being down), which says nothing about the
   * agent's other models. Read by `CooldownStore` to choose the entry's key.
   */
  readonly cooldownScope: "agent" | "model";
  /** Whether `resolveExhaustion` consults the retry strategy on a terminal exit. */
  readonly terminalBackoff: boolean;
}

/**
 * Default cooldown for a transient availability failure. Not a retry delay --
 * nothing sleeps on it, so it is not a `RetryStrategy` concern and must never
 * be passed to `_agentManagerDeps.sleep`.
 */
const TRANSIENT_COOLDOWN_MS = 60_000;

/**
 * Exhaustive over the outcome union — the compiler rejects a new outcome that
 * forgets a row here, which is the point of the Record type.
 */
const POLICIES: Readonly<Record<AdapterFailure["outcome"], FailurePolicy>> = Object.freeze({
  "fail-auth": {
    sameAgentRetry: "none",
    swap: "immediate",
    cooldown: "run",
    cooldownScope: "agent",
    terminalBackoff: false,
  },
  "fail-quota": {
    sameAgentRetry: "none",
    swap: "immediate",
    cooldown: "run",
    cooldownScope: "agent",
    terminalBackoff: false,
  },
  "fail-rate-limit": {
    sameAgentRetry: "none",
    swap: "immediate",
    cooldown: { ms: TRANSIENT_COOLDOWN_MS },
    cooldownScope: "model",
    terminalBackoff: true,
  },
  "fail-service-down": {
    sameAgentRetry: "adapter-error",
    swap: "immediate",
    cooldown: { ms: TRANSIENT_COOLDOWN_MS },
    cooldownScope: "model",
    terminalBackoff: true,
  },
  "fail-stale": {
    sameAgentRetry: "stale",
    swap: "immediate",
    cooldown: { ms: TRANSIENT_COOLDOWN_MS },
    cooldownScope: "model",
    terminalBackoff: true,
  },
  "fail-timeout": {
    sameAgentRetry: "timeout",
    swap: "after-retry-lane",
    cooldown: "none",
    cooldownScope: "model",
    terminalBackoff: false,
  },
  /**
   * Reuses the `timeout` lane rather than inventing a third: that lane already
   * does exactly what a spin wants — same agent, FRESH session (so the
   * repeating transcript is dropped) at a reduced budget, then a swap once the
   * lane is spent. `trySameAgentRetry` dispatches on the lane, not the
   * outcome, so this needs no new retry machinery (nax#2013).
   */
  "fail-spin": {
    sameAgentRetry: "timeout",
    swap: "after-retry-lane",
    cooldown: "none",
    cooldownScope: "model",
    terminalBackoff: false,
  },
  "fail-adapter-error": {
    sameAgentRetry: "adapter-error",
    swap: "quality-gated",
    cooldown: "none",
    cooldownScope: "model",
    terminalBackoff: false,
  },
  "fail-quality": {
    sameAgentRetry: "none",
    swap: "quality-gated",
    cooldown: "none",
    cooldownScope: "model",
    terminalBackoff: false,
  },
  "fail-unknown": {
    sameAgentRetry: "none",
    swap: "quality-gated",
    cooldown: "none",
    cooldownScope: "model",
    terminalBackoff: false,
  },
  "fail-aborted": {
    sameAgentRetry: "none",
    swap: "never",
    cooldown: "none",
    cooldownScope: "model",
    terminalBackoff: false,
  },
});

export function failurePolicyFor(outcome: AdapterFailure["outcome"]): FailurePolicy {
  return POLICIES[outcome];
}

/**
 * Resolve a cooldown to an absolute expiry, honouring the provider's own
 * recovery time when it supplied one. A provider asking for 300s parks the
 * agent for 300s rather than the table constant.
 *
 * Invalid provider values (negative, NaN, Infinity) fall back to the constant,
 * mirroring the guard `defaultRetryStrategy` already applies.
 */
export function resolveCooldownExpiry(failure: AdapterFailure, now: number): number | "run" | null {
  const { cooldown } = failurePolicyFor(failure.outcome);
  if (cooldown === "none") return null;
  if (cooldown === "run") return "run";
  const retryAfter = failure.retryAfterSeconds;
  const fromProvider =
    retryAfter !== undefined && Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter * 1000 : undefined;
  return now + (fromProvider ?? cooldown.ms);
}
