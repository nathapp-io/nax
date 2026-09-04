/**
 * A whole-turn wall-clock budget, shared by both transports.
 *
 * `timeoutSeconds` has always meant "per agent coding session"
 * (config-descriptions.ts, execution.sessionTimeoutSeconds, default 3600) and
 * acpx spends it that way. Native spent it per LLM call instead, so a turn's
 * real bound was `maxTurns x timeoutSeconds` — a product nobody intended. This
 * type exists so one budget can be created once per turn and consulted by
 * every round-trip inside it.
 */

export interface TurnDeadline {
  /** Milliseconds left, clamped at 0. `undefined` when the turn is unbounded. */
  remainingMs(): number | undefined;
  /** True once the budget is spent. Always false for an unbounded turn. */
  expired(): boolean;
}

const UNBOUNDED: TurnDeadline = {
  remainingMs: () => undefined,
  expired: () => false,
};

export function createTurnDeadline(timeoutSeconds: number | undefined, now: () => number = Date.now): TurnDeadline {
  if (timeoutSeconds === undefined) return UNBOUNDED;
  const endsAt = now() + timeoutSeconds * 1000;
  return {
    remainingMs: () => Math.max(0, endsAt - now()),
    expired: () => now() >= endsAt,
  };
}
