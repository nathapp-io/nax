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
 *
 * Precedence: when a `tier` is present and `models` is available, the TIER MAP is
 * authoritative; `modelPin` is only consulted when there is no tier. A declared
 * tier and a declared literal pin are mutually exclusive on `HopKind` — a hop
 * target names either `{ agent, tier }` or `{ agent, model: "<pin>" }`, never both.
 * So "both present" at this call site only ever means a DECLARED tier plus a
 * DERIVED dispatched model (`manager-run-fallback.ts` calls
 * `markUnavailable(currentAgent, failure, currentTier, dispatchedModel)` after a
 * hop that dispatched through a tier). A later `{agent, tier}`-shaped candidate
 * lookup carries no model and resolves identity through the tier map — so mark
 * time and read time must key on the SAME map, or a rung that just died can read
 * back as healthy (the two strings can diverge when a tier's model changes
 * between marking and lookup, or when the dispatched string isn't a bare
 * "provider/model"). Keying on the pin string in that case broke that symmetry.
 */

import { MODEL_SHORTHAND_TIERS, resolveModel, resolveModelForAgent, resolveTierMembership } from "@/config";
import type { ModelsConfig } from "@/config/schema-types";
import type { FallbackTarget } from "./swap-decision";

/**
 * Resolve `agent`@`tier` (or a literal `modelPin`) to a stable model-identity
 * string ("provider/model"), or undefined when it cannot be resolved — no
 * `models` injected, no `tier`/`modelPin` given (a tier-less plain-string
 * target has no model to resolve until dispatch chooses an effective tier —
 * see the module doc), or the tier names no entry for either `agent` or
 * `defaultAgent` (the same `MODEL_NOT_FOUND` case `resolveModelForAgent`
 * throws for elsewhere). Callers fall back to tier-based (or bare-agent)
 * identity when this returns undefined, which is exactly the pre-existing
 * keying — so an unresolvable case degrades to the prior fix, never to the
 * pre-fix bare-agent-only behaviour.
 *
 * Precedence is tier-first: when `tier` and `models` are both present, the tier
 * map is authoritative (mark time and read time must agree on the same map — see
 * the module doc). `modelPin` is used only when there is no tier, OR when the
 * tier fails to resolve (the `MODEL_NOT_FOUND` case) and a pin is available to
 * fall back to — a throwing tier lookup must not swallow a usable pin. A literal
 * pin still resolves without the tier map for a tier-less target (`hopModelId` ->
 * `resolveModel` in build-hop-callback.ts is the same call dispatch makes), so
 * selection identity and dispatch identity name the same endpoint for a
 * tier-less rung (nax#1966).
 */
export function resolveFallbackModelId(
  models: ModelsConfig | undefined,
  agent: string,
  tier: string | undefined,
  defaultAgent: string,
  modelPin?: string,
): string | undefined {
  if (tier && models) {
    try {
      const def = resolveModelForAgent(models, agent, tier, defaultAgent);
      return `${def.provider}/${def.model}`;
    } catch {
      // Fall through to the pin below — a tier that fails to resolve must not
      // swallow a usable pin.
    }
  }
  if (modelPin !== undefined) {
    const def = resolveModel(modelPin);
    return `${def.provider}/${def.model}`;
  }
  return undefined;
}

/**
 * Does candidate `agentA`@`tierA`(/`modelA`) name the SAME endpoint as `agentB`@`tierB`
 * (/`modelB`)? Compares resolved identities when both sides resolve one; otherwise
 * degrades to exact `(tier, model)` equality — the "prior fix" tier-based keying — never
 * to bare-agent equality. Without that degradation, two same-agent targets with
 * DIFFERENT tiers both collapse to `undefined` when no `models` config is injected and
 * wrongly compare equal, re-excluding a same-agent/different-tier target that must
 * survive (nax#1966; the regression this closes lives in
 * `test/unit/agents/fallback-tier-targets.test.ts`, describe block
 * "a same-agent, different-tier fallback target").
 */
export function sameFallbackHop(
  models: ModelsConfig | undefined,
  defaultAgent: string,
  agentA: string,
  agentB: string | undefined,
  tierA?: string,
  modelA?: string,
  tierB?: string,
  modelB?: string,
): boolean {
  if (agentA !== agentB || agentB === undefined) return false;
  const idA = resolveFallbackModelId(models, agentA, tierA, defaultAgent, modelA);
  const idB = resolveFallbackModelId(models, agentB, tierB, defaultAgent, modelB);
  if (idA !== undefined && idB !== undefined) return idA === idB;
  return tierA === tierB && modelA === modelB;
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
 * A literal (non-tier) `model` is returned unchanged, and stays a pin all the way
 * to dispatch: `HopKind` carries it, and both seams resolve it directly rather
 * than through the tier map (`hopModelId` in build-hop-callback.ts for the run
 * path, `resolveHopCompleteOptions` for the complete path). The ModelDef that
 * produces is identical to the one the same id yields as a `models.<agent>.<tier>`
 * entry — both resolve through `resolveModel` — so a pin and a tier naming the
 * same model dispatch the same way.
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
  return target;
}
