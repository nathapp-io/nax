/**
 * Which provider overrides a set of protocol entries was built with.
 *
 * Since issue #36 the same `providerOverrides` array has to reach two places:
 * the client, whose catalog `model()`, `listModels()` and `pricing()` read, and
 * the protocol entries, whose catalog the wire resolves against. Declaring it
 * on the client alone reproduces #36 exactly — the model resolves and prices
 * and then throws "Unknown model" on the first real request — and nothing about
 * that omission is visible until a request is actually made.
 *
 * So the protocol side records what it was told, and the client checks the
 * record at construction. The record lives in a module-private WeakMap keyed by
 * the entries object rather than in a property on it: `ProtocolEntries` is a
 * published type, and a marker property would either widen that public shape or
 * force a cast at every touch point. A WeakMap keeps the association entirely
 * inside this module and lets the entries be collected normally.
 *
 * This module deliberately imports no pi-ai. It sits outside the three-file
 * adapter allowlist that scripts/check-pi-ai-imports.ts enforces, and the
 * check it powers is about declaration data, not about the wire.
 */

import type { OpenRouterRouting, PercentileTarget, ProviderOverride } from "../providers/types.ts";
import type { ProtocolEntries } from "./registry.ts";

const declared = new WeakMap<ProtocolEntries, readonly ProviderOverride[]>();

/**
 * Records what the protocol side was told, including "nothing".
 *
 * Recording an absent or empty array is the point rather than an edge case:
 * "these entries declared no overrides" is precisely the state that reproduces
 * #36, and it is only distinguishable from "these entries were hand-built and
 * never went through defaultProtocols" if the former is written down.
 */
export function recordDeclaredOverrides(entries: ProtocolEntries, overrides: readonly ProviderOverride[]): void {
  declared.set(entries, overrides);
}

/** What these entries declared, or undefined when they never declared at all. */
export function declaredOverridesFor(entries: ProtocolEntries): readonly ProviderOverride[] | undefined {
  return declared.get(entries);
}

/** Whether two header maps say the same thing. Order is not part of the value. */
function sameHeaders(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>> | undefined): boolean {
  if (b === undefined) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => b[key] === a[key]);
}

/**
 * The advice every declaration-check message ends with. One constant so the
 * messages cannot drift apart, and so the issue number is written once.
 */
const REMEDY =
  "Pass the same providerOverrides array to the protocol entries as to createClient — " +
  "defaultProtocols({ providerOverrides }) — or pass a factory as `protocols` so the array is declared once. " +
  "Declaring it on the client alone is issue #36: the model resolves and prices correctly and then fails at " +
  "request time.";

/**
 * One routing declaration as a comparable string.
 *
 * Content, not identity: two independently built declarations that state the
 * same restriction produce the same request, so treating object identity as
 * the requirement would fail a consumer whose wiring is right — the same
 * reasoning the override-array check above already follows.
 *
 * Arrays stay in the order they were declared. `order`, `only`, `ignore` and
 * `quantizations` are ordered on the wire (OpenRouter tries `order` as a
 * sequence, and `quantizations` is a filter list whose spelling the request
 * preserves), so `["a","b"]` and `["b","a"]` are different requests and a
 * comparison that sorted them would bless a mismatch.
 */
function routingKey(routing: OpenRouterRouting | undefined): string {
  if (routing === undefined) return "no routing";
  return JSON.stringify([
    routing.allow_fallbacks ?? null,
    routing.require_parameters ?? null,
    routing.data_collection ?? null,
    routing.zdr ?? null,
    routing.order ?? null,
    routing.only ?? null,
    routing.ignore ?? null,
    routing.quantizations ?? null,
    routing.sort ?? null,
    targetKey(routing.preferred_min_throughput),
    targetKey(routing.preferred_max_latency),
  ]);
}

/** A percentile target: one number, or its per-percentile values in a fixed order. */
function targetKey(target: PercentileTarget | undefined): unknown {
  if (target === undefined) return null;
  if (typeof target === "number") return target;
  return [target.p50 ?? null, target.p75 ?? null, target.p90 ?? null, target.p99 ?? null];
}

/**
 * The routing that would reach the wire for one model id, from one catalog's
 * declared overrides.
 *
 * Resolved across successive declarations for the same id rather than read off
 * the last one. A later declaration that omits routing inherits the restriction
 * already stated — which is what pi-client.ts's applyOverrides does with the
 * routing it has already seen for that id — and an explicit declaration
 * replaces it. Reading the last declaration alone reports "no restriction" for
 * a catalog whose request still carries one, so a pair that disagrees only by
 * inheritance would slip through.
 *
 * A declaration that moves the id to a protocol other than openai-completions
 * clears the inherited value, because pi reads `compat.openRouterRouting` from
 * its openai-completions adapter and nothing else; the wire drops it there, so
 * this must too or the check would claim a restriction the request never has.
 */
function effectiveRouting(
  overrides: readonly ProviderOverride[],
  provider: string,
  modelId: string,
): OpenRouterRouting | undefined {
  let effective: OpenRouterRouting | undefined;
  for (const override of overrides) {
    if (override.provider !== provider) continue;
    for (const model of override.models ?? []) {
      if (model.id !== modelId) continue;
      if (model.openRouterRouting !== undefined) effective = model.openRouterRouting;
      else if (model.protocol !== "openai-completions") effective = undefined;
    }
  }
  return effective;
}

/** Renders one effective routing for an error message. */
function describeRouting(routing: OpenRouterRouting | undefined): string {
  return routing === undefined ? "no routing" : JSON.stringify(routing);
}

