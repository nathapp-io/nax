/**
 * `agent.acp.promptRetries` on the sdk transport (S4b spec §7.2, S4b-0 Ruling
 * T1-1). This is agent-internal retry, below any dispatch decision, so it is not
 * a RetryStrategy (retry-strategy.md "Scope: dispatch tiers only"): acpx ran the
 * same loop inside its own process. It follows acpx 0.19.4 exactly: only a
 * JSON-RPC internal (-32603) or parse (-32700) error, which includes a rate
 * limit, and only when the attempt produced no turn event at all (checked by
 * the caller); backoff min(1000 * 2^n, 10000) ms with no jitter. A session the
 * agent no longer knows is recovered by re-opening, never resent (D3-f).
 */
import { codeOf, contextOf, isSessionGone } from "./failure-map";

export const PROMPT_RETRY_BASE_MS = 1_000;
export const PROMPT_RETRY_MAX_MS = 10_000;

const RETRYABLE_RPC_CODES: ReadonlySet<number> = new Set([-32603, -32700]);

export function isRetryablePromptError(err: unknown): boolean {
  if (isSessionGone(err)) return false;
  const code = codeOf(err);
  if (code === "AGENT_SESSION_RATE_LIMITED") return true;
  if (code !== "AGENT_SESSION_TURN_FAILED") return false;
  const rpcCode = contextOf(err).rpcCode;
  return typeof rpcCode === "number" && RETRYABLE_RPC_CODES.has(rpcCode);
}

/** `retryIndex` 0 is the wait before the first retry. */
export function promptRetryDelayMs(retryIndex: number): number {
  return Math.min(PROMPT_RETRY_BASE_MS * 2 ** retryIndex, PROMPT_RETRY_MAX_MS);
}
