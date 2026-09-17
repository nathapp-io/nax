import { isAbsolute, join, relative } from "node:path";
import type { ConfigLoader, ConfigSelector, NaxConfig } from "../config";
import { mergePackageConfig } from "../config";
import { getSafeLogger } from "../logger";

export const _packagesDeps = { getSafeLogger };

export type PackageOverrideLoader = (repoRoot: string, packageDir: string) => Promise<Partial<NaxConfig> | null>;

export interface PackageView {
  readonly packageDir: string;
  readonly relativeFromRoot: string;
  /**
   * Absolute path to the repo root (.nax/ anchor) — the MAIN CHECKOUT, captured
   * once per run and stamped on every view, never re-pointed at a worktree.
   *
   * Do NOT use it as a spawn cwd for a story-scoped command under worktree
   * isolation: that writes the user's real working tree (nax#2093). Route
   * package commands through `packageWorkdir(view)` and Exec's
   * `target: "repoRoot"` through `storyExecRoot(view)` instead.
   */
  readonly repoRoot: string;
  /** True when a per-package config override was hydrated for this package. */
  readonly hasOverride: boolean;
  readonly config: NaxConfig;
  select<C>(selector: ConfigSelector<C>): C;
}

export interface PackageRegistry {
  all(): readonly PackageView[];
  resolve(packageDir?: string): PackageView;
  repo(): PackageView;
  hydrate(packageDirs: readonly string[], loadOverride?: PackageOverrideLoader): Promise<void>;
}

/**
 * The absolute directory a PackageView's git and shell commands must run in.
 *
 * `packageDir` is "" for the root package of every single-package repo (see
 * `toRelativeKey`), and passing that straight to a spawn's `cwd` silently means
 * process.cwd() — the directory nax was launched from, which with `-d` is a
 * different repository entirely. Callers that need a real directory must route
 * through here rather than reading `packageDir` directly.
 *
 * Note the resolved path must exist: a spawn against a missing cwd throws
 * ENOENT, where the previous relative-path behaviour silently fell back to
 * process.cwd(). For a package directory a story has yet to create, that turns
 * a silently wrong result into a loud failure — deliberate, but a behaviour
 * change worth knowing about.
 */
export function packageWorkdir(view: Pick<PackageView, "packageDir" | "repoRoot">): string {
  const { packageDir, repoRoot } = view;
  if (!packageDir) return repoRoot;
  if (!repoRoot || isAbsolute(packageDir)) return packageDir;
  return join(repoRoot, packageDir);
}

function createPackageView(config: NaxConfig, packageDir: string, repoRoot: string, hasOverride: boolean): PackageView {
  const memo = new Map<string, unknown>();
  // TYPE-29 (D-23): use path.relative rather than startsWith(repoRoot) so
  // a sibling directory whose name is a prefix of the repo root (e.g.
  // /repo vs /repository) does not produce a garbage relative key.
  const relativeFromRoot = packageDir
    ? isAbsolute(packageDir) && isAbsolute(repoRoot)
      ? stripLeadingSlash(relative(repoRoot, packageDir))
      : packageDir
    : "";

  return {
    packageDir,
    relativeFromRoot,
    repoRoot,
    hasOverride,
    config,
    select<C>(selector: ConfigSelector<C>): C {
      if (memo.has(selector.name)) {
        return memo.get(selector.name) as C;
      }
      const value = selector.select(config);
      memo.set(selector.name, value);
      return value;
    },
  };
}

function stripLeadingSlash(p: string): string {
  return p.startsWith("./") ? p.slice(2) : p === "." ? "" : p;
}

