/**
 * Context Engine — Manifest Persistence
 *
 * Persists per-stage ContextManifest files under:
 *   <projectDir>/.nax/features/<featureId>/stories/<storyId>/context-manifest-<stage>.json
 *
 * Also provides lightweight discovery helpers for `nax context inspect`.
 */

import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { featureDir, featuresDir } from "@/config";
import { saveJsonFile } from "@/utils/json-file";
import type { ContextManifest } from "./types";

export const _manifestStoreDeps = {
  mkdirp: (path: string): Promise<string | undefined> => mkdir(path, { recursive: true }),
  /**
   * Atomic JSON write (tmp file + rename). Manifests are read concurrently by
   * `nax context inspect` and by the effectiveness annotator while a run is
   * still writing them, so a torn read would surface as "no manifest" rather
   * than as an error. `saveJsonFile` owns the tmp+rename and the serialisation.
   */
  writeJson: (path: string, data: unknown): Promise<void> => saveJsonFile(path, data, "context-manifest"),
  fileExists: (path: string): Promise<boolean> => Bun.file(path).exists(),
  readFile: (path: string): Promise<string> => Bun.file(path).text(),
  listFeatureDirs: async (projectDir: string): Promise<string[]> => {
    const baseDir = featuresDir(projectDir);
    try {
      const dirs: string[] = [];
      // `"*/"` + onlyFiles:false is what yields directories. A bare `"*"` scan
      // defaults to files only, so this returned [] for every real repo —
      // `.nax/features/` holds nothing but feature directories.
      for await (const entry of new Bun.Glob("*/").scan({ cwd: baseDir, absolute: false, onlyFiles: false })) {
        dirs.push(entry);
      }
      return dirs.sort();
    } catch {
      return [];
    }
  },
  listManifestFiles: async (storyDir: string): Promise<string[]> => {
    try {
      const files: string[] = [];
      for await (const entry of new Bun.Glob("context-manifest-*.json").scan({ cwd: storyDir, absolute: false })) {
        files.push(entry);
      }
      return files.sort();
    } catch {
      return [];
    }
  },
  /**
   * Story subdirectories under a feature's `stories/` dir (US-003).
   * The trailing-slash glob pattern + onlyFiles:false yields directories
   * only, so stray files alongside story dirs are excluded rather than
   * throwing.
   */
  listStoryDirs: async (storiesDir: string): Promise<string[]> => {
    try {
      const dirs: string[] = [];
      for await (const entry of new Bun.Glob("*/").scan({ cwd: storiesDir, absolute: false, onlyFiles: false })) {
        dirs.push(entry);
      }
      return dirs.sort();
    } catch {
      return [];
    }
  },
};

export function contextStoryDir(projectDir: string, featureId: string, storyId: string): string {
  return join(featureDir(projectDir, featureId), "stories", storyId);
}

export function contextManifestPath(projectDir: string, featureId: string, storyId: string, stage: string): string {
  return join(contextStoryDir(projectDir, featureId, storyId), `context-manifest-${stage}.json`);
}

export function rebuildManifestPath(projectDir: string, featureId: string, storyId: string): string {
  return join(contextStoryDir(projectDir, featureId, storyId), "rebuild-manifest.json");
}

function toStoredPath(projectDir: string, pathValue: string): string {
  const relativePath = isAbsolute(pathValue) ? relative(projectDir, pathValue) : pathValue;
  return relativePath === "" ? "." : relativePath;
}

function toAbsolutePath(projectDir: string, pathValue: string): string {
  return isAbsolute(pathValue) ? pathValue : resolve(projectDir, pathValue);
}

function toStoredManifest(projectDir: string, manifest: ContextManifest): ContextManifest {
  return {
    ...manifest,
    ...(manifest.repoRoot !== undefined && { repoRoot: toStoredPath(projectDir, manifest.repoRoot) }),
    ...(manifest.packageDir !== undefined && { packageDir: toStoredPath(projectDir, manifest.packageDir) }),
  };
}

function hydrateManifestPaths(projectDir: string, manifest: ContextManifest): ContextManifest {
  return {
    ...manifest,
    ...(manifest.repoRoot !== undefined && { repoRoot: toAbsolutePath(projectDir, manifest.repoRoot) }),
    ...(manifest.packageDir !== undefined && { packageDir: toAbsolutePath(projectDir, manifest.packageDir) }),
  };
}

export async function writeContextManifest(
  projectDir: string,
  featureId: string,
  storyId: string,
  stage: string,
  manifest: ContextManifest,
): Promise<void> {
  const filePath = contextManifestPath(projectDir, featureId, storyId, stage);
  await _manifestStoreDeps.mkdirp(dirname(filePath));
  await _manifestStoreDeps.writeJson(filePath, toStoredManifest(projectDir, manifest));
}

export interface RebuildManifestEntry {
  requestId: string;
  stage: string;
  priorAgentId: string;
  newAgentId: string;
  failureCategory: string;
  failureOutcome: string;
  priorChunkIds: string[];
  newChunkIds: string[];
  chunkIdMap: Array<{ priorChunkId: string; newChunkId: string }>;
  createdAt: string;
}

