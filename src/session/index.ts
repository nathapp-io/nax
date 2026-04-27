/**
 * Session Manager — public barrel
 */

export { SessionManager, _sessionManagerDeps } from "./manager";
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
