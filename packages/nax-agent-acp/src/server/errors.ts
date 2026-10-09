/**
 * Failures as SDK RequestErrors at the protocol edge (S5 spec §7). Facade errors
 * with a protocol meaning map to it; anything else is logged with its stack and
 * reaches the client as its message only, secrets redacted (a provider error can
 * echo a key). One request's failure never stops the process.
 */
import { RequestError } from "@agentclientprotocol/sdk";
import { type AgentLogger, AgentSessionError, NaxError, redactSecrets } from "@nathapp/nax-agent";

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

/** Turn and open failures that mean "log in again" (S5-4 M-32). */
export const CREDENTIAL_FAILURE_CODES: ReadonlySet<string> = new Set([
  "fail-auth",
  "CREDENTIAL_HELPER_FAILED",
  "CREDENTIAL_HELPER_INVALID",
  "CREDENTIAL_CHANGED",
  "CREDENTIAL_FILE_UNREADABLE",
  "CREDENTIALS_NOT_CONFIGURED",
]);

export function isAuthFailureCode(code: string): boolean {
  return CREDENTIAL_FAILURE_CODES.has(code);
}

export function loginHint(provider?: string): string {
  const name = provider ?? "<provider>";
  return `Log in with \`nax-agent login ${name}\` (or \`nax auth login ${name}\`), then retry.`;
}

/** `auth_required` (-32000): editors offer the advertised login methods on it (spec §6.3). */
export function authRequired(message: string, data: Readonly<Record<string, unknown>>): RequestError {
  const provider = typeof data.provider === "string" ? data.provider : undefined;
  // A redacted NaxError message may already end in "."; never print "..".
  return RequestError.authRequired(data, `${message.replace(/\.+$/, "")}. ${loginHint(provider)}`);
}

export function toRequestError(error: unknown, logger: AgentLogger): RequestError {
  if (error instanceof RequestError) return error;
  if (error instanceof AgentSessionError) {
    if (error.code === "AGENT_SESSION_INVALID_OPTIONS") return invalidParams(error.message);
    if (error.code === "AGENT_SESSION_BUSY") return turnInProgress();
  }
  if (error instanceof NaxError && isAuthFailureCode(error.code)) {
    return authRequired(redactSecrets(error.message), { code: error.code });
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
