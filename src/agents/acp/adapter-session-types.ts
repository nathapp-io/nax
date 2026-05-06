/**
 * ACP session interface contracts shared by adapter.ts, spawn-client.ts,
 * and adapter-lifecycle.ts. Kept separate to avoid circular imports.
 */

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
  /** acpx exit code — present only on error responses (exitCode !== 0). */
  exitCode?: number;
}

export interface AcpSession {
  prompt(text: string): Promise<AcpSessionResponse>;
  close(options?: { forceTerminate?: boolean }): Promise<void>;
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
   * Called synchronously at the start of each prompt() call with the callId and
   * a cancel function. Callers use this to register the cancel function in the
   * idle-watchdog controllerRegistry so the watchdog can cancel stale prompts.
   * The cancel function calls session.cancelActivePrompt(); callers should wrap it
   * to set _staleCancelled before calling.
   */
  onWatchdogRegister?: (callId: string, cancel: () => Promise<void>) => void;
}

export interface AcpClient {
  start(): Promise<void>;
  createSession(opts: { agentName: string; permissionMode: string; sessionName?: string }): Promise<AcpSession>;
  /** Resume an existing named session. Returns null if the session is not found. */
  loadSession?(sessionName: string, agentName: string, permissionMode: string): Promise<AcpSession | null>;
  /** Close a named session directly without first ensuring/loading it. */
  closeSession?(sessionName: string, agentName: string): Promise<void>;
  close(): Promise<void>;
}
