/**
 * The agent session facade's public error (S3 spec section 7). Every code is
 * namespaced AGENT_SESSION_* so it cannot collide with nax's SESSION_* codes
 * or registerCodingTool's TOOL_NAME_RESERVED.
 */
import { NaxError } from "#src/infra/nax-error";

export type AgentSessionErrorCode =
  | "AGENT_SESSION_INVALID_OPTIONS"
  | "AGENT_SESSION_EXISTS"
  | "AGENT_SESSION_BUSY"
  | "AGENT_SESSION_CLOSED"
  | "AGENT_SESSION_INVALID_ANSWER"
  | "AGENT_SESSION_NOT_FOUND"
  | "AGENT_SESSION_SCHEMA_UNSUPPORTED"
  | "AGENT_SESSION_MODEL_MISMATCH"
  | "AGENT_SESSION_SANDBOX_UNAVAILABLE"
  | "AGENT_SESSION_TOOL_NAME_RESERVED";

export class AgentSessionError extends NaxError {
  declare readonly code: AgentSessionErrorCode;

  constructor(message: string, code: AgentSessionErrorCode, context: Record<string, unknown> = {}) {
    super(message, code, { stage: "agent-session", ...context });
    this.name = "AgentSessionError";
  }
}
