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
import type { AuthCooldownStamp } from "./auth-cooldown";
import { providerOf } from "./cooldown-provider";
import { failurePolicyFor, resolveCooldownExpiry } from "./retry/failure-policy";

/** `"run"` means no expiry — cleared only by a story-boundary sweep or `clear()`. */
interface CooldownEntry {
  readonly auth?: AuthCooldownStamp;
  readonly failure: AdapterFailure;
  readonly expiresAt: number | "run";
}

/** The one spelling of the provider slot's namespace; the key and its reader must agree. */
const PROVIDER_SLOT = "::provider::";

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
  mark(agent: string, failure: AdapterFailure, tier?: string, modelId?: string, auth?: AuthCooldownStamp): void {
    const expiresAt = resolveCooldownExpiry(failure, this._now());
    if (expiresAt === null) return;
    // A native auth stamp narrows credential retirement to its provider.
    // Otherwise the policy decides scope, preserving ACP and other failure keys.
    // An agent-scoped fault uses the bare agent name, found from any lookup.
    // A provider-scoped fault (exhausted plan quota) parks every model of that
    // provider; with no provider in the model id it degrades to the bare agent.
    const scope = failurePolicyFor(failure.outcome).cooldownScope;
    const key = auth
      ? providerSlotKey(agent, auth.providerId)
      : scope === "agent"
        ? agent
        : scope === "provider"
          ? providerKey(agent, modelId)
          : identityKey(agent, tier, modelId);
    // One slot per provider, shared by the two marks that key on it: an auth
    // stamp and a provider-scoped fault (`fail-quota`). The key is deliberately
    // the same string — `_live`'s narrowed probe finds the provider's cooldown
    // by it — so an unstamped mark must not erase a stamp it lands on. Were it
    // to, `authCooldowns()` would stop reporting that provider and a re-login
    // could never release it: the run-long park the auth release path exists to
    // undo would survive. The incoming failure and its expiry still win, so the
    // slot always describes the newest fault.
    const stamped = auth ?? this._at(key)?.auth;
    this._entries.set(key, { failure, expiresAt, ...(stamped ? { auth: stamped } : {}) });
  }

  authCooldowns(): readonly { key: string; agent: string; auth: AuthCooldownStamp }[] {
    const entries: { key: string; agent: string; auth: AuthCooldownStamp }[] = [];
    for (const key of this._entries.keys()) {
      const entry = this._at(key);
      if (entry?.auth) entries.push({ key, agent: key.split(PROVIDER_SLOT)[0] ?? key, auth: entry.auth });
    }
    return entries;
  }

  release(key: string): boolean {
    return this._entries.delete(key);
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

  /**
   * Returns the entry only while it is still in force; expires it lazily.
   *
   * Checks the narrow identity first, then the provider key, then the bare agent key — but the bare key
   * counts only when the entry there is itself agent-scoped. An agent-scoped
   * cooldown must block EVERY tier/model of that agent, or the swap re-dispatches
   * the same broken credentials under a different tier name and buys a second
   * identical failure. A MODEL-scoped entry can also land on the bare key (the
   * failing hop named no tier, so there was no narrower identity to record), and
   * that one must NOT blanket the agent: it says one dispatch was rate-limited,
   * not that the agent's other models are unusable. When no tier/model is given
   * the two keys coincide and a tier-less caller reads exactly as it always did.
   */
  private _live(agent: string, tier?: string, modelId?: string): CooldownEntry | undefined {
    const narrow = identityKey(agent, tier, modelId);
    const own = this._at(narrow);
    if (own) return own;
    if (narrow === agent) {
      const stamped = this.authCooldowns().find((entry) => entry.agent === agent);
      return stamped ? this._at(stamped.key) : undefined;
    }
    const provider = providerKey(agent, modelId);
    const byProvider = provider === agent ? undefined : this._at(provider);
    if (byProvider) return byProvider;
    // The bare key blankets the agent for an agent-scoped fault, and for a
    // provider-scoped one that named no provider (it had nothing narrower to key on).
    const agentWide = this._at(agent);
    const scope = agentWide ? failurePolicyFor(agentWide.failure.outcome).cooldownScope : undefined;
    return scope === "agent" || scope === "provider" ? agentWide : undefined;
  }

  /** One key's entry, expired lazily. */
  private _at(key: string): CooldownEntry | undefined {
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

/**
 * The provider's slot, shared on purpose by the two marks that key on it: an
 * auth stamp (`AuthCooldownStamp.providerId`) and a provider-scoped fault
 * (`fail-quota`, via `providerKey`). One slot per provider means one release
 * frees every tier that reaches it, and `_live`'s narrowed probe finds it by
 * this exact key, so the two spellings must not drift apart.
 */
function providerSlotKey(agent: string, providerId: string): string {
  return `${agent}::provider::${providerId}`;
}

/** Provider-scoped cooldown key; the bare agent when the model id names no provider. */
function providerKey(agent: string, modelId?: string): string {
  const provider = providerOf(modelId);
  return provider ? providerSlotKey(agent, provider) : agent;
}
