import { getSafeLogger } from "../logger";

export interface CostEvent {
  readonly ts: number;
  readonly runId: string;
  /** Stable project identity — `runId`/`storyId` collide across repos (#1429). */
  readonly projectKey?: string;
  /** Row schema version. 1 = pre-#1433 (no model/role attribution). */
  readonly schemaVersion?: number;
  readonly agentName: string;
  /**
   * Concrete model the call ran on. `"unknown"` only when the dispatch carried
   * no resolved model — before #1433 this was hardcoded to `"unknown"` on 100%
   * of rows, so treat `"unknown"` on a schemaVersion<2 row as "not recorded",
   * not as a real value.
   */
  readonly model: string;
  /** Tier the model resolved from, when one selected it. Absent for pinned models. */
  readonly modelTier?: string;
  /**
   * Resolved run-profile chain ("cc-acceptance", "a+b", "default"). Without it a
   * row cannot distinguish a deliberate profile pin from a stage ignoring its
   * configured tier — profiles live outside the run artifacts entirely.
   */
  readonly profile?: string;
  readonly stage?: string;
  /**
   * Session role (`test-writer`, `implementer`, `acceptance-gen`, …). The
   * sub-stage attribution key — `stage` alone collapses 23 roles into 6 buckets.
   */
  readonly sessionRole?: string;
  readonly featureName?: string;
  readonly storyId?: string;
  readonly packageDir?: string;
  readonly callId?: string;
  readonly scopeId?: string;
  readonly tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  /** Estimated cost from token usage × pricing rates (always present). */
  readonly estimatedCostUsd: number;
  /** Normalized exact cost: from wire protocol when available, else falls back to estimatedCostUsd. */
  readonly exactCostUsd: number;
  /** Canonical cost for budget/totals: exact when available, else estimated. */
  readonly costUsd: number;
  /** Confidence derived from presence of exactCostUsd at wire boundary. */
  readonly confidence: "exact" | "estimated";
  /**
   * Where `costUsd` came from.
   *
   * - `wire` — the agent reported an exact cost; `confidence` is `"exact"`.
   * - `model-rates` — estimated from this model's entry in `MODEL_PRICING`.
   * - `fallback-rates` — estimated from the generic $3/$15-per-1M card because
   *   the pricing table has no entry for the model. Treat these as indicative
   *   only: measured against rows that also had a wire cost, the estimator ran
   *   0.4x in aggregate and up to 21x off per row (#1433).
   * - `unknown-model` — no model was resolved, so the rate card cannot be named.
   */
  readonly pricingSource?: "wire" | "model-rates" | "fallback-rates" | "unknown-model";
  readonly durationMs: number;
}

export interface CostErrorEvent {
  /**
   * Discriminator. Error rows carry no cost or token fields, so without this a
   * consumer cannot distinguish "the call failed" from "the call cost zero" —
   * 197 of July 2026's 6,433 rows were ambiguous this way (#1433).
   */
  readonly kind: "error";
  readonly ts: number;
  readonly runId: string;
  readonly projectKey?: string;
  readonly schemaVersion?: number;
  readonly agentName: string;
  readonly model?: string;
  readonly stage?: string;
  readonly storyId?: string;
  readonly callId?: string;
  readonly scopeId?: string;
  readonly errorCode: string;
  readonly durationMs: number;
}

export interface CostSnapshot {
  readonly totalCostUsd: number;
  readonly totalEstimatedCostUsd: number;
  readonly totalExactCostUsd: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly callCount: number;
  readonly errorCount: number;
}

export interface CostScopeHandle {
  /** The scopeId this handle filters by. */
  readonly scopeId: string;
  /** Totals across events recorded with this scope's scopeId at call time. */
  snapshot(): CostSnapshot;
  /** Idempotent release of internal indexes. */
  close(): void;
}

export interface OperationSummaryEvent {
  readonly runId: string;
  readonly operation: "run-with-fallback" | "complete-with-fallback";
  readonly hopCount: number;
  readonly fallbackTriggered: boolean;
  readonly totalCostUsd: number;
  readonly totalElapsedMs: number;
  readonly finalStatus: "ok" | "exhausted" | "cancelled" | "error";
}

