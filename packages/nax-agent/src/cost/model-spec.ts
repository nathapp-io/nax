/**
 * Model spec parsing.
 *
 * nax profiles name models with a trailing reasoning-effort suffix, e.g.
 * "gpt-5.6-luna[high]". This is a nax-level convention, not an artifact of any
 * one transport: both agent transports consume it, each decomposing it before
 * the value reaches its own destination.
 *
 * - The ACP path decomposes it before the bare model id reaches acpx. The
 *   suffix form mirrors codex-acp's legacy session/set_model identifier
 *   format; acpx 0.13+ selects models through the config-option channel
 *   instead, where the id is bare and effort is a sibling option
 *   (reasoning_effort).
 * - The native path decomposes it before the bare model id reaches
 *   `client.model()`, and forwards the effort as a `thinking` level on the
 *   request (see `src/agents/native/models.ts`).
 *
 * Only a well-formed trailing [..] is treated as a suffix. Anything else is passed
 * through as a model id so a profile typo surfaces as the adapter's own
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
