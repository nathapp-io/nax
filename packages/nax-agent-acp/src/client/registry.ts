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

/**
 * How profiles none, read and review are enforced on this agent (§6.4 layer 1, as
 * revised by the 2026-10-07 fix bundle). An agent may enforce read-only through its
 * mode alone (codex-acp's `read-only`, nax#2372); `disallowedTools` and
 * `sessionOptions` go through the pre-approval channel and are empty for an agent
 * that has none.
 */
export interface ReadOnlyEnforcement {
  /** The mode set for none/read/review. */
  readonly mode: ModeSetting;
  /** Agent tools removed from the session under none/read/review. */
  readonly disallowedTools: readonly string[];
  /** Extra agent options under none/read/review, merged into the pre-approval channel's options. */
  readonly sessionOptions: Readonly<Record<string, unknown>>;
}

export interface AgentRegistryEntry {
  readonly name: AcpAgentName;
  /** Tried in order; the first command found wins (S4-2 launch). */
  readonly launch: readonly LaunchCandidate[];
  /** How profiles `none`, `read` and `review` are enforced; undefined means those profiles are unsupported (§6.4). */
  readonly readOnly: ReadOnlyEnforcement | undefined;
  /** Mode for profiles `ask` and `full`; undefined means the agent's own default is kept. */
  readonly defaultMode: ModeSetting | undefined;
  /** How embedder tools are pre-approved at the adapter (R12); undefined means tools are unsupported. */
  readonly preApproval: "claudeCode.allowedTools" | undefined;
  /** Variables passed through the env allowlist so the adapter can authenticate itself (§6.2). */
  readonly authEnv: readonly string[];
}

const local = (command: string, ...args: string[]): LaunchCandidate => ({ command, args });
const npx = (spec: string): LaunchCandidate => ({ command: "npx", args: ["-y", spec] });

function freezeReadOnly(readOnly: ReadOnlyEnforcement | undefined): ReadOnlyEnforcement | undefined {
  if (readOnly === undefined) return undefined;
  const options = Object.entries(readOnly.sessionOptions).map(([key, value]) => [
    key,
    Array.isArray(value) ? Object.freeze([...value]) : value,
  ]);
  return Object.freeze({
    mode: Object.freeze({ ...readOnly.mode }),
    disallowedTools: Object.freeze([...readOnly.disallowedTools]),
    sessionOptions: Object.freeze(Object.fromEntries(options)),
  });
}

function entry(
  name: AcpAgentName,
  launch: LaunchCandidate[],
  authEnv: string[],
  policy?: Pick<AgentRegistryEntry, "readOnly" | "defaultMode" | "preApproval">,
): AgentRegistryEntry {
  return Object.freeze({
    name,
    launch: Object.freeze(launch.map((c) => Object.freeze({ command: c.command, args: Object.freeze([...c.args]) }))),
    readOnly: freezeReadOnly(policy?.readOnly),
    defaultMode: policy?.defaultMode === undefined ? undefined : Object.freeze({ ...policy.defaultMode }),
    preApproval: policy?.preApproval,
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
        // #2366: no plan mode (it wrote its plan file without asking). The write tools are
        // removed instead, and no Claude settings file loads: their allow rules, hooks and
        // MCP servers act without a permission request.
        readOnly: {
          mode: { configId: "mode", value: "default" },
          disallowedTools: ["Write", "Edit", "MultiEdit", "NotebookEdit", "EnterPlanMode"],
          sessionOptions: { settingSources: [], allowDangerouslySkipPermissions: false },
        },
        defaultMode: { configId: "mode", value: "default" },
        preApproval: "claudeCode.allowedTools",
      },
    ),
  ],
  [
    "codex",
    entry("codex", [local("codex-acp"), npx("@agentclientprotocol/codex-acp@~2.1.1")], ["OPENAI_API_KEY"], {
      // nax#2372: codex-acp enforces none/read/review with its own `read-only` mode (OS
      // sandbox, read-only filesystem, no network, every escalation asked of us). It has
      // no pre-approval channel, so no settings and no removed tools ride along; full and
      // ask keep the launch mode (US-002 sets it from config).
      readOnly: { mode: { configId: "mode", value: "read-only" }, disallowedTools: [], sessionOptions: {} },
      defaultMode: undefined,
      preApproval: undefined,
    }),
  ],
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