export function createPackageRegistry(loader: ConfigLoader, repoRoot: string): PackageRegistry {
  const cache = new Map<string, PackageView>();
  const mergedConfigs = new Map<string, NaxConfig>();
  const knownPackages = new Set<string>();
  let hydrated = false;

  // Normalize to relative so cache and mergedConfigs keys are consistent with
  // what hydrate() stores (discoverWorkspacePackages returns relative paths).
  // Pipeline stages pass absolute workdirs; without this, mergedConfigs.get() always misses.
  // TYPE-29 (D-23): use path.relative rather than a separator-prefix check —
  // both inputs are absolute POSIX paths here, so the result is unambiguous
  // and the separator-less `startsWith(repoRoot)` bug is avoided.
  function toRelativeKey(packageDir: string | undefined): string {
    if (!packageDir) return "";
    if (isAbsolute(packageDir) && isAbsolute(repoRoot)) {
      if (packageDir === repoRoot) return "";
      return stripLeadingSlash(relative(repoRoot, packageDir));
    }
    return packageDir;
  }

  /**
   * Worktrees live at `<repoRoot>/.nax-wt/<storyId>/` (worktree/manager.ts), so a
   * story's package resolves to `.nax-wt/<storyId>/<pkg>` — which never matches the
   * plain `<pkg>` keys hydrate() stored, silently yielding root config (nax#2069).
   *
   * This strips the worktree prefix for the OVERRIDE LOOKUP ONLY. The key itself
   * stays as-is: resolve() passes it to createPackageView as `packageDir`, and
   * packageWorkdir() joins that onto repoRoot — shortening it would point every
   * file tool at the main checkout instead of the worktree.
   *
   * The guard rests on `.nax-wt` being a reserved nax worktree directory
   * (gitignored, hidden, and never a workspace package path), so a first path
   * segment of `.nax-wt` is treated as the worktree prefix.
   */
  function toOverrideKey(relativeKey: string): string {
    const segments = relativeKey.split("/");
    if (segments[0] !== ".nax-wt") return relativeKey;
    return segments.slice(2).join("/");
  }

  function resolve(packageDir?: string): PackageView {
    const key = toRelativeKey(packageDir);
    const cached = cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    // Use merged config if hydration pre-loaded one for this package; otherwise root config.
    const overrideKey = toOverrideKey(key);
    const overrideConfig = mergedConfigs.get(overrideKey);
    const hasOverride = overrideConfig !== undefined;
    // Warn when a caller resolves a non-root package before hydrate() has run — the
    // returned view silently uses root config instead of per-package overrides.  This
    // catches entry points (CLI one-off commands, plugins) that skip runSetupPhase.
    if (!hasOverride && key) {
      if (!hydrated) {
        _packagesDeps
          .getSafeLogger()
          ?.warn(
            "packages",
            "resolve() called for non-root package before hydrate(); returning root config (per-package overrides not applied)",
            { packageDir: key },
          );
      } else if (overrideKey && !knownPackages.has(overrideKey)) {
        _packagesDeps
          .getSafeLogger()
          ?.warn(
            "packages",
            "resolve() got an unknown package key after hydrate(); returning root config (per-package overrides not applied)",
            { packageDir: key, overrideKey },
          );
      }
    }
    const config = overrideConfig ?? loader.current();
    const view = createPackageView(config, key, repoRoot, hasOverride);
    cache.set(key, view);
    return view;
  }

  async function hydrate(packageDirs: readonly string[], loadOverride?: PackageOverrideLoader): Promise<void> {
    const load = loadOverride ?? (await import("../config")).loadPackageOverride;

    for (const dir of packageDirs) {
      if (!dir) {
        continue;
      }
      knownPackages.add(dir);
      if (mergedConfigs.has(dir)) {
        continue;
      }
      const override = await load(repoRoot, dir);
      if (override !== null) {
        mergedConfigs.set(dir, mergePackageConfig(loader.current(), override));
        // A pre-hydration resolve can have cached the same package through a
        // worktree path (`.nax-wt/<story>/<dir>`). Invalidate every identity
        // key that maps to this override, while preserving unrelated views.
        for (const key of cache.keys()) {
          if (toOverrideKey(key) === dir) cache.delete(key);
        }
      }
    }
    hydrated = true;
  }

  return {
    all() {
      return [...cache.values()];
    },
    resolve,
    repo() {
      return resolve(undefined);
    },
    hydrate,
  };
}

/**
 * The root of the tree the story is actually executing in.
 *
 * `PackageView.repoRoot` is the MAIN CHECKOUT -- captured once per run in
 * createRuntime() and stamped on every view, never re-pointed at a worktree.
 * Under storyIsolation "worktree" an Exec with target "repoRoot" resolved
 * against it wrote the user's real working tree (nax#2093).
 *
 * Counterpart to toOverrideKey above: that one strips the `.nax-wt/<storyId>`
 * prefix for the OVERRIDE LOOKUP; this one keeps it, because a repo-scoped
 * command must run inside the story's own tree. Both rest on `.nax-wt` being a
 * reserved nax worktree directory, gitignored and never a workspace package path.
 */
export function storyExecRoot(view: { readonly repoRoot: string; readonly packageDir?: string }): string {
  const { repoRoot, packageDir } = view;
  if (!packageDir) return repoRoot;
  // Mirror packageWorkdir's guard (:46). An absolute packageDir is already a
  // real directory the caller resolved, so the relative-key arithmetic below
  // does not apply: `split("/")[0]` is "" for such a path, the `.nax-wt` check
  // falls through, and returning repoRoot would hand back the MAIN CHECKOUT --
  // silently re-entering the nax#2093 bug this function exists to fix.
  if (!repoRoot || isAbsolute(packageDir)) return packageDir;
  const segments = packageDir.split("/");
  if (segments[0] !== ".nax-wt" || segments.length < 2) return repoRoot;
  return join(repoRoot, segments[0], segments[1] as string);
}
