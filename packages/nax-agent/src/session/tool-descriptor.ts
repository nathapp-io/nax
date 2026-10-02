/**
 * Pull-tool descriptor shapes shared by the context engine and the agent
 * contract (S1 spec section 4.2, port 2); `context/engine` re-exports them.
 */

/** Minimal JSON Schema type alias — no external library required. */
export type JSONSchema = Record<string, unknown>;

/**
 * Descriptor for a pull tool registered with the agent session (Phase 4+).
 * The orchestrator returns these alongside push markdown; agent adapters
 * register them as callable tools on the session.
 */
export interface ToolDescriptor {
  /** Tool identifier exposed to the agent (e.g. "query_neighbor") */
  name: string;
  /** Human-readable description shown to the agent */
  description: string;
  /** JSON Schema for the tool's input arguments */
  inputSchema: JSONSchema;
  /** Maximum calls allowed per agent session before the tool errors */
  maxCallsPerSession: number;
  /** Maximum tokens returned per call (response is truncated to this ceiling) */
  maxTokensPerCall: number;
}
