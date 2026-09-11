/**
 * Walk helper for the model-resolution precheck (US-1984).
 *
 * The walker produces three things:
 *   - `tierEntries`: every `models.<agent>.<tier>` config entry, with the
 *     (provider, model) pair the dispatch reads and whether the entry
 *     declared `pricing` / `contextWindow` overrides. The check itself uses
 *     this to walk native resolver lookups AND to find a literal pin's
 *     tier entry (AC7 — the pin names an id the tier also exposes, and the
 *     tier's overrides are the ones the literal route silently discards).
 *   - `pins`: every literal `{agent, model}` pin AND every site that resolves
 *     via a tier label (`review.semantic.model = "balanced"`, etc.) —
 *     unified under the same LiteralPin shape because both can fail and both
 *     must surface a Check with the right key path in its message.
 *   - `catalogOverrides`: the user's `agent.native.catalogOverrides` list,
 *     returned alongside so the check can short-circuit ids the user has
 *     declared against the bundled catalog snapshot (AC4).
 *
 * `mergeWithDefaults` deep-merges the input against DEFAULT_CONFIG so callers
 * can drive the walk with a single-site override (e.g. `{ agent: { native:
 * { catalogOverrides: [...] } } }`) without restating every other key.
 */

import { DEFAULT_CONFIG, type NaxConfig } from "@/config";
import type { ConfiguredModel, ProviderCatalogOverride } from "@/config/schema-types";

/** A literal `{agent, model}` pin found at a config site. */
export interface LiteralPin {
  /** Configuration key path (e.g. "review.adversarial.model"). */
  readonly keyPath: string;
  readonly agent: string;
  readonly model: string;
  /**
   * When the pin sits against a tier entry that declared `pricing` or
   * `contextWindow`, that fact surfaces here. The literal-pin warning
   * (AC7) fires only when the resolver reports the override fields were
   * dropped on the way through.
   */
  readonly tierEntryOverrides?: { hasPricing: boolean; hasContextWindow: boolean };
}

/**
 * A `models.<agent>.<tier>` config entry — not a literal pin, but the
 * resolver still walks it. The entry's id must resolve in the catalog (or
 * under catalogOverrides) before any pin that names the tier can dispatch.
 */
export interface ModelsTierEntry {
  readonly keyPath: string;
  readonly agent: string;
  readonly tier: string;
  readonly provider: string;
  readonly model: string;
  readonly hasPricing: boolean;
  readonly hasContextWindow: boolean;
}

/** Look up the (provider, model) pair for a given (agent, tier) name pair
 *  in the walked tier entries. Used by sites that store a tier reference
 *  (autoMode.escalation.tierOrder rungs, agent.fallback.map `{agent, tier}`
 *  rungs) so the pin can carry the underlying id instead of the bare label —
 *  a label like "balanced" passed to the resolver would resolve as
 *  `unknown/balanced`, producing a false blocker even when the tier
 *  entry itself is configured. */
function findTierEntryForAgent(entries: ModelsTierEntry[], agent: string, tier: string): ModelsTierEntry | undefined {
  return entries.find((e) => e.agent === agent && e.tier === tier);
}

/** Default provider when an entry string lacks a "/". Same shape as schema-types#resolveModel. */
function providerFromEntry(entry: string): string {
  if (entry.startsWith("claude")) return "anthropic";
  if (entry.startsWith("gpt") || entry.startsWith("o1") || entry.startsWith("o3")) return "openai";
  if (entry.startsWith("gemini")) return "google";
  return "unknown";
}

/** Split an entry like "provider/model" into provider+model. Bare strings get a heuristic provider. */
function splitEntry(entry: string): { provider: string; model: string } {
  const slash = entry.indexOf("/");
  if (slash === -1) return { provider: providerFromEntry(entry), model: entry };
  return { provider: entry.slice(0, slash), model: entry.slice(slash + 1) };
}

