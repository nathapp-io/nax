/**
 * Failures as SDK RequestErrors at the protocol edge (S5 spec §7). Facade errors
 * with a protocol meaning map to it; anything else is logged with its stack and
 * reaches the client as its message only, secrets redacted (a provider error can
 * echo a key). One request's failure never stops the process.
 */
import { RequestError } from "@agentclientprotocol/sdk";
import { type AgentLogger, AgentSessionError, redactSecrets } from "@nathapp/nax-agent";

export const TURN_IN_PROGRESS = "turn in progress";

export function turnInProgress(): RequestError {
  return RequestError.invalidRequest(undefined, TURN_IN_PROGRESS);
}

export function unknownSession(sessionId: string): RequestError {
  return RequestError.resourceNotFound(sessionId);
}

export function invalidParams(message: string): RequestError {
  return RequestError.invalidParams(undefined, message);
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function toRequestError(error: unknown, logger: AgentLogger): RequestError {
  if (error instanceof RequestError) return error;
  if (error instanceof AgentSessionError) {
    if (error.code === "AGENT_SESSION_INVALID_OPTIONS") return invalidParams(error.message);
    if (error.code === "AGENT_SESSION_BUSY") return turnInProgress();
  }
  const message = redactSecrets(messageOf(error));
  logger.error("server", "request failed", {
    error: message,
    ...(error instanceof Error && error.stack !== undefined ? { stack: redactSecrets(error.stack) } : {}),
  });
  return RequestError.internalError(undefined, message);
}

export async function guard<T>(logger: AgentLogger, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toRequestError(error, logger);
  }
}
