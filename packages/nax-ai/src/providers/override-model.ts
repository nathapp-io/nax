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

/**
 * The second consistency rule: a routing declaration that cannot reach the
 * wire is rejected rather than ignored.
 *
 * pi sends `compat.openRouterRouting` from its `openai-completions` adapter
 * and from no other (`dist/api/openai-completions.js:745-747`; zero
 * occurrences in `anthropic-messages.js`). OpenRouter itself serves models on
 * both apis, so "declared routing on an OpenRouter model" is not enough for it
 * to be sent — and a consumer who pinned `quantizations: ["fp8"]` and silently
 * got the routing lottery anyway has no way to notice. Same reasoning as
 * `assertOverrideModelProvider`: there is no configuration this shape
 * expresses correctly.
 *
 * An empty object is rejected for a different reason: pi's check is
 * truthiness, not emptiness, so `{}` would reach the wire as `provider: {}` —
 * a request field that says nothing, sent because a caller declared something
 * that says nothing. Rejecting it turns a no-op into a question.
 */
export function assertOverrideModelRouting(model: ResolvedModel): void {
  const routing = model.openRouterRouting;
  if (routing === undefined) return;

  if (model.protocol !== "openai-completions") {
    throw new Error(
      `Model "${model.id}" declares openRouterRouting but its protocol is "${model.protocol}". Only ` +
        `"openai-completions" sends the OpenRouter "provider" request field, so this declaration could never ` +
        `reach the wire: either declare the model on "openai-completions" or drop the routing.`,
    );
  }

  const hasPreference = [
    routing.allow_fallbacks,
    routing.require_parameters,
    routing.data_collection,
    routing.zdr,
    routing.order,
    routing.only,
    routing.ignore,
    routing.quantizations,
    routing.sort,
  ].some((value) => value !== undefined);
  if (!hasPreference) {
    throw new Error(
      `Model "${model.id}" declares openRouterRouting that states no preference. An empty declaration would be ` +
        `sent as an empty "provider" block and change nothing: state at least one preference, or omit the field.`,
    );
  }
}
