/**
 * Launch and policy data per registered ACP agent (S4 spec §6.10).
 *
 * The capability record built from `initialize` is authoritative at runtime and
 * only narrows what this table allows. Versions are bumped deliberately. Custom
 * agents (`{ name, command }`) have no entry: no mode ids, no pre-approval and no
 * auth variables, so their requirements fail closed.
 */

export type AcpAgentName = "claude" | "codex" | "cursor" | "gemini" | "opencode" | "pi";

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
 * mode alone (codex-acp's `read-only`, nax#2372) or through variables injected into
 * its process environment (opencode's `OPENCODE_CONFIG_CONTENT` permission policy);
 * `disallowedTools` and `sessionOptions` go through the pre-approval channel and are
 * empty for an agent that has none.
 */
export interface ReadOnlyEnforcement {
  /** The mode set for none/read/review; undefined means nax sets no mode for them. */
  readonly mode: ModeSetting | undefined;
  /**
   * The mode set under `review` instead of `mode` when an operator Bash allow rule
   * makes nax decide shell requests (nax#2592). For an agent whose read-only mode
   * tells the model it cannot run commands, so it never asks; enforcement stays with
   * the agent's permission config and nax's shell decision. Absent: `mode` throughout.
   */
  readonly reviewShellMode?: ModeSetting;
  /** Agent tools removed from the session under none/read/review. */
  readonly disallowedTools: readonly string[];
  /** Extra agent options under none/read/review, merged into the pre-approval channel's options. */
  readonly sessionOptions: Readonly<Record<string, unknown>>;
  /** Extra agent process environment under none/read/review, by profile; {} when the agent needs none. */
  readonly launchEnv: Readonly<Partial<Record<"none" | "read" | "review", Readonly<Record<string, string>>>>>;
  /**
   * The rule-policy translator that builds this agent's launch env from nax's
   * permission rules (rule-policy.ts); undefined means the agent's env is the
   * `launchEnv` above, whatever the rules.
   */
  readonly policy: "opencode" | "cursor" | "pi" | undefined;
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
  const launchEnv = Object.entries(readOnly.launchEnv).map(([profile, env]) => [profile, Object.freeze({ ...env })]);
  // A mode-less agent (opencode, nax#2372) sets no mode at all: there is nothing to copy.
  const mode = readOnly.mode === undefined ? undefined : Object.freeze({ ...readOnly.mode });
  return Object.freeze({
    mode,
    ...(readOnly.reviewShellMode === undefined
      ? {}
      : { reviewShellMode: Object.freeze({ ...readOnly.reviewShellMode }) }),
    disallowedTools: Object.freeze([...readOnly.disallowedTools]),
    sessionOptions: Object.freeze(Object.fromEntries(options)),
    launchEnv: Object.freeze(Object.fromEntries(launchEnv)),
    policy: readOnly.policy,
  });
}

// opencode's permission policy, injected as `OPENCODE_CONFIG_CONTENT` (its highest-rank
// config source). Rules are last-match-wins over { action, resource }, so the catch-all
// deny comes first and each allowance after it. A denied tool is removed from opencode's
// catalog, so the model never sees it.

/** none: no tool at all. */
export const OPENCODE_NONE_CONFIG = JSON.stringify({ permission: { "*": "deny" } });
/** read: only opencode's read tools. */
export const OPENCODE_READ_CONFIG = JSON.stringify({
  permission: { "*": "deny", read: "allow", glob: "allow", grep: "allow", list: "allow" },
});
/** review: the read tools, plus shell commands asked of nax (decided by the review rule). */
export const OPENCODE_REVIEW_CONFIG = JSON.stringify({
  permission: { "*": "deny", read: "allow", glob: "allow", grep: "allow", list: "allow", bash: "ask" },
});

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
          launchEnv: {},
          policy: undefined,
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
      readOnly: {
        mode: { configId: "mode", value: "read-only" },
        disallowedTools: [],
        sessionOptions: {},
        launchEnv: {},
        policy: undefined,
      },
      defaultMode: undefined,
      preApproval: undefined,
    }),
  ],
  // nax#2372: cursor's own modes do not enforce anything (probed: mode `ask` let a forced
  // write through, mode `plan` let the model switch back to `agent` and write), so `ask`
  // only tells the model it is read-only; the real enforcement is its permission config
  // (US-004: an isolated cli-config.json, pointed at by CURSOR_CONFIG_DIR). No plan mode
  // is ever used here. nax#2592: `ask` also makes the model refuse to try a shell command,
  // so review with an operator Bash allow rule runs in `agent`: writes stay denied by the
  // permission config, and nax decides every shell request (shell-rules.ts).
  [
    "cursor",
    entry("cursor", [local("cursor-agent", "acp")], ["CURSOR_API_KEY"], {
      readOnly: {
        mode: { configId: "mode", value: "ask" },
        reviewShellMode: { configId: "mode", value: "agent" },
        disallowedTools: [],
        sessionOptions: {},
        launchEnv: {},
        policy: "cursor",
      },
      defaultMode: undefined,
      preApproval: undefined,
    }),
  ],
  // nax#2372: gemini's `plan` mode is its read-only mode (read tools only, no shell
  // tool). It has no pre-approval channel, so no settings and no removed tools ride
  // along; full and ask keep the launch mode.
  [
    "gemini",
    entry("gemini", [local("gemini", "--acp")], ["GEMINI_API_KEY"], {
      readOnly: {
        mode: { configId: "mode", value: "plan" },
        disallowedTools: [],
        sessionOptions: {},
        launchEnv: {},
        policy: undefined,
      },
      defaultMode: undefined,
      preApproval: undefined,
    }),
  ],
  // nax#2372: opencode has no read-only mode (its `plan` agent still runs shell and web
  // tools). Enforcement is its own permission config, injected per profile as an env
  // variable: opencode denies every tool, then allows its read tools back for read and
  // review, and under review asks nax about each shell command. No mode is set, and it
  // has no pre-approval channel (embedder tools stay unsupported). The launch env below
  // is what an operator with no read-tool deny rule gets; `policy: "opencode"` lets
  // rule-policy.ts translate an unconditional deny of Read, Glob or Grep instead.
  [
    "opencode",
    entry("opencode", [local("opencode", "acp")], [], {
      readOnly: {
        mode: undefined,
        disallowedTools: [],
        sessionOptions: {},
        launchEnv: {
          none: { OPENCODE_CONFIG_CONTENT: OPENCODE_NONE_CONFIG },
          read: { OPENCODE_CONFIG_CONTENT: OPENCODE_READ_CONFIG },
          review: { OPENCODE_CONFIG_CONTENT: OPENCODE_REVIEW_CONFIG },
        },
        policy: "opencode",
      },
      defaultMode: undefined,
      preApproval: undefined,
    }),
  ],
  // Exact pin: a tilde range does not pin 0.0.x.
  // nax#2372, US-004: pi has no mode and no permission config of its own. Read-only is
  // its own tool allowlist (`--tools` / `--no-tools`) plus, under review, the gate
  // extension that turns every bash call into a confirm prompt nax decides
  // (rule-policy.ts, shell-rules.ts). Both are written per launch and named by the
  // wrapper PI_ACP_PI_COMMAND points at.
  [
    "pi",
    entry("pi", [local("pi-acp"), npx("pi-acp@0.0.34")], [], {
      readOnly: {
        mode: undefined,
        disallowedTools: [],
        sessionOptions: {},
        launchEnv: {},
        policy: "pi",
      },
      defaultMode: undefined,
      preApproval: undefined,
    }),
  ],
]);

export const ACP_AGENT_NAMES: readonly AcpAgentName[] = Object.freeze([...REGISTRY.keys()]);

export function isAcpAgentName(name: string): name is AcpAgentName {
  return (ACP_AGENT_NAMES as readonly string[]).includes(name);
}

/** The registry entry for a registered agent name; undefined for anything else (custom agents included). */
export function registryEntry(name: string): AgentRegistryEntry | undefined {
  return isAcpAgentName(name) ? REGISTRY.get(name) : undefined;
}
