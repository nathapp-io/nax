/**
 * The package-manager knowledge table for the install-shaped exec branch.
 *
 * Each entry is DATA — a description of one manager's install verbs (and
 * their aliases), its no-scripts mechanism, how to rewrite argv for a
 * package-scoped versus repo-root-scoped call, and which incoming flags
 * would smuggle in a second workspace member if we spliced our own scoping
 * flag in beside them. No branching policy lives here; `normalizeExec` in
 * `package-managers.ts` is the only place that interprets these fields.
 *
 * Facts this table encodes, verified against each tool's own documentation
 * (see task-4 brief, 2026-09-06) plus two review-driven fix rounds:
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
 *
 * Install-verb ALIASES (fix round 1, Critical finding A): each manager's
 * install verb has common short aliases the model can reach for just as
 * easily as the canonical spelling (`npm i` is as ordinary an invocation as
 * `npm install`). They are listed here as additional single-token verb
 * sequences, matched by `classifyExec` exactly like the canonical verb in
 * both its position-anchored match and its fail-closed scan — never as a
 * special case in the matcher itself. Sources: npm's own `install` command
 * aliases (`i`, `in`, `ins`, `inst`, `insta`, `instal`, `install`, `add`) and
 * its `install-test`/`it` alias pair; pnpm's `i`/`install-test` aliases of
 * `install`; bun's `i`/`a` aliases of `install`/`add`. Yarn Classic and
 * Berry do not document a short alias for `install`/`add`, so none is
 * added — checked and confirmed empty, not merely unresearched.
 *
 * Workspace-scoping SMUGGLING (fix round 1, Critical finding 2 + addendum
 * A/C): before this table splices in its own scoping flag or no-scripts
 * flag, `normalizeExec` screens the incoming argv for tokens that would
 * change what gets targeted if left in place — a second `-w`/`--filter`
 * naming another member, or a `--ignore-scripts`/`--no-ignore-scripts` the
 * model added itself. `scopingConflict` is each entry's screen for the
 * first kind; the second kind (`SCRIPTS_CONTROL_FLAG`) is universal and
 * lives in `package-managers.ts` since it isn't manager-specific data. Both
 * DENY rather than strip: dropping a flag the model wrote changes the
 * request while reporting success, which is worse than a visible refusal.
 * Coverage: npm `-w`/`--workspace`/`--workspaces`/`--workspace-root`/
 * `--include-workspace-root`; pnpm `--filter`/`-f`/`-w`/`--workspace-root`/
 * `--filter-prod`/`--include-workspace-root`; cargo `-p`/`--package`; uv
 * `--package`/`--all-packages`. Yarn's `workspace`/`workspaces` leading
 * subcommand is not screened here — see the comment on yarn's
 * `scopingConflict` for why that path is already unreachable by
 * construction.
 *
 * Directory-redirect CONTAINMENT (fix round 2): `target` is a closed enum
 * precisely so no path can arrive from the model — `normalizeExec` computes
 * cwd, the model never supplies one. A directory-redirect flag inside argv
 * (`bun add --cwd /elsewhere x`) hands that choice straight back, ignoring
 * whatever cwd this table computed. This is the containment property
 * itself, not a scoping nicety, so it is screened for EVERY manager entry
 * via `globalDirectoryFlags`/`installDirectoryFlags`, denied on the same
 * deny-never-strip basis as scoping/scripts-control flags.
 *
 * A flag global to the manager (works with any subcommand, not just an
 * install verb) is screened for BOTH install-shaped and generic calls —
 * `normalizeExec` checks it before branching on classification kind at all,
 * because a generic call (`bun x tsc --cwd /elsewhere`) escapes the same
 * containment otherwise. An install-specific flag is screened only when the
 * call is already install-shaped, since it has no effect (or no meaning) on
 * a generic invocation of that manager.
 *
 * | manager | global (`globalDirectoryFlags`) | install-only (`installDirectoryFlags`) |
 * |---|---|---|
 * | bun | `--cwd` | — |
 * | yarn | `--cwd`, `-C` (fix round 3 — `-C` is added for symmetry with pnpm; not confirmed as a documented yarn alias, but an over-denial here is the safe direction) | — |
 * | pnpm | `--dir`, `-C` | — |
 * | npm | — | — (`--prefix` changes npm's effective directory; already denied by `DENIED_FLAGS` in `exec-guard.ts` regardless of manager — not duplicated here) |
 * | cargo | `--manifest-path` (accepted by nearly every cargo subcommand, `add`/`fetch` included) | — |
 * | pip | `--python` (a general pip option, valid before or after the subcommand, that redirects which interpreter/environment gets installed into) | `--target`, `-t` (documented short alias, fix round 3), `--root` (install-destination overrides, meaningful only for `pip install`; `--prefix` is likewise install-scoped but already covered by the same shared `DENIED_FLAGS` entry as npm's, so also not duplicated) |
 * | uv | `--directory`, `--project` (both are documented as general uv options, accepted ahead of the subcommand, that change what "the project" means for the whole invocation) | — |
 * | go | `-C` (a general go flag: "change to dir before running the command") | — |
 *
 * `uv pip <anything>` (fix round 3, finding 3) is denied at classification
 * time, not treated as a directory-redirect flag gap — see the comment on
 * `isNestedPipInvocation` in `package-managers.ts` for why nesting one
 * manager's semantics inside another's entry was rejected in favor of a
 * flat denial.
 */