/**
 * Rejects two catalogs that disagree about the routing one model id sends.
 *
 * Routing is the one override field that reaches the wire, so an id declared
 * on both sides with different effective routing is a request whose OpenRouter
 * restrictions depend on which catalog the backend happens to read — the
 * consumer pinned `zdr` and the wire may not carry it. Pricing never crosses
 * the wire, so a repriced amendment on both sides (or on one) is not a
 * disagreement and stays accepted.
 *
 * A model the base catalog carries is not exempt here, unlike the override
 * check above: nothing bundled supplies an `openRouterRouting`, so a
 * restriction declared only on the client is one the request will never send.
 */
function assertRoutingAgrees(
  provider: string,
  modelId: string,
  clientSide: readonly ProviderOverride[],
  protocolSide: readonly ProviderOverride[],
): void {
  const clientRouting = effectiveRouting(clientSide, provider, modelId);
  const protocolRouting = effectiveRouting(protocolSide, provider, modelId);
  if (routingKey(clientRouting) === routingKey(protocolRouting)) return;
  throw new Error(
    `Provider override for "${provider}" declares model "${modelId}" whose effective openRouterRouting differs ` +
      `between the two catalogs: the client declares ${describeRouting(clientRouting)}, the protocol entries ` +
      `declare ${describeRouting(protocolRouting)}. Routing reaches the wire only from the protocol side's ` +
      `catalog, so this request would be sent with whichever restriction that catalog states — including none. ` +
      REMEDY,
  );
}

/**
 * Rejects a client whose protocol entries do not cover the overrides the
 * client itself declares.
 *
 * Deliberately content-aware rather than identity-based. Two separately
 * constructed but equal arrays work correctly at runtime — they build two
 * backend catalogs, which costs memory and nothing else — so treating array
 * identity as the requirement would fail a consumer whose wiring is right.
 * What matters is only whether each thing the client side promises is also
 * promised at the wire.
 *
 * Extra overrides on the protocol side never fail: a backend catalog knowing
 * about a model the client cannot name is inert, and forbidding it would make
 * one shared protocol set unusable by several narrower clients.
 *
 * Nor does an override of a model the base catalog already carries. Amending a
 * bundled model — correcting stale pricing is the usual reason — needs nothing
 * at the wire: pricing never crosses it, and the backend resolves that id from
 * its own catalog whether or not the override was declared there too. Only a
 * model the base catalog does not carry can produce #36, because only that one
 * has nowhere else to be found. Demanding declaration for the rest would fail
 * consumers whose wiring is already correct.
 *
 * `openRouterRouting` is the exception, and it is checked separately for every
 * model id on both sides: it is the one override field a request carries, so
 * two catalogs that disagree about it send different requests for one model.
 * See assertRoutingAgrees.
 *
 * Called at construction rather than from `validate()`, because `validate()`
 * is opt-in and a consumer who never calls it keeps exactly the silent trap
 * this exists to remove.
 */
export function assertProtocolOverridesDeclared(
  clientSide: readonly ProviderOverride[],
  entries: ProtocolEntries,
  /** Whether the base provider catalog already carries this model. */
  inBaseCatalog: (provider: string, modelId: string) => boolean,
): void {
  const protocolSide = declaredOverridesFor(entries);
  // Hand-built entries never declared anything, and "did not declare" is not
  // "declared nothing": a consumer assembling entries itself owns the wiring,
  // and several tests and embedders legitimately do. Only entries that went
  // through a declaring factory can be held to what they said.
  if (protocolSide === undefined) return;

  const forProvider = (provider: string): readonly ProviderOverride[] =>
    protocolSide.filter((override) => override.provider === provider);

  for (const override of clientSide) {
    const counterparts = forProvider(override.provider);

    for (const model of override.models ?? []) {
      if (!inBaseCatalog(override.provider, model.id)) {
        const covered = counterparts.some((counterpart) =>
          (counterpart.models ?? []).some((candidate) => candidate.id === model.id),
        );
        if (!covered) {
          throw new Error(
            `Provider override for "${override.provider}" declares model "${model.id}", which the base provider ` +
              `catalog does not carry, but the protocol entries declare no override model with that id for that ` +
              `provider, so nothing at the wire can resolve it. ${REMEDY}`,
          );
        }
      }

      // Independent of the check above: routing is the one override field the
      // request carries, so it is held to agreement even for an id the base
      // catalog already serves. A repriced amendment that states no routing
      // agrees with a protocol side that states none, which is what keeps the
      // usual reason to amend a bundled model working.
      assertRoutingAgrees(override.provider, model.id, clientSide, protocolSide);
    }

    if (override.baseUrl !== undefined) {
      const covered = counterparts.some((counterpart) => counterpart.baseUrl === override.baseUrl);
      if (!covered) {
        throw new Error(
          `Provider override for "${override.provider}" sets baseUrl "${override.baseUrl}" on the client, but the ` +
            `protocol entries do not set that baseUrl for that provider, so requests would still reach the ` +
            `provider's original endpoint. ${REMEDY}`,
        );
      }
    }

    if (override.headers !== undefined) {
      const headers = override.headers;
      const covered = counterparts.some((counterpart) => sameHeaders(headers, counterpart.headers));
      if (!covered) {
        throw new Error(
          `Provider override for "${override.provider}" sets headers on the client, but the protocol entries do ` +
            `not set the same headers for that provider, so those headers would never reach the wire. ${REMEDY}`,
        );
      }
    }
  }
}
