/**
 * A turn's end as the answer to `session/prompt` (S5 spec §4.4). `errored` is a
 * JSON-RPC error so editors show a failure, not a normal stop; a credential
 * failure is `auth_required` (S5-4 M-32). `interrupted` only occurs after a
 * resume and is reported the same way if it ever reaches here.
 */
import { type PromptResponse, RequestError, type SessionUpdate, type Usage } from "@agentclientprotocol/sdk";
import { redactSecrets, type SessionEvent, type TokenUsage } from "@nathapp/nax-agent";
import { authRequired, isAuthFailureCode } from "#src/server/errors";
import { announce } from "#src/server/translate/notice";

export type TurnEndEvent = Extract<SessionEvent, { type: "turn_end" }>;

export type PromptOutcome =
  | { readonly kind: "response"; readonly response: PromptResponse; readonly notices: readonly SessionUpdate[] }
  | { readonly kind: "error"; readonly error: RequestError };

export function toAcpUsage(usage: TokenUsage): Usage {
  const cacheRead = usage.cacheReadTokens;
  const cacheWrite = usage.cacheWriteTokens;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(cacheRead !== undefined ? { cachedReadTokens: cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cachedWriteTokens: cacheWrite } : {}),
    totalTokens: usage.inputTokens + usage.outputTokens + (cacheRead ?? 0) + (cacheWrite ?? 0),
  };
}

function failure(code: string, message: string): PromptOutcome {
  if (isAuthFailureCode(code)) return { kind: "error", error: authRequired(redactSecrets(message), { code, message }) };
  return { kind: "error", error: RequestError.internalError({ code, message }, message) };
}

/** `notices`: whether the client advertised `session.notices` (else warnings become agent text). */
export function promptOutcome(end: TurnEndEvent, turnTimeoutSeconds: number, notices: boolean): PromptOutcome {
  const usage = toAcpUsage(end.usage);
  switch (end.status) {
    case "completed":
      return { kind: "response", response: { stopReason: "end_turn", usage }, notices: [] };
    case "cancelled":
      return { kind: "response", response: { stopReason: "cancelled", usage }, notices: [] };
    case "timed_out":
      return {
        kind: "response",
        response: { stopReason: "max_turn_requests", usage },
        notices: [
          announce(
            notices,
            "warning",
            "Turn timed out",
            `The turn reached its ${turnTimeoutSeconds}s time limit and was stopped.`,
          ),
        ],
      };
    case "errored":
      return failure(end.error?.code ?? "AGENT_TURN_ERRORED", end.error?.message ?? "The turn failed");
    case "interrupted":
      return failure("AGENT_TURN_INTERRUPTED", "The turn was interrupted");
  }
}
