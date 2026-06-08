/**
 * Monorepo Workspace Discovery
 *
 * Detects monorepo package directories from well-known workspace manifests:
 *   - pnpm-workspace.yaml
 *   - package.json#workspaces
 *   - lerna.json
 *   - turbo.json / nx.json
 *   - rush.json
 *   - Nested go.mod / pyproject.toml / Cargo.toml
 *   - Existing .nax/mono/ layout
 *
 * Returns a list of relative package directory paths (e.g. ["packages/api", "packages/web"]).
 * Returns empty array when not a monorepo or detection fails.
 */

import { join } from "node:path";
import { getSafeLogger } from "../../logger";

/** Injectable deps for testability */
export const _workspaceDeps = {
  readText: async (path: string): Promise<string | null> => {
    const f = Bun.file(path);
    if (!(await f.exists())) return null;
    return f.text();
  },
  spawn: Bun.spawn as typeof Bun.spawn,
  glob: (pattern: string, cwd: string) => new Bun.Glob(pattern).scan({ cwd, onlyFiles: false }),
  stat: (path: string) => Bun.file(path).stat(),
};

/** Expand workspace globs (e.g. "packages/*") to concrete directories */
async function expandWorkspaceGlob(workdir: string, pattern: string): Promise<string[]> {
  const dirs: string[] = [];
  try {
    const globber = new Bun.Glob(pattern);
    for await (const entry of globber.scan({ cwd: workdir, onlyFiles: false })) {
      // Only include directories that have a package.json / go.mod / etc.
      const hasMarker = await Promise.any([
        Bun.file(`${workdir}/${entry}/package.json`).exists(),
        Bun.file(`${workdir}/${entry}/go.mod`).exists(),
        Bun.file(`${workdir}/${entry}/pyproject.toml`).exists(),
        Bun.file(`${workdir}/${entry}/Cargo.toml`).exists(),
      ]).catch(() => false);
      if (hasMarker) dirs.push(entry);
    }
  } catch {
    // Glob error — skip pattern
  }
  return dirs;
}

/** Detect packages from pnpm-workspace.yaml */
async function detectPnpmWorkspace(workdir: string): Promise<string[]> {
  const text = await _workspaceDeps.readText(`${workdir}/pnpm-workspace.yaml`);
  if (!text) return [];
  try {
    const parsed = Bun.YAML.parse(text) as Record<string, unknown>;
    const packages = parsed?.packages;
    if (!Array.isArray(packages)) return [];
    const expanded = await Promise.all(
      packages
        .filter((p): p is string => typeof p === "string")
        .map((pattern) => expandWorkspaceGlob(workdir, pattern)),
    );
    return expanded.flat();
  } catch {
    return [];
  }
}

/** Detect packages from package.json#workspaces (npm/yarn) */
async function detectNpmWorkspaces(workdir: string): Promise<string[]> {
  const text = await _workspaceDeps.readText(`${workdir}/package.json`);
  if (!text) return [];
  try {
    const pkg = JSON.parse(text) as Record<string, unknown>;
    const workspaces = pkg.workspaces;
    const patterns: string[] = Array.isArray(workspaces)
      ? workspaces.filter((p): p is string => typeof p === "string")
      : typeof workspaces === "object" &&
          workspaces !== null &&
          Array.isArray((workspaces as Record<string, unknown>).packages)
        ? ((workspaces as Record<string, unknown>).packages as string[])
        : [];
    if (patterns.length === 0) return [];
    const expanded = await Promise.all(patterns.map((p) => expandWorkspaceGlob(workdir, p)));
    return expanded.flat();
  } catch {
    return [];
  }
}

/** Detect packages from lerna.json */
async function detectLernaWorkspace(workdir: string): Promise<string[]> {
  const text = await _workspaceDeps.readText(`${workdir}/lerna.json`);
  if (!text) return [];
  try {
    const config = JSON.parse(text) as Record<string, unknown>;
    const packages = config.packages;
    const patterns: string[] = Array.isArray(packages)
      ? packages.filter((p): p is string => typeof p === "string")
      : ["packages/*"];
    const expanded = await Promise.all(patterns.map((p) => expandWorkspaceGlob(workdir, p)));
    return expanded.flat();
  } catch {
    return [];
  }
}

