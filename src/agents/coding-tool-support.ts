/**
 * Turn resolved grants plus an operation's declaration into a live runtime.
 *
 * nax-permission-mode-allow: consumes permissions already resolved by
 * resolvePermissions; decides none.
 *
 * This is the seam that makes coding tools reachable at all. Callers reach it
 * through resolveCodingToolSupport() below, which is the single entry point
 * both dispatch hops use — see its comment for why that matters.
 */

import { NaxError } from "@/errors";
import {
  type CodingTool,
  type CodingToolName,
  type CodingToolRuntime,
  compileToolPolicy,
  createCodingToolRuntime,
  createNoOpToolAuditSink,
  createRunCommandTool,
  createToolAuditSink,
  EXEC_TOOL_NAME,
  type ToolAuditSink,
  type ToolGrant,
} from "@/tools";
import { toolAuditDir } from "../config/paths";
import { resolvePermissions } from "../config/permissions";
import { resolvePackageName } from "./exec-package-name";
import type { AgentRunOptions } from "./types";

export interface CodingToolSupport {
  readonly runtime: CodingToolRuntime;
  readonly tools: readonly CodingTool[];
  readonly auditSink: ToolAuditSink;
}

export function buildCodingToolSupport(args: {
  root?: string;
  /**
   * Repo root for Exec's `target: "repoRoot"` form. Falls back to `root`
   * when absent (single-package repos, where the two coincide).
   */
  repoRoot?: string;
  grants?: readonly ToolGrant[];
  declared: readonly CodingToolName[];
  storyId?: string;
  declaredCommands?: ReadonlyMap<string, string>;
  stripEnvVars?: readonly string[];
  auditDir?: string;
  sessionName?: string;
  /** Manifest name of the member at `root`; see `resolvePackageName`. */
  packageName?: string;
  /** `config.install.allowScripts` (Task 8 adds the field); defaults to false. */
  allowScripts?: boolean;
}): CodingToolSupport | undefined {
  if (args.declared.length === 0) return undefined;
  const grants = args.grants ?? [];
  if (grants.length === 0) return undefined;

  // An empty root passed to a spawn or a path join silently means
  // process.cwd() — the directory nax was launched from, which under `-d` is a
  // different repository. That is the #1794 defect; refuse instead. Callers
  // pass packageWorkdir(view), which never yields "".
  if (args.root === undefined || args.root.trim() === "") {
    throw new NaxError(
      "Cannot enable coding tools: no working directory was supplied, so the permitted root is unknown.",
      "CODING_TOOL_ROOT_MISSING",
      { stage: "tools" },
    );
  }

  // `Exec` is a capability marker in an operation's `tools` declaration, not
  // a registered tool — nothing in registerBuiltinCodingTools carries this
  // name. It decides whether RunCommand gets its argv branch (Task 6); it
  // must never reach runtime.advertised() itself, or the lookup for a tool
  // named "Exec" would simply fail and the marker would vanish from the
  // advertised set without a trace of why.
  const allowExec = args.declared.includes(EXEC_TOOL_NAME);
  const advertised = args.declared.filter((name) => name !== EXEC_TOOL_NAME);

  const declaredCommands = args.declaredCommands ?? new Map<string, string>();
  const sink =
    args.auditDir !== undefined
      ? createToolAuditSink({ dir: args.auditDir, sessionName: args.sessionName ?? "unattached" })
      : createNoOpToolAuditSink();
  const runtime = createCodingToolRuntime({
    policy: compileToolPolicy(grants, args.root),
    ...(args.storyId !== undefined ? { storyId: args.storyId } : {}),
    sink,
    extraTools:
      declaredCommands.size > 0 || allowExec
        ? [
            createRunCommandTool(declaredCommands, {
              stripEnvVars: args.stripEnvVars,
              ...(allowExec
                ? {
                    exec: {
                      repoRoot: args.repoRoot ?? args.root,
                      packageWorkdir: args.root,
                      allowScripts: args.allowScripts ?? false,
                      ...(args.packageName !== undefined ? { packageName: args.packageName } : {}),
                    },
                  }
                : {}),
            }),
          ]
        : [],
  });
  const tools = runtime.advertised(advertised);
  if (tools.length === 0) return undefined;
  return { runtime, tools, auditSink: sink };
}

