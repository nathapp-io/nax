import { join } from "node:path";
import { getSafeLogger } from "../logger";
import { type DrainRow, drainWritePasses } from "./cost-aggregator-drain";
import { writeLedgerAtomic } from "./cost-ledger-write";

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
  /** v7: set on a partial row (a still-unrecorded in-flight turn); absent on every finished row. */
  readonly partial?: boolean;
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
   * Session role (`implementer`, `wf-implementer`, `plan`, …). The
   * sub-stage attribution key — `stage` alone collapses 23 roles into 6 buckets.
   */
  readonly sessionRole?: string;
  readonly featureName?: string;
  readonly storyId?: string;
  readonly packageDir?: string;
  readonly callId?: string;
  readonly scopeId?: string;
  /** Per-turn identity copied from `protocolIds.turnId`; selects a single row within a `callId`. */
  readonly turnId?: string;
  /**
   * Token usage for this dispatch. Omitted on a `usageMissing` row (AC8-10) —
   * a zeroed `tokens` object would re-create the "failed vs cost zero"
   * ambiguity the `kind: "error"` discriminator was added for, so a row with
   * genuinely absent token accounting carries no `tokens` field at all rather
   * than one with `input: 0, output: 0`.
   */
  readonly tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  /**
   * Round-trips inside this turn, copied from the dispatch event. The UNIT
   * travels with the number (`roundTripUnit`) because on ACP each round-trip
   * is a complete delegated agent run while on native each is a single model
   * call — averaging them without the discriminator produces a meaningless
   * number, so the count is never persisted alone.
   *
   * `complete` events carry neither; the cost row omits both fields rather
   * than defaulting them to `1`, so a reader can tell "unknown loop length"
   * apart from "one round-trip" (AC4).
   */
  readonly roundTrips?: number;
  readonly roundTripUnit?: "model-call" | "agent-run";
  /**
   * Set on a successful session-turn row whose dispatch event carried no
   * `tokenUsage` (AC9-11). The cost row still records the dispatch — the
   * loop-length signal is preserved — but token totals are left absent
   * rather than reported as zero, so a reader can distinguish
   * "the call succeeded and burned zero tokens" from
   * "we don't know what it burned".
   */
  readonly usageMissing?: boolean;
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
   * - `model-rates` — estimated from this model's entry in the now-retired
   *   table-backed rate card (US-003 deleted the table; this value is
   *   retained for backward compatibility with pre-US-003 ledger rows).
   * - `fallback-rates` — estimated from the generic $3/$15-per-1M card
   *   because neither the catalog nor an explicit override resolved a rate.
   *   Treat these as indicative only: measured against rows that also had a
   *   wire cost, the estimator ran 0.4x in aggregate and up to 21x off per
   *   row (#1433).
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
  /**
   * The four per-1M rates that priced the call (US-003), sourced from
   * `DispatchEvent.rates` when the producer stamped them. Describes
   * `estimatedCostUsd`, NOT `costUsd` — a wire-exact cost overwrites the row's
   * `pricingSource` to `"wire"` while `rates` still records the estimate's
   * numbers. Omitted (not undefined) when the producer did not stamp.
   */
  readonly rates?: import("./cost-row-rates").CostRowRates;
  readonly auth?: import("@nathapp/nax-agent").AuthStamp;
  /**
   * Version of the catalog package the row's `rates` came from (US-003).
   * Stamped only when the producer's reported `pricingSource` was
   * `"catalog-rates"` — `config-override` and `fallback-rates` rows omit it
   * because their rates did not originate from the catalog, and stamping
   * `catalogVersion` there would falsely assert that origin. Inlined at
   * build time as the version of the pinned `@nathapp/nax-ai` dependency;
   * omitted entirely when that pin is unreadable, so an empty or
   * placeholder string never reaches a row.
   */
  readonly catalogVersion?: string;
  /** nax build that wrote this row (US-007): `NAX_VERSION`. Absent on rows written before it. */
  readonly naxVersion?: string;
  /** `NAX_COMMIT` of that build — read absence as "not recorded", never as "unknown build". */
  readonly naxCommit?: string;
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
  /** Per-turn identity copied from `protocolIds.turnId`; selects a single row within a `callId`. */
  readonly turnId?: string;
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
   * US-002: the rate card that priced the failed dispatch's estimated cost,
   * forwarded from the thrown `SessionTurnError` when it carried one. Error
   * rows omit it when no card was resolved or no estimate was produced.
   */
  readonly pricingSource?: "catalog-rates" | "fallback-rates";
  /**
   * Canonical cost for budget/totals: exact when available, else estimated.
   * `totalCostUsd` keeps its successful-spend meaning; failed spend is
   * summed separately into `CostSnapshot.totalErrorCostUsd`.
   */
  readonly costUsd?: number;
  /** nax build that wrote this row (US-007), as on a successful row. Absent on older rows. */
  readonly naxVersion?: string;
  readonly naxCommit?: string;
}

