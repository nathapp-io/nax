/**
 * resumeAgentSession's checks on the stored document (S3 spec 4.2, 6.4). They
 * run before any backend opens: the id comes from the argument, the document
 * exists, this build reads its schema, its messages are an array, and the
 * model that wrote it is the one resuming. The model rule is the loop's own
 * (transcriptModelIdentity): an effort suffix is not a different model.
 */
import { NaxError } from "#src/infra/nax-error";
import { transcriptModelIdentity } from "#src/native/session/transcript-identity";
import type { TranscriptDoc, TranscriptStore } from "#src/native/session/transcript-types";
import { AgentSessionError } from "./agent-session-errors.ts";
import type { CreateAgentSessionOptions } from "./agent-session-types.ts";

/**
 * The options to validate for a resume: the argument is the session id. A
 * different `options.sessionId` is a caller bug, refused before the store is
 * read. Non-object options pass through for the option validator to reject.
 */
export function resumeInput(sessionId: string, options: CreateAgentSessionOptions): unknown {
  if (typeof options !== "object" || options === null) return options;
  if (options.sessionId !== undefined && options.sessionId !== sessionId) {
    throw new AgentSessionError(
      `Invalid agent session options: sessionId "${options.sessionId}" is not the session being resumed ("${sessionId}")`,
      "AGENT_SESSION_INVALID_OPTIONS",
      { path: "sessionId" },
    );
  }
  return { ...options, sessionId };
}

/** The stored document a resume starts from. Throws when there is none or this session may not read it. */
export async function loadResumable(store: TranscriptStore, sessionId: string, model: string): Promise<TranscriptDoc> {
  const doc = await store.load(sessionId);
  if (doc === null) {
    throw new AgentSessionError(
      `Session "${sessionId}" has no document in the transcript store`,
      "AGENT_SESSION_NOT_FOUND",
      { sessionId },
    );
  }
  const version: unknown = doc.schemaVersion;
  if (version !== undefined && version !== 1) {
    throw new AgentSessionError(
      `Session "${sessionId}" has transcript schemaVersion ${String(version)}; this build reads 1`,
      "AGENT_SESSION_SCHEMA_UNSUPPORTED",
      { sessionId },
    );
  }
  if (!Array.isArray(doc.messages)) {
    throw new NaxError(
      `transcript for session "${sessionId}" is unreadable: messages is not an array`,
      "TRANSCRIPT_CORRUPT",
      { stage: "agent-session", sessionId },
    );
  }
  const resuming = transcriptModelIdentity(model);
  if (doc.model !== undefined && doc.model !== resuming) {
    throw new AgentSessionError(
      `Session "${sessionId}" was written by model "${doc.model}"; resume it with that model, not "${resuming}"`,
      "AGENT_SESSION_MODEL_MISMATCH",
      { sessionId },
    );
  }
  return doc;
}

/** The turn a dead process left running (spec 6.4), or undefined. */
export function interruptedTurnOf(doc: TranscriptDoc): string | undefined {
  const turn = doc.turn;
  return turn?.state === "running" && typeof turn.turnId === "string" ? turn.turnId : undefined;
}