/** Build a literal pin from a `ConfiguredModel` (string tier OR `{agent, model}` pin).
 *
 *  Tier labels are resolved through the `tierEntries` table: when a site
 *  carries `plan.model = "balanced"` and `models.<agent>.balanced` is
 *  configured, the pin stores the underlying (provider, model) id, not the
 *  bare label. Without this resolution the resolver would receive
 *  `provider="unknown", model="balanced"` and produce a false blocker on
 *  a perfectly valid configuration (semantic review finding) — and on a
 *  native default agent the bare label would route through the catalog
 *  missing every entry on `models.<agent>.<tier>`.
 *
 *  When the tier is unknown, the pin still carries the tier label so the
 *  key path surfaces in the report via the check's `model:` token. */
function pinFromConfiguredModel(
  keyPath: string,
  selection: ConfiguredModel | undefined,
  defaultAgent: string,
  tierOverrides: ReadonlyMap<string, { hasPricing: boolean; hasContextWindow: boolean }>,
  tierEntries: ModelsTierEntry[],
): LiteralPin | undefined {
  if (selection === undefined) return undefined;
  if (typeof selection === "string") {
    const overrides = tierOverrides.get(selection);
    const resolved = findTierEntryForAgent(tierEntries, defaultAgent, selection);
    if (resolved !== undefined) {
      // Pin carries the underlying id so the resolver looks up the correct
      // catalog entry. The keyPath still names the config site, so the
      // dropped-overrides warning (if any) names the pin.
      return {
        keyPath,
        agent: defaultAgent,
        model: `${resolved.provider}/${resolved.model}`,
        ...(resolved.hasPricing || resolved.hasContextWindow
          ? {
              tierEntryOverrides: {
                hasPricing: resolved.hasPricing,
                hasContextWindow: resolved.hasContextWindow,
              },
            }
          : overrides !== undefined
            ? { tierEntryOverrides: overrides }
            : {}),
      };
    }
    // Tier not in the models map — fall back to the tier label so the key
    // path still surfaces; the resolver will reject it as unknown.
    return {
      keyPath,
      agent: defaultAgent,
      model: selection,
      ...(overrides !== undefined ? { tierEntryOverrides: overrides } : {}),
    };
  }
  // Literal `{agent, model}` pin. `model` may be either a tier name (in which case the
  // tier entry's overrides are the ones the literal route silently discards) or a
  // provider-qualified id.
  const overrides = tierOverrides.get(selection.model);
  return {
    keyPath,
    agent: selection.agent,
    model: selection.model,
    ...(overrides !== undefined ? { tierEntryOverrides: overrides } : {}),
  };
}

/**
 * Treat the input config as a partial overlay over DEFAULT_CONFIG: missing fields fall
 * through to the schema defaults, so callers can drive the check with a single-site
 * override (`{ agent: { native: { catalogOverrides: [...] } } }`) without restating
 * every other key the walk visits.
 *
 * The merge is structural — only the fields the override actually declares are
 * overwritten; arrays and primitives replace wholesale. The walk reads only
 * a handful of nested properties off the result and treats every one as
 * optional with a sensible fallback, so a partial override cannot produce an
 * undefined-access downstream.
 *
 * Each branch clones the baseVal reference before recursing so the merge
 * cannot mutate `DEFAULT_CONFIG`'s nested objects across calls (one test's
 * override would otherwise leak into the next invocation).
 */
export function mergeWithDefaults(config: unknown): NaxConfig {
  return mergeWithDefaultsImpl(config);
}

/** Implementation signature uses `unknown` end-to-end so the recursive merge
 *  can return `unknown` from the deepest branch — the public signature
 *  (`NaxConfig` in, `NaxConfig` out) is the only `as`-free boundary. */
function mergeWithDefaultsImpl(config: unknown): NaxConfig {
  if (
    config === null ||
    config === undefined ||
    (typeof config === "object" && Object.keys(config as object).length === 0)
  ) {
    return DEFAULT_CONFIG;
  }
  return applyOverlayToBase(DEFAULT_CONFIG, config);
}

function applyOverlayToBase<T>(base: T, override: unknown): T {
  // The shallow spread preserves `T`; the overlay works on the loose
  // `Record<string, unknown>` shape end-to-end and only writes back into
  // this sibling object. The walker reads only optional fields with
  // fallbacks, so the structural guarantee holds at the consumer.
  const merged = { ...base };
  applyOverlay(merged as Record<string, unknown>, override);
  return merged;
}

