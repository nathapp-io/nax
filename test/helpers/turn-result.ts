/**
 * `TurnResult` fixtures.
 *
 * Four required fields, of which tests typically set only `output`. Sites wrote
 * that one plus `turnId` — a field `TurnResult` does not have (it lives nested
 * at `protocolIds.turnId`) — and the excess-property error masked the fact that
 * required `internalRoundTrips` was missing. Complete defaults here mean the
 * compiler checks whichever field the test is actually asserting on
 * (#1514 dead-fixture-keys).
 */
import type { TurnResult } from "@/agents/types";

export function makeTurnResult(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    output: "",
    tokenUsage: { inputTokens: 0, outputTokens: 0 },
    estimatedCostUsd: 0,
    internalRoundTrips: 1,
    ...overrides,
  };
}
