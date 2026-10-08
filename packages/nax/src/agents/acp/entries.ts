/**
 * Per-agent rows for the ACP SDK transport (S4b spec §5.1): what nax shows and
 * advertises for each agent nax-agent-acp can launch. Carried over from the acpx
 * adapter's agent-entries.ts; the launch command itself is nax-agent-acp's
 * registry, so `binary` is the agent's own CLI, used only for display and the
 * `--version` probe in `nax agents` (D2-f).
 */
import type { AcpAgentName } from "@nathapp/nax-agent-acp/client";
import type { ModelTier } from "@/config/schema";

export interface AcpEntry {
  /** The nax-agent-acp registry name the backend launches. */
  readonly agent: AcpAgentName;
  /** The agent's own CLI. Not what is launched. */
  readonly binary: string;
  readonly displayName: string;
  readonly supportedTiers: readonly ModelTier[];
  readonly maxContextTokens: number;
}

const ENTRIES: Readonly<Record<string, AcpEntry>> = Object.freeze({
  claude: {
    agent: "claude",
    binary: "claude",
    displayName: "Claude Code (ACP)",
    supportedTiers: ["fast", "balanced", "powerful"],
    maxContextTokens: 200_000,
  },
  codex: {
    agent: "codex",
    binary: "codex",
    displayName: "OpenAI Codex (ACP)",
    supportedTiers: ["fast", "balanced"],
    maxContextTokens: 128_000,
  },
  gemini: {
    agent: "gemini",
    binary: "gemini",
    displayName: "Gemini CLI (ACP)",
    supportedTiers: ["fast", "balanced", "powerful"],
    maxContextTokens: 1_000_000,
  },
  opencode: {
    agent: "opencode",
    binary: "opencode",
    displayName: "opencode (ACP)",
    supportedTiers: ["fast", "balanced", "powerful"],
    maxContextTokens: 128_000,
  },
  pi: {
    agent: "pi",
    binary: "pi",
    displayName: "Pi Coding Agent (ACP)",
    supportedTiers: ["fast", "balanced", "powerful"],
    maxContextTokens: 128_000,
  },
});

/** The names `nax agents` lists and the bake-off accepts. */
export const ACP_AGENT_NAMES: ReadonlySet<string> = new Set(Object.keys(ENTRIES));

export function acpEntry(agentName: string): AcpEntry | undefined {
  return Object.hasOwn(ENTRIES, agentName) ? ENTRIES[agentName] : undefined;
}

/** A known nax agent name with no ACP launcher (aider): it lists, but never opens (spec §11 item 2). */
export const UNSUPPORTED_ENTRY: Omit<AcpEntry, "agent"> = Object.freeze({
  binary: "",
  displayName: "ACP Agent",
  supportedTiers: ["balanced"],
  maxContextTokens: 128_000,
});
