/**
 * The package-manager knowledge table for the install-shaped exec branch.
 *
 * Each entry is DATA — a description of one manager's install verbs, its
 * no-scripts mechanism, and how to rewrite argv for a package-scoped versus
 * repo-root-scoped call. No branching policy lives here; `normalizeExec` in
 * `package-managers.ts` is the only place that interprets these fields.
 *
 * Facts this table encodes, verified against each tool's own documentation
 * (see task-4 brief, 2026-09-06):
 *
 * - Yarn 2+ ("Berry") has no `--ignore-scripts` flag; it honours the
 *   `enableScripts` setting, overridable per-invocation via the
 *   `YARN_ENABLE_SCRIPTS` environment variable. Yarn 1 ("Classic") takes
 *   `--ignore-scripts`. Passing `--ignore-scripts` to Yarn 2+ is a hard
 *   error, so version detection that is inconclusive must default to the
 *   Yarn 2+ branch — the env var is inert on Yarn 1, the flag is fatal on
 *   Yarn 2+, and failing toward the inert option is the safe direction.
 * - pnpm's `--filter` requires the `./` prefix to select by path
 *   (`--filter ./packages/foo`); the bare form (`packages/foo`) is parsed as
 *   a package NAME and silently selects nothing.
 * - `yarn workspace <name>` and `cargo add -p <name>` take the manifest
 *   NAME, not a path.
 *
 * pip and uv no-scripts mechanisms: I could not confirm a mechanism from
 * either tool's own documentation that actually suppresses arbitrary code
 * execution during an install the way `--ignore-scripts` does for npm/bun/
 * yarn-classic:
 *
 * - pip has no `--ignore-scripts` equivalent at all. `--only-binary :all:`
 *   forces wheel-only resolution (no sdist, so no `setup.py` executes for
 *   any package pip resolves), but it is a resolution-strategy flag, not a
 *   scripts switch — it errors the whole install if a required dependency
 *   ships no wheel, rather than degrading gracefully. Wiring it in as if it
 *   were "the no-scripts flag" would look like protection where none was
 *   verified, and I have not confirmed it is safe as a blanket default
 *   here. Left as `{ none: true }`.
 * - uv installs prebuilt wheels by default and only builds from source
 *   (running a build backend, e.g. `setup.py`/PEP 517 hooks) when a
 *   dependency has no wheel for the target platform, same as pip. There is
 *   no uv flag documented as suppressing that fallback build step itself —
 *   `--no-build-isolation` changes how a source build is isolated, it does
 *   not prevent one from happening, so it is not a substitute either. Left
 *   as `{ none: true }` per the brief's instruction not to invent a switch.
 *
 * Both gaps mean pip/uv installs get cwd/scoping normalization but no
 * scripts-suppression hardening. This should be tracked as a follow-up
 * rather than silently accepted.
 */

import type { NormalizeResult, NoScripts, WorkspaceContext } from "./package-managers-types";

export interface ManagerEntry {
  /** Install verbs. A verb outside this list makes the call generic, not denied. */
  readonly installVerbs: readonly (readonly string[])[];
  readonly noScripts: (ctx: WorkspaceContext) => NoScripts;
  /** True when the manager needs the member's manifest NAME rather than its path. */
  readonly needsPackageName: boolean;
  readonly packageForm: (argv: readonly string[], ctx: WorkspaceContext) => NormalizeResult;
  readonly rootForm: (argv: readonly string[], ctx: WorkspaceContext) => NormalizeResult;
}

const IGNORE_SCRIPTS_FLAG: NoScripts = { flag: "--ignore-scripts" };
const NO_MECHANISM: NoScripts = { none: true };

