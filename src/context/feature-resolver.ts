/**
 * Feature ID resolver for the Context Engine v1.
 *
 * Walks .nax/features/<id>/prd.json to find which feature a story belongs to.
 * Caches results per workdir so the glob scan only runs once per run.
 */
import { Glob } from "bun";
import { getLogger } from "../logger";
import type { UserStory } from "../prd";
import { errorMessage } from "../utils/errors";

// Per-workdir cache: Map<workdir, Map<storyId, featureId | null>>
const _cache = new Map<string, Map<string, string | null>>();

/** Injectable deps for testing */
export const _resolverDeps = {
  glob: (pattern: string, opts: { cwd: string }) => new Glob(pattern).scan({ ...opts, dot: true }),
  readFile: (path: string) => Bun.file(path).text(),
};

/**
 * Clear the cache. For testing only.
 */
export function clearFeatureResolverCache(): void {
  _cache.clear();
}

/**
 * Resolve which feature a story belongs to by scanning .nax/features/<id>/prd.json.
 * Returns the feature directory name (featureId) or null if the story is unattached.
 * Results are cached per workdir.
 */
export async function resolveFeatureId(story: UserStory, workdir: string): Promise<string | null> {
  const logger = getLogger();

  // Check cache
  let wdCache = _cache.get(workdir);
  if (wdCache?.has(story.id)) {
    return wdCache.get(story.id) ?? null;
  }

  if (!wdCache) {
    wdCache = new Map();
    _cache.set(workdir, wdCache);
  }

  const matches: string[] = [];

  try {
    // Scan for all prd.json files under .nax/features/*/
    const scanner = _resolverDeps.glob(".nax/features/*/prd.json", { cwd: workdir });
    for await (const relPath of scanner) {
      let prdData: { userStories?: Array<{ id: string }> };
      try {
        const raw = await _resolverDeps.readFile(`${workdir}/${relPath}`);
        prdData = JSON.parse(raw) as typeof prdData;
      } catch {
        logger.warn("feature-resolver", "Malformed prd.json — skipping", {
          path: relPath,
          storyId: story.id,
        });
        continue;
      }

      const storyIds = (prdData.userStories ?? []).map((s) => s.id);
      if (storyIds.includes(story.id)) {
        // Extract feature ID: ".nax/features/<featureId>/prd.json"
        const parts = relPath.split("/");
        const featureId = parts[2]; // index 2 in ".nax/features/<id>/prd.json"
        if (featureId) matches.push(featureId);
      }
    }
  } catch (err) {
    logger.warn("feature-resolver", "Failed to scan feature directories", {
      storyId: story.id,
      error: errorMessage(err),
    });
    wdCache.set(story.id, null);
    return null;
  }

  if (matches.length === 0) {
    wdCache.set(story.id, null);
    return null;
  }

  if (matches.length > 1) {
    logger.warn("feature-resolver", "Story appears in multiple features — using first match", {
      storyId: story.id,
      matches,
    });
  }

  const featureId = matches[0];
  wdCache.set(story.id, featureId);
  return featureId;
}
