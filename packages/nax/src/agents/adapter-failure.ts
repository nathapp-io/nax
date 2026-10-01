/**
 * Failure descriptor returned (or synthesized) by an agent adapter. Part of the
 * session contract (S1 spec section 4.2, port 2); `context/engine` re-exports it.
 */

export interface AdapterFailure {
  /**
   * "availability" — vendor quota, rate-limit, service down, auth error.
   *   Triggers agent fallback (same tier, different agent).
   * "quality" — review/verify rejected output.
   *   Triggers tier escalation by default; agent fallback is opt-in.
   */
  category: "availability" | "quality";
  /**
   * Machine-readable outcome code.
   * availability: fail-quota | fail-service-down | fail-auth | fail-rate-limit | fail-aborted | fail-stale
   * quality:      fail-timeout | fail-adapter-error | fail-quality | fail-unknown | fail-spin | fail-incomplete
   *
   * `fail-aborted` — the run was cancelled via AgentRunOptions.abortSignal
   * (shutdown in progress). Not retriable; fallback chains should not fire.
   * `fail-stale` — either (a) the idle watchdog cancelled due to no stream activity
   * within the configured idle timeout, or (b) the agent finished cleanly with empty
   * output. The `reason` field distinguishes: "idle-watchdog" vs "empty-output".
   * Retriable up to maxRetryAttempts.
   * `fail-spin` — the spin breaker ended the turn: the model kept issuing tool
   * calls whose shape it had already issued, with no new work between them
   * (nax#2013). Distinct from `fail-timeout` on purpose — both mean "no usable
   * answer within the budget", but only this one is measurable as a spin, and
   * #2013 exists because the failure mode was invisible. Retriable: the retry
   * opens a fresh session, so the repetition is not carried forward.
   * `fail-incomplete` — the turn ended with tool calls outstanding (transport's
   * `turnIncomplete` fact), reachable through `normalizeHopOutput` even when the
   * turn carries prose (nax#2054). Distinct from `fail-quality` on purpose: that
   * outcome's policy is sameAgentRetry "none" + swap "quality-gated", which would
   * hard-fail with no retry or swap when `agent.fallback.onQualityFailure` is off.
   * Retriable on the timeout lane, same as `fail-spin`.
   * `fail-invalid-tool-call` — the invalid-call budget ended the turn (nax#2047);
   * not a timeout, so the retry names the rejected call (nax#2200). Timeout lane.
   */
  outcome:
    | "fail-quota"
    | "fail-service-down"
    | "fail-auth"
    | "fail-rate-limit"
    | "fail-aborted"
    | "fail-stale"
    | "fail-timeout"
    | "fail-adapter-error"
    | "fail-quality"
    | "fail-unknown"
    | "fail-spin"
    | "fail-incomplete"
    | "fail-invalid-tool-call";
  /** Human-readable description (≤500 chars) for the failure-note chunk */
  message: string;
  /** True when the same agent/tier could succeed on immediate retry */
  retriable: boolean;
  /** Seconds to wait before retrying (for rate-limit failures) */
  retryAfterSeconds?: number;
  /**
   * Observability tag — distinguishes outcome subtypes. No semantic effect on retry/swap.
   * Examples: "idle-watchdog" (fail-stale from idle watchdog cancellation),
   * "empty-output" (fail-stale synthesized when agent returned no output).
   */
  reason?: string;
  /** The rejected call behind a `fail-invalid-tool-call`, for the retry prompt. */
  invalidToolCall?: import("./session-types").InvalidToolCallDetail;
}
