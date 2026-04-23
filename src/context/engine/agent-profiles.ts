/**
 * Context Engine v2 — Agent Profile Registry (Phase 5.5)
 *
 * Maps agent ids to their capability flags and rendering style.
 * The orchestrator uses these when calling renderForAgent() to produce
 * push markdown that fits the target agent's conventions.
 *
 * Built-in profiles: claude, codex.
 * Unknown agent ids fall back to CONSERVATIVE_DEFAULT_PROFILE with a
 * manifest warning — they still get a bundle, just with the safest
 * rendering defaults (plain text, no tool calls).
 *
 * Adding a new profile requires only ~20 lines here; no other changes.
 *
 * See: docs/specs/SPEC-context-engine-v2.md §Agent profile registry
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Capability flags for an agent family.
 * These govern how the orchestrator renders and budgets the push block.
 */
export interface AgentCapabilities {
  /** Hard context window limit for this agent (tokens) */
  maxContextTokens: number;
  /**
   * Soft target for the push block.
   * The orchestrator uses min(stageConfig.budgetTokens, preferredPromptTokens)
   * as the effective packing ceiling when an agent id is known.
   */
  preferredPromptTokens: number;
  /** Whether the agent supports tool/function calls (false → pull tools skipped) */
  supportsToolCalls: boolean;
  /** Whether the agent accepts a system prompt separate from the user prompt */
  supportsSystemPrompt: boolean;
  /** Whether the agent renders Markdown formatting (false → strip headers etc.) */
  supportsMarkdown: boolean;
  /**
   * How the push block is framed.
   *   "markdown-sections" — ## Section headers (Claude default)
   *   "xml-tagged"        — <context_section type="…"> wrappers (Codex)
   *   "plain"             — plain-text brackets [Section] (conservative default)
   */
  systemPromptStyle: "xml-tagged" | "markdown-sections" | "plain";
  /**
   * Tool schema dialect exposed to the agent.
   *   "anthropic" — Claude tool_use format
   *   "openai"    — OpenAI functions/tools format
   *   "mcp"       — Model Context Protocol format
   *   "none"      — agent does not support tool calls
   */
  toolSchemaDialect: "anthropic" | "openai" | "mcp" | "none";
}

/** Complete profile for one agent family. */
export interface AgentProfile {
  caps: AgentCapabilities;
}

// ─────────────────────────────────────────────────────────────────────────────
// Conservative default (unknown agents)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Safe fallback profile used when the agent id is not in AGENT_PROFILES.
 * Uses plain-text framing, no tool calls, and a modest token budget.
 */
export const CONSERVATIVE_DEFAULT_PROFILE: AgentProfile = {
  caps: {
    maxContextTokens: 32_000,
    preferredPromptTokens: 8_000,
    supportsToolCalls: false,
    supportsSystemPrompt: true,
    supportsMarkdown: true,
    systemPromptStyle: "plain",
    toolSchemaDialect: "none",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Built-in profiles
// ─────────────────────────────────────────────────────────────────────────────

/** Registry of built-in agent profiles (AC-27). */
export const AGENT_PROFILES: Record<string, AgentProfile> = {
  claude: {
    caps: {
      maxContextTokens: 200_000,
      preferredPromptTokens: 16_000,
      supportsToolCalls: true,
      supportsSystemPrompt: true,
      supportsMarkdown: true,
      systemPromptStyle: "markdown-sections",
      toolSchemaDialect: "anthropic",
    },
  },
  codex: {
    caps: {
      maxContextTokens: 128_000,
      preferredPromptTokens: 12_000,
      supportsToolCalls: true,
      supportsSystemPrompt: true,
      supportsMarkdown: true,
      systemPromptStyle: "xml-tagged",
      toolSchemaDialect: "openai",
    },
  },
  gemini: {
    caps: {
      maxContextTokens: 1_000_000,
      preferredPromptTokens: 16_000,
      supportsToolCalls: true,
      supportsSystemPrompt: true,
      supportsMarkdown: true,
      systemPromptStyle: "markdown-sections",
      toolSchemaDialect: "openai",
    },
  },
  cursor: {
    caps: {
      maxContextTokens: 128_000,
      preferredPromptTokens: 12_000,
      supportsToolCalls: true,
      supportsSystemPrompt: true,
      supportsMarkdown: true,
      systemPromptStyle: "markdown-sections",
      toolSchemaDialect: "openai",
    },
  },
  opencode: {
    caps: {
      maxContextTokens: 128_000,
      preferredPromptTokens: 12_000,
      supportsToolCalls: true,
      supportsSystemPrompt: true,
      supportsMarkdown: true,
      systemPromptStyle: "markdown-sections",
      toolSchemaDialect: "openai",
    },
  },
  local: {
    caps: {
      maxContextTokens: 32_000,
      preferredPromptTokens: 8_000,
      supportsToolCalls: false,
      supportsSystemPrompt: true,
      supportsMarkdown: true,
      systemPromptStyle: "plain",
      toolSchemaDialect: "none",
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Lookup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Look up the profile for an agent id.
 *
 * Returns the registered profile when the id is known; otherwise returns
 * CONSERVATIVE_DEFAULT_PROFILE and sets isDefault: true so callers can
 * emit a manifest warning.
 */
export function getAgentProfile(agentId: string): { profile: AgentProfile; isDefault: boolean } {
  const profile = AGENT_PROFILES[agentId];
  if (profile) return { profile, isDefault: false };
  return { profile: CONSERVATIVE_DEFAULT_PROFILE, isDefault: true };
}
