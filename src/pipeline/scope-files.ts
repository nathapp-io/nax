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

import { getLogger } from "../logger";
import { getContextFiles, getExpectedFiles } from "../prd/types";
import { collectDiffFileList, resolveEffectiveRef } from "../review/diff-utils";
import { errorMessage } from "../utils/errors";
import type { PipelineContext } from "./types";

export const _scopeFilesDeps = {
  resolveEffectiveRef: (workdir: string, storyGitRef: string | undefined, storyId: string) =>
    resolveEffectiveRef(workdir, storyGitRef, storyId),
  collectDiffFileList: (workdir: string, ref: string) => collectDiffFileList(workdir, ref),
};

export async function resolveScopeFiles(ctx: PipelineContext): Promise<string[]> {
  const declared = [...getContextFiles(ctx.story), ...getExpectedFiles(ctx.story)];

  const ref = await _scopeFilesDeps.resolveEffectiveRef(ctx.workdir, ctx.story.storyGitRef, ctx.story.id);
  if (!ref) return [...new Set(declared)].sort();

  let diffFiles: string[] | undefined;
  try {
    diffFiles = await _scopeFilesDeps.collectDiffFileList(ctx.workdir, ref);
  } catch (err) {
    getLogger().warn("scope-files", "collectDiffFileList failed — degrading to declared sources", {
      storyId: ctx.story.id,
      error: errorMessage(err),
    });
    return [...new Set(declared)].sort();
  }

  if (!diffFiles) return [...new Set(declared)].sort();

  return [...new Set([...declared, ...diffFiles])].sort();
}
