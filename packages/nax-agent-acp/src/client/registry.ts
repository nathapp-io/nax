/**
 * Launch and policy data per registered ACP agent (S4 spec §6.10).
 *
 * The capability record built from `initialize` is authoritative at runtime and
 * only narrows what this table allows. Versions are bumped deliberately. Custom
 * agents (`{ name, command }`) have no entry: no mode ids, no pre-approval and no
 * auth variables, so their requirements fail closed.
 */

export type AcpAgentName = "claude" | "codex" | "gemini" | "opencode" | "pi";

export interface LaunchCandidate {
  readonly command: string;
  readonly args: readonly string[];
}

/** A session config option and the value that selects a mode (Claude: option `mode`). */
export interface ModeSetting {
  readonly configId: string;
  readonly value: string;
}

export interface AgentRegistryEntry {
  readonly name: AcpAgentName;
  /** Tried in order; the first command found wins (S4-2 launch). */
  readonly launch: readonly LaunchCandidate[];
  /** Mode for profiles `none` and `read`; undefined means those profiles are unsupported (§6.4). */
  readonly readOnlyMode: ModeSetting | undefined;
  /** Mode for profiles `ask` and `full`; undefined means the agent's own default is kept. */
  readonly defaultMode: ModeSetting | undefined;
  /** How embedder tools are pre-approved at the adapter (R12); undefined means tools are unsupported. */
  readonly preApproval: "claudeCode.allowedTools" | undefined;
  /** Variables passed through the env allowlist so the adapter can authenticate itself (§6.2). */
  readonly authEnv: readonly string[];
}

const local = (command: string, ...args: string[]): LaunchCandidate => ({ command, args });
const npx = (spec: string): LaunchCandidate => ({ command: "npx", args: ["-y", spec] });

function entry(
  name: AcpAgentName,
  launch: LaunchCandidate[],
  authEnv: string[],
  claude?: Pick<AgentRegistryEntry, "readOnlyMode" | "defaultMode" | "preApproval">,
): AgentRegistryEntry {
  return Object.freeze({
    name,
    launch: Object.freeze(launch.map((c) => Object.freeze({ command: c.command, args: Object.freeze([...c.args]) }))),
    readOnlyMode: claude?.readOnlyMode === undefined ? undefined : Object.freeze({ ...claude.readOnlyMode }),
    defaultMode: claude?.defaultMode === undefined ? undefined : Object.freeze({ ...claude.defaultMode }),
    preApproval: claude?.preApproval,
    authEnv: Object.freeze([...authEnv]),
  });
}

const REGISTRY: ReadonlyMap<AcpAgentName, AgentRegistryEntry> = new Map([
  [
    "claude",
    entry(
      "claude",
      [local("claude-agent-acp"), npx("@agentclientprotocol/claude-agent-acp@~0.85.1")],
      ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
      {
        readOnlyMode: { configId: "mode", value: "plan" },
        defaultMode: { configId: "mode", value: "default" },
        preApproval: "claudeCode.allowedTools",
      },
    ),
  ],
  ["codex", entry("codex", [local("codex-acp"), npx("@agentclientprotocol/codex-acp@~2.1.1")], ["OPENAI_API_KEY"])],
  ["gemini", entry("gemini", [local("gemini", "--acp")], ["GEMINI_API_KEY"])],
  ["opencode", entry("opencode", [local("opencode", "acp")], [])],
  // Exact pin: a tilde range does not pin 0.0.x.
  ["pi", entry("pi", [local("pi-acp"), npx("pi-acp@0.0.34")], [])],
]);

export const ACP_AGENT_NAMES: readonly AcpAgentName[] = Object.freeze([...REGISTRY.keys()]);

export function isAcpAgentName(name: string): name is AcpAgentName {
  return (ACP_AGENT_NAMES as readonly string[]).includes(name);
}

/** The registry entry for a registered agent name; undefined for anything else (custom agents included). */
export function registryEntry(name: string): AgentRegistryEntry | undefined {
  return isAcpAgentName(name) ? REGISTRY.get(name) : undefined;
}
