/**
 * ACP Adapter Types
 *
 * Type definitions for the ACP (Agent Communication Protocol) adapter.
 */

import type { ModelTier } from "../../config/schema";

/**
 * Response from an ACP session prompt call.
 */
export interface AcpSessionResponse {
  messages: Array<{ role: string; content: string }>;
  stopReason: "end_turn" | "cancelled" | "error" | string;
  cumulative_token_usage?: { input_tokens: number; output_tokens: number };
}

/**
 * An active ACP session — wraps a conversation with an agent.
 */
export interface AcpSession {
  prompt(text: string): Promise<AcpSessionResponse>;
  close(): Promise<void>;
  cancelActivePrompt(): Promise<void>;
}

/**
 * ACP client interface — manages agent lifecycle and sessions.
 */
export interface AcpClient {
  start(): Promise<void>;
  createSession(opts: { agentName: string; permissionMode: string }): Promise<AcpSession>;
  close(): Promise<void>;
  cancelActivePrompt(): Promise<void>;
}

/**
 * Configuration for the ACP adapter.
 */
export interface AcpAdapterConfig {
  /** Agent name (e.g., 'claude', 'codex', 'gemini') */
  agentName: string;
  /** Permission mode — always approve-all for headless execution */
  permissionMode: string;
  /** Timeout for a full run in milliseconds */
  runTimeoutMs?: number;
  /** Timeout for a single prompt call in milliseconds */
  promptTimeoutMs?: number;
}

/**
 * Internal run context — tracks state during a single run() invocation.
 */
export interface AcpRunContext {
  startTime: number;
  attempts: number;
  lastError?: Error;
}

/**
 * Maps agent names to their binary commands and display names.
 */
export interface AgentRegistryEntry {
  binary: string;
  displayName: string;
  supportedTiers: readonly ModelTier[];
  maxContextTokens: number;
}