/** Recursive structural overlay. The `unknown` end-to-end types let the
 *  recursion return through without runtime-shape narrowing casts at the
 *  leaves. Each branch clones the baseVal reference before recursing so
 *  the merge cannot mutate `DEFAULT_CONFIG`'s nested objects across calls
 *  (one test's override would otherwise leak into the next invocation). */
function applyOverlay(base: Record<string, unknown>, override: unknown): Record<string, unknown> {
  if (override === null || typeof override !== "object" || Array.isArray(override)) {
    return base;
  }
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    if (v === undefined) continue;
    const baseVal = base[k];
    if (
      baseVal !== null &&
      typeof baseVal === "object" &&
      !Array.isArray(baseVal) &&
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v)
    ) {
      // Clone before recursing — without this, nested DEFAULT_CONFIG objects
      // get mutated in place and persist across calls.
      const cloned: Record<string, unknown> = { ...(baseVal as Record<string, unknown>) };
      base[k] = applyOverlay(cloned, v);
    } else {
      base[k] = v;
    }
  }
  return base;
}

/**
 * Walk every configured model reference site. The walk covers both the literal-pin
 * sites the user typed and every `models.<agent>.<tier>` entry — the latter is what
 * the dispatch reads, so an entry that names an absent id is just as blocking as a
 * literal pin to the same id.
 */
