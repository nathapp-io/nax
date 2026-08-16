/**
 * Context Engine v2 — FeatureContextProvider (v2 adapter)
 *
 * Wraps the existing v1 FeatureContextProvider to implement IContextProvider.
 * This adapter preserves exact v1 behavior in Phase 0 (parity requirement).
 *
 * The v1 provider reads .nax/features/<featureId>/context.md and returns
 * the raw markdown with a header. The v2 adapter packages that result as a
 * "feature" kind chunk with budget-floor guarantee.
 *
 * story and config are injected at construction time (the orchestrator
 * builds a fresh provider per assemble() call).
 *
 * Phase 0: behavioral parity with v1 — same file, same header, same tokens.
 * Phase 2 (Amendment A): staleness detection (AC-46/AC-47).
 * US-003: dependency-scoped fragment reads with distance decay.
 */

import { createHash } from "node:crypto";
import {
  listFragmentStoryIds as listFragmentStoryIdsImpl,
  readFragment as readFragmentImpl,
} from "@/context/fragments";
import type { ContextToolRuntimeConfig } from "../../../config/selectors";
import type { NaxConfig } from "../../../config/types";
import { getLogger } from "../../../logger";
import type { PRD, UserStory } from "../../../prd";
import { loadPRD as loadPRDImpl } from "../../../prd";
import { errorMessage } from "../../../utils/errors";
import { FeatureContextProvider as FeatureContextProviderV1 } from "../../providers/feature-context";
import { applyStaleness, detectContradictions, parseFeatureContextEntries, selectStaleByAge } from "../staleness";
import type { ContextProviderResult, ContextRequest, IContextProvider, RawChunk } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps
// ─────────────────────────────────────────────────────────────────────────────

