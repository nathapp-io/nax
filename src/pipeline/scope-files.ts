/**
 * Scope-file resolver for context stage producer wiring.
 *
 * Resolves the complete evidence set of files a story touches, for SCOPING
 * decisions only. Never used to fetch content — see ContextRequest.touchedFiles
 * for the curated, capped list the content-fetching providers consume.
 *
 * Lives under `src/pipeline/` because `src/context/` value-imports from
 * `src/review/` (filterContextByRole), so any module under `src/context/`
 * that value-imported from `src/review/` to reach `collectDiffFileList`
 * would close a circular import.
 *
 * Composition reuses `getContextFiles(story)`, `getExpectedFiles(story)`,
 * `resolveEffectiveRef(workdir, story.storyGitRef, story.id)`, and
 * `collectDiffFileList(workdir, ref)`. The union is deduped and sorted
 * ascending lexicographically. If the ref is unresolvable or diff
 * collection returns undefined or throws, return declared sources and do
 * not throw.
 */

import { getContextFiles, getExpectedFiles } from "../prd/types";
import { collectDiffFileList, resolveEffectiveRef } from "../review/diff-utils";
import type { PipelineContext } from "./types";

export const _scopeFilesDeps = {
  resolveEffectiveRef: (workdir: string, storyGitRef: string | undefined, storyId: string) =>
    resolveEffectiveRef(workdir, storyGitRef, storyId),
  collectDiffFileList: (workdir: string, ref: string) => collectDiffFileList(workdir, ref),
};

/**
 * Stub implementation. The implementer replaces the body with the
 * union-and-dedupe-and-sort composition described in the file header.
 *
 * Returns the deduped, sorted union of declared sources (contextFiles +
 * expectedFiles) — sufficient to keep tests compileable; tests asserting
 * that collectDiffFileList() output is merged in will fail at assertion.
 */
export async function resolveScopeFiles(ctx: PipelineContext): Promise<string[]> {
  const declared = [...getContextFiles(ctx.story), ...getExpectedFiles(ctx.story)];
  return [...new Set(declared)].sort();
}

export { getContextFiles, getExpectedFiles };