export const MANAGER_TABLE: Readonly<Record<string, ManagerEntry>> = {
  bun: {
    installVerbs: [["install"], ["add"]],
    noScripts: () => IGNORE_SCRIPTS_FLAG,
    needsPackageName: false,
    // bun resolves the workspace member purely from cwd — no scoping flag needed.
    packageForm: (argv, ctx) => ({ argv, cwd: ctx.packageWorkdir }),
    rootForm: (argv, ctx) => ({ argv, cwd: ctx.repoRoot }),
  },

  npm: {
    installVerbs: [["install"], ["ci"]],
    noScripts: () => IGNORE_SCRIPTS_FLAG,
    needsPackageName: false,
    // `npm -w <relPath> <verb> ...` runs from the repo root; `-w` accepts a
    // relative path.
    packageForm: (argv, ctx) => ({
      argv: [argv[0] as string, "-w", ctx.packageRelPath, ...argv.slice(1)],
      cwd: ctx.repoRoot,
    }),
    rootForm: (argv, ctx) => ({ argv, cwd: ctx.repoRoot }),
  },

  pnpm: {
    installVerbs: [["install"], ["add"]],
    noScripts: () => IGNORE_SCRIPTS_FLAG,
    needsPackageName: false,
    // The `./` prefix is mandatory: pnpm parses a bare "packages/foo" as a
    // package NAME, which silently selects nothing.
    packageForm: (argv, ctx) => ({
      argv: [argv[0] as string, "--filter", `./${ctx.packageRelPath}`, ...argv.slice(1)],
      cwd: ctx.repoRoot,
    }),
    // `pnpm add -w ...` targets the workspace root package explicitly.
    rootForm: (argv, ctx) => ({
      argv: [argv[0] as string, argv[1] as string, "-w", ...argv.slice(2)],
      cwd: ctx.repoRoot,
    }),
  },

  yarn: {
    installVerbs: [["install"], ["add"]],
    noScripts: (ctx) => (ctx.yarnMajor === 1 ? IGNORE_SCRIPTS_FLAG : { env: { YARN_ENABLE_SCRIPTS: "false" } }),
    needsPackageName: true,
    // `yarn workspace <name> ...` takes the manifest NAME, not a path.
    packageForm: (argv, ctx) => {
      if (!ctx.packageName) {
        return { error: "yarn workspace scoping requires the member package's manifest name" };
      }
      return { argv: [argv[0] as string, "workspace", ctx.packageName, ...argv.slice(1)], cwd: ctx.repoRoot };
    },
    rootForm: (argv, ctx) => ({ argv, cwd: ctx.repoRoot }),
  },

  pip: {
    installVerbs: [["install"]],
    // See file header: no confirmed ignore-scripts equivalent for pip.
    noScripts: () => NO_MECHANISM,
    needsPackageName: false,
    packageForm: (argv, ctx) => ({ argv, cwd: ctx.packageWorkdir }),
    rootForm: (argv, ctx) => ({ argv, cwd: ctx.repoRoot }),
  },

  uv: {
    installVerbs: [["sync"], ["add"]],
    // See file header: no confirmed ignore-scripts equivalent for uv.
    noScripts: () => NO_MECHANISM,
    needsPackageName: true,
    // `uv <verb> --package <name> ...` restricts the operation to one
    // workspace member; runs from the repo root.
    packageForm: (argv, ctx) => {
      if (!ctx.packageName) {
        return { error: "uv workspace scoping requires the member package's manifest name" };
      }
      return {
        argv: [argv[0] as string, argv[1] as string, "--package", ctx.packageName, ...argv.slice(2)],
        cwd: ctx.repoRoot,
      };
    },
    rootForm: (argv, ctx) => ({ argv, cwd: ctx.repoRoot }),
  },

  go: {
    installVerbs: [["get"], ["mod", "download"]],
    // Downloads only; runs nothing.
    noScripts: () => NO_MECHANISM,
    needsPackageName: false,
    packageForm: (argv, ctx) => ({ argv, cwd: ctx.packageWorkdir }),
    rootForm: (argv, ctx) => ({ argv, cwd: ctx.repoRoot }),
  },

  cargo: {
    installVerbs: [["add"], ["fetch"]],
    // `cargo add` edits a manifest, `cargo fetch` downloads; neither runs a
    // build script during the command itself.
    noScripts: () => NO_MECHANISM,
    needsPackageName: true,
    // `cargo add -p <name> ...` takes the manifest NAME, not a path.
    packageForm: (argv, ctx) => {
      if (!ctx.packageName) {
        return { error: "cargo -p scoping requires the member package's manifest name" };
      }
      return {
        argv: [argv[0] as string, argv[1] as string, "-p", ctx.packageName, ...argv.slice(2)],
        cwd: ctx.repoRoot,
      };
    },
    rootForm: (argv, ctx) => ({ argv, cwd: ctx.repoRoot }),
  },
};
