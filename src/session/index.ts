/**
 * Session Manager — public barrel
 */

export { SessionManager, _sessionManagerDeps } from "./manager";
export type {
  SessionDescriptor,
  SessionState,
  SessionRole,
  ProtocolIds,
  CreateSessionOptions,
  TransitionOptions,
  ISessionManager,
} from "./types";
export { SESSION_TRANSITIONS } from "./types";
