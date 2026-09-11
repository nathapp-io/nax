/**
 * Model-resolution precheck check (US-1984).
 *
 * One local catalog-backed walk over configured model references that:
 *   - blocks (Tier 1) an unresolved native id,
 *   - leaves ACP ids unverified for acpx's live dispatch validation,
 *   - warns when a literal `{agent, model}` pin drops tier-configured pricing
 *     or contextWindow overrides that the literal route would have used.
 *
 * The check is intentionally narrow: a literal pin against an `models.<agent>`
 * tier routes through `resolveModel(selection.model)` and never re-reads the
 * tier entry's overrides (out of scope: nax#1984 Option 1). A user who sets
 * pricing/contextWindow on a tier and then literal-pins the same id gets the
 * warning, not a silent override-loss.
 *
 * Production wiring: `_modelResolutionDeps.resolveNative` is `resolveNativeId`
 * from `src/agents/native/model-resolver.ts`, which uses the cached nax-ai
 * client (`getNativeClient(catalogOverrides)`). The precheck sees the exact
 * same catalog and overrides the dispatch will use. Tests swap the seam to
 * drive specific outcomes without loading the bundled catalog.
 */

import { resolveNativeId } from "@/agents/native";
import type { ProviderCatalogOverride } from "@/config/schema-types";
import {
  collectConfiguredModelPins,
  type LiteralPin,
  type ModelsTierEntry,
  splitEntry,
} from "./checks-model-resolution-walk";
import type { Check } from "./types";

// Re-export so existing callers importing LiteralPin from checks keep working
// (the interface itself lives next to the walker that produces it).
export type { LiteralPin };

export interface ModelResolutionDeps {
  /**
   * Look up a native (provider-qualified) id. Returns "resolved", "unresolved",
   * or "error". A "resolved" result MUST surface whether pricing and
   * contextWindow were declared — the literal-pin warning needs it.
   */
  resolveNative: (
    provider: string,
    model: string,
    overrides: readonly ProviderCatalogOverride[],
  ) => Promise<{ status: "resolved" | "unresolved" | "error"; hasPricing?: boolean; hasContextWindow?: boolean }>;
}

/**
 * Injectable seam — production wires `resolveNative` to `resolveNativeId` from
 * `src/agents/native/model-resolver.ts` so the cached nax-ai client (and
 * `agent.native.catalogOverrides`) is threaded through the same client the
 * dispatch uses. Tests swap both fields to drive specific resolution outcomes
 * without loading the bundled catalog. ACP ids are deliberately unverified:
 * acpx validates them against the live agent's advertised models at dispatch.
 */
export const _modelResolutionDeps: ModelResolutionDeps = {
  resolveNative: (provider, model, overrides) => resolveNativeId(provider, model, overrides),
};

/** True when the resolver table for `agent` routes through the native path. */
function isNativeAgent(agent: string): boolean {
  return agent === "native";
}

export { collectConfiguredModelPins };

/**
 * Tier-1/2 model-resolution check.
 *
 * Walks every collected literal pin and every `models.<agent>.<tier>` entry,
 * emitting one Check per failure site. A resolver that rejects the catalog
 * emits a single warning (AC6) — never a blocker — so a transient catalog
 * miss does not stop a run.
 *
 * Dispatch rule: only the native agent uses the local resolver (production
 * wires it to nax-ai's bundled snapshot via `getNativeClient` in
 * `src/agents/native/client.ts`). ACP ids are left unverified because acpx
 * validates them against live agent capabilities at dispatch. A native id the
 * override-aware client cannot resolve is a blocker, because that is exactly
 * the failure mode that caused `nax#1983` (an adversarial-review parse error
 * 22 minutes into a run for an id the resolver had no answer for).
 *
 * The check can emit mixed results (a blocker for an unresolved native id
 * alongside a native catalog-infrastructure warning).
 * `normalizeChecks` in `src/precheck/index.ts` fans the array into the
 * orchestrator, which splits by tier: blockers fail-fast, warnings queue.
 */
