export interface CostEvent {
  readonly ts: number;
  readonly runId: string;
  readonly agentName: string;
  readonly model: string;
  readonly stage?: string;
  readonly storyId?: string;
  readonly packageDir?: string;
  readonly tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  /** Estimated cost from token usage × pricing rates (always present). */
  readonly estimatedCostUsd: number;
  /** Exact cost reported by wire protocol (when available). */
  readonly exactCostUsd?: number;
  /** Canonical cost for budget/totals: exact when available, else estimated. */
  readonly costUsd: number;
  /** Confidence derived from presence of exactCostUsd. */
  readonly confidence: "exact" | "estimated";
  readonly durationMs: number;
}

export interface CostErrorEvent {
  readonly ts: number;
  readonly runId: string;
  readonly agentName: string;
  readonly model?: string;
  readonly stage?: string;
  readonly storyId?: string;
  readonly errorCode: string;
  readonly durationMs: number;
}

export interface CostSnapshot {
  readonly totalCostUsd: number;
  readonly totalEstimatedCostUsd: number;
  readonly totalExactCostUsd?: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly callCount: number;
  readonly errorCount: number;
}

export interface ICostAggregator {
  record(event: CostEvent): void;
  recordError(event: CostErrorEvent): void;
  snapshot(): CostSnapshot;
  byAgent(): Record<string, CostSnapshot>;
  byStage(): Record<string, CostSnapshot>;
  byStory(): Record<string, CostSnapshot>;
  drain(): Promise<void>;
}

const EMPTY_SNAPSHOT: CostSnapshot = {
  totalCostUsd: 0,
  totalEstimatedCostUsd: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  callCount: 0,
  errorCount: 0,
};

export function createNoOpCostAggregator(): ICostAggregator {
  return {
    record() {},
    recordError() {},
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
    async drain() {},
  };
}

import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** Injectable deps — swap `write` in tests to avoid real disk I/O. */
export const _costAggDeps = {
  write: (path: string, data: string): Promise<number> => Bun.write(path, data),
};

function emptySnap(): CostSnapshot {
  return {
    totalCostUsd: 0,
    totalEstimatedCostUsd: 0,
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
    totalExactCostUsd: e.exactCostUsd != null ? (snap.totalExactCostUsd ?? 0) + e.exactCostUsd : snap.totalExactCostUsd,
    totalInputTokens: snap.totalInputTokens + e.tokens.input,
    totalOutputTokens: snap.totalOutputTokens + e.tokens.output,
    callCount: snap.callCount + 1,
    errorCount: snap.errorCount,
  };
}

export class CostAggregator implements ICostAggregator {
  private readonly _events: CostEvent[] = [];
  private readonly _errors: CostErrorEvent[] = [];
  private _draining = false;
  private _inFlightEvents: CostEvent[] = [];
  private _inFlightErrors: CostErrorEvent[] = [];

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

  async drain(): Promise<void> {
    this._draining = true;
    try {
      const events = [...this._events];
      const errors = [...this._errors];
      this._events.length = 0;
      this._errors.length = 0;

      if (
        events.length === 0 &&
        errors.length === 0 &&
        this._inFlightEvents.length === 0 &&
        this._inFlightErrors.length === 0
      )
        return;

      mkdirSync(this._drainDir, { recursive: true });
      const path = join(this._drainDir, `${this._runId}.jsonl`);

      const sorted = [...events, ...errors].sort((a, b) => a.ts - b.ts);
      const content = `${sorted.map((e) => JSON.stringify(e)).join("\n")}\n`;
      await _costAggDeps.write(path, content);

      if (this._inFlightEvents.length > 0 || this._inFlightErrors.length > 0) {
        const lateEvents = [...this._inFlightEvents];
        const lateErrors = [...this._inFlightErrors];
        this._inFlightEvents.length = 0;
        this._inFlightErrors.length = 0;
        const lateSorted = [...lateEvents, ...lateErrors].sort((a, b) => a.ts - b.ts);
        const lateContent = `${lateSorted.map((e) => JSON.stringify(e)).join("\n")}\n`;
        await _costAggDeps.write(path, lateContent);
      }
    } finally {
      this._draining = false;
    }
  }
}