export function collectConfiguredModelPins(config: unknown): {
  pins: LiteralPin[];
  tierEntries: ModelsTierEntry[];
  catalogOverrides: readonly ProviderCatalogOverride[];
} {
  const cfg = mergeWithDefaults(config);

  const tierOverrides = new Map<string, { hasPricing: boolean; hasContextWindow: boolean }>();
  const tierEntries: ModelsTierEntry[] = [];
  for (const [agentName, agentMap] of Object.entries(cfg.models ?? {})) {
    if (agentMap === undefined) continue;
    for (const [tier, entry] of Object.entries(agentMap)) {
      if (entry === undefined) continue;
      const { provider, model } = typeof entry === "string" ? splitEntry(entry) : splitEntry(entry.model);
      const hasPricing = typeof entry !== "string" && entry.pricing !== undefined;
      const hasContextWindow = typeof entry !== "string" && entry.contextWindow !== undefined;
      tierOverrides.set(`${agentName}/${tier}`, { hasPricing, hasContextWindow });
      // A bare entry like "haiku" or "anthropic/claude-opus-5" is itself the (provider, model) pair.
      // A `ModelDef` shape carries its own provider/model and its overrides are the ones the
      // literal-pin warning is about — keep both visible in the override table.
      if (typeof entry !== "string") {
        tierOverrides.set(`${entry.provider}/${entry.model}`, { hasPricing, hasContextWindow });
      }
      tierEntries.push({
        keyPath: `models.${agentName}.${tier}`,
        agent: agentName,
        tier,
        provider,
        model,
        hasPricing,
        hasContextWindow,
      });
    }
  }

  const pins: LiteralPin[] = [];
  const defaultAgent = cfg.agent?.default ?? "claude";

  // review.{semantic,adversarial}.model and plan.model and acceptance.model and tdd.sessionTiers.*
  if (cfg.review?.semantic !== undefined) {
    const pin = pinFromConfiguredModel(
      "review.semantic.model",
      cfg.review.semantic.model,
      defaultAgent,
      tierOverrides,
      tierEntries,
    );
    if (pin !== undefined) pins.push(pin);
  }
  if (cfg.review?.adversarial !== undefined) {
    const pin = pinFromConfiguredModel(
      "review.adversarial.model",
      cfg.review.adversarial.model,
      defaultAgent,
      tierOverrides,
      tierEntries,
    );
    if (pin !== undefined) pins.push(pin);
  }
  if (cfg.plan !== undefined) {
    const pin = pinFromConfiguredModel("plan.model", cfg.plan.model, defaultAgent, tierOverrides, tierEntries);
    if (pin !== undefined) pins.push(pin);
  }
  if (cfg.acceptance !== undefined) {
    const pin = pinFromConfiguredModel(
      "acceptance.model",
      cfg.acceptance.model,
      defaultAgent,
      tierOverrides,
      tierEntries,
    );
    if (pin !== undefined) pins.push(pin);
  }
  if (cfg.tdd?.sessionTiers !== undefined) {
    const sessionTiers = cfg.tdd.sessionTiers;
    for (const role of ["testWriter", "verifier"] as const) {
      const pin = pinFromConfiguredModel(
        `tdd.sessionTiers.${role}`,
        sessionTiers[role],
        defaultAgent,
        tierOverrides,
        tierEntries,
      );
      if (pin !== undefined) pins.push(pin);
    }
  }
  if (cfg.routing?.llm !== undefined) {
    const pin = pinFromConfiguredModel(
      "routing.llm.model",
      cfg.routing.llm.model,
      defaultAgent,
      tierOverrides,
      tierEntries,
    );
    if (pin !== undefined) pins.push(pin);
  }

  // every rung of autoMode.escalation.tierOrder
  const tierOrder = cfg.autoMode?.escalation?.tierOrder ?? [];
  tierOrder.forEach((rung, idx) => {
    const tier = rung.tier;
    const agent = rung.agent ?? defaultAgent;
    const resolved = findTierEntryForAgent(tierEntries, agent, tier);
    if (resolved !== undefined) {
      // Pin stores the underlying id (provider-qualified) so the resolver
      // looks up the correct catalog entry — not the tier label, which would
      // produce a false "unknown/powerful" blocker (semantic review finding).
      pins.push({
        keyPath: `autoMode.escalation.tierOrder[${idx}].tier`,
        agent,
        model: `${resolved.provider}/${resolved.model}`,
        ...(resolved.hasPricing || resolved.hasContextWindow
          ? {
              tierEntryOverrides: {
                hasPricing: resolved.hasPricing,
                hasContextWindow: resolved.hasContextWindow,
              },
            }
          : {}),
      });
    } else {
      // Tier not in the models map. Emit the tier label so the key path
      // still appears in the report; the resolver will reject it.
      pins.push({
        keyPath: `autoMode.escalation.tierOrder[${idx}].tier`,
        agent,
        model: tier,
      });
    }
  });

  // every rung of agent.fallback.map[<primary>][i]
  const fallbackMap = cfg.agent?.fallback?.map ?? {};
  for (const [primary, rungs] of Object.entries(fallbackMap)) {
    if (!Array.isArray(rungs)) continue;
    rungs.forEach((rung, idx) => {
      if (typeof rung === "string") {
        // bare string = a different primary agent name (per ADR-012, values are agent names).
        // No model id to resolve; nothing to emit.
        return;
      }
      if ("model" in rung) {
        // { agent, model } literal pin.
        const overrides = tierOverrides.get(`${rung.agent}/${rung.model}`);
        pins.push({
          keyPath: `agent.fallback.map.${primary}[${idx}]`,
          agent: rung.agent,
          model: rung.model,
          ...(overrides !== undefined ? { tierEntryOverrides: overrides } : {}),
        });
      } else if ("tier" in rung) {
        // { agent, tier } rung. AC5 requires "every rung of agent.fallback.map"
        // to emit a failing check naming the site, regardless of whether
        // the rung is a literal pin or a tier reference. We resolve the
        // tier through the models map so the underlying id is what the
        // resolver sees; when the tier is unknown we fall through to the
        // tier label so the key path still surfaces in the report.
        const resolved = findTierEntryForAgent(tierEntries, rung.agent, rung.tier);
        pins.push({
          keyPath: `agent.fallback.map.${primary}[${idx}]`,
          agent: rung.agent,
          model: resolved !== undefined ? `${resolved.provider}/${resolved.model}` : rung.tier,
          ...(resolved !== undefined && (resolved.hasPricing || resolved.hasContextWindow)
            ? {
                tierEntryOverrides: {
                  hasPricing: resolved.hasPricing,
                  hasContextWindow: resolved.hasContextWindow,
                },
              }
            : {}),
        });
      }
    });
  }

  // native catalog overrides carry (provider, model) the bundled catalog does not know —
  // the resolver must accept these so the check passes for any id the user declared.
  const catalogOverrides = cfg.agent?.native?.catalogOverrides ?? [];

  return { pins, tierEntries, catalogOverrides };
}
