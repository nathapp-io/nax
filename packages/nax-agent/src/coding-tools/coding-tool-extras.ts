/**
 * The session-local tools an operation declares: RunCommand (its declared
 * commands and, when `Exec` is declared, its argv branch) and Bash.
 *
 * Extracted from coding-tool-support.ts to keep that file under its 600-line
 * source limit ahead of the P4 sandbox wiring. A pure move: every comment that
 * explains a field below travelled with it.
 */
import type { BashApprovalMode } from "#src/config/bash-approval";
import type { QualityCommandSpec } from "#src/internal/command-spec/index";
import type { CommandLauncher } from "#src/sandbox/index";
import {
  type CodingTool,
  createBashTool,
  createRunCommandTool,
  type DeclaredCommandRunner,
  type ToolGrant,
} from "#src/tools/index";

export interface DeclaredCommandToolsArgs {
  readonly declaredCommands: ReadonlyMap<string, QualityCommandSpec>;
  readonly allowExec: boolean;
  readonly execGrant: ToolGrant | undefined;
  readonly allowBash: boolean;
  readonly bashDescriptionPatterns: readonly string[];
  readonly bashApproval: BashApprovalMode;
  /** A human can answer an escalated Bash command (ADR-030, amended for P4). */
  readonly humanApproval?: boolean;
  readonly root: string;
  readonly repoRoot?: string;
  readonly packageWorkdir?: string;
  readonly commandCwd?: string;
  readonly allowScripts?: boolean;
  readonly packageName?: string;
  readonly stripEnvVars?: readonly string[];
  readonly shell?: string;
  /** Port 7: runs declared commands; nax supplies `runQualityCommand`. */
  readonly runDeclaredCommand?: DeclaredCommandRunner;
  /** P4: how Bash and Exec-branch commands run; absent = direct spawn (tests). */
  readonly launcher?: CommandLauncher;
  /**
   * US-003/US-008: whether this session offers the per-call `unsandboxed`
   * argument — on Bash (`createBashTool`) and on RunCommand's argv branch
   * (`createRunCommandTool`'s `exec` option, US-008). Advertisement only:
   * RunCommand's DECLARED-command branch has no argv to unwrap and refuses the
   * flag by name.
   */
  readonly unsandboxedCommands?: boolean;
}

/**
 * US-003: `unsandboxedCommands` as a spreadable field — present only when the
 * session opted in, so "off" and "absent" stay one shape all the way down to
 * `createBashTool` and to RunCommand's `exec` option (US-008).
 *
 * A helper rather than an inline `cond ? { field } : {}` spread because
 * `buildDeclaredCommandTools` and `buildCodingToolSupport` both sit at their
 * cognitive-complexity baseline and a ternary inside either one would raise it.
 */
export function unsandboxedToolOptions(args: { readonly unsandboxedCommands?: boolean }): {
  readonly unsandboxedCommands?: true;
} {
  return args.unsandboxedCommands === true ? { unsandboxedCommands: true } : {};
}

/**
 * US-005: the same option as the RUNTIME's field — whether a `Bash`/`Exec`
 * call may run outside the sandbox at all, plus the Bash approval mode that
 * decides how an enabled request is routed.
 *
 * Absent when the session did not opt in, so "off" and "absent" stay one shape
 * all the way to `createCodingToolRuntime` (absent means disabled). A helper
 * for the same reason as `unsandboxedToolOptions`: `buildCodingToolSupport`
 * sits at its cognitive-complexity baseline and a ternary inside it would
 * raise it.
 */
export function unsandboxedRuntimeOption(args: {
  readonly unsandboxedCommands?: boolean;
  readonly askOnUnsandboxed?: boolean;
  readonly bashApproval: BashApprovalMode;
}): {
  readonly unsandboxed?: {
    readonly enabled: boolean;
    readonly bashApproval: BashApprovalMode;
    readonly alwaysAsk?: boolean;
  };
} {
  if (args.unsandboxedCommands !== true) return {};
  return {
    unsandboxed: {
      enabled: true,
      bashApproval: args.bashApproval,
      ...(args.askOnUnsandboxed === true ? { alwaysAsk: true } : {}),
    },
  };
}

export function buildDeclaredCommandTools(args: DeclaredCommandToolsArgs): CodingTool[] {
  return [
    ...(args.declaredCommands.size > 0 || args.allowExec
      ? [
          createRunCommandTool(args.declaredCommands, {
            stripEnvVars: args.stripEnvVars,
            commandCwd: args.commandCwd ?? args.root,
            runDeclaredCommand: args.runDeclaredCommand,
            ...(args.allowExec
              ? {
                  exec: {
                    repoRoot: args.repoRoot ?? args.root,
                    // Post-root-move: `args.root` is the repo root, so the
                    // fallback only matters for single-package repos where
                    // the two coincide (and for tests not threading
                    // `packageWorkdir`). Production always threads it via
                    // `commandCwd` plumbing in `resolveCodingToolSupport`
                    // (Task 10), which makes `effectiveTarget`'s
                    // `packageRelPath === ""` collapse impossible for a
                    // package story.
                    packageWorkdir: args.packageWorkdir ?? args.root,
                    allowScripts: args.allowScripts ?? false,
                    // The compiled grant, not BUILT_IN_EXEC_PATTERNS -- a
                    // project's own Exec(...) expression replaces that
                    // list rather than extending it (see the comment on
                    // BUILT_IN_EXEC_PATTERNS in src/config/permissions.ts).
                    // `allowExec` is true only when execGrant is defined,
                    // so this array is never actually empty at this call
                    // site; the fallback exists only for the type.
                    patterns: args.execGrant?.patterns ?? [],
                    ...(args.packageName !== undefined ? { packageName: args.packageName } : {}),
                    ...(args.launcher !== undefined ? { launcher: args.launcher } : {}),
                    // US-008: the same option Bash takes, forwarded to the argv
                    // branch's advertisement through the same helper — one
                    // shape for "off" and "absent" on both tools.
                    ...unsandboxedToolOptions(args),
                  },
                }
              : {}),
          }),
        ]
      : []),
    ...(args.allowBash
      ? [
          createBashTool({
            ...(args.shell !== undefined ? { shell: args.shell } : {}),
            ...(args.stripEnvVars !== undefined ? { stripEnvVars: args.stripEnvVars } : {}),
            // The EFFECTIVE grant, so the description names what THIS
            // stage may actually run, incl. the synthetic grant under
            // `raw` (ADR-030 / F3) -- ignored under `raw` regardless.
            patterns: args.bashDescriptionPatterns,
            bashApproval: args.bashApproval,
            ...(args.humanApproval === true ? { humanApproval: true } : {}),
            ...(args.launcher !== undefined ? { launcher: args.launcher } : {}),
            ...unsandboxedToolOptions(args),
          }),
        ]
      : []),
  ];
}
