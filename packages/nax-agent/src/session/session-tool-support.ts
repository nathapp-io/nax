/**
 * Profile -> coding tools (spec 4.5, 6.2, 6.3). A profile is a capability
 * statement; this module turns it into the declared tools and grants that
 * buildCodingToolSupport takes, picks the embedder default protected-paths
 * policy, and enforces the sandbox floor for "full".
 */
import { unsandboxedToolOptions } from "#src/coding-tools/coding-tool-extras";
import { resolveSessionSandbox } from "#src/coding-tools/coding-tool-sandbox";
import { buildCodingToolSupport, type CodingToolSupport } from "#src/coding-tools/coding-tool-support";
import { UNIVERSAL_CODING_TOOLS } from "#src/coding-tools/universal-coding-tools";
import type { CommandInterceptor } from "#src/command-interceptor/index";
import type { BashApprovalMode } from "#src/config/bash-approval";
import { DEFAULT_SANDBOX_CONFIG, type SandboxConfig } from "#src/config/schemas-sandbox";
import { credentialsConfig } from "#src/infra/credentials-config";
import type { AskResolver } from "#src/permissions/index";
import type { CommandLauncher, SandboxState } from "#src/sandbox/index";
import { EMPTY_OWNED_PATHS_POLICY } from "#src/tools/owned-paths";
import type { ProtectedPathsPolicy } from "#src/tools/protected-paths";
import type { ResolvedProviderTools } from "#src/tools/provider-advertise";
import { renderProviderInstructions } from "#src/tools/provider-instructions";
import type { CodingToolName, ToolGrant } from "#src/tools/types";
import { AgentSessionError } from "./agent-session-errors.ts";
import type { AgentSessionProfile } from "./agent-session-types.ts";

/** The pipeline stage the facade's tool calls and asks carry. */
export const SESSION_STAGE = "session";

const READ_TOOLS: readonly CodingToolName[] = ["Read", "Glob", "Grep", "Git"];
const WRITE_TOOLS: readonly CodingToolName[] = ["Write", "Edit", "Delete", "Bash"];
const ASK_PROFILE_TOOLS: readonly CodingToolName[] = ["Write", "Edit", "Delete", "GitCommit"];

export function declaredToolsFor(
  profile: AgentSessionProfile,
  protectedPaths: ProtectedPathsPolicy,
): readonly CodingToolName[] {
  if (profile === "none") return [...UNIVERSAL_CODING_TOOLS];
  if (profile === "read") return [...UNIVERSAL_CODING_TOOLS, ...READ_TOOLS];
  if (profile === "review") return [...UNIVERSAL_CODING_TOOLS, ...READ_TOOLS, "Bash"];
  // GitCommit refuses every path without ignore patterns, so it is offered only with them.
  const commit: readonly CodingToolName[] = protectedPaths.gitIgnorePatterns.length > 0 ? ["GitCommit"] : [];
  return [...UNIVERSAL_CODING_TOOLS, ...READ_TOOLS, ...WRITE_TOOLS, ...commit];
}

export function grantsFor(declared: readonly CodingToolName[]): readonly ToolGrant[] {
  return declared.map((tool) => ({ tool, patterns: ["*"] }));
}

/**
 * Ask rules evaluate after grants. Under "gated" every Bash command is put to
 * the person. Under the "ask" profile every mutating path tool is too, and the
 * profile forces "gated", so Bash always asks there.
 */
export function askRulesFor(
  declared: readonly CodingToolName[],
  bashApproval: BashApprovalMode,
  profile: AgentSessionProfile,
): readonly ToolGrant[] {
  const bash = bashApproval === "gated" && declared.includes("Bash") ? ["Bash" as const] : [];
  const mutating = profile === "ask" ? ASK_PROFILE_TOOLS.filter((tool) => declared.includes(tool)) : [];
  return [...mutating, ...bash].map((tool) => ({ tool, patterns: ["*"] }));
}

