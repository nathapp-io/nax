/**
 * Shared types between `package-managers.ts` (the public surface) and
 * `package-managers-table.ts` (the per-manager data). Split out so the table
 * does not need to import the module that imports it.
 */

export type ExecTarget = "package" | "repoRoot";

/**
 * The subset of `NormalizeInput` a manager entry's functions need, minus the
 * argv/target already threaded explicitly through the call.
 */
export interface WorkspaceContext {
  readonly repoRoot: string;
  readonly packageWorkdir: string;
  readonly packageRelPath: string;
  readonly packageName?: string;
  readonly allowScripts: boolean;
  /** Yarn major version, when known. Undefined means "inconclusive" — the
   * Yarn entry's `noScripts` must default to the Yarn 2+ (env-var) branch,
   * since the flag branch is a hard error on Yarn 2+ and the env var is
   * merely inert on Yarn 1. */
  readonly yarnMajor?: number;
}

export type NoScripts =
  | { readonly flag: string }
  | { readonly env: Readonly<Record<string, string>> }
  | { readonly none: true };

export type NormalizeResult =
  | { readonly argv: readonly string[]; readonly cwd: string; readonly env?: Readonly<Record<string, string>> }
  | { readonly error: string };
