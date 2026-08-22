import { isAbsolute, relative } from "node:path";
import type { ConfigLoader, ConfigSelector, NaxConfig } from "../config";
import { mergePackageConfig } from "../config";
import { getSafeLogger } from "../logger";

export const _packagesDeps = { getSafeLogger };

export type PackageOverrideLoader = (repoRoot: string, packageDir: string) => Promise<Partial<NaxConfig> | null>;

export interface PackageView {
  readonly packageDir: string;
  readonly relativeFromRoot: string;
  /** Absolute path to the repo root (.nax/ anchor). Use as cwd when running root-config commands. */
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

  function resolve(packageDir?: string): PackageView {
    const key = toRelativeKey(packageDir);
    const cached = cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    // Use merged config if hydration pre-loaded one for this package; otherwise root config.
    const overrideConfig = mergedConfigs.get(key);
    const hasOverride = overrideConfig !== undefined;
    // Warn when a caller resolves a non-root package before hydrate() has run — the
    // returned view silently uses root config instead of per-package overrides.  This
    // catches entry points (CLI one-off commands, plugins) that skip runSetupPhase.
    if (!hasOverride && key && !hydrated) {
      _packagesDeps
        .getSafeLogger()
        ?.warn(
          "packages",
          "resolve() called for non-root package before hydrate(); returning root config (per-package overrides not applied)",
          { packageDir: key },
        );
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
      if (mergedConfigs.has(dir)) {
        continue;
      }
      const override = await load(repoRoot, dir);
      if (override !== null) {
        mergedConfigs.set(dir, mergePackageConfig(loader.current(), override));
        // Invalidate any stale root-config view so the next resolve() picks up the merge.
        cache.delete(dir);
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