/**
 * Resolve coding-tool support for one dispatch, from the run options alone.
 *
 * nax-permission-mode-allow: delegates the decision to resolvePermissions();
 * decides nothing itself.
 *
 * Exists so the two real hops (`operations/build-hop-callback.ts`,
 * `runtime/session-run-hop.ts`) resolve support identically and cannot drift:
 * a tool wired into one hop and not the other is invisible until an operation
 * happens to dispatch through the other. Call this, never the raw producer
 * above — it takes no `auditDir`, so it yields a non-recording ledger sink.
 */
/**
 * Ledger session name.
 *
 * Story-only names collide across the three TDD roles, which all write to one
 * directory -- so a ledger could not answer which session made a call, and that
 * is the evidence ADR-029 parity claims are read from.
 */
export function buildLedgerSessionName(opts: { storyId?: string; sessionRole?: string; featureName?: string }): string {
  const base = opts.storyId ?? opts.featureName;
  if (base === undefined) return "unattached";
  return opts.sessionRole === undefined ? base : `${base}-${opts.sessionRole}`;
}

export async function resolveCodingToolSupport(
  options: Pick<
    AgentRunOptions,
    | "declaredTools"
    | "codingToolRoot"
    | "codingToolRepoRoot"
    | "outputDir"
    | "pipelineStage"
    | "storyId"
    | "sessionRole"
    | "featureName"
    | "config"
  >,
): Promise<CodingToolSupport | undefined> {
  const declared = options.declaredTools ?? [];
  if (declared.length === 0) return undefined;
  const resolved = resolvePermissions(options.config, options.pipelineStage ?? "run");
  // RULING F2: AgentRunOptions['config'] is typed as the agent-manager Pick
  // (agent/execution/profile), yet both hops source it from configLoader.current(),
  // so it carries the full NaxConfig at runtime — only the type lies. The read is
  // widened locally here; the shared agentManagerConfigSelector stays untouched.
  const widenedConfig = options.config as
    | {
        quality?: { commands?: Partial<Record<string, string>>; stripEnvVars?: unknown };
        // `install.allowScripts` does not exist in the schema yet (Task 8 adds
        // it) — read defensively and default to false rather than adding an
        // unreleased field to the config type here.
        install?: { allowScripts?: unknown };
      }
    | undefined;
  const quality = widenedConfig?.quality;
  const commands = quality?.commands ?? {};
  const stripEnvVars = Array.isArray(quality?.stripEnvVars)
    ? quality.stripEnvVars.filter((value): value is string => typeof value === "string")
    : [];
  const allowScripts = widenedConfig?.install?.allowScripts === true;
  const declaredCommands = new Map(
    Object.entries(commands).filter((e): e is [string, string] => typeof e[1] === "string"),
  );
  const root = options.codingToolRoot;
  const auditDir =
    root !== undefined && root.trim() !== ""
      ? toolAuditDir(
          { root, ...(options.outputDir !== undefined ? { outputDir: options.outputDir } : {}) },
          options.featureName,
        )
      : undefined;
  const sessionName = buildLedgerSessionName({
    ...(options.storyId !== undefined ? { storyId: options.storyId } : {}),
    ...(options.sessionRole !== undefined ? { sessionRole: options.sessionRole } : {}),
    ...(options.featureName !== undefined ? { featureName: options.featureName } : {}),
  });
  // Resolved here, ahead of the sync tool seam (buildCodingToolSupport):
  // both dispatch hops call that seam on a hot path, so it stays synchronous
  // and never touches the filesystem itself. Skipped unless the op declared
  // Exec — no reason to read a manifest off disk on every dispatch when
  // nothing downstream will use the result.
  const packageName =
    root !== undefined && root.trim() !== "" && declared.includes(EXEC_TOOL_NAME)
      ? await resolvePackageName(root)
      : undefined;
  return buildCodingToolSupport({
    root: options.codingToolRoot,
    ...(options.codingToolRepoRoot !== undefined ? { repoRoot: options.codingToolRepoRoot } : {}),
    grants: resolved.toolGrants,
    declared,
    ...(options.storyId !== undefined ? { storyId: options.storyId } : {}),
    declaredCommands,
    stripEnvVars,
    ...(auditDir !== undefined ? { auditDir } : {}),
    sessionName,
    ...(packageName !== undefined ? { packageName } : {}),
    allowScripts,
  });
}
