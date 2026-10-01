/**
 * Shared protocol identifiers captured from adapter-backed sessions.
 *
 * Kept in runtime so agent/session subsystems can depend on a neutral type
 * without importing each other.
 */
export interface ProtocolIds {
  /** Stable protocol record ID for a logical session. */
  recordId: string | null;
  /** Volatile physical session ID (changes on reconnect). */
  sessionId: string | null;
}
