/**
 * Session Manager — public barrel
 */

export { SessionManager, _sessionManagerDeps } from "./manager";
export { SessionKeeper } from "./session-keeper";
export type { SessionKeeperOptions, SessionKeeperSendOptions } from "./session-keeper";
export { formatSessionName } from "./naming";
export type { ProtocolIds } from "../runtime/protocol-types";
export type {
  SessionDescriptor,
  SessionState,
  SessionRole,
  CreateSessionOptions,
  TransitionOptions,
  ISessionManager,
  OpenSessionRequest,
  SendPromptOpts,
  RunInSessionOpts,
  NameForRequest,
} from "./types";
export { SESSION_TRANSITIONS } from "./types";
// Re-export scratch-writer so callers can use `@/session/scratchFilePath` /
// `@/session/ScratchEntry` instead of reaching into the internal path.
export { scratchFilePath, appendScratchEntry, readDigestFile, writeDigestFile, digestFilePath } from "./scratch-writer";
export type {
  ScratchEntry,
  VerifyScratchEntry,
  RectifyScratchEntry,
  TddSessionScratchEntry,
  SelfVerificationScratchEntry,
  ToolDiagnosticsScratchEntry,
} from "./scratch-writer";