export interface ICostAggregator {
  record(event: CostEvent): void;
  recordError(event: CostErrorEvent): void;
  recordOperationSummary(event: OperationSummaryEvent): void;
  snapshot(): CostSnapshot;
  byAgent(): Record<string, CostSnapshot>;
  byStage(): Record<string, CostSnapshot>;
  byStory(): Record<string, CostSnapshot>;
  byCall(): Record<string, CostSnapshot>;
  byScope(): Record<string, CostSnapshot>;
  openScope(scopeId?: string): CostScopeHandle;
  drain(): Promise<void>;
}

const EMPTY_SNAPSHOT: CostSnapshot = {
  totalCostUsd: 0,
  totalEstimatedCostUsd: 0,
  totalExactCostUsd: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  callCount: 0,
  errorCount: 0,
};

function makeCorrelationId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createNoOpCostAggregator(): ICostAggregator {
  return {
    record() {},
    recordError() {},
    recordOperationSummary() {},
    snapshot() {
      return EMPTY_SNAPSHOT;
    },
    byAgent() {
      return {};
    },
    byStage() {
      return {};
    },
    byStory() {
      return {};
    },
    byCall() {
      return {};
    },
    byScope() {
      return {};
    },
    openScope(scopeId?: string): CostScopeHandle {
      return {
        scopeId: scopeId ?? makeCorrelationId(),
        snapshot: () => EMPTY_SNAPSHOT,
        close: () => {},
      };
    },
    async drain() {},
  };
}

import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** Injectable deps — swap in tests to avoid real disk I/O or logger side-effects. */
export const _costAggDeps = {
  write: (path: string, data: string): Promise<number> => Bun.write(path, data),
  getSafeLogger: () => getSafeLogger(),
  newCorrelationId: makeCorrelationId,
};

function emptySnap(): CostSnapshot {
  return {
    totalCostUsd: 0,
    totalEstimatedCostUsd: 0,
    totalExactCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    callCount: 0,
    errorCount: 0,
  };
}

function accumulate(snap: CostSnapshot, e: CostEvent): CostSnapshot {
  return {
    totalCostUsd: snap.totalCostUsd + e.costUsd,
    totalEstimatedCostUsd: snap.totalEstimatedCostUsd + e.estimatedCostUsd,
    totalExactCostUsd: snap.totalExactCostUsd + e.exactCostUsd,
    totalInputTokens: snap.totalInputTokens + e.tokens.input,
    totalOutputTokens: snap.totalOutputTokens + e.tokens.output,
    callCount: snap.callCount + 1,
    errorCount: snap.errorCount,
  };
}

function accumulateError(snap: CostSnapshot): CostSnapshot {
  return {
    ...snap,
    errorCount: snap.errorCount + 1,
  };
}

export class CostAggregator implements ICostAggregator {
  private readonly _events: CostEvent[] = [];
  private readonly _errors: CostErrorEvent[] = [];
  private _draining = false;
  private readonly _inFlightEvents: CostEvent[] = [];
  private readonly _inFlightErrors: CostErrorEvent[] = [];
  private readonly _openScopes = new Set<string>();

  constructor(
    private readonly _runId: string,
    private readonly _drainDir: string,
  ) {}

  record(event: CostEvent): void {
    if (this._draining) {
      this._inFlightEvents.push(event);
      return;
    }
    this._events.push(event);
  }

  recordError(event: CostErrorEvent): void {
    if (this._draining) {
      this._inFlightErrors.push(event);
      return;
    }
    this._errors.push(event);
  }

  recordOperationSummary(_event: OperationSummaryEvent): void {}

  snapshot(): CostSnapshot {
    const allEvents = [...this._events, ...this._inFlightEvents];
    const allErrors = [...this._errors, ...this._inFlightErrors];
    return allEvents.reduce(accumulate, { ...emptySnap(), errorCount: allErrors.length });
  }

  byAgent(): Record<string, CostSnapshot> {
    const m: Record<string, CostSnapshot> = {};
    for (const e of this._events) m[e.agentName] = accumulate(m[e.agentName] ?? emptySnap(), e);
    for (const e of this._inFlightEvents) m[e.agentName] = accumulate(m[e.agentName] ?? emptySnap(), e);
    return m;
  }

