import { resolvePricingSource } from "@/agents";
import type { CostErrorEvent, CostEvent, ICostAggregator, OperationSummaryEvent } from "../cost-aggregator";
import type { DispatchErrorEvent, DispatchEvent, IDispatchEventBus, OperationCompletedEvent } from "../dispatch-events";

/**
 * Cost-row schema version.
 *
 * 1 — implicit, pre-#1433. `model` was hardcoded to the literal "unknown" on
 *     every row; `modelTier`, `sessionRole`, `featureName`, `profile`,
 *     `pricingSource` and `projectKey` did not exist; and error rows were
 *     indistinguishable from genuine zero-cost rows.
 *
 *     These rows cannot be backfilled — `model` in particular is unrecoverable —
 *     so a row *without* this field must be read as model-unattributed rather
 *     than treating its "unknown" as a value.
 *
 * 2 — Guarantees, on every row: `model` (falling back to "unknown"
 *     only when the dispatch resolved none), `sessionRole`, `pricingSource`,
 *     `schemaVersion`, and `projectKey` when the runtime supplied one.
 *     `modelTier` is present only when a tier selected the model — an explicit
 *     `{ agent, model }` pin reports none rather than a fabricated tier.
 *     Error rows additionally carry `kind: "error"`.
 *
 * 3 — (#1464). `model` is now the bare id with any `[effort]` suffix stripped,
 *     so rate cards keyed on the bare id (e.g. `gpt-5.6-luna`) apply to
 *     `MODEL_PRICING` lookups that previously could never match the composite
 *     string. `effort` is present when the resolved model spec named a
 *     reasoning effort, omitted otherwise.
 *
 *     IMPORTANT: v2 rows carry COMPOSITE models (`gpt-5.6-luna[high]`). A
 *     consumer aggregating across the v2/v3 boundary will see
 *     `gpt-5.6-luna[high]` and `gpt-5.6-luna` as distinct keys unless it
 *     normalizes v2 rows itself.
 *
 * 4 — current (US-001). Session-turn rows additionally carry `roundTrips` and
 *     `roundTripUnit` (the unit discriminates ACP's delegated-agent-run count
 *     from native's model-call count — averaging the two without the
 *     discriminator produces a meaningless number, so the count is never
 *     persisted alone). A session-turn whose dispatch carried no `tokenUsage`
 *     and no `exactCostUsd` still records a row, with `usageMissing: true` and
 *     the `tokens` field omitted entirely; the loop-length signal is preserved
 *     even when token accounting is absent. `complete` events carry neither
 *     `roundTrips` nor `roundTripUnit` and the row omits both rather than
 *     defaulting them to `1`. Error rows additionally carry `model` (omitted
 *     when no `modelDef` was attributed, never defaulted to "unknown").
 *
 * Bump this when adding or changing a field consumers key on, and extend the
 * list above — the constant is how a reader learns what a row guarantees.
 */
export const COST_ROW_SCHEMA_VERSION = 4;

