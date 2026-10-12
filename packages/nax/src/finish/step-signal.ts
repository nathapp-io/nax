/**
 * Finish A: a step's signal is the phase signal plus its own limit. `limit` is returned
 * alone so callers can tell a step limit (continue the loop) from a phase stop. The
 * agent's own timeout is set to the limit plus a margin, so the step limit always
 * fires first: a fail-timeout is retried without checking the abort signal.
 */
export const STEP_TIMEOUT_MARGIN_MS = 60_000;

export function stepSignal(
  base: AbortSignal | undefined,
  ms: number | undefined,
): { signal: AbortSignal | undefined; limit: AbortSignal | undefined } {
  const limit = ms !== undefined ? AbortSignal.timeout(ms) : undefined;
  if (!limit) return { signal: base, limit: undefined };
  return { signal: base ? AbortSignal.any([base, limit]) : limit, limit };
}
