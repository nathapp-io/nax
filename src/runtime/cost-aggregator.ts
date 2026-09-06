import { getSafeLogger } from "../logger";

export interface CostEvent {
  readonly ts: number;
  readonly runId: string;
  /** Stable project identity — `runId`/`storyId` collide across repos (#1429). */
  readonly projectKey?: string;
  /**
   * Row schema version; see `COST_ROW_SCHEMA_VERSION`. Absent on pre-#1433 rows,
   * which carry no model, tier, role, profile, pricing-source or project
   * attribution and cannot be backfilled.
   */
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
   * Reasoning effort from nax's `model[effort]` profile-suffix convention
   * (#1464) — a nax-level convention, not an upstream one. Sparse: only codex
   * profiles currently carry a suffix, so most rows omit this field entirely
   * rather than carrying `undefined`. If a future agent expresses reasoning
   * effort differently, this field needs a defined cross-agent meaning rather
   * than "whatever was in brackets" before it can represent that agent too.
   */
  readonly effort?: string;
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
   * - `catalog-rates` — priced from nax-ai's catalog (native adapter, US-003).
   * - `config-override` — an explicit `modelDef.pricing` won wholesale (native
   *   adapter, US-003).
   *
   * The last two are producer-supplied (US-004) and reach the row only when
   * the dispatch event carries them — the cost subscriber copies them
   * through rather than re-deriving. The union here is declared
   * independently of `resolvePricingSource`'s return type; widening only one
   * of the two would leave the feature half-landed and failing typecheck.
   */
  readonly pricingSource?:
    | "wire"
    | "model-rates"
    | "fallback-rates"
    | "unknown-model"
    | "catalog-rates"
    | "config-override";
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
  // US-001 (failed-dispatch cost attribution). `tokens` stays optional and
  // is left undefined when the dispatch error carried no usage — a zeroed
  // `tokens` would re-create the "failed vs cost zero" ambiguity the `kind`
  // discriminator was added for.
  readonly sessionRole?: string;
  readonly tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  readonly estimatedCostUsd?: number;
  readonly exactCostUsd?: number;
  /**
   * Canonical cost for budget/totals: exact when available, else estimated.
   * `totalCostUsd` keeps its successful-spend meaning; failed spend is
   * summed separately into `CostSnapshot.totalErrorCostUsd`.
   */
  readonly costUsd?: number;
}

export interface CostSnapshot {
  readonly totalCostUsd: number;
  readonly totalEstimatedCostUsd: number;
  readonly totalExactCostUsd: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly callCount: number;
  readonly errorCount: number;
  /**
   * Sum of `costUsd` from error rows — spent usage on dispatches that
   * threw. `totalCostUsd` keeps its successful-spend meaning, so failed
   * spend becomes visible without silently re-basing every historical
   * comparison (US-001).
   *
   * Optional on the type so existing test fixtures that build literal
   * `CostSnapshot` objects compile unchanged; absent means zero (no error
   * rows have been recorded).
   */
  readonly totalErrorCostUsd?: number;
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

/** Safety ceiling on drain()'s write-until-empty loop — a steady trickle of
 *  late-arriving events must not turn shutdown into an unbounded resort/rewrite
 *  loop over the full committed set. */
const MAX_DRAIN_PASSES = 20;

const EMPTY_SNAPSHOT: CostSnapshot = {
  totalCostUsd: 0,
  totalEstimatedCostUsd: 0,
  totalExactCostUsd: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  callCount: 0,
  errorCount: 0,
  totalErrorCostUsd: 0,
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
    totalErrorCostUsd: 0,
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
    totalErrorCostUsd: snap.totalErrorCostUsd ?? 0,
  };
}

function accumulateError(snap: CostSnapshot, e?: CostErrorEvent): CostSnapshot {
  return {
    ...snap,
    errorCount: snap.errorCount + 1,
    totalErrorCostUsd: (snap.totalErrorCostUsd ?? 0) + (e?.costUsd ?? 0),
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
    const eventReduced = allEvents.reduce(accumulate, emptySnap());
    return allErrors.reduce((snap, e) => accumulateError(snap, e), eventReduced);
  }

  byAgent(): Record<string, CostSnapshot> {
    const m: Record<string, CostSnapshot> = {};
    for (const e of this._events) m[e.agentName] = accumulate(m[e.agentName] ?? emptySnap(), e);
    for (const e of this._inFlightEvents) m[e.agentName] = accumulate(m[e.agentName] ?? emptySnap(), e);
    for (const e of this._errors) m[e.agentName] = accumulateError(m[e.agentName] ?? emptySnap(), e);
    for (const e of this._inFlightErrors) m[e.agentName] = accumulateError(m[e.agentName] ?? emptySnap(), e);
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
    for (const e of this._errors) {
      const k = e.stage ?? "unknown";
      m[k] = accumulateError(m[k] ?? emptySnap(), e);
    }
    for (const e of this._inFlightErrors) {
      const k = e.stage ?? "unknown";
      m[k] = accumulateError(m[k] ?? emptySnap(), e);
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
    for (const e of this._errors) {
      const k = e.storyId ?? "unknown";
      m[k] = accumulateError(m[k] ?? emptySnap(), e);
    }
    for (const e of this._inFlightErrors) {
      const k = e.storyId ?? "unknown";
      m[k] = accumulateError(m[k] ?? emptySnap(), e);
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
      m[e.callId] = accumulateError(m[e.callId] ?? emptySnap(), e);
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
      m[e.scopeId] = accumulateError(m[e.scopeId] ?? emptySnap(), e);
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
        return matchingErrors.reduce((snap, e) => accumulateError(snap, e), eventSnapshot);
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
      // Splice _events/_errors into the accumulating "committed" set up front,
      // then loop: write it, splice out whatever landed in _inFlightEvents /
      // _inFlightErrors *during* that write, merge it in, and write again.
      // Repeat until a write observes nothing new — a single splice-then-write
      // pass can miss events recorded during the second write itself (BUG-29),
      // so the loop, not the write, is what guarantees emptiness.
      let committed = [...this._events.splice(0), ...this._errors.splice(0)];
      if (committed.length === 0 && this._inFlightEvents.length === 0 && this._inFlightErrors.length === 0) {
        return;
      }

      mkdirSync(this._drainDir, { recursive: true });
      const path = join(this._drainDir, `${this._runId}.jsonl`);

      // Always write at least once so the initial committed batch lands on disk.
      let first = true;
      let pass = 0;
      while (first || this._inFlightEvents.length > 0 || this._inFlightErrors.length > 0) {
        if (++pass > MAX_DRAIN_PASSES) {
          _costAggDeps
            .getSafeLogger()
            ?.warn("cost-aggregator", "drain exceeded max passes — late events keep arriving", {
              pass,
              inFlightEvents: this._inFlightEvents.length,
              inFlightErrors: this._inFlightErrors.length,
            });
          break;
        }
        first = false;
        const late = [...this._inFlightEvents.splice(0), ...this._inFlightErrors.splice(0)];
        committed = [...committed, ...late].sort((a, b) => a.ts - b.ts);
        await _costAggDeps.write(path, `${committed.map((e) => JSON.stringify(e)).join("\n")}\n`);
      }

      // Post-drain, committed is now the full persisted set. Replace _events
      // so snapshot()/byX() readers see exactly what was flushed to disk —
      // otherwise a late arrival that raced the final write would be counted
      // twice (once here, once already merged into `committed`) or a settled
      // in-memory total would permanently diverge from the audit trail.
      const committedEvents = committed.filter((e): e is CostEvent => !("kind" in e && e.kind === "error"));
      const committedErrors = committed.filter((e): e is CostErrorEvent => "kind" in e && e.kind === "error");
      this._events.length = 0;
      this._events.push(...committedEvents);
      this._errors.length = 0;
      this._errors.push(...committedErrors);
    } finally {
      this._draining = false;
    }
  }
}
