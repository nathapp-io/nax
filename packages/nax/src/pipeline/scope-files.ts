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
 * The returned set is repo-rooted (nax#2071). A story stamped by plan-time
 * canonicalization (`workdirSource` defined) declares repo-rooted paths as
 * written, so its declared sources are used verbatim (US-001). A legacy story
 * -- one written before that stamp existed -- still declares package-relative
 * paths and is mapped through `toRepoFrame` at this seam; it is NOT
 * self-healed. `collectDiffFileList` output is repo-rooted already.
 *
 * Composition reuses `getContextFiles(story)`, `getExpectedFiles(story)`,
 * `resolveEffectiveRef(workdir, story.storyGitRef, story.id)`, and
 * `collectDiffFileList(workdir, ref)`. The union is deduped and sorted
 * ascending lexicographically. If the ref is unresolvable or diff
 * collection returns undefined or throws, return declared sources and do
 * not throw.
 */

import { errorMessage } from "@nathapp/nax-agent/internal";
import { getLogger } from "../logger";
import { getContextFiles, getExpectedFiles } from "../prd/types";
import { collectDiffFileList, resolveEffectiveRef } from "../review/diff-utils";
import { storyWorkdir, toRepoFrame } from "../utils/path-frame";
import type { PipelineContext } from "./types";

export const _scopeFilesDeps = {
  resolveEffectiveRef: (workdir: string, storyGitRef: string | undefined, storyId: string) =>
    resolveEffectiveRef(workdir, storyGitRef, storyId),
  collectDiffFileList: (workdir: string, ref: string) => collectDiffFileList(workdir, ref),
};

export async function resolveScopeFiles(ctx: PipelineContext): Promise<string[]> {
  // nax#2071: a legacy story's declared paths are package-relative while
  // collectDiffFileList is repo-rooted, so frame the declared side to make the
  // union speak one convention. US-001: a stamped story's declared paths are
  // repo-rooted already, and toRepoFrame at "." normalises their spelling only.
  const declaredFrame = ctx.story.workdirSource === undefined ? storyWorkdir(ctx.story) : ".";
  const declared = [...getContextFiles(ctx.story), ...getExpectedFiles(ctx.story)].map((file) =>
    toRepoFrame(file, declaredFrame),
  );

  let ref: string | undefined;
  try {
    ref = await _scopeFilesDeps.resolveEffectiveRef(ctx.workdir, ctx.story.storyGitRef, ctx.story.id);
  } catch (err) {
    getLogger().warn("scope-files", "resolveEffectiveRef failed — degrading to declared sources", {
      storyId: ctx.story.id,
      error: errorMessage(err),
    });
    return [...new Set(declared)].sort();
  }
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
