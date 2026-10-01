/**
 * Session Manager — public barrel
 */

export type { ProtocolIds } from "../runtime/protocol-types";
export { _sessionManagerDeps, SessionManager } from "./manager";
export { formatSessionName } from "./naming";
export { recordAgentHandoff } from "./reopen-handoff";
export { purgeStaleScratch } from "./scratch-purge";
export type {
  ScratchEntry,
  SelfVerificationScratchEntry,
  TddSessionScratchEntry,
  ToolDiagnosticsScratchEntry,
  VerifyScratchEntry,
} from "./scratch-writer";
// Re-export scratch-writer so callers can use `@/session/scratchFilePath` /
// `@/session/ScratchEntry` instead of reaching into the internal path.
export { appendScratchEntry, digestFilePath, readDigestFile, scratchFilePath, writeDigestFile } from "./scratch-writer";
export type { SessionKeeperOptions, SessionKeeperSendOptions } from "./session-keeper";
export { SessionKeeper } from "./session-keeper";
export type { SweepFeatureTranscriptsOptions } from "./transcript-sweep";
export { sweepFeatureTranscripts } from "./transcript-sweep";
export type {
  CreateSessionOptions,
  ISessionManager,
  NameForRequest,
  OpenSessionRequest,
  RunInSessionOpts,
  SendPromptOpts,
  SessionDescriptor,
  SessionRole,
  SessionState,
  TransitionOptions,
} from "./types";
export { SESSION_TRANSITIONS } from "./types";
