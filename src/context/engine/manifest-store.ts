/**
 * Context Engine — Manifest Persistence
 *
 * Persists per-stage ContextManifest files under:
 *   <projectDir>/.nax/features/<featureId>/stories/<storyId>/context-manifest-<stage>.json
 *
 * Also provides lightweight discovery helpers for `nax context inspect`.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
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

export async function writeContextManifest(
  projectDir: string,
  featureId: string,
  storyId: string,
  stage: string,
  manifest: ContextManifest,
): Promise<void> {
  const filePath = contextManifestPath(projectDir, featureId, storyId, stage);
  await _manifestStoreDeps.mkdirp(dirname(filePath));
  await _manifestStoreDeps.writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
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
        results.push({
          featureId: feature,
          stage: stageFromFileName(fileName),
          path: fullPath,
          manifest: JSON.parse(raw) as ContextManifest,
        });
      } catch {
        // Skip malformed files so inspect stays best-effort.
      }
    }
  }

  return results.sort((a, b) => a.path.localeCompare(b.path));
}