export async function checkModelResolution(config: unknown): Promise<Check[]> {
  const { pins, tierEntries, catalogOverrides } = collectConfiguredModelPins(config);

  // Track which (provider, model) pairs the native resolver has rejected at the
  // catalog level — collapses the per-site duplicates into one warning (AC6).
  const nativeRejectedKeys = new Set<string>();
  let anyNativeError = false;

  const checks: Check[] = [];

  // getNativeClient is cached per override set (see src/agents/native/client.ts); the
  // override list we just built is what the precheck-side resolver hands to it so the
  // user-declared ids reach the runtime. AC10 verifies the dispatch wiring.

  // ── Tier entry walk — `models.<agent>.<tier>` ──
  for (const entry of tierEntries) {
    const isNative = isNativeAgent(entry.agent);
    if (isNative) {
      const fullKey = `${entry.provider}/${entry.model}`;
      const result = await _modelResolutionDeps.resolveNative(entry.provider, entry.model, catalogOverrides);
      if (result.status === "error") {
        anyNativeError = true;
        nativeRejectedKeys.add(fullKey);
        continue;
      }
      if (result.status === "unresolved") {
        checks.push({
          name: "model-resolution",
          tier: "blocker",
          passed: false,
          message: `[model-resolution] Native model id does not resolve in the catalog: ${entry.keyPath} provider=${entry.provider} model=${entry.model}. Add the id to agent.native.catalogOverrides or pick a tier that ships in the bundled catalog.`,
        });
      }
      // resolved — nothing to report at the entry itself
    }
  }

  // ── Literal pin walk ──
  for (const pin of pins) {
    const isNative = isNativeAgent(pin.agent);
    if (isNative) {
      const { provider, model } = splitEntry(pin.model);
      const fullKey = `${provider}/${model}`;
      const result = await _modelResolutionDeps.resolveNative(provider, model, catalogOverrides);
      if (result.status === "error") {
        anyNativeError = true;
        nativeRejectedKeys.add(fullKey);
        continue;
      }
      if (result.status === "unresolved") {
        checks.push({
          name: "model-resolution",
          tier: "blocker",
          passed: false,
          message: `[model-resolution] Native model id does not resolve in the catalog: ${pin.keyPath} provider=${provider} model=${model}. Add the id to agent.native.catalogOverrides or pick a tier that ships in the bundled catalog.`,
        });
      }
      // resolved — check AC7: did the literal pin drop tier-configured pricing/contextWindow?
      const tierEntry = findTierEntryForPin(tierEntries, pin);
      // Tier-name selections (e.g. `plan.model = "balanced"`) route through the
      // tier reference, which respects the tier entry's overrides — so the
      // AC7 dropped-overrides warning must NOT fire for those. The walk
      // marks them with `tierReference: true`; literal `{agent, model}`
      // pins (which DO drop the tier's overrides) carry no such flag.
      if (!pin.tierReference && tierEntry && (tierEntry.hasPricing || tierEntry.hasContextWindow)) {
        const dropped = describeDroppedOverrides(tierEntry);
        checks.push({
          name: "model-resolution",
          tier: "warning",
          passed: false,
          message: `[model-resolution] Literal pin ${pin.keyPath} names "${pin.model}", routing through the literal path drops tier-configured ${dropped} from models.${tierEntry.agent}.${tierEntry.tier}. Move the override under agent.native.catalogOverrides, or pin by tier name to keep it.`,
        });
      }
    }
  }

  // Catalog-rejection warnings — single message each, gathered from every site that hit it.
  if (anyNativeError) {
    const sample = Array.from(nativeRejectedKeys).slice(0, 3).join(", ");
    checks.push({
      name: "model-resolution",
      tier: "warning",
      passed: false,
      message: `Native catalog resolver rejected the bundled snapshot — every configured native id is treated as unverified until the catalog is back. Configure missing ids under agent.native.catalogOverrides. Sample unresolved ids: ${sample}.`,
    });
  }
  if (checks.length === 0) {
    return [{ name: "model-resolution", tier: "blocker", passed: true, message: "All configured model ids resolve" }];
  }

  // The orchestrator splits by tier — `blocker` rows break the run, `warning`
  // rows fan out to the warnings list. Mixed results from a single check are
  // supported here on purpose: a transient catalog miss should not stop a run
  // when the actual blocker (an unresolved native id) is also present.
  return checks;
}

function findTierEntryForPin(entries: ModelsTierEntry[], pin: LiteralPin): ModelsTierEntry | undefined {
  // A literal `{agent, model}` pin matches a tier entry whose (provider, model
  // id) pair resolves to the same id the pin names — even if the tier label
  // differs. AC7's setup is exactly this: `models.native.balanced = { provider:
  // "anthropic", model: "claude-sonnet-5", pricing, contextWindow }` and a
  // literal pin `{ agent: "native", model: "claude-sonnet-5" }`. The pin may
  // name the id bare (`"claude-sonnet-5"`) or provider-qualified
  // (`"anthropic/claude-sonnet-5"`) — both must hit the same tier entry. We
  // split the pin's model id and compare both pieces so a provider-qualified
  // pin matches a tier entry whose `splitEntry` already produced the bare id.
  const split = splitEntry(pin.model);
  return entries.find((e) => {
    if (e.agent !== pin.agent) return false;
    if (e.provider !== split.provider) return false;
    return e.model === split.model;
  });
}

function describeDroppedOverrides(entry: ModelsTierEntry): string {
  const parts: string[] = [];
  if (entry.hasPricing) parts.push("pricing");
  if (entry.hasContextWindow) parts.push("contextWindow");
  return parts.join("/");
}