import { normalizeFlagToken } from "./exec-guard";
import type { NormalizeResult, NoScripts, WorkspaceContext } from "./package-managers-types";

export interface ManagerEntry {
  /** Install verbs AND their aliases. A verb outside this list makes the call generic, not denied. */
  readonly installVerbs: readonly (readonly string[])[];
  readonly noScripts: (ctx: WorkspaceContext) => NoScripts;
  /** True when the manager needs the member's manifest NAME rather than its path. Read centrally by `normalizeExec`. */
  readonly needsPackageName: boolean;
  /**
   * Returns the incoming flag/token that would smuggle in a scoping
   * decision of its own (another workspace member, or "all packages") if
   * this table spliced its own scoping flag in beside it — or `undefined`
   * when the argv is clean. Checked before any rewriting.
   */
  readonly scopingConflict: (argv: readonly string[]) => string | undefined;
  /**
   * Returns the incoming flag that redirects the working directory (or the
   * install destination/environment) this manager operates on, when that
   * flag is global to the manager — checked for BOTH install-shaped and
   * generic calls, since `target` being a closed enum only holds if no
   * argv-supplied path can override it.
   */
  readonly globalDirectoryConflict: (argv: readonly string[]) => string | undefined;
  /** Same as `globalDirectoryConflict`, but for a flag that only applies to
   * (or only makes sense for) an install verb — checked only when the call
   * is already install-shaped. */
  readonly installDirectoryConflict: (argv: readonly string[]) => string | undefined;
  readonly packageForm: (argv: readonly string[], ctx: WorkspaceContext) => NormalizeResult;
  readonly rootForm: (argv: readonly string[], ctx: WorkspaceContext) => NormalizeResult;
}

const IGNORE_SCRIPTS_FLAG: NoScripts = { flag: "--ignore-scripts" };
const NO_MECHANISM: NoScripts = { none: true };

/** Shared by every `packageForm` that needs the member's manifest NAME (yarn, cargo, uv).
 * `normalizeExec` already denies before calling `packageForm` when
 * `entry.needsPackageName` is true and `input.packageName` is undefined —
 * this exists so each `packageForm` can narrow `ctx.packageName` from
 * `string | undefined` to `string` without a postfix `!` (banned in this
 * repo), and as a second, independent guard rather than only a comment. */
function packageNameOrError(
  ctx: WorkspaceContext,
  manager: string,
): { readonly name: string } | { readonly error: string } {
  if (ctx.packageName === undefined) {
    return { error: `${manager} workspace scoping requires the member package's manifest name` };
  }
  return { name: ctx.packageName };
}

/** A token anywhere in argv (after the binary) that case/`=`-normalizes to one of `flags`. */
function flagConflict(argv: readonly string[], flags: readonly string[]): string | undefined {
  const lowered = new Set(flags.map((flag) => normalizeFlagToken(flag)));
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i] as string;
    if (lowered.has(normalizeFlagToken(token))) return token;
  }
  return undefined;
}

