export interface CostEvent {
  readonly ts: number;
  readonly runId: string;
  readonly agentName: string;
  readonly model: string;
  readonly stage?: string;
  readonly storyId?: string;
  readonly packageDir?: string;
  readonly tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  readonly costUsd: number;
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
