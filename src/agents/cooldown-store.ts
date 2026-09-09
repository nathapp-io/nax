/**
 * Agent availability with an expiry.
 *
 * Replaces the permanent `Map<string, AdapterFailure>` that `markUnavailable`
 * used to write. That map conflated two meanings — "skip this agent for this
 * hop selection" and "retire this agent" — which is why nax#1371 could not let
 * a wall-clock timeout swap without poisoning the pool. Hop-local exclusion is
 * now an explicit argument to `nextCandidate`; this store owns only retirement,
 * and retirement has a duration.
 *
 * Cooldowns are advisory and evaluated on read, so no sweep is required for
 * correctness. `sweepTransient` exists for the story boundary, where the old
 * `resetTransientUnavailable` contract has to be preserved.
 */

import type { AdapterFailure } from "@/context/engine";
import { resolveCooldownExpiry } from "./retry/failure-policy";

/** `"run"` means no expiry — cleared only by a story-boundary sweep or `clear()`. */
interface CooldownEntry {
  readonly failure: AdapterFailure;
  readonly expiresAt: number | "run";
}

export class CooldownStore {
  private readonly _entries = new Map<string, CooldownEntry>();

  constructor(private readonly _now: () => number) {}

  /**
   * Records a cooldown. A policy cooldown of `none` records nothing.
   *
   * `tier` scopes the cooldown to that tier's identity rather than the whole
   * agent. On the native path the provider lives in the model id string
   * (`models.native.<tier>`), so one tier's rate-limit must not park every
   * other tier of the same agent — those point at unrelated providers.
   *
   * `modelId`, when the caller can resolve one, scopes it narrower still: two
   * tiers that resolve to the SAME model (e.g. `fast` and `balanced` both
   * pointing at one minimax entry) must share one cooldown, or a rate-limit on
   * one tier leaves the other looking healthy while it dispatches to the same
   * dead provider. Preferred over `tier` when given; falls back to the
   * tier/agent key otherwise, so an unresolvable model degrades to the
   * pre-existing tier-scoped identity, never to bare-agent.
   */
  mark(agent: string, failure: AdapterFailure, tier?: string, modelId?: string): void {
    const expiresAt = resolveCooldownExpiry(failure, this._now());
    if (expiresAt === null) return;
    this._entries.set(identityKey(agent, tier, modelId), { failure, expiresAt });
  }

  isCooling(agent: string, tier?: string, modelId?: string): boolean {
    return this._live(agent, tier, modelId) !== undefined;
  }

  failureFor(agent: string, tier?: string, modelId?: string): AdapterFailure | undefined {
    return this._live(agent, tier, modelId)?.failure;
  }

  /**
   * Story-boundary sweep: drops every expiring entry, keeps run-long ones.
   * Preserves the contract `resetTransientUnavailable` had when it compared
   * outcomes by hand, but sources the distinction from the policy table.
   */
  sweepTransient(): void {
    for (const [key, entry] of this._entries) {
      if (entry.expiresAt !== "run") this._entries.delete(key);
    }
  }

  clear(): void {
    this._entries.clear();
  }

  /** Returns the entry only while it is still in force; expires it lazily. */
  private _live(agent: string, tier?: string, modelId?: string): CooldownEntry | undefined {
    const key = identityKey(agent, tier, modelId);
    const entry = this._entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt === "run") return entry;
    if (entry.expiresAt > this._now()) return entry;
    this._entries.delete(key);
    return undefined;
  }
}

/**
 * Cooldown identity: the bare agent name, unless a tier or resolved model
 * scopes it narrower. A tier-less, model-less caller (every existing config)
 * keys exactly as before.
 */
function identityKey(agent: string, tier?: string, modelId?: string): string {
  if (modelId) return `${agent}::model::${modelId}`;
  return tier ? `${agent}::${tier}` : agent;
}
