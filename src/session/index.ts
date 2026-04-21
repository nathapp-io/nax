/**
 * Session Manager — public barrel
 */

export { SessionManager, _sessionManagerDeps } from "./manager";
export type {
  AuditTurnEntry,
  SessionDescriptor,
  SessionState,
  SessionRole,
  ProtocolIds,
  CreateSessionOptions,
  TransitionOptions,
  ISessionManager,
} from "./types";
export { SESSION_TRANSITIONS } from "./types";
export { auditTurn } from "./audit";
export { _promptAuditDeps, writePromptAudit, buildAuditFilename, findNaxProjectRoot } from "./audit-writer";
export type { PromptAuditEntry } from "./audit-writer";
