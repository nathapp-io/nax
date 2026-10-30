/**
 * The models and efforts a live ACP agent offers, as plain ids the embedder can show
 * and pass back (chat-acp-brain US-001). Reported in the capability record, so nax
 * never starts an agent just to list them. The ids are agent data: each one that
 * cleanLabel would change (control characters, whitespace runs, a session secret, more
 * than MODEL_ID_MAX_CHARS characters) is dropped rather than shown altered, so an id
 * reported here is exactly the id the agent offered.
 */
import { EFFORT_FALLBACK_IDS, MODEL_ID_MAX_CHARS, selectValues } from "#src/client/capabilities";
import type { SessionOffers } from "#src/client/session-offers";
import { cleanLabel } from "#src/client/text";

export interface OfferedChoices {
  readonly models: readonly string[];
  readonly efforts: readonly string[];
}

/** At most this many ids per list. */
export const MAX_OFFERED_CHOICES = 50;

/** Duplicates dropped (first kept), then every id cleanLabel would alter, then the cap. */
function sanitized(ids: readonly string[], secrets: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (cleanLabel(id, secrets, MODEL_ID_MAX_CHARS) !== id) continue;
    kept.push(id);
    if (kept.length === MAX_OFFERED_CHOICES) break;
  }
  return Object.freeze(kept);
}

/** Every category "model" option's values in offer order, then the legacy models block's ids. */
function modelIds(offers: SessionOffers): readonly string[] {
  const fromOptions = offers.configOptions
    .filter((option) => option.category === "model")
    .flatMap((option) => selectValues(option));
  return [...fromOptions, ...offers.modelIds];
}

/** The first "thought_level" option's values, else those of the agent's fallback option id, else none. */
function effortIds(offers: SessionOffers, agentName: string): readonly string[] {
  const byCategory = offers.configOptions.find((option) => option.category === "thought_level");
  if (byCategory !== undefined) return selectValues(byCategory);
  const fallbackId = Object.hasOwn(EFFORT_FALLBACK_IDS, agentName) ? EFFORT_FALLBACK_IDS[agentName] : undefined;
  if (fallbackId === undefined) return [];
  const option = offers.configOptions.find((candidate) => candidate.id === fallbackId);
  return option === undefined ? [] : selectValues(option);
}

export function offeredChoices(offers: SessionOffers, agentName: string, secrets: readonly string[]): OfferedChoices {
  return Object.freeze({
    models: sanitized(modelIds(offers), secrets),
    efforts: sanitized(effortIds(offers, agentName), secrets),
  });
}
