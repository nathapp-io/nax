/**
 * A turn's usage (S4 spec §6.7 usage, S4-5 D5-a, D5-b, D5-h). Tokens come from
 * PromptResponse.usage and are per turn as reported: Claude's adapter resets them
 * when a turn starts (D5-a). Output tokens include thought tokens; cache fields stay
 * absent when not reported. Cost comes from usage_update.cost, a cumulative USD
 * reading: the session's meter remembers the reading at the end of the last priced
 * turn (0 for a new agent process), and a turn's cost is its latest reading minus
 * that. A reading below the baseline means the agent's counter restarted, so the
 * raw reading is the turn's cost. No reading: costUsd 0, "unpriced", baseline kept.
 */
import type { PromptResponse } from "@agentclientprotocol/sdk";
import type { TokenUsage, TurnEvent } from "@nathapp/nax-agent";
import { isRecord } from "#src/client/text";

export interface TurnCost {
  readonly costUsd: number;
  readonly costSource: "reported" | "unpriced";
}

export interface TurnSpend extends TurnCost {
  readonly tokenUsage: TokenUsage;
}

export interface CostMeter {
  /** Starts a turn: forgets readings of a turn that never settled. */
  beginTurn(): void;
  /** A usage_update's `cost`: kept when it is a finite, non-negative USD amount. */
  observe(cost: unknown): void;
  /** The turn's cost; a priced turn moves the baseline to its latest reading. */
  settle(): TurnCost;
}

const UNPRICED: TurnCost = Object.freeze({ costUsd: 0, costSource: "unpriced" });

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function usdAmount(cost: unknown): number | undefined {
  if (!isRecord(cost) || typeof cost.amount !== "number" || typeof cost.currency !== "string") return undefined;
  if (cost.currency.trim().toUpperCase() !== "USD") return undefined;
  return Number.isFinite(cost.amount) && cost.amount >= 0 ? cost.amount : undefined;
}

export function tokenUsageOf(usage: unknown): TokenUsage {
  if (!isRecord(usage)) return { inputTokens: 0, outputTokens: 0 };
  const cacheRead = count(usage.cachedReadTokens);
  const cacheWrite = count(usage.cachedWriteTokens);
  return {
    inputTokens: count(usage.inputTokens) ?? 0,
    outputTokens: (count(usage.outputTokens) ?? 0) + (count(usage.thoughtTokens) ?? 0),
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
  };
}

export function createCostMeter(): CostMeter {
  let baseline = 0;
  let latest: number | undefined;
  return {
    beginTurn() {
      latest = undefined;
    },
    observe(cost) {
      const amount = usdAmount(cost);
      if (amount !== undefined) latest = amount;
    },
    settle() {
      if (latest === undefined) return UNPRICED;
      const reading = latest;
      const delta = reading - baseline;
      baseline = reading;
      latest = undefined;
      return { costUsd: delta < 0 ? reading : delta, costSource: "reported" };
    },
  };
}

export function turnSpend(response: PromptResponse, meter: CostMeter): TurnSpend {
  return { tokenUsage: tokenUsageOf(response.usage), ...meter.settle() };
}

export function usageEvent(spend: TurnSpend): TurnEvent {
  const { tokenUsage } = spend;
  return {
    type: "usage",
    round: 0,
    inputTokens: tokenUsage.inputTokens,
    outputTokens: tokenUsage.outputTokens,
    ...(tokenUsage.cacheReadTokens === undefined ? {} : { cacheRead: tokenUsage.cacheReadTokens }),
    ...(tokenUsage.cacheWriteTokens === undefined ? {} : { cacheWrite: tokenUsage.cacheWriteTokens }),
    costUsd: spend.costUsd,
    costSource: spend.costSource,
  };
}
