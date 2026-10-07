/**
 * Per-turn events a backend pushes to `SendTurnOpts.onTurnEvent` (S3 spec
 * 5.3, 5.4). Backend-neutral: the S3 facade adds `sessionId`, `turnId`, `at`
 * and `metadata` and turns these into its `SessionEvent`s. nax sets no sink.
 *
 * - Deltas are provisional. `after_response` handlers may patch the recorded
 *   text, so the transcript and `TurnResult.output` are authoritative.
 * - `stream_reset` voids the deltas of `round` so far: the round's request is
 *   being re-issued (a retry), and `attempt` is the new attempt's 1-based number.
 * - `usage` is one per round-trip model call and marks the round's end.
 * - `stream_reset` voids everything since the failed attempt began, including
 *   any retry backoff; the deltas after it are the new attempt's.
 * - `usage` excludes the compaction summary call, so a turn's totals come from
 *   `TurnResult` (`tokenUsage`, `estimatedCostUsd`), not from summing events.
 * - `tool_call.input` and `tool_result.preview` are redacted BEST-EFFORT (the
 *   logger's redactor: secret-named keys, known token shapes, KEY=value text)
 *   and byte-capped. A secret file's text can still appear; treat previews and
 *   inputs as sensitive. Text and thinking deltas are not redacted.
 * - Every `tool_call` is followed by exactly one `tool_result`, also when the
 *   turn throws. A refusal is a non-error result carrying the refusal text.
 *   Calls the loop answers without running (spin stop, cancel) and `ask_human`
 *   emit no tool events; they appear only in the transcript.
 */
export type TurnEvent =
  | { readonly type: "text_delta"; readonly round: number; readonly text: string }
  | { readonly type: "thinking_delta"; readonly round: number; readonly text: string }
  | { readonly type: "stream_reset"; readonly round: number; readonly attempt: number }
  | { readonly type: "tool_call"; readonly callId: string; readonly name: string; readonly input: unknown }
  | {
      readonly type: "tool_result";
      readonly callId: string;
      readonly isError: boolean;
      readonly preview: string;
      /** UTF-8 byte length of the full result before the preview cap (S4b spec 7.4). Absent when unknown. */
      readonly resultBytes?: number;
    }
  /** A running tool's liveness beat (an ACP heartbeat); carries no content. Not a session event. */
  | { readonly type: "tool_progress"; readonly callId: string }
  | {
      readonly type: "usage";
      readonly round: number;
      readonly inputTokens: number;
      readonly outputTokens: number;
      /** Absent when the call reported no cache data -- never coerced to 0. */
      readonly cacheRead?: number;
      /** Absent when the call reported no cache data -- never coerced to 0. */
      readonly cacheWrite?: number;
      readonly costUsd: number;
      /**
       * Absent means computed from the catalog (the native backend). `unpriced`
       * rows carry `costUsd: 0` and must not be summed as a real cost.
       */
      readonly costSource?: import("./agent-session-types.ts").CostSource;
    }
  | { readonly type: "compaction"; readonly reason: "proactive" | "overflow" };

/** The per-turn sink. Called synchronously; a throw or a rejected promise is contained by the backend. */
export type TurnEventSink = (event: TurnEvent) => void;
