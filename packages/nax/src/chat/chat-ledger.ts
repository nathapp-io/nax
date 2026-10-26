import { join } from "node:path";
import type { SessionEvent } from "@nathapp/nax-agent";
import { CostAggregator } from "@/runtime";
import { COST_ROW_SCHEMA_VERSION } from "@/runtime/middleware";

export type ChatUsageEvent = Extract<SessionEvent, { type: "usage" }>;

export type ChatLedgerRole = "tui" | "subagent";

export interface ChatLedger {
  /** `role` is the row's `sessionRole`; the chat session's own usage is `tui` (the default). */
  record(event: ChatUsageEvent, previousAt: string, model?: string, role?: ChatLedgerRole): void;
  drain(): Promise<void>;
}

export interface ChatLedgerOptions {
  readonly sessionId: string;
  readonly projectKey: string;
  readonly model: string;
  readonly outputDir: string;
  readonly startedAt: Date;
}

/** One process ledger, retaining an aggregator per session so reopens never discard prior rows. */
export function createChatLedger(options: ChatLedgerOptions): ChatLedger {
  const aggregators = new Map<string, CostAggregator>();
  return {
    record(event, previousAt, model = options.model, role = "tui") {
      const runId = `chat-${event.sessionId}-${options.startedAt.getTime()}`;
      let aggregator = aggregators.get(runId);
      if (!aggregator) {
        aggregator = new CostAggregator(runId, join(options.outputDir, "cost"));
        aggregators.set(runId, aggregator);
      }
      const exact = event.costSource !== "unpriced";
      aggregator.record({
        ts: Date.parse(event.at),
        runId,
        projectKey: options.projectKey,
        schemaVersion: COST_ROW_SCHEMA_VERSION,
        agentName: "native",
        model,
        stage: "chat",
        sessionRole: role,
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
    async drain() {
      await Promise.all([...aggregators.values()].map((aggregator) => aggregator.drain()));
    },
  };
}