interface RebuildManifestFile {
  storyId: string;
  events: RebuildManifestEntry[];
}

export async function writeRebuildManifest(
  projectDir: string,
  featureId: string,
  storyId: string,
  entry: RebuildManifestEntry,
): Promise<void> {
  const filePath = rebuildManifestPath(projectDir, featureId, storyId);
  await _manifestStoreDeps.mkdirp(dirname(filePath));

  const current: RebuildManifestFile = { storyId, events: [] };
  if (await _manifestStoreDeps.fileExists(filePath)) {
    try {
      const raw = await _manifestStoreDeps.readFile(filePath);
      const parsed = JSON.parse(raw) as RebuildManifestFile;
      if (Array.isArray(parsed.events)) {
        current.events = parsed.events;
      }
    } catch {
      // Fall through — malformed files are replaced with a valid manifest.
    }
  }

  current.events.push(entry);
  await _manifestStoreDeps.writeJson(filePath, current);
}

export interface StoredContextManifest {
  featureId: string;
  stage: string;
  path: string;
  manifest: ContextManifest;
}

function stageFromFileName(fileName: string): string {
  return fileName.replace(/^context-manifest-/, "").replace(/\.json$/, "");
}

/**
 * Read and parse every `context-manifest-*.json` file in one story directory
 * into `StoredContextManifest[]`, tagged with the given `featureId`. Shared by
 * `loadContextManifests` (features → one story) and `loadFeatureManifests`
 * (one feature → stories) so their read/parse/skip-malformed behaviour can't
 * drift between the two outer directory-enumeration strategies.
 * Best-effort: a missing or malformed file is skipped, never thrown.
 */
async function loadStoryManifests(
  projectDir: string,
  featureId: string,
  storyDir: string,
): Promise<StoredContextManifest[]> {
  const manifestFiles = await _manifestStoreDeps.listManifestFiles(storyDir);
  const results: StoredContextManifest[] = [];

  for (const fileName of manifestFiles) {
    const fullPath = join(storyDir, fileName);
    if (!(await _manifestStoreDeps.fileExists(fullPath))) continue;
    try {
      const raw = await _manifestStoreDeps.readFile(fullPath);
      const parsed = JSON.parse(raw) as ContextManifest;
      results.push({
        featureId,
        stage: stageFromFileName(fileName),
        path: fullPath,
        manifest: hydrateManifestPaths(projectDir, parsed),
      });
    } catch {
      // Skip malformed files so callers stay best-effort.
    }
  }

  return results;
}

export async function loadContextManifests(
  projectDir: string,
  storyId: string,
  featureId?: string,
): Promise<StoredContextManifest[]> {
  const featureIds = featureId ? [featureId] : await _manifestStoreDeps.listFeatureDirs(projectDir);
  const results: StoredContextManifest[] = [];

  for (const feature of featureIds) {
    const storyDir = contextStoryDir(projectDir, feature, storyId);
    results.push(...(await loadStoryManifests(projectDir, feature, storyDir)));
  }

  return results.sort((a, b) => a.path.localeCompare(b.path));
}

export interface LoadFeatureManifestsOptions {
  /** Project root containing `.nax/` (canonical key, used by pipeline callers). */
  projectDir?: string;
  /** Alias for `projectDir` accepted from direct API callers. */
  featureDir?: string;
  /** Only meaningful when passed inside the single-object call form. */
  featureId?: string;
}

/**
 * Load every stored context manifest under a feature directory (US-003).
 *
 * Best-effort, fail-open: a missing or empty feature dir returns []. The
 * function reads every story subdirectory's manifest files and returns them
 * flattened, sorted by absolute path. Non-directory entries alongside story
 * directories (stray files, symlinks) are ignored rather than throwing,
 * matching `loadContextManifests`'s malformed-skip behaviour.
 *
 * Distinct from `loadContextManifests`: this takes a feature ID, not a
 * story ID, and returns manifests across every story in the feature.
 *
 * Two call forms are supported:
 *   - `loadFeatureManifests(featureId, { featureDir: projectDir })` — direct API callers.
 *   - `loadFeatureManifests({ featureId, projectDir })` — single-object form used
 *     by pipeline callers so the invocation can be asserted on as one argument.
 */
export async function loadFeatureManifests(
  featureIdOrOptions?: string | LoadFeatureManifestsOptions,
  options: LoadFeatureManifestsOptions = {},
): Promise<StoredContextManifest[]> {
  const opts: LoadFeatureManifestsOptions =
    typeof featureIdOrOptions === "string" ? { featureId: featureIdOrOptions, ...options } : { ...featureIdOrOptions };

  const featureId = opts.featureId;
  const projectDir = opts.projectDir ?? opts.featureDir;
  if (!featureId || !projectDir) return [];

  const storiesDir = join(featureDir(projectDir, featureId), "stories");
  const storyDirs = await _manifestStoreDeps.listStoryDirs(storiesDir);
  const results: StoredContextManifest[] = [];

  for (const storyDirName of storyDirs) {
    const storyDir = join(storiesDir, storyDirName);
    results.push(...(await loadStoryManifests(projectDir, featureId, storyDir)));
  }

  return results.sort((a, b) => a.path.localeCompare(b.path));
}
