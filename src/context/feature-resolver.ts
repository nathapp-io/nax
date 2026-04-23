/**
 * Feature ID resolver for the Context Engine v1.
 *
 * Walks .nax/features/<id>/prd.json to find which feature a story belongs to.
 * Builds a full storyId→featureId index once per workdir (O(1) per lookup after
 * the first call) instead of re-scanning all PRD files on every cache miss.
 */
import { Glob } from "bun";
import { getLogger } from "../logger";
import type { UserStory } from "../prd";
import { errorMessage } from "../utils/errors";

/**
 * Per-workdir index: Map<workdir, Map<storyId, featureId | null>>
 *
 * The index is built once per workdir by scanning all prd.json files, so every
 * known storyId is resolved in a single pass. Subsequent calls are O(1) map
 * lookups with no filesystem I/O.
 *
 * Lifecycle: cleared by disposeFeatureResolver() at run completion to prevent
 * unbounded growth across multiple runs in the same process.
 */
const _index = new Map<string, Map<string, string | null>>();

/** Tracks in-progress index builds to avoid concurrent duplicate scans */
const _indexBuilding = new Map<string, Promise<Map<string, string | null>>>();

/** Injectable deps for testing */
export const _resolverDeps = {
  glob: (pattern: string, opts: { cwd: string }) => new Glob(pattern).scan({ ...opts, dot: true }),
  readFile: (path: string) => Bun.file(path).text(),
};

/**
 * Clear the resolver state. Call at run completion to release memory.
 * Pass a workdir to clear only that workdir; omit to clear all.
 */
export function disposeFeatureResolver(workdir?: string): void {
  if (workdir !== undefined) {
    _index.delete(workdir);
    _indexBuilding.delete(workdir);
  } else {
    _index.clear();
    _indexBuilding.clear();
  }
}

/**
 * @deprecated Use disposeFeatureResolver() — clears both index and build state.
 * Kept for test compatibility.
 */
export function clearFeatureResolverCache(): void {
  disposeFeatureResolver();
}

/**
 * Build a complete storyId→featureId index for all features in workdir.
 * Scans every .nax/features/<id>/prd.json once and maps all their story IDs.
 */
async function buildIndex(workdir: string): Promise<Map<string, string | null>> {
  const logger = getLogger();
  const index = new Map<string, string | null>();

  try {
    const scanner = _resolverDeps.glob(".nax/features/*/prd.json", { cwd: workdir });
    for await (const relPath of scanner) {
      let prdData: { userStories?: Array<{ id: string }> };
      try {
        const raw = await _resolverDeps.readFile(`${workdir}/${relPath}`);
        prdData = JSON.parse(raw) as typeof prdData;
      } catch {
        logger.warn("feature-resolver", "Malformed prd.json — skipping", { path: relPath });
        continue;
      }

      const parts = relPath.split("/");
      const featureId = parts[2]; // ".nax/features/<featureId>/prd.json"
      if (!featureId) continue;

      for (const story of prdData.userStories ?? []) {
        if (!story.id) continue;
        if (index.has(story.id)) {
          logger.warn("feature-resolver", "Story appears in multiple features — keeping first match", {
            storyId: story.id,
            existing: index.get(story.id),
            duplicate: featureId,
          });
        } else {
          index.set(story.id, featureId);
        }
      }
    }
  } catch (err) {
    logger.warn("feature-resolver", "Failed to scan feature directories", {
      error: errorMessage(err),
    });
  }

  return index;
}

/**
 * Check whether a specific feature's prd.json contains the given story.
 * Returns the featureId when the story is present, otherwise null.
 *
 * This bypasses the global index and is used when the caller already knows
 * which feature the story belongs to (e.g. `nax run -f <feature>`) — it
 * avoids story-ID collisions across features that restart numbering at US-001.
 */
async function tryResolveFromActiveFeature(
  story: UserStory,
  workdir: string,
  activeFeature: string,
): Promise<string | null> {
  const logger = getLogger();
  const prdPath = `${workdir}/.nax/features/${activeFeature}/prd.json`;

  try {
    const raw = await _resolverDeps.readFile(prdPath);
    const prd = JSON.parse(raw) as { userStories?: Array<{ id: string }> };
    for (const entry of prd.userStories ?? []) {
      if (entry.id === story.id) return activeFeature;
    }
    return null;
  } catch (err) {
    logger.debug("feature-resolver", "Active-feature PRD unreadable — falling back to index scan", {
      storyId: story.id,
      activeFeature,
      error: errorMessage(err),
    });
    return null;
  }
}

/**
 * Resolve which feature a story belongs to by scanning .nax/features/<id>/prd.json.
 * Returns the feature directory name (featureId) or null if the story is unattached.
 *
 * When `activeFeature` is provided, the resolver first checks that feature's prd.json
 * directly. This prevents story-ID collisions (US-001 in multiple features) from
 * pointing at the wrong feature and is the common path for `nax run -f <feature>`.
 *
 * When the hint does not resolve (missing PRD, story not listed), falls back to the
 * global index: the first call per workdir builds a full index of all features in
 * one pass; subsequent calls for any story in the same workdir are O(1) map lookups.
 */
export async function resolveFeatureId(
  story: UserStory,
  workdir: string,
  activeFeature?: string,
): Promise<string | null> {
  if (activeFeature) {
    const hinted = await tryResolveFromActiveFeature(story, workdir, activeFeature);
    if (hinted) return hinted;
  }

  // Return from completed index if available
  const existing = _index.get(workdir);
  if (existing) {
    return existing.get(story.id) ?? null;
  }

  // Avoid concurrent duplicate builds for the same workdir
  let building = _indexBuilding.get(workdir);
  if (!building) {
    building = buildIndex(workdir);
    _indexBuilding.set(workdir, building);
  }

  const index = await building;
  _index.set(workdir, index);
  _indexBuilding.delete(workdir);

  return index.get(story.id) ?? null;
}