/** The configured credentials directory; undefined when configureCredentials was never called. */
function configuredCredentialDir(): string | undefined {
  try {
    return credentialsConfig().configDir();
  } catch {
    return undefined;
  }
}

/**
 * The embedder default (spec 6.2). A session with its own credentials source
 * (memory or exec) has no credentials directory on disk; one that falls back
 * to the configureCredentials slot protects that slot's directory.
 */
export function defaultProtectedPaths(ownCredentials: boolean): ProtectedPathsPolicy {
  const base: ProtectedPathsPolicy = { gitExcludePathspecs: [], gitIgnorePatterns: [] };
  const credentialDir = ownCredentials ? undefined : configuredCredentialDir();
  return credentialDir === undefined ? base : { ...base, credentialDir };
}

export interface SessionLauncherArgs {
  readonly profile: AgentSessionProfile;
  readonly root: string;
  readonly protectedPaths: ProtectedPathsPolicy;
  /**
   * The resolved mode. Since US-001 the floor itself no longer keys on it —
   * `nativeProfileRules` has already validated which mode may pair with
   * `allowUnsandboxed` — but it stays part of the call so the caller declares
   * the session's posture in one place.
   */
  readonly bashApproval: BashApprovalMode;
  readonly allowUnsandboxed: boolean;
  readonly config?: SandboxConfig;
}

/** What the floor decided: the launcher to run under (if any), and the state to report. */
export interface ResolvedSessionLauncher {
  readonly launcher: CommandLauncher | undefined;
  readonly sandbox: SandboxState;
}

/**
 * The sandbox floor (spec 6.3): "ask", "full" and "review" need a usable sandbox,
 * unless the session explicitly allows running without one — under `gated` (every
 * call still goes to the person) or under `raw` (the person's own standing choice).
 * The resolved state rides back beside the launcher, so the session can report
 * what its commands actually run under.
 */
export async function resolveSessionLauncher(args: SessionLauncherArgs): Promise<ResolvedSessionLauncher> {
  if (args.profile !== "full" && args.profile !== "ask" && args.profile !== "review") {
    return { launcher: undefined, sandbox: { kind: "disabled" } };
  }
  const launcher = await resolveSessionSandbox({
    config: args.config ?? DEFAULT_SANDBOX_CONFIG,
    root: args.root,
    needsLauncher: true,
    protectedPaths: args.protectedPaths,
    ownedPaths: EMPTY_OWNED_PATHS_POLICY,
  });
  if (launcher.state.kind === "available") return { launcher, sandbox: launcher.state };
  if (args.allowUnsandboxed) return { launcher: undefined, sandbox: launcher.state };
  const reason = launcher.state.kind === "unavailable" ? launcher.state.reason : "the sandbox is disabled";
  throw new AgentSessionError(
    `Profile "${args.profile}" needs a usable sandbox (${reason}). Pass allowUnsandboxed: true to run without one.`,
    "AGENT_SESSION_SANDBOX_UNAVAILABLE",
    { reason },
  );
}

export interface SessionToolSupportArgs {
  readonly profile: AgentSessionProfile;
  readonly root: string;
  readonly sessionName: string;
  readonly protectedPaths: ProtectedPathsPolicy;
  readonly bashApproval: BashApprovalMode;
  readonly launcher: CommandLauncher | undefined;
  readonly askResolver: AskResolver;
  readonly interceptor: CommandInterceptor | undefined;
  readonly askRules?: readonly ToolGrant[];
  readonly denyRules?: readonly ToolGrant[];
  /**
   * US-003: offer Bash's per-call `unsandboxed` argument for this session
   * (from `nativeProfileRules(...).allowUnsandboxedCommands`). Optional and
   * defaulting to off, so every existing caller keeps today's tool surface.
   */
  readonly unsandboxedCommands?: boolean;
  readonly providerTools?: ResolvedProviderTools;
  /**
   * Narrow the profile's built-in tools to these names; the universal scratchpad
   * tools are always kept. ABSENT keeps every profile tool. Never adds a tool.
   * Provider tools are narrowed earlier, by `providerAdmits` at resolution.
   */
  readonly allowedTools?: readonly string[];
}

