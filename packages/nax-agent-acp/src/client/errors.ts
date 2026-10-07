/**
 * Errors of the ACP backend (S4 spec §5.7, §7). Classification (auth or not)
 * runs on the agent's raw error here; only the classified code and a redacted,
 * control-stripped excerpt of at most 4 KB reach messages and details.
 */
import { RequestError } from "@agentclientprotocol/sdk";
import { AgentSessionError, NaxError, redactSecrets } from "@nathapp/nax-agent";
import { capBytes, scrubSecrets, stripControl } from "#src/client/text";

/** Byte cap of every agent-text excerpt (stderr, JSON-RPC messages). */
export const EXCERPT_BYTES = 4096;

/** JSON-RPC code of `RequestError.authRequired()`. */
const AUTH_REQUIRED_CODE = -32000;

/** JSON-RPC code of `RequestError.resourceNotFound()`: Claude's adapter answers an unknown session with it (D6-e). */
const RESOURCE_NOT_FOUND_CODE = -32002;

/** The steps whose not-found answer means the agent lost the stored session (§6.9 step 2). */
const RESTORE_STEPS: ReadonlySet<string> = new Set(["session/resume", "session/load"]);

/** Agent text reporting a lost session, for agents that answer with another code. */
const SESSION_NOT_FOUND_TEXT = /session not found|no conversation found/i;

function lostOnRestore(step: string, err: RequestError): boolean {
  return RESTORE_STEPS.has(step) && (err.code === RESOURCE_NOT_FOUND_CODE || SESSION_NOT_FOUND_TEXT.test(err.message));
}

/** Stop reasons other than end_turn, as NaxError codes owned by this package (§5.7). */
export const ACP_STOP_CODES = Object.freeze({
  max_tokens: "ACP_STOP_MAX_TOKENS",
  max_turn_requests: "ACP_STOP_MAX_TURN_REQUESTS",
  refusal: "ACP_STOP_REFUSAL",
  cancelled: "ACP_STOP_CANCELLED",
} as const);

export type AcpStopCode = (typeof ACP_STOP_CODES)[keyof typeof ACP_STOP_CODES];

/** Agent text made safe for an error: control characters stripped (except \n, \t), secrets redacted, capped. */
export function agentTextExcerpt(text: string, secrets: readonly string[]): string {
  return capBytes(redactSecrets(scrubSecrets(stripControl(text), secrets)), EXCERPT_BYTES);
}

export function capabilityUnsupported(capability: string, reason: string): AgentSessionError {
  return new AgentSessionError(
    `The ACP agent cannot meet the "${capability}" requirement: ${reason}`,
    "AGENT_SESSION_CAPABILITY_UNSUPPORTED",
    { capability },
  );
}

export function backendUnavailable(reason: string, details: Readonly<Record<string, unknown>> = {}): AgentSessionError {
  return new AgentSessionError(`The ACP agent is unavailable: ${reason}`, "AGENT_SESSION_BACKEND_UNAVAILABLE", {
    ...details,
  });
}

export function closedDuringOpen(sessionId: string): AgentSessionError {
  return new AgentSessionError(`Session "${sessionId}" was closed while it was opening`, "AGENT_SESSION_CLOSED", {
    sessionId,
  });
}

/** The session cannot run another turn: closed, or its agent is gone and cannot be reconnected (§6.3 step 5). */
export function sessionLost(sessionId: string, reason: string): AgentSessionError {
  return new AgentSessionError(`ACP session "${sessionId}" is closed: ${reason}`, "AGENT_SESSION_CLOSED", {
    sessionId,
  });
}

/** The JSON-RPC error the agent answered with; undefined for transport failures. */
export function rpcErrorOf(err: unknown): RequestError | undefined {
  return err instanceof RequestError ? err : undefined;
}

/**
 * A rejected open-phase request: initialize, session/new, session/resume,
 * session/load or session/set_config_option. Classification runs on the raw
 * message; only the redacted excerpt escapes (§7).
 */
export function openRequestError(step: string, err: RequestError, secrets: readonly string[]): AgentSessionError {
  const excerpt = agentTextExcerpt(err.message, secrets);
  if (err.code === AUTH_REQUIRED_CODE) {
    return new AgentSessionError(
      `The ACP agent requires authentication (${step}): ${excerpt}`,
      "AGENT_SESSION_AUTH_REQUIRED",
      { step },
    );
  }
  if (lostOnRestore(step, err)) {
    return new AgentSessionError(
      `The ACP agent no longer has this session (${step}): ${excerpt}`,
      "AGENT_SESSION_NOT_FOUND",
      { step },
    );
  }
  return backendUnavailable(`${step} failed: ${excerpt}`, { step, rpcCode: err.code });
}

/**
 * A rate limit, read from structured JSON-RPC error data only (S4b spec §8); never
 * from message text. claude-agent-acp sends `data.errorKind: "rate_limit"` and no
 * retry-after (S4b-0 finding a).
 */
export function rateLimitOf(data: unknown): { readonly retryAfterSeconds?: number } | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  return "errorKind" in data && data.errorKind === "rate_limit" ? {} : undefined;
}

/** A rejected session/prompt (§7: a JSON-RPC error on prompt is AGENT_SESSION_TURN_FAILED). */
export function promptRequestError(err: RequestError, secrets: readonly string[]): NaxError {
  const excerpt = agentTextExcerpt(err.message, secrets);
  if (err.code === AUTH_REQUIRED_CODE) {
    return new AgentSessionError(`The ACP agent requires authentication: ${excerpt}`, "AGENT_SESSION_AUTH_REQUIRED", {
      step: "session/prompt",
    });
  }
  const limit = rateLimitOf(err.data);
  if (limit !== undefined) {
    return new AgentSessionError(`The ACP agent was rate-limited: ${excerpt}`, "AGENT_SESSION_RATE_LIMITED", {
      step: "session/prompt",
      ...limit,
    });
  }
  return new NaxError(`The ACP prompt failed: ${excerpt}`, "AGENT_SESSION_TURN_FAILED", {
    stage: "acp",
    rpcCode: err.code,
  });
}

/** A stop reason other than end_turn. Own keys only: "__proto__" or "toString" is unknown, not a code. */
export function stopReasonError(stopReason: string): NaxError {
  if (Object.hasOwn(ACP_STOP_CODES, stopReason)) {
    const code = ACP_STOP_CODES[stopReason as keyof typeof ACP_STOP_CODES];
    return new NaxError(`The ACP agent stopped the turn: ${stopReason}`, code, { stage: "acp", stopReason });
  }
  const shown = agentTextExcerpt(stopReason, []).slice(0, 64);
  return new NaxError(
    `The ACP agent ended the turn with an unknown stop reason "${shown}"`,
    "AGENT_SESSION_TURN_FAILED",
    { stage: "acp", stopReason: shown },
  );
}
