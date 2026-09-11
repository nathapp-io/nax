/**
 * The one consistency rule a provider override's models must satisfy.
 *
 * A `ProviderOverride` names the provider it amends, and each `ResolvedModel`
 * it carries names its provider again. Nothing forces the two to agree, and
 * when they disagree both catalogs used to accept it silently: the model is
 * filed under the override's provider while still claiming to belong to the
 * other one. That is not a harmless inconsistency. Client-side, `streamFrom`
 * sends `model.provider` as the request's provider, so the protocol's own
 * lookup then misses. At the wire, auth is resolved from `model.provider`, so
 * the request is signed against a provider the caller never meant to use.
 *
 * There is no configuration this shape expresses correctly, so it is rejected
 * at construction — the precedent `createClient` already sets for a negative
 * `transportRetries`: nonsense config is told to the caller rather than
 * clamped or quietly tolerated.
 *
 * It lives in its own module so both catalogs — normaliseCatalog here and
 * applyOverrides in protocols/pi-client.ts — raise literally the same error,
 * rather than two wordings that drift apart. It imports no pi-ai, so the
 * adapter-boundary gate is unaffected by pi-client.ts calling it.
 */

import type { ResolvedModel } from "./types.ts";

export function assertOverrideModelProvider(provider: string, model: ResolvedModel): void {
  if (model.provider === provider) return;
  throw new Error(
    `Provider override for "${provider}" carries model "${model.id}" whose own provider field is ` +
      `"${model.provider}". An override amends the provider it is declared under, so the two must agree: ` +
      `either declare this model under "${model.provider}" or set its provider to "${provider}".`,
  );
}
