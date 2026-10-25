import { join } from "node:path";
import type { SessionEvent } from "@nathapp/nax-agent";
import { CostAggregator } from "@/runtime";
import { COST_ROW_SCHEMA_VERSION } from "@/runtime/middleware";

export type ChatUsageEvent = Extract<SessionEvent, { type: "usage" }>;

export interface ChatLedger {
  record(event: ChatUsageEvent, previousAt: string): void;
  drain(): Promise<void>;
}

export interface ChatLedgerOptions {
  readonly sessionId: string;
  readonly projectKey: string;
  readonly model: string;
  readonly outputDir: string;
  readonly startedAt: Date;
}

/** One aggregator per process: a resumed session must not rewrite earlier rows. */
export function createChatLedger(options: ChatLedgerOptions): ChatLedger {
  const runId = `chat-${options.sessionId}-${options.startedAt.getTime()}`;
  const aggregator = new CostAggregator(runId, join(options.outputDir, "cost"));
  return {
    record(event, previousAt) {
      const exact = event.costSource !== "unpriced";
      aggregator.record({
        ts: Date.parse(event.at),
        runId,
        projectKey: options.projectKey,
        schemaVersion: COST_ROW_SCHEMA_VERSION,
        agentName: "native",
        model: options.model,
        stage: "chat",
        sessionRole: "tui",
        turnId: event.turnId,
        durationMs: Date.parse(event.at) - Date.parse(previousAt),
        tokens: {
          input: event.inputTokens,
          output: event.outputTokens,
          ...(event.cacheRead !== undefined ? { cacheRead: event.cacheRead } : {}),
          ...(event.cacheWrite !== undefined ? { cacheWrite: event.cacheWrite } : {}),
        },
        costUsd: event.costUsd,
        confidence: exact ? "exact" : "estimated",
        exactCostUsd: exact ? event.costUsd : 0,
        estimatedCostUsd: exact ? 0 : event.costUsd,
      });
    },
    drain: () => aggregator.drain(),
  };
}
