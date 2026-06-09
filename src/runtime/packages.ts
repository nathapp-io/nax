import type { ConfigLoader, ConfigSelector, NaxConfig } from "../config";
import { mergePackageConfig } from "../config";

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
  const relativeFromRoot = packageDir
    ? packageDir.startsWith(repoRoot)
      ? packageDir.slice(repoRoot.length).replace(/^\//, "")
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

export function createPackageRegistry(loader: ConfigLoader, repoRoot: string): PackageRegistry {
  const cache = new Map<string, PackageView>();
  const mergedConfigs = new Map<string, NaxConfig>();

  // Normalize to relative so cache and mergedConfigs keys are consistent with
  // what hydrate() stores (discoverWorkspacePackages returns relative paths).
  // Pipeline stages pass absolute workdirs; without this, mergedConfigs.get() always misses.
  function toRelativeKey(packageDir: string | undefined): string {
    if (!packageDir) return "";
    const prefix = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
    if (packageDir.startsWith(prefix)) return packageDir.slice(prefix.length);
    if (packageDir === repoRoot) return "";
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