export const MANAGER_TABLE: Readonly<Record<string, ManagerEntry>> = {
  bun: {
    installVerbs: [["install"], ["i"], ["add"], ["a"]],
    noScripts: () => IGNORE_SCRIPTS_FLAG,
    needsPackageName: false,
    // bun has no workspace-scoping flag in this table's model — nothing to smuggle.
    scopingConflict: () => undefined,
    // `--cwd` is global to bun (any subcommand), so it must be screened
    // regardless of classification — see the file header table.
    globalDirectoryConflict: (argv) => flagConflict(argv, ["--cwd"]),
    installDirectoryConflict: () => undefined,
    // bun resolves the workspace member purely from cwd — no scoping flag needed.
    packageForm: (argv, ctx) => ({ argv, cwd: ctx.packageWorkdir }),
    rootForm: (argv, ctx) => ({ argv, cwd: ctx.repoRoot }),
  },

  npm: {
    installVerbs: [
      ["install"],
      ["i"],
      ["in"],
      ["ins"],
      ["inst"],
      ["insta"],
      ["instal"],
      ["install-test"],
      ["it"],
      ["add"],
      ["ci"],
    ],
    noScripts: () => IGNORE_SCRIPTS_FLAG,
    needsPackageName: false,
    scopingConflict: (argv) =>
      flagConflict(argv, ["-w", "--workspace", "--workspaces", "--workspace-root", "--include-workspace-root"]),
    // npm's directory-redirect flag is `--prefix`, already denied by the
    // shared, manager-agnostic `DENIED_FLAGS` in `exec-guard.ts` — not
    // duplicated here (see the file header table).
    globalDirectoryConflict: () => undefined,
    installDirectoryConflict: () => undefined,
    // `npm -w <relPath> <verb> ...` runs from the repo root; `-w` accepts a
    // relative path.
    packageForm: (argv, ctx) => ({
      argv: [argv[0] as string, "-w", ctx.packageRelPath, ...argv.slice(1)],
      cwd: ctx.repoRoot,
    }),
    rootForm: (argv, ctx) => ({ argv, cwd: ctx.repoRoot }),
  },

  pnpm: {
    installVerbs: [["install"], ["i"], ["install-test"], ["add"]],
    noScripts: () => IGNORE_SCRIPTS_FLAG,
    needsPackageName: false,
    scopingConflict: (argv) =>
      flagConflict(argv, ["--filter", "-f", "-w", "--workspace-root", "--filter-prod", "--include-workspace-root"]),
    // `--dir`/`-C` are global to pnpm (any subcommand) — screened
    // regardless of classification.
    globalDirectoryConflict: (argv) => flagConflict(argv, ["--dir", "-C"]),
    installDirectoryConflict: () => undefined,
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
    // `yarn workspace <name> ...`/`yarn workspaces ...` as a LEADING
    // subcommand would be the smuggling vector here, but it is already
    // unreachable: `classifyExec`'s position-anchored match only ever
    // classifies a call as install-shaped when the very first non-flag
    // token IS an install verb. A leading "workspace"/"workspaces" token
    // fails that match, and the real verb further along the argv is then
    // caught by the fail-closed scan instead (denied, not silently made
    // generic) before this function is ever reached. No independent screen
    // is needed on top of that.
    scopingConflict: () => undefined,
    // `--cwd` is global to yarn (any subcommand) — screened regardless of
    // classification. `-C` is added for symmetry with pnpm's entry (fix
    // round 3, finding 2) — yarn's own docs do not document a `-C` short
    // alias, so this is an over-denial rather than a confirmed fact; that
    // is the safe direction here, so it stays.
    globalDirectoryConflict: (argv) => flagConflict(argv, ["--cwd", "-C"]),
    installDirectoryConflict: () => undefined,
    // `yarn workspace <name> ...` takes the manifest NAME, not a path.
    packageForm: (argv, ctx) => {
      const resolved = packageNameOrError(ctx, "yarn");
      if ("error" in resolved) return resolved;
      return { argv: [argv[0] as string, "workspace", resolved.name, ...argv.slice(1)], cwd: ctx.repoRoot };
    },
    rootForm: (argv, ctx) => ({ argv, cwd: ctx.repoRoot }),
  },

  pip: {
    installVerbs: [["install"]],
    // See file header: no confirmed ignore-scripts equivalent for pip.
    noScripts: () => NO_MECHANISM,
    needsPackageName: false,
    // pip has no workspace concept in this table's model — nothing to smuggle.
    scopingConflict: () => undefined,
    // `--python` is a general pip option (valid before or after the
    // subcommand) that redirects which interpreter/environment gets
    // installed into — screened regardless of classification. `--prefix`
    // would be the other general redirect, but it is already covered by
    // the same shared `DENIED_FLAGS` entry as npm's, so not duplicated.
    globalDirectoryConflict: (argv) => flagConflict(argv, ["--python"]),
    // `--target`/`--root` only mean anything for `pip install`. `-t` is
    // pip's own documented short alias for `--target` (fix round 3,
    // finding 1) — checked pip's docs for a short alias of `--root` and
    // `--python` too; neither documents one, so only `-t` is added here.
    installDirectoryConflict: (argv) => flagConflict(argv, ["--target", "-t", "--root"]),
    packageForm: (argv, ctx) => ({ argv, cwd: ctx.packageWorkdir }),
    rootForm: (argv, ctx) => ({ argv, cwd: ctx.repoRoot }),
  },

  uv: {
    installVerbs: [["sync"], ["add"]],
    // See file header: no confirmed ignore-scripts equivalent for uv.
    noScripts: () => NO_MECHANISM,
    needsPackageName: true,
    scopingConflict: (argv) => flagConflict(argv, ["--package", "--all-packages"]),
    // `--directory`/`--project` are general uv options (accepted ahead of
    // the subcommand) that change what "the project" means for the whole
    // invocation — screened regardless of classification.
    globalDirectoryConflict: (argv) => flagConflict(argv, ["--directory", "--project"]),
    installDirectoryConflict: () => undefined,
    // `uv <verb> --package <name> ...` restricts the operation to one
    // workspace member; runs from the repo root.
    packageForm: (argv, ctx) => {
      const resolved = packageNameOrError(ctx, "uv");
      if ("error" in resolved) return resolved;
      return {
        argv: [argv[0] as string, argv[1] as string, "--package", resolved.name, ...argv.slice(2)],
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
    // go has no workspace-scoping flag in this table's model — nothing to smuggle.
    scopingConflict: () => undefined,
    // `-C dir` is a general go flag ("change to dir before running the
    // command") — screened regardless of classification.
    globalDirectoryConflict: (argv) => flagConflict(argv, ["-C"]),
    installDirectoryConflict: () => undefined,
    packageForm: (argv, ctx) => ({ argv, cwd: ctx.packageWorkdir }),
    rootForm: (argv, ctx) => ({ argv, cwd: ctx.repoRoot }),
  },

  cargo: {
    installVerbs: [["add"], ["fetch"]],
    // `cargo add` edits a manifest, `cargo fetch` downloads; neither runs a
    // build script during the command itself.
    noScripts: () => NO_MECHANISM,
    needsPackageName: true,
    scopingConflict: (argv) => flagConflict(argv, ["-p", "--package"]),
    // `--manifest-path` is accepted by nearly every cargo subcommand,
    // `add`/`fetch` included — screened regardless of classification.
    globalDirectoryConflict: (argv) => flagConflict(argv, ["--manifest-path"]),
    installDirectoryConflict: () => undefined,
    // `cargo add -p <name> ...` takes the manifest NAME, not a path.
    packageForm: (argv, ctx) => {
      const resolved = packageNameOrError(ctx, "cargo");
      if ("error" in resolved) return resolved;
      return {
        argv: [argv[0] as string, argv[1] as string, "-p", resolved.name, ...argv.slice(2)],
        cwd: ctx.repoRoot,
      };
    },
    rootForm: (argv, ctx) => ({ argv, cwd: ctx.repoRoot }),
  },
};