/**
 * The `admits` predicate for `resolveProviderTools`: a tool `<id>__<local>` is
 * admitted when `allowedTools` names it exactly or names `<id>__*`.
 */
export function providerAdmits(allowedTools: readonly string[]): (providerId: string, localName: string) => boolean {
  const allowed = new Set(allowedTools);
  return (providerId, localName) => allowed.has(`${providerId}__${localName}`) || allowed.has(`${providerId}__*`);
}

/** The profile's built-ins narrowed by `allowedTools`; the scratchpad trio always survives. */
function narrowBuiltIns(
  profileTools: readonly CodingToolName[],
  allowedTools: readonly string[] | undefined,
): readonly CodingToolName[] {
  if (allowedTools === undefined) return profileTools;
  const allowed = new Set<string>(allowedTools);
  return profileTools.filter((tool) => UNIVERSAL_CODING_TOOLS.includes(tool) || allowed.has(tool));
}

export interface SessionToolSupport {
  readonly support: CodingToolSupport;
  readonly grants: readonly ToolGrant[];
}

/** Optional overlays share one forwarding point for future posture knobs. */
function postureToolOptions(args: SessionToolSupportArgs): { readonly denyRules?: readonly ToolGrant[] } {
  return args.denyRules === undefined ? {} : { denyRules: args.denyRules };
}

export function buildSessionToolSupport(args: SessionToolSupportArgs): SessionToolSupport {
  const profileTools = narrowBuiltIns(declaredToolsFor(args.profile, args.protectedPaths), args.allowedTools);
  // CodingToolName enumerates built-ins, but the runtime also accepts provider names.
  const declared = [
    ...new Set([...profileTools, ...(args.providerTools?.tools.map((tool) => tool.name) ?? [])]),
  ] as readonly CodingToolName[];
  const grants = [...grantsFor(profileTools), ...(args.providerTools?.grants ?? [])];
  // Only the "ask" profile adds provider asks by default; configured overlays follow them.
  const askRules = [
    ...askRulesFor(profileTools, args.bashApproval, args.profile),
    ...(args.profile === "ask" ? (args.providerTools?.askTools ?? []) : []).map((tool) => ({
      tool: tool as CodingToolName,
      patterns: ["*"],
    })),
    ...(args.askRules ?? []),
  ];
  const providerInstructions = renderProviderInstructions(args.providerTools?.instructions ?? []);
  const support = buildCodingToolSupport({
    root: args.root,
    commandCwd: args.root,
    pipelineStage: SESSION_STAGE,
    sessionName: args.sessionName,
    declared,
    grants,
    ...(args.providerTools !== undefined
      ? {
          extraTools: args.providerTools.tools,
          providerIdByTool: args.providerTools.providerIdByTool,
        }
      : {}),
    ...(providerInstructions !== undefined ? { providerInstructions } : {}),
    bashApproval: args.bashApproval,
    protectedPaths: args.protectedPaths,
    ownedPaths: EMPTY_OWNED_PATHS_POLICY,
    askResolver: args.askResolver,
    ...(askRules.length > 0 ? { askRules } : {}),
    ...(args.interceptor !== undefined ? { interceptor: args.interceptor } : {}),
    ...(args.launcher !== undefined ? { launcher: args.launcher } : {}),
    ...unsandboxedToolOptions(args),
    ...postureToolOptions(args),
  });
  // Unreachable while the scratchpad trio is always declared and granted; kept for the type.
  if (support === undefined) {
    throw new AgentSessionError("No coding tools resolved for the session", "AGENT_SESSION_INVALID_OPTIONS", {
      profile: args.profile,
    });
  }
  return { support, grants };
}
