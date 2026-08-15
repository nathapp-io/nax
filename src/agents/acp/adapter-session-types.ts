/**
 * ACP session interface contracts shared by adapter.ts, spawn-client.ts,
 * and adapter-lifecycle.ts. Kept separate to avoid circular imports.
 */

import type { PipelineStage } from "../../config/permissions";
import type { AgentStreamEvent } from "../../runtime/agent-stream-events";
import type { SessionTokenUsage } from "./wire-types";

export interface AcpSessionResponse {
  messages: Array<{ role: string; content: string }>;
  stopReason: string;
  cumulative_token_usage?: SessionTokenUsage;
  /** Exact cost in USD from acpx usage_update event. Preferred over token-based estimation. */
  exactCostUsd?: number;
  /** True if acpx signalled the error is retryable (e.g. QUEUE_DISCONNECTED_BEFORE_COMPLETION). */
  retryable?: boolean;
  /**
   * Parsed JSON-RPC error text (from `finalizeParseState`), when acpx emitted an
   * error envelope even on an otherwise exit-0 turn. Undefined when no error was
   * captured. Carried through so `stopReason: "error"` responses always have a
   * concrete reason instead of a generic message.
   */
  error?: string;
  /** acpx exit code — present only on error responses (exitCode !== 0). */
  exitCode?: number;
  /**
   * Transport fact: `cancelActivePrompt()` was invoked during this prompt, so
   * the resulting `stopReason: "error"` was caused by an external cancel
   * rather than acpx itself. The adapter does not name _why_ — that is a
   * wiring-layer policy decision (e.g. fail-stale when the watchdog cancelled).
   */
  cancelled?: boolean;
}

export interface AcpSession {
  prompt(text: string): Promise<AcpSessionResponse>;
  /**
   * `signal` (PERF-1): optional external abort — when provided, threaded into the
   * underlying trackedSpawn's deadline race so a caller (e.g. run-completion
   * teardown) can cut the wait short instead of waiting the full hard deadline.
   */
  close(options?: { forceTerminate?: boolean; signal?: AbortSignal }): Promise<void>;
  cancelActivePrompt(): Promise<void>;
  /** Volatile session ID: updated by acpx on each Claude Code reconnect (acpxSessionId). */
  readonly id?: string;
  /** Stable record ID: assigned at session creation, never changes across reconnects (acpxRecordId). */
  readonly recordId?: string;
}

export interface AcpClientOptions {
  /** Optional stream callback to emit activity events during agent execution. */
  onStreamActivity?: (event: AgentStreamEvent) => void;
  /**
   * Generic per-call lifecycle hook — invoked synchronously when each prompt()
   * starts, with the callId and an opaque cancel function (calls
   * `session.cancelActivePrompt()`). The wiring layer above the adapter uses
   * this to populate any per-call cancellation registry it owns. The adapter
   * has no knowledge of what the consumer does with the cancel handle.
   * Depopulation happens via the `agent.call_ended` event on the stream bus.
   */
  onActiveCall?: (callId: string, cancel: () => Promise<void>) => void;
  /** Run-level correlation ID threaded into all stream events from this client's sessions. */
  runId?: string;
  /** Story ID threaded into all stream events for log correlation in parallel runs. */
  storyId?: string;
  /** Pipeline stage threaded into all stream events for log correlation. */
  stage?: PipelineStage;
  /**
   * trackedSpawn hard deadline (ms) for teardown ops (sessions close/stop/cancel).
   * Resolved by the wiring layer from config.agent.acp.trackedSpawnDeadlineMs.
   * Falls back to the spawn-client module default when omitted (#1583).
   */
  trackedSpawnDeadlineMs?: number;
  /**
   * trackedSpawn hard deadline (ms) for startup ops (sessions ensure —
   * createSession/loadSession/applyReasoningEffort). Resolved by the wiring
   * layer from config.agent.acp.trackedSpawnStartupDeadlineMs. Falls back to
   * the spawn-client module default when omitted (#1583).
   */
  trackedSpawnStartupDeadlineMs?: number;
  /**
   * BUG-15: per-model env overrides from config.models.<agent>.<tier>.env.
   * Merged over the process env baseline in buildAllowedEnv() so a model
   * entry can supply its own API key / base URL without polluting other
   * models' subprocess env. Previously accepted by the schema but never
   * threaded anywhere — silently ignored.
   */
  env?: Record<string, string>;
}

export interface AcpClient {
  /** Working directory the client spawns agent subprocesses in (when known). */
  readonly cwd?: string;
  start(): Promise<void>;
  createSession(opts: { agentName: string; permissionMode: string; sessionName?: string }): Promise<AcpSession>;
  /** Resume an existing named session. Returns null if the session is not found. */
  loadSession?(sessionName: string, agentName: string, permissionMode: string): Promise<AcpSession | null>;
  /** Close a named session directly without first ensuring/loading it. */
  closeSession?(sessionName: string, agentName: string, signal?: AbortSignal): Promise<void>;
  /**
   * BUG-16: hard-terminate the acpx queue-owner process for `agentName`
   * (`acpx <agentName> stop`), regardless of session state. Used by
   * closePhysicalSession({ force: true }) for errored sessions where a
   * graceful closeSession is not enough. Optional — clients without a
   * hard-stop concept may omit it.
   */
  forceStop?(agentName: string, signal?: AbortSignal): Promise<void>;
  close(): Promise<void>;
}
