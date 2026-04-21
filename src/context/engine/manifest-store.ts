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
import type { ContextManifest } from "./types";

export const _manifestStoreDeps = {
  mkdirp: (path: string): Promise<string | undefined> => mkdir(path, { recursive: true }),
  writeFile: (path: string, content: string): Promise<number> => Bun.write(path, content),
  fileExists: (path: string): Promise<boolean> => Bun.file(path).exists(),
  readFile: (path: string): Promise<string> => Bun.file(path).text(),
  listFeatureDirs: async (projectDir: string): Promise<string[]> => {
    const baseDir = join(projectDir, ".nax", "features");
    try {
      const dirs: string[] = [];
      for await (const entry of new Bun.Glob("*").scan({ cwd: baseDir, absolute: false })) {
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
};

export function contextStoryDir(projectDir: string, featureId: string, storyId: string): string {
  return join(projectDir, ".nax", "features", featureId, "stories", storyId);
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
  await _manifestStoreDeps.writeFile(filePath, `${JSON.stringify(toStoredManifest(projectDir, manifest), null, 2)}\n`);
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
  await _manifestStoreDeps.writeFile(filePath, `${JSON.stringify(current, null, 2)}\n`);
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

export async function loadContextManifests(
  projectDir: string,
  storyId: string,
  featureId?: string,
): Promise<StoredContextManifest[]> {
  const featureIds = featureId ? [featureId] : await _manifestStoreDeps.listFeatureDirs(projectDir);
  const results: StoredContextManifest[] = [];

  for (const feature of featureIds) {
    const storyDir = contextStoryDir(projectDir, feature, storyId);
    const manifestFiles = await _manifestStoreDeps.listManifestFiles(storyDir);
    for (const fileName of manifestFiles) {
      const fullPath = join(storyDir, fileName);
      if (!(await _manifestStoreDeps.fileExists(fullPath))) continue;
      try {
        const raw = await _manifestStoreDeps.readFile(fullPath);
        const parsed = JSON.parse(raw) as ContextManifest;
        results.push({
          featureId: feature,
          stage: stageFromFileName(fileName),
          path: fullPath,
          manifest: hydrateManifestPaths(projectDir, parsed),
        });
      } catch {
        // Skip malformed files so inspect stays best-effort.
      }
    }
  }

  return results.sort((a, b) => a.path.localeCompare(b.path));
}