export function attachCostSubscriber(
  bus: IDispatchEventBus,
  aggregator: ICostAggregator,
  runId: string,
  /**
   * Stable project identity. `runId` and `storyId` are project-local and collide
   * across repos, so a row lifted out of its directory cannot otherwise say where
   * it came from — the same defect #1429 fixed for curator observations.
   */
  projectKey?: string,
): () => void {
  const offDispatch = bus.onDispatch((event: DispatchEvent) => {
    const tu = event.tokenUsage;
    const wireExactCostUsd = event.exactCostUsd;
    const estimatedCostUsd = event.estimatedCostUsd ?? 0;

    const hasWireExactCost = typeof wireExactCostUsd === "number" && Number.isFinite(wireExactCostUsd);
    const exactCostUsd = hasWireExactCost ? wireExactCostUsd : estimatedCostUsd;
    const confidence: "exact" | "estimated" = hasWireExactCost ? "exact" : "estimated";

    // US-001: session-turn dispatches are recorded even when token usage and
    // exact cost are both absent. The cost row still carries roundTrips /
    // roundTripUnit / round-trip-cost / role attribution, plus `usageMissing:
    // true` to flag the absent token accounting — preserving the loop-length
    // signal (the AC's stated motivation) without a zeroed `tokens` object
    // (which would re-create the "failed vs cost zero" ambiguity the
    // `kind: "error"` discriminator was added for).
    //
    // `complete` dispatches still skip when no token usage AND no exact cost
    // — the AC is explicit that this asymmetry is intentional, and the
    // pre-existing "skips emit when no tokenUsage and no exactCostUsd" test
    // is the load-bearing assertion for that path.
    const isSessionTurn = event.kind === "session-turn";
    if (!isSessionTurn && !tu && exactCostUsd === 0) return;

    // `usageMissing` is set only for session-turn rows that have no token
    // accounting. complete rows are not flagged — they have their own skip
    // path, and a complete-with-zero-usage row is structurally different from
    // a session-turn-with-zero-usage row.
    const usageMissing = isSessionTurn && !tu ? true : undefined;

    const costEvent: CostEvent = {
      ts: event.timestamp,
      runId,
      ...(projectKey !== undefined ? { projectKey } : {}),
      schemaVersion: COST_ROW_SCHEMA_VERSION,
      agentName: event.agentName,
      // #1433: this was the literal "unknown" on every row, because DispatchEvent
      // carried no model. It still falls back to "unknown" when a dispatch has no
      // resolved model, but that is now a real signal rather than a constant.
      model: event.model ?? "unknown",
      ...(event.modelTier !== undefined ? { modelTier: event.modelTier } : {}),
      ...(event.effort !== undefined ? { effort: event.effort } : {}),
      ...(event.profile !== undefined ? { profile: event.profile } : {}),
      stage: event.stage,
      // Both already on the event and previously discarded. sessionRole is the
      // sub-stage attribution key: `stage` alone collapses 23 roles into 6 buckets.
      sessionRole: event.sessionRole,
      ...(event.featureName !== undefined ? { featureName: event.featureName } : {}),
      storyId: event.storyId,
      callId: event.callId,
      scopeId: event.scopeId,
      // US-001: omit `tokens` on a `usageMissing` row. Carrying a zeroed
      // `tokens: { input: 0, output: 0 }` object would re-create the
      // "failed vs cost zero" ambiguity the `kind: "error"` discriminator
      // was added for (#1433) — a reader could not tell "we don't know
      // the tokens" apart from "the call cost zero tokens".
      ...(tu
        ? {
            tokens: {
              input: tu.inputTokens ?? 0,
              output: tu.outputTokens ?? 0,
              cacheRead: tu.cacheReadInputTokens,
              cacheWrite: tu.cacheCreationInputTokens,
            },
          }
        : {}),
      // US-001: roundTrips / roundTripUnit live only on session-turn events.
      // complete events have neither, and the cost row omits both rather than
      // defaulting them to `1` so a reader can tell "unknown loop length"
      // apart from "one round-trip".
      ...(event.kind === "session-turn" ? { roundTrips: event.roundTrips } : {}),
      ...(event.kind === "session-turn" ? { roundTripUnit: event.roundTripUnit } : {}),
      ...(usageMissing !== undefined ? { usageMissing } : {}),
      estimatedCostUsd,
      exactCostUsd,
      costUsd: exactCostUsd,
      confidence,
      // US-004: a wire-exact cost still wins; otherwise a pricingSource carried
      // on the event is used as-is, and `resolvePricingSource(event.model)` is
      // consulted only when the event carries none. This is the same
      // producer-supplied-wins precedent the "wire" branch on this line
      // already sets — the native adapter (US-003) reports its rate card via
      // CompleteResult.pricingSource / TurnResult.pricingSource, and the
      // dispatch event forwards it here. The ACP path supplies no value, so
      // the ACP behaviour is unchanged.
      pricingSource: hasWireExactCost ? "wire" : (event.pricingSource ?? resolvePricingSource(event.model)),
      durationMs: event.durationMs,
    };
    aggregator.record(costEvent);
  });

  const offError = bus.onDispatchError((event: DispatchErrorEvent) => {
    // US-001: failed dispatches record spent usage. Lift tokenUsage,
    // estimatedCostUsd, exactCostUsd and sessionRole off the dispatch event
    // when the producer supplied them — a SessionTurnError that carries
    // BUG-57 usage lands here as a thrown turn. `tokens` stays undefined
    // when no usage arrived, so a zeroed `tokens` object never recreates
    // the "failed vs cost zero" ambiguity the `kind:"error"` discriminator
    // was added for.
    const tu = event.tokenUsage;
    const costUsd = event.exactCostUsd ?? event.estimatedCostUsd;
    const errorEvent: CostErrorEvent = {
      kind: "error",
      ts: event.timestamp,
      runId,
      ...(projectKey !== undefined ? { projectKey } : {}),
      schemaVersion: COST_ROW_SCHEMA_VERSION,
      agentName: event.agentName,
      // US-001: error rows now carry the model the dispatch was pinned to,
      // when `buildDispatchErrorEvent` resolved one. Omitted (not "unknown")
      // when no `modelDef` was attributed — a failed dispatch with no model
      // is not the same as one that ran on a known model.
      ...(event.model !== undefined ? { model: event.model } : {}),
      ...(event.modelTier !== undefined ? { modelTier: event.modelTier } : {}),
      ...(event.effort !== undefined ? { effort: event.effort } : {}),
      stage: event.stage,
      storyId: event.storyId,
      callId: event.callId,
      scopeId: event.scopeId,
      errorCode: event.errorCode,
      durationMs: event.durationMs,
      ...(event.sessionRole !== undefined ? { sessionRole: event.sessionRole } : {}),
      ...(tu
        ? {
            tokens: {
              input: tu.inputTokens ?? 0,
              output: tu.outputTokens ?? 0,
              cacheRead: tu.cacheReadInputTokens,
              cacheWrite: tu.cacheCreationInputTokens,
            },
          }
        : {}),
      ...(event.estimatedCostUsd !== undefined ? { estimatedCostUsd: event.estimatedCostUsd } : {}),
      ...(event.exactCostUsd !== undefined ? { exactCostUsd: event.exactCostUsd } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
    };
    aggregator.recordError(errorEvent);
  });

  const offCompleted = bus.onOperationCompleted((event: OperationCompletedEvent) => {
    const summary: OperationSummaryEvent = {
      runId,
      operation: event.operation,
      hopCount: event.hopCount,
      fallbackTriggered: event.fallbackTriggered,
      totalCostUsd: event.totalCostUsd,
      totalElapsedMs: event.totalElapsedMs,
      finalStatus: event.finalStatus,
    };
    aggregator.recordOperationSummary(summary);
  });

  return () => {
    offDispatch();
    offError();
    offCompleted();
  };
}