export const _featureContextV2Deps = {
  createV1Provider: () => new FeatureContextProviderV1(),
  /**
   * Load the feature PRD from disk. Default returns `null` when the file is
   * missing or unparseable so US-003 AC9 (missing `prd.json`) returns no
   * fragment chunks while still preserving the context.md chunk.
   */
  loadPRD: async (path: string): Promise<PRD | null> => {
    try {
      return await loadPRDImpl(path);
    } catch (err) {
      getLogger().warn("feature-context-v2", "Failed to load feature PRD for fragment reads", {
        path,
        error: errorMessage(err),
      });
      return null;
    }
  },
  /**
   * Read a fragment body. Default delegates to `@/context/fragments`.
   * Unreadable / missing fragments surface as `null`, which the caller
   * treats as "skip" per the AC8 contract.
   */
  readFragment: async (projectDir: string, featureId: string, storyId: string): Promise<string | null> => {
    try {
      return await readFragmentImpl(projectDir, featureId, storyId);
    } catch (err) {
      getLogger().warn("feature-context-v2", "Failed to read fragment", {
        storyId,
        featureId,
        error: errorMessage(err),
      });
      return null;
    }
  },
  /**
   * List story ids that have a fragment under the feature. Default delegates
   * to `@/context/fragments`. An empty result lets the caller skip the
   * dependency walk entirely (fast-path for features with no fragments).
   */
  listFragmentStoryIds: async (projectDir: string, featureId: string): Promise<string[]> => {
    try {
      return await listFragmentStoryIdsImpl(projectDir, featureId);
    } catch (err) {
      getLogger().warn("feature-context-v2", "Failed to list fragment story ids", {
        featureId,
        error: errorMessage(err),
      });
      return [];
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Share of a stage's token budget that dependency fragments may occupy.
 *
 * Fragments are floor-kind, so this is the only thing bounding them — see the
 * rationale at the call site in `collectFragmentChunks`. The effective bound is
 * never below one fragment's write-time ceiling (`fragments.maxTokens`), so a
 * small stage budget degrades to "nearest fragment only" rather than to none.
 */
const FRAGMENT_BUDGET_SHARE = 0.2;

function contentHash8(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function renderEntryContent(section: string, text: string): string {
  return section ? `### ${section}\n\n${text}` : text;
}

/**
 * Resolve the `.nax` directory under repoRoot.
 *
 * NOTE: this is NOT the fragment store's `projectDir`. The store owns the
 * `.nax` segment itself (`fragmentPath` -> `featureDir` -> `featuresDir`), so
 * its `projectDir` argument is the REPO ROOT. Passing this helper's result
 * there resolves to `<repoRoot>/.nax/.nax/...` and silently finds nothing —
 * which is exactly the defect this comment exists to prevent recurring.
 */
function naxDirFor(repoRoot: string): string {
  return `${repoRoot}/.nax`;
}

function featurePrdPath(repoRoot: string, featureId: string): string {
  // Appends its own `/features/...`, so it takes the `.nax` dir, not the root.
  return `${naxDirFor(repoRoot)}/features/${featureId}/prd.json`;
}

/**
 * Build the dependency index from a PRD. Missing fields default to `[]`
 * (matches `loadPRD`'s normalisation in @/prd).
 */
function depsByStoryId(prd: PRD): Map<string, string[]> {
  const deps = new Map<string, string[]>();
  for (const story of prd.userStories) {
    deps.set(story.id, story.dependencies ?? []);
  }
  return deps;
}

/**
 * Walk the dependency graph from `startId` using BFS. Each story is recorded
 * with its shortest distance from the requesting story. Cycles terminate via
 * the visited set; diamonds settle at the shorter path. Returns a Map keyed
 * by story id, with insertion order = BFS discovery order — useful for stable
 * chunk ordering downstream.
 *
 * `startId` itself is never added to the result even when a cycle returns to
 * it: fragments are read back from *dependencies*, never from the requesting
 * story emitting to itself (see AC3 and the cycle-regression test).
 */
function walkDependencyGraph(prd: PRD, startId: string): Map<string, number> {
  const deps = depsByStoryId(prd);
  const reached = new Map<string, number>();
  const queue: Array<{ id: string; distance: number }> = [];

  const startDeps = deps.get(startId) ?? [];
  for (const depId of startDeps) {
    // Guard the start too: a self-loop on startId (A → A) would otherwise
    // emit A's own fragment to itself at distance 1.
    if (depId === startId || reached.has(depId)) continue;
    reached.set(depId, 1);
    queue.push({ id: depId, distance: 1 });
  }

  while (queue.length > 0) {
    const head = queue.shift();
    if (!head) break;
    const { id, distance } = head;
    const nextDeps = deps.get(id) ?? [];
    const nextDistance = distance + 1;
    for (const nextId of nextDeps) {
      // A cycle returning to the requesting story is a no-op for fragment
      // emission. Skipping at traversal time also keeps distances consistent
      // downstream: without the guard, A would be re-entered at a longer
      // distance and could pollute the reached set.
      if (nextId === startId || reached.has(nextId)) continue;
      reached.set(nextId, nextDistance);
      queue.push({ id: nextId, distance: nextDistance });
    }
  }

  return reached;
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

/**
 * v2 adapter for the feature context engine.
 * Constructed per-request by the orchestrator with story and config bound.
 */
export class FeatureContextProviderV2 implements IContextProvider {
  readonly id = "feature-context";
  readonly kind = "feature" as const;

  constructor(
    private readonly story: UserStory,
    private readonly config: ContextToolRuntimeConfig,
  ) {}

  /**
   * Fetch feature context via the v1 provider and adapt the result into a
   * v2 RawChunk.  Returns empty chunks when the feature engine is disabled
   * or no context.md exists.
   *
   * When staleness detection is enabled (Amendment A AC-46/AC-47), the chunk
   * is annotated with staleCandidate: true and a scoreMultiplier when any
   * entries in the content are age-stale or contradiction-stale.
   *
   * US-003: additionally walks the dependency graph of the feature's
   * `prd.json` and emits one fragment chunk per reached story, scored by
   * `fragments.decay ** dependencyDistance` (base score 1.0).
   */
  async fetch(request: ContextRequest): Promise<ContextProviderResult> {
    const logger = getLogger();
    const chunks: RawChunk[] = [];

    // ── 1. context.md path (v1) ─────────────────────────────────────────────
    try {
      const v1 = _featureContextV2Deps.createV1Provider();
      const result = await v1.getContext(this.story, request.repoRoot, this.config, request.featureId);
      if (result) {
        chunks.push(...this.buildContextMdChunks(result.content, result.estimatedTokens, request.storyId));
      }
    } catch (err) {
      logger.warn("feature-context-v2", "Failed to fetch feature context — continuing without it", {
        storyId: request.storyId,
        error: errorMessage(err),
      });
    }

    // ── 2. fragment path (US-003) ───────────────────────────────────────────
    try {
      const fragmentResults = await this.collectFragmentChunks(request);
      chunks.push(...fragmentResults);
    } catch (err) {
      logger.warn("feature-context-v2", "Failed to fetch fragments — continuing without them", {
        storyId: request.storyId,
        error: errorMessage(err),
      });
    }

    return { chunks, pullTools: [] };
  }

  /** Translate the v1 context.md result into v2 RawChunks (with staleness applied). */
  private buildContextMdChunks(content: string, estimatedTokens: number, storyId: string): RawChunk[] {
    const logger = getLogger();
    const hash = contentHash8(content);
    const baseChunk: RawChunk = {
      id: `feature-context:${hash}`,
      kind: "feature",
      scope: "feature",
      role: ["implementer", "reviewer", "tdd"],
      content,
      tokens: estimatedTokens,
      rawScore: 1.0,
    };

    // Amendment A AC-46/AC-47: staleness detection (read-time, no LLM).
    const stalenessConfig = this.config.context?.v2?.staleness;
    if (stalenessConfig?.enabled === false) {
      return [baseChunk];
    }

    const maxStoryAge = stalenessConfig?.maxStoryAge ?? 10;
    const scoreMultiplier = stalenessConfig?.scoreMultiplier ?? 0.4;
    const entries = parseFeatureContextEntries(content);

    if (entries.length > 1) {
      const contradicted = detectContradictions(entries);
      const ageStale = selectStaleByAge(entries, maxStoryAge);
      const result = entries.map((entry) => {
        const entryContent = renderEntryContent(entry.section, entry.text);
        const entryChunk: RawChunk = {
          id: `feature-context:${hash}:entry-${entry.index}`,
          kind: "feature",
          scope: "feature",
          role: ["implementer", "reviewer", "tdd"],
          content: entryContent,
          tokens: estimateTokens(entryContent),
          rawScore: 1.0,
        };
        const isStale = contradicted.has(entry.index) || ageStale.has(entry.index);
        return applyStaleness(entryChunk, { isStale, scoreMultiplier });
      });

      if (result.some((chunk) => chunk.staleCandidate)) {
        logger.debug("feature-context-v2", "Stale entries detected in feature context", {
          storyId,
          contradicted: contradicted.size,
          ageStale: ageStale.size,
        });
      }
      return result;
    }

    if (entries.length === 1) {
      const contradicted = detectContradictions(entries);
      const ageStale = selectStaleByAge(entries, maxStoryAge);
      const isStale = contradicted.has(entries[0].index) || ageStale.has(entries[0].index);
      return [applyStaleness(baseChunk, { isStale, scoreMultiplier })];
    }

    return [baseChunk];
  }

  /**
   * Walk the feature's PRD dependency graph, read each reached story's
   * fragment, and emit one RawChunk per story with rawScore decayed by
   * `fragments.decay ** distance`. Returns `[]` when fragments are
   * disabled, the feature is unknown, the PRD is absent, or no fragments
   * exist on disk.
   */
  private async collectFragmentChunks(request: ContextRequest): Promise<RawChunk[]> {
    const logger = getLogger();
    const fragmentsConfig = this.config.context?.v2?.fragments;
    if (fragmentsConfig?.enabled !== true) return [];

    const featureId = request.featureId;
    if (!featureId) return [];

    // The store owns the `.nax` segment — its `projectDir` is the repo root,
    // matching what `completionStage` passes to `writeFragment` on capture.
    const projectDir = request.repoRoot;

    // Fast path — empty fragment set means nothing to traverse (AC1 / AC10).
    const availableFragments = await _featureContextV2Deps.listFragmentStoryIds(projectDir, featureId);
    if (availableFragments.length === 0) return [];

    const prdPath = featurePrdPath(request.repoRoot, featureId);
    const prd = await _featureContextV2Deps.loadPRD(prdPath);
    if (!prd) return [];

    const reached = walkDependencyGraph(prd, request.storyId);
    if (reached.size === 0) return [];

    // Preserve BFS discovery order via Map iteration (stable across runs).
    const fragmentSet = new Set(availableFragments);
    const decay = fragmentsConfig.decay;
    const out: RawChunk[] = [];

    // Fragments are emitted as `kind: "feature"`, which is a FLOOR kind — they
    // bypass the stage budget entirely and are force-included even when they
    // score below the minimum. `decay ** distance` therefore only ORDERS them;
    // it cannot exclude one. Without a bound here, a story late in a large
    // feature pulls every transitive dependency's fragment into a 4k-token
    // stage unmetered, starving the non-floor providers. BFS order makes this
    // a nearest-first cut, which is the behaviour decay was meant to express.
    const fragmentBudget = Math.max(
      fragmentsConfig.maxTokens,
      Math.floor(request.budgetTokens * FRAGMENT_BUDGET_SHARE),
    );
    let usedTokens = 0;
    let droppedForBudget = 0;

    for (const [storyId, distance] of reached) {
      // AC8 / AC9: a reached story without a fragment contributes nothing.
      // The dep walk already terminated for cycles; listFragmentStoryIds
      // is the source of truth for which story ids have an on-disk file.
      if (!fragmentSet.has(storyId)) continue;

      const body = await _featureContextV2Deps.readFragment(projectDir, featureId, storyId);
      if (body === null) continue;

      const bodyTokens = estimateTokens(body);
      if (usedTokens + bodyTokens > fragmentBudget) {
        droppedForBudget++;
        continue;
      }
      usedTokens += bodyTokens;

      out.push({
        id: `feature-fragment:${storyId}`,
        kind: "feature",
        scope: "feature",
        role: ["implementer", "reviewer", "tdd"],
        content: body,
        tokens: bodyTokens,
        rawScore: decay ** distance,
      });
    }

    if (droppedForBudget > 0) {
      // Warn, not debug: a silently truncated fragment set is the same class
      // of invisible failure as the empty one this bound replaced.
      // Note: the loop keeps scanning after a skip, so a small distant
      // fragment may still fit once a larger nearer one has been dropped.
      logger.warn("feature-context-v2", "Fragment budget reached — some dependency fragments were dropped", {
        storyId: request.storyId,
        featureId,
        kept: out.length,
        dropped: droppedForBudget,
        fragmentBudget,
        usedTokens,
      });
    }

    if (out.length > 0) {
      logger.debug("feature-context-v2", "Loaded fragment chunks", {
        storyId: request.storyId,
        featureId,
        fragmentCount: out.length,
      });
    }

    return out;
  }
}