export interface CostSnapshot {
  readonly totalCostUsd: number;
  readonly totalEstimatedCostUsd: number;
  readonly totalExactCostUsd: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  /** Cache-read tokens across successful dispatches with reported usage. */
  readonly totalCacheReadTokens?: number;
  /** Cache-creation tokens across successful dispatches with reported usage. */
  readonly totalCacheWriteTokens?: number;
  /** Successful dispatches that supplied token usage; distinguishes absent usage from zero usage. */
  readonly tokenUsageCount?: number;
  readonly callCount: number;
  readonly errorCount: number;
  /**
   * Sum of `costUsd` from error rows — spent usage on dispatches that
   * threw. `totalCostUsd` keeps its successful-spend meaning, so failed
   * spend becomes visible without silently re-basing every historical
   * comparison (US-001).
   *
   * Always numeric: a snapshot with no failed dispatches reports zero.
   */
  readonly totalErrorCostUsd: number;
}

/**
 * Every dollar a snapshot accounts for — successful spend plus the spend of
 * dispatches that threw.
 *
 * The SSOT for "what did this actually cost", and the only reading that should
 * ever reach a user, a budget guard, or a run total. `totalCostUsd` alone
 * answers a narrower question — "what did the work that succeeded cost" — and
 * using it where money is meant understates the bill by exactly the failures.
 *
 * The split behind it is preserved on purpose (US-001): a sum cannot be
 * un-summed, so both halves stay on the snapshot and callers that care about
 * wasted spend read `totalErrorCostUsd` directly.
 */
export function totalSpendUsd(snap: Pick<CostSnapshot, "totalCostUsd" | "totalErrorCostUsd">): number {
  return snap.totalCostUsd + snap.totalErrorCostUsd;
}

/** Both halves of one story's spend. Mirrors `RunMetrics.totalCost` / `errorCostUsd`. */
export interface StorySpend {
  /** Every dollar the story accounted for — successful spend plus failed-dispatch spend. */
  cost: number;
  /** The failed half of `cost`. Zero when nothing threw; callers omit the field at zero. */
  errorCostUsd: number;
}

/**
 * Read one story's spend out of the aggregator, folding failed-dispatch spend in.
 *
 * `fallbackUsd` is returned ONLY when the story has no rows at all. This is the
 * distinction #1960 turns on: an error row creates the `byStory()` key, so the
 * pre-#1960 `?.totalCostUsd ?? fallback` saw a snapshot whose successful total
 * was 0, never fired the fallback, and reported `cost: 0` for a story that had
 * burned real money. Pricing failed dispatches made that number strictly worse;
 * reading through here is what fixes it.
 */
export function storySpendUsd(
  costAggregator: ICostAggregator | undefined,
  storyId: string,
  fallbackUsd: number,
): StorySpend {
  const snap = costAggregator?.byStory()[storyId];
  if (snap === undefined) return { cost: fallbackUsd, errorCostUsd: 0 };
  return { cost: totalSpendUsd(snap), errorCostUsd: snap.totalErrorCostUsd };
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
  totalCacheReadTokens: 0,
  totalCacheWriteTokens: 0,
  tokenUsageCount: 0,
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

/** Injectable deps — swap in tests to avoid real disk I/O or logger side-effects. */
export const _costAggDeps = {
  write: (path: string, data: string): Promise<number> => writeLedgerAtomic(path, data),
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
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    tokenUsageCount: 0,
    callCount: 0,
    errorCount: 0,
    totalErrorCostUsd: 0,
  };
}

