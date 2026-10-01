/**
 * The session-local tools an operation declares: RunCommand (its declared
 * commands and, when `Exec` is declared, its argv branch) and Bash.
 *
 * Extracted from coding-tool-support.ts to keep that file under its 600-line
 * source limit ahead of the P4 sandbox wiring. A pure move: every comment that
 * explains a field below travelled with it.
 */
import type { BashApprovalMode } from "@/config/bash-approval";
import type { CommandLauncher } from "@/sandbox";
import { type CodingTool, createBashTool, createRunCommandTool, type ToolGrant } from "@/tools";
import type { QualityCommandSpec } from "../quality";

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
  /** P4: how Bash and Exec-branch commands run; absent = direct spawn (tests). */
  readonly launcher?: CommandLauncher;
}

export function buildDeclaredCommandTools(args: DeclaredCommandToolsArgs): CodingTool[] {
  return [
    ...(args.declaredCommands.size > 0 || args.allowExec
      ? [
          createRunCommandTool(args.declaredCommands, {
            stripEnvVars: args.stripEnvVars,
            commandCwd: args.commandCwd ?? args.root,
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
          }),
        ]
      : []),
  ];
}
