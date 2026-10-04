/**
 * Profile -> coding tools (spec 4.5, 6.2, 6.3). A profile is a capability
 * statement; this module turns it into the declared tools and grants that
 * buildCodingToolSupport takes, picks the embedder default protected-paths
 * policy, and enforces the sandbox floor for "full".
 */
import { resolveSessionSandbox } from "#src/coding-tools/coding-tool-sandbox";
import { buildCodingToolSupport, type CodingToolSupport } from "#src/coding-tools/coding-tool-support";
import { UNIVERSAL_CODING_TOOLS } from "#src/coding-tools/universal-coding-tools";
import type { CommandInterceptor } from "#src/command-interceptor/index";
import type { BashApprovalMode } from "#src/config/bash-approval";
import { DEFAULT_SANDBOX_CONFIG } from "#src/config/schemas-sandbox";
import { credentialsConfig } from "#src/infra/credentials-config";
import type { AskResolver } from "#src/permissions/index";
import type { CommandLauncher } from "#src/sandbox/index";
import { EMPTY_OWNED_PATHS_POLICY } from "#src/tools/owned-paths";
import type { ProtectedPathsPolicy } from "#src/tools/protected-paths";
import type { CodingToolName, ToolGrant } from "#src/tools/types";
import { AgentSessionError } from "./agent-session-errors.ts";
import type { AgentSessionProfile } from "./agent-session-types.ts";

/** The pipeline stage the facade's tool calls and asks carry. */
export const SESSION_STAGE = "session";

const READ_TOOLS: readonly CodingToolName[] = ["Read", "Glob", "Grep", "Git"];
const WRITE_TOOLS: readonly CodingToolName[] = ["Write", "Edit", "Delete", "Bash"];

export function declaredToolsFor(
  profile: AgentSessionProfile,
  protectedPaths: ProtectedPathsPolicy,
): readonly CodingToolName[] {
  if (profile === "none") return [...UNIVERSAL_CODING_TOOLS];
  if (profile === "read") return [...UNIVERSAL_CODING_TOOLS, ...READ_TOOLS];
  // GitCommit refuses every path without ignore patterns, so it is offered only with them.
  const commit: readonly CodingToolName[] = protectedPaths.gitIgnorePatterns.length > 0 ? ["GitCommit"] : [];
  return [...UNIVERSAL_CODING_TOOLS, ...READ_TOOLS, ...WRITE_TOOLS, ...commit];
}

export function grantsFor(declared: readonly CodingToolName[]): readonly ToolGrant[] {
  return declared.map((tool) => ({ tool, patterns: ["*"] }));
}

/**
 * Under "gated", every Bash command is put to the person: an unconditional ask
 * rule on top of the unconditional grant (ask rules are evaluated after
 * grants). "raw" and "escalate" add none.
 */
export function askRulesFor(declared: readonly CodingToolName[], bashApproval: BashApprovalMode): readonly ToolGrant[] {
  return bashApproval === "gated" && declared.includes("Bash") ? [{ tool: "Bash", patterns: ["*"] }] : [];
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
  readonly bashApproval: BashApprovalMode;
  readonly allowUnsandboxed: boolean;
}

/** The sandbox floor (spec 6.3): "full" needs a usable sandbox unless gated + allowUnsandboxed. */
export async function resolveSessionLauncher(args: SessionLauncherArgs): Promise<CommandLauncher | undefined> {
  if (args.profile !== "full") return undefined;
  const launcher = await resolveSessionSandbox({
    config: DEFAULT_SANDBOX_CONFIG,
    root: args.root,
    needsLauncher: true,
    protectedPaths: args.protectedPaths,
    ownedPaths: EMPTY_OWNED_PATHS_POLICY,
  });
  if (launcher.state.kind === "available") return launcher;
  if (args.bashApproval === "gated" && args.allowUnsandboxed) return undefined;
  const reason = launcher.state.kind === "unavailable" ? launcher.state.reason : "the sandbox is disabled";
  throw new AgentSessionError(
    `Profile "full" needs a usable sandbox (${reason}). Pass bashApproval "gated" with allowUnsandboxed: true to run without one.`,
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
}

export interface SessionToolSupport {
  readonly support: CodingToolSupport;
  readonly grants: readonly ToolGrant[];
}

export function buildSessionToolSupport(args: SessionToolSupportArgs): SessionToolSupport {
  const declared = declaredToolsFor(args.profile, args.protectedPaths);
  const grants = grantsFor(declared);
  const askRules = askRulesFor(declared, args.bashApproval);
  const support = buildCodingToolSupport({
    root: args.root,
    commandCwd: args.root,
    pipelineStage: SESSION_STAGE,
    sessionName: args.sessionName,
    declared,
    grants,
    bashApproval: args.bashApproval,
    protectedPaths: args.protectedPaths,
    ownedPaths: EMPTY_OWNED_PATHS_POLICY,
    askResolver: args.askResolver,
    ...(askRules.length > 0 ? { askRules } : {}),
    ...(args.interceptor !== undefined ? { interceptor: args.interceptor } : {}),
    ...(args.launcher !== undefined ? { launcher: args.launcher } : {}),
  });
  // Unreachable while the scratchpad trio is always declared and granted; kept for the type.
  if (support === undefined) {
    throw new AgentSessionError("No coding tools resolved for the session", "AGENT_SESSION_INVALID_OPTIONS", {
      profile: args.profile,
    });
  }
  return { support, grants };
}