function accumulate(snap: CostSnapshot, e: CostEvent): CostSnapshot {
  // `tokens` is optional since AC8-10 — a `usageMissing` row omits it rather
  // than carrying a zeroed object. When absent, token counters stay at their
  // current value (zero from a fresh emptySnap()), so totals reflect only
  // dispatches with real token accounting.
  const tokens = e.tokens;
  return {
    totalCostUsd: snap.totalCostUsd + e.costUsd,
    totalEstimatedCostUsd: snap.totalEstimatedCostUsd + e.estimatedCostUsd,
    totalExactCostUsd: snap.totalExactCostUsd + e.exactCostUsd,
    totalInputTokens: snap.totalInputTokens + (tokens?.input ?? 0),
    totalOutputTokens: snap.totalOutputTokens + (tokens?.output ?? 0),
    totalCacheReadTokens: (snap.totalCacheReadTokens ?? 0) + (tokens?.cacheRead ?? 0),
    totalCacheWriteTokens: (snap.totalCacheWriteTokens ?? 0) + (tokens?.cacheWrite ?? 0),
    tokenUsageCount: (snap.tokenUsageCount ?? 0) + (tokens ? 1 : 0),
    callCount: snap.callCount + 1,
    errorCount: snap.errorCount,
    totalErrorCostUsd: snap.totalErrorCostUsd,
  };
}

function accumulateError(snap: CostSnapshot, e?: CostErrorEvent): CostSnapshot {
  return {
    ...snap,
    errorCount: snap.errorCount + 1,
    totalErrorCostUsd: snap.totalErrorCostUsd + (e?.costUsd ?? 0),
  };
}

export class CostAggregator implements ICostAggregator {
  private readonly _events: CostEvent[] = [];
  private readonly _errors: CostErrorEvent[] = [];
  private _draining = false;
  private readonly _inFlightEvents: CostEvent[] = [];
  private readonly _inFlightErrors: CostErrorEvent[] = [];
  private readonly _openScopes = new Set<string>();
  /** Settles when the last queued drain does — never rejects, so a failure cannot cancel the queue. */
  private _drainTail: Promise<void> = Promise.resolve();
  /** Drains running or waiting on `_drainTail`; zero means a new drain may start immediately. */
  private _pendingDrains = 0;

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

  drain(): Promise<void> {
    const openScopeCount = this._openScopes.size;
    if (openScopeCount > 0) {
      _costAggDeps.getSafeLogger()?.warn("cost-aggregator", "drain called with open scopes", { openScopeCount });
    }

    this._pendingDrains++;
    // Drains run one at a time. With an idle queue the first write pass starts
    // synchronously, so an event recorded right after `drain()` lands in the
    // in-flight buffer rather than a set this drain already copied; with one
    // pending, the drain queues behind it on `_drainTail`.
    const next =
      this._pendingDrains === 1 ? this._drainAllPasses() : this._drainTail.then(() => this._drainAllPasses());
    // The tail never rejects: a failed drain must not cancel the drains behind it.
    this._drainTail = next.catch(() => {});
    return next;
  }

  private async _drainAllPasses(): Promise<void> {
    this._draining = true;
    // A copy, not a splice: the rows being written stay in `_events`, so a mid-drain
    // snapshot counts them and a write that throws leaves them retained.
    const committed: DrainRow[] = [...this._events, ...this._errors];
    try {
      if (committed.length === 0 && this._inFlightEvents.length === 0 && this._inFlightErrors.length === 0) return;
      await drainWritePasses({
        dir: this._drainDir,
        path: join(this._drainDir, `${this._runId}.jsonl`),
        committed,
        takeInFlight: () => {
          const late: DrainRow[] = [...this._inFlightEvents, ...this._inFlightErrors];
          this._retain();
          return late;
        },
        inFlightCount: () => ({ events: this._inFlightEvents.length, errors: this._inFlightErrors.length }),
        write: _costAggDeps.write,
        logger: _costAggDeps.getSafeLogger(),
      });
    } finally {
      // Anything that arrived after the last pass's copy belongs to the next drain.
      this._retain();
      this._draining = false;
      this._pendingDrains--;
      this._openScopes.clear();
    }
  }

  /** Move the in-flight buffers into the retained arrays — each is already kind-partitioned,
   *  and doing it as rows arrive is what keeps a mid-drain `snapshot()` from missing them. */
  private _retain(): void {
    this._events.push(...this._inFlightEvents.splice(0));
    this._errors.push(...this._inFlightErrors.splice(0));
  }
}