  byStage(): Record<string, CostSnapshot> {
    const m: Record<string, CostSnapshot> = {};
    for (const e of this._events) {
      const k = e.stage ?? "unknown";
      m[k] = accumulate(m[k] ?? emptySnap(), e);
    }
    for (const e of this._inFlightEvents) {
      const k = e.stage ?? "unknown";
      m[k] = accumulate(m[k] ?? emptySnap(), e);
    }
    return m;
  }

  byStory(): Record<string, CostSnapshot> {
    const m: Record<string, CostSnapshot> = {};
    for (const e of this._events) {
      const k = e.storyId ?? "unknown";
      m[k] = accumulate(m[k] ?? emptySnap(), e);
    }
    for (const e of this._inFlightEvents) {
      const k = e.storyId ?? "unknown";
      m[k] = accumulate(m[k] ?? emptySnap(), e);
    }
    return m;
  }

  byCall(): Record<string, CostSnapshot> {
    const m: Record<string, CostSnapshot> = {};
    for (const e of [...this._events, ...this._inFlightEvents]) {
      if (e.callId === undefined) continue;
      m[e.callId] = accumulate(m[e.callId] ?? emptySnap(), e);
    }
    for (const e of [...this._errors, ...this._inFlightErrors]) {
      if (e.callId === undefined) continue;
      m[e.callId] = accumulateError(m[e.callId] ?? emptySnap());
    }
    return m;
  }

  byScope(): Record<string, CostSnapshot> {
    const m: Record<string, CostSnapshot> = {};
    for (const e of [...this._events, ...this._inFlightEvents]) {
      if (e.scopeId === undefined) continue;
      m[e.scopeId] = accumulate(m[e.scopeId] ?? emptySnap(), e);
    }
    for (const e of [...this._errors, ...this._inFlightErrors]) {
      if (e.scopeId === undefined) continue;
      m[e.scopeId] = accumulateError(m[e.scopeId] ?? emptySnap());
    }
    return m;
  }

  openScope(scopeId?: string): CostScopeHandle {
    const id = scopeId ?? _costAggDeps.newCorrelationId();
    this._openScopes.add(id);
    let closed = false;

    return {
      scopeId: id,
      snapshot: (): CostSnapshot => {
        const matching = [...this._events, ...this._inFlightEvents].filter((e) => e.scopeId === id);
        const matchingErrors = [...this._errors, ...this._inFlightErrors].filter((e) => e.scopeId === id);
        const eventSnapshot = matching.reduce(accumulate, emptySnap());
        return matchingErrors.reduce((snap) => accumulateError(snap), eventSnapshot);
      },
      close: (): void => {
        if (closed) return;
        closed = true;
        this._openScopes.delete(id);
      },
    };
  }

  async drain(): Promise<void> {
    const openScopeCount = this._openScopes.size;
    if (openScopeCount > 0) {
      _costAggDeps.getSafeLogger()?.warn("cost-aggregator", "drain called with open scopes", { openScopeCount });
    }

    this._draining = true;
    try {
      const events = this._events.splice(0);
      const errors = this._errors.splice(0);

      if (events.length === 0 && errors.length === 0) return;

      mkdirSync(this._drainDir, { recursive: true });
      const path = join(this._drainDir, `${this._runId}.jsonl`);

      const sorted = [...events, ...errors].sort((a, b) => a.ts - b.ts);
      await _costAggDeps.write(path, `${sorted.map((e) => JSON.stringify(e)).join("\n")}\n`);

      // Flush any events that arrived during the async write.
      // Re-write the complete merged file so the first batch is not lost.
      const lateEvents = this._inFlightEvents.splice(0);
      const lateErrors = this._inFlightErrors.splice(0);
      if (lateEvents.length > 0 || lateErrors.length > 0) {
        const allSorted = [...sorted, ...lateEvents, ...lateErrors].sort((a, b) => a.ts - b.ts);
        await _costAggDeps.write(path, `${allSorted.map((e) => JSON.stringify(e)).join("\n")}\n`);
      }
    } finally {
      this._draining = false;
    }
  }
}
