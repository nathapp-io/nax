/** Token and cost totals per session role (spec §9 "token totals per role", P2-R3). */
import type { RoleTokens } from "./types";

/** The DispatchEvent fields the meter reads (structural, so any dispatch-event source fits). */
export interface MeterEvent {
  readonly sessionRole: string;
  readonly exactCostUsd?: number;
  readonly estimatedCostUsd?: number;
  readonly tokenUsage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
  };
}

export interface DispatchSource {
  onDispatch(listener: (event: MeterEvent) => void): () => void;
}

export interface TokenMeter {
  totals(): RoleTokens;
  byRole(): Readonly<Record<string, RoleTokens>>;
  stop(): void;
}

export const EMPTY_TOKENS: RoleTokens = { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 };

/**
 * US-005 (nax#2525): attach the cache columns only when there is cache traffic. Omitting a zero
 * keeps every role-entry shape written before this field existed byte-identical, so the existing
 * closed-world assertions (and any older `result.json`) still read as zero cache tokens.
 */
function withCache(base: RoleTokens, cacheReadTokens: number, cacheWriteTokens: number): RoleTokens {
  return {
    ...base,
    ...(cacheReadTokens !== 0 ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== 0 ? { cacheWriteTokens } : {}),
  };
}

function add(a: RoleTokens, b: RoleTokens): RoleTokens {
  return withCache(
    {
      inputTokens: a.inputTokens + b.inputTokens,
      outputTokens: a.outputTokens + b.outputTokens,
      costUsd: a.costUsd + b.costUsd,
      calls: a.calls + b.calls,
    },
    (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
  );
}

export function addRoleTokens(
  a: Readonly<Record<string, RoleTokens>>,
  b: Readonly<Record<string, RoleTokens>>,
): Record<string, RoleTokens> {
  const roles = new Set([...Object.keys(a), ...Object.keys(b)]);
  return Object.fromEntries([...roles].map((r) => [r, add(a[r] ?? EMPTY_TOKENS, b[r] ?? EMPTY_TOKENS)]));
}

export function startTokenMeter(source: DispatchSource | undefined): TokenMeter {
  let byRole: Readonly<Record<string, RoleTokens>> = {};
  const unsubscribe =
    source?.onDispatch((e) => {
      const one = withCache(
        {
          inputTokens: e.tokenUsage?.inputTokens ?? 0,
          outputTokens: e.tokenUsage?.outputTokens ?? 0,
          costUsd: e.exactCostUsd ?? e.estimatedCostUsd ?? 0,
          calls: 1,
        },
        e.tokenUsage?.cacheReadTokens ?? 0,
        e.tokenUsage?.cacheWriteTokens ?? 0,
      );
      byRole = { ...byRole, [e.sessionRole]: add(byRole[e.sessionRole] ?? EMPTY_TOKENS, one) };
    }) ?? (() => {});
  return {
    totals: () => Object.values(byRole).reduce(add, EMPTY_TOKENS),
    byRole: () => byRole,
    stop: unsubscribe,
  };
}
