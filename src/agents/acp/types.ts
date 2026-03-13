/**
 * ACP Adapter Types
 *
 * Type definitions for the ACP (Agent Communication Protocol) adapter.
 * The adapter shells out to `acpx` CLI — no in-process ACP client needed.
 */

import type { ModelTier } from "../../config/schema";

/**
 * Maps agent names to their acpx registry entries and capabilities.
 */
export interface AgentRegistryEntry {
  /** Agent name in acpx's built-in registry (e.g., 'claude', 'codex', 'gemini') */
  binary: string;
  /** Human-readable display name */
  displayName: string;
  /** Model tiers this agent supports */
  supportedTiers: readonly ModelTier[];
  /** Max context window in tokens */
  maxContextTokens: number;
}
