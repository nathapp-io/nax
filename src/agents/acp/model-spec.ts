/**
 * Model spec parsing.
 *
 * nax profiles name codex models with a reasoning-effort suffix, e.g.
 * "gpt-5.6-luna[high]". That form is the identifier format of codex-acp's legacy
 * session/set_model API. acpx 0.13+ selects models through the config-option
 * channel instead, where the id is bare and effort is a sibling option
 * (reasoning_effort). The suffix is therefore a nax-level convention that must be
 * decomposed before the value reaches acpx.
 *
 * Only a well-formed trailing [..] is treated as a suffix. Anything else is passed
 * through as a model id so a profile typo surfaces as acpx's own
 * unadvertised-model error rather than a silent rewrite.
 */

export interface ModelSpec {
  /** Model id with any effort suffix removed. Safe to pass to acpx as --model. */
  readonly model: string;
  /** Reasoning effort from the suffix, when one was present. */
  readonly effort?: string;
}

/** Matches "<model>[<effort>]" where neither part contains a bracket. */
const EFFORT_SUFFIX = /^([^[\]]+)\[([^[\]]+)\]$/;

export function parseModelSpec(raw: string): ModelSpec {
  const match = EFFORT_SUFFIX.exec(raw);
  if (!match) return { model: raw };
  return { model: match[1] as string, effort: match[2] as string };
}
