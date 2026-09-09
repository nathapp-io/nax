/**
 * Resolve a fallback target's identity to the underlying MODEL, not the tier name.
 *
 * nax follow-up to the same-agent/different-tier fallback fix: `models.native` can
 * point two different tiers (e.g. `fast` and `balanced`) at the same underlying
 * model/provider. Keying exclusion and cooldown on `tier` alone (the first fix)
 * lets a swap "succeed" onto a target that is really the same dead provider under
 * a different tier name. This module resolves a target's ACTUAL model, following
 * the same tier-vs-literal discrimination `ConfiguredModel` uses elsewhere
 * (`resolveConfiguredModel`, `agent-profile-resolver.ts`), so two targets that
 * resolve to the same model collide on one cooldown/exclusion identity regardless
 * of what tier name each one was spelled with.
 *
 * `AgentManager` does not read `config.models` (`agentManagerConfigSelector`
 * deliberately excludes it — ADR-019 puts model resolution at the callOp seam).
 * The functions here take `models`/`defaultAgent` as plain arguments instead: the
 * manager receives them as an explicitly injected constructor dependency (see
 * `CreateAgentManagerOpts.models` in factory.ts and its wiring in
 * `runtime/index.ts`), never through the config selector. That is a deliberate,
 * narrow DI seam — not a widening of the selector — and it mirrors the existing
 * `modelDefFor` seam `ResolvedCompleteOptions` already uses for the same reason
 * (see `resolveHopCompleteOptions` in manager-dispatch.ts).
 */

import { MODEL_SHORTHAND_TIERS, resolveModelForAgent, resolveTierMembership } from "@/config";
import type { ModelsConfig } from "@/config/schema-types";
import { getSafeLogger } from "@/logger";
import type { FallbackTarget } from "./swap-decision";

/**
 * Resolve `agent`@`tier` to a stable model-identity string ("provider/model"),
 * or undefined when it cannot be resolved — no `models` injected, no `tier`
 * given (a tier-less plain-string target has no model to resolve until
 * dispatch chooses an effective tier — see the module doc), or the tier names
 * no entry for either `agent` or `defaultAgent` (the same `MODEL_NOT_FOUND`
 * case `resolveModelForAgent` throws for elsewhere). Callers fall back to
 * tier-based (or bare-agent) identity when this returns undefined, which is
 * exactly the pre-existing keying — so an unresolvable case degrades to the
 * prior fix, never to the pre-fix bare-agent-only behaviour.
 */
export function resolveFallbackModelId(
  models: ModelsConfig | undefined,
  agent: string,
  tier: string | undefined,
  defaultAgent: string,
): string | undefined {
  if (!tier || !models) return undefined;
  try {
    const def = resolveModelForAgent(models, agent, tier, defaultAgent);
    return `${def.provider}/${def.model}`;
  } catch {
    return undefined;
  }
}

/**
 * Convert a `{ agent, model }` fallback target into its dispatchable shape.
 *
 * `model` may name a tier (shorthand alias or a real tier key) or a literal
 * model id (`ConfiguredModel` semantics — mirrors `resolveTierMembership` in
 * `agent-profile-resolver.ts`). When it names a tier, this returns an
 * equivalent `{ agent, tier }` target — from here on indistinguishable from a
 * target that was always spelled with `tier`, so it dispatches and gets
 * model-identity-keyed exclusion exactly like one.
 *
 * A literal (non-tier) `model` is NOT converted: `HopKind`/`resolveHopCompleteOptions`/
 * `build-hop-callback.ts`'s dispatch machinery only understands a tier name, not
 * an arbitrary model id, and wiring a true literal-pin swap target through those
 * is a larger change than this identity fix. The target is returned unchanged —
 * it still dispatches, but degrades to the caller's own effective tier (the same
 * behaviour a plain-string target has today), and a warning is logged so the gap
 * is visible rather than silent. `.tier`-shaped and tier-resolving `.model`-shaped
 * targets are unaffected by this limitation.
 */
export function resolveFallbackDispatchTarget(
  models: ModelsConfig | undefined,
  defaultAgent: string,
  target: FallbackTarget,
): FallbackTarget {
  if (target.model === undefined || !models) return target;
  const aliased = MODEL_SHORTHAND_TIERS[target.model.toLowerCase()] ?? target.model;
  const membership = resolveTierMembership(models, target.agent, aliased, defaultAgent);
  if (membership.isTier) return { agent: target.agent, tier: aliased };
  getSafeLogger()?.warn(
    "agent-manager",
    "Fallback target names a literal model — swap dispatch is not wired for literal pins yet, falling back to the caller's effective tier",
    { agent: target.agent, model: target.model },
  );
  return target;
}