/** Detect packages from turbo.json or nx.json (project root, no package dirs) */
async function detectTurboOrNx(workdir: string): Promise<string[]> {
  const hasTurbo = await Bun.file(`${workdir}/turbo.json`).exists();
  const hasNx = await Bun.file(`${workdir}/nx.json`).exists();
  if (!hasTurbo && !hasNx) return [];

  // Turbo/Nx projects also have pnpm-workspace.yaml or package.json#workspaces
  // We rely on those detectors for package dirs; this just confirms monorepo layout
  const fromPnpm = await detectPnpmWorkspace(workdir);
  const fromNpm = await detectNpmWorkspaces(workdir);
  return [...new Set([...fromPnpm, ...fromNpm])];
}

/** Detect packages from existing .nax/mono/ layout */
async function detectNaxMonoLayout(workdir: string): Promise<string[]> {
  const dirs: string[] = [];
  const monoRoot = join(workdir, ".nax", "mono");

  async function walk(currentDir: string, relativeParts: string[]): Promise<void> {
    const entries: string[] = [];
    for await (const entry of _workspaceDeps.glob("*", currentDir)) {
      entries.push(entry);
    }
    let hasConfig = false;

    for (const entry of entries) {
      const entryPath = join(currentDir, entry);
      const stat = await _workspaceDeps.stat(entryPath);
      const isDirectory = (stat.mode & 0o170000) === 0o040000;

      if (!isDirectory && entry === "config.json") {
        hasConfig = true;
        continue;
      }
      if (isDirectory) {
        await walk(entryPath, [...relativeParts, entry]);
      }
    }

    if (hasConfig && relativeParts.length > 0) {
      dirs.push(relativeParts.join("/"));
    }
  }

  try {
    await walk(monoRoot, []);
  } catch {
    // No .nax/mono layout
  }
  return dirs;
}

// ── Workspace Discovery Memo ──────────────────────────────────────────────────

const _workspaceCache = new Map<string, string[]>();

/** Clear the workspace-discovery memo. Call in test teardown for isolation. */
export function clearWorkspaceCache(): void {
  _workspaceCache.clear();
}

/**
 * Discover all monorepo package directories in the given workdir (memoized per process).
 * Returns a deduplicated list of relative paths.
 * Returns empty array for single-package projects.
 * Call `clearWorkspaceCache()` in test teardown to reset the memo.
 */
async function discoverWorkspacePackagesUncached(workdir: string): Promise<string[]> {
  const [fromPnpm, fromNpm, fromLerna, fromTurboNx, fromNaxMono] = await Promise.all([
    detectPnpmWorkspace(workdir),
    detectNpmWorkspaces(workdir),
    detectLernaWorkspace(workdir),
    detectTurboOrNx(workdir),
    detectNaxMonoLayout(workdir),
  ]);

  const all = [...fromPnpm, ...fromNpm, ...fromLerna, ...fromTurboNx, ...fromNaxMono];
  const unique = [...new Set(all)].sort();

  if (unique.length > 0) {
    getSafeLogger()?.debug("detect", "Workspace packages discovered", {
      workdir,
      count: unique.length,
      packages: unique,
    });
  }

  return unique;
}

/**
 * Discover all monorepo package directories in the given workdir (memoized per process).
 * Wraps `discoverWorkspacePackagesUncached` — same return value, cached after first call.
 */
export async function discoverWorkspacePackages(workdir: string): Promise<string[]> {
  if (_workspaceCache.has(workdir)) return _workspaceCache.get(workdir) ?? [];
  const result = await discoverWorkspacePackagesUncached(workdir);
  _workspaceCache.set(workdir, result);
  return result;
}
