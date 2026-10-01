/**
 * Per-agent ACP adapter entries.
 *
 * One row per agent name that nax can drive over ACP: the binary whose presence
 * on PATH means "installed", the display name, and the capability envelope the
 * adapter advertises. Kept separate from the adapter itself so adding an agent
 * is a data change, not a change to session-lifecycle code.
 */

import type { AgentRegistryEntry } from "./types";

const AGENT_REGISTRY: Record<string, AgentRegistryEntry> = {
  claude: {
    binary: "claude",
    displayName: "Claude Code (ACP)",
    supportedTiers: ["fast", "balanced", "powerful"],
    maxContextTokens: 200_000,
  },
  codex: {
    binary: "codex",
    displayName: "OpenAI Codex (ACP)",
    supportedTiers: ["fast", "balanced"],
    maxContextTokens: 128_000,
  },
  gemini: {
    binary: "gemini",
    displayName: "Gemini CLI (ACP)",
    supportedTiers: ["fast", "balanced", "powerful"],
    maxContextTokens: 1_000_000,
  },
  opencode: {
    binary: "opencode",
    displayName: "opencode (ACP)",
    supportedTiers: ["fast", "balanced", "powerful"],
    maxContextTokens: 128_000,
  },
  // Reached through the third-party pi-acp bridge, which acpx spawns via npx.
  // pi advertises model selection as an ACP config option, so all three tiers
  // are selectable; the conservative context ceiling matches pi's own default
  // for models whose metadata it cannot resolve.
  pi: {
    binary: "pi",
    displayName: "Pi Coding Agent (ACP)",
    supportedTiers: ["fast", "balanced", "powerful"],
    maxContextTokens: 128_000,
  },
};

const DEFAULT_ENTRY: AgentRegistryEntry = {
  binary: "claude",
  displayName: "ACP Agent",
  supportedTiers: ["balanced"],
  maxContextTokens: 128_000,
};

export function resolveRegistryEntry(agentName: string): AgentRegistryEntry {
  return AGENT_REGISTRY[agentName] ?? DEFAULT_ENTRY;
}

/** Names that have a real ACP adapter entry (subset of KNOWN_AGENT_NAMES). */
export const ACP_ADAPTER_NAMES: ReadonlySet<string> = new Set(Object.keys(AGENT_REGISTRY));
