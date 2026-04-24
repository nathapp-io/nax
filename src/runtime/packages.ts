import type { ConfigLoader, ConfigSelector, NaxConfig } from "../config";

export interface PackageView {
  readonly packageDir: string;
  readonly relativeFromRoot: string;
  readonly config: NaxConfig;
  select<C>(selector: ConfigSelector<C>): C;
}

export interface PackageRegistry {
  all(): readonly PackageView[];
  resolve(packageDir?: string): PackageView;
  repo(): PackageView;
}

function createPackageView(config: NaxConfig, packageDir: string, repoRoot: string): PackageView {
  const memo = new Map<string, unknown>();
  const relativeFromRoot = packageDir
    ? packageDir.startsWith(repoRoot)
      ? packageDir.slice(repoRoot.length).replace(/^\//, "")
      : packageDir
    : "";

  return {
    packageDir,
    relativeFromRoot,
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

  function resolve(packageDir?: string): PackageView {
    const key = packageDir ?? "";
    const cached = cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    // Wave 1: no per-package config merging — root config only.
    // Wave 3 will call mergePackageConfig(root, loadPackageOverride(packageDir)).
    const config = loader.current();
    const view = createPackageView(config, key, repoRoot);
    cache.set(key, view);
    return view;
  }

  return {
    all() {
      return [...cache.values()];
    },
    resolve,
    repo() {
      return resolve(undefined);
    },
  };
}
