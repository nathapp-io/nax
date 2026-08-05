/**
 * `### Modifies` preservation — deterministic modification-authority repair.
 *
 * Attaches what `./modifies-extract` read out of the spec onto the stories that
 * declared it. The implementer, rectifier, and reviewers only ever receive a
 * `UserStory` — never the spec, never the PRD envelope — so an authorisation
 * that does not reach the story object does not exist as far as they are
 * concerned. That is the whole of #1450.
 *
 * Unlike `./out-of-scope`, there is no feature-level tier and no propagation:
 * authority to rewrite an existing test belongs to exactly the story that owns
 * the breaking change. Broadcasting it would tell every other implementer it may
 * rewrite a test that is not its business.
 *
 * Pure and deterministic — no I/O, no LLM.
 */

import { type SpecModifiedFile, extractSpecModifiedFiles } from "./modifies-extract";
import type { ModifiedFileEntry, PRD, UserStory } from "./types";

/** Outcome of {@link applyModifiedFiles}: the updated PRD plus what it could not place. */
export interface ApplyModifiedFilesResult {
  /** The input reference itself when nothing was attached, so callers can detect a no-op. */
  readonly prd: PRD;
  /**
   * Entries that named no story, or named one absent from the PRD. Dropped
   * rather than broadcast — the caller is expected to warn, since a silently
   * discarded authorisation reproduces the deadlock this feature prevents.
   */
  readonly orphans: SpecModifiedFile[];
  /** Entries rejected by {@link isSafeRelativePath}. Reported separately: an unowned entry is an authoring slip, an escaping path is not. */
  readonly invalidPaths: SpecModifiedFile[];
}

/**
 * The same path policy `./schema.ts` enforces on `contextFiles` / `expectedFiles`:
 * repo-relative, no traversal.
 *
 * It has to be re-applied here because of call ordering. `validatePlanOutput`
 * runs in the plan op's `parse`, but this carry runs in its `verify` — strictly
 * afterwards — so an entry injected from the spec would reach `prd.json`, and the
 * implementer's authorisation block, without ever passing the validator that
 * rejects absolute and `..` paths everywhere else.
 *
 * Rejection is a drop-and-warn rather than a throw: this is a fidelity carry, not
 * a gate, and failing an entire plan over one malformed spec bullet trades a
 * missing authorisation for no PRD at all. `schema.ts` still throws on the same
 * shape when a hand-edited `prd.json` is loaded.
 */
export function isSafeRelativePath(path: string): boolean {
  return !path.startsWith("/") && !path.includes("..");
}

/**
 * Merge spec entries into whatever the story already carried, deduplicating on
 * path.
 *
 * Spec entries are ordered first, so on a collision the **spec's** reason wins.
 * That is the module's whole premise: the spec is the authority and its wording
 * is carried verbatim. Letting a `prd.json` value survive would mean an edited
 * spec silently failed to update the authorisation it owns.
 *
 * Within one side, first-seen wins — a spec that lists the same path twice keeps
 * the first reason rather than the last.
 */
function mergeEntries(existing: readonly ModifiedFileEntry[], incoming: readonly ModifiedFileEntry[]) {
  const byPath = new Map<string, ModifiedFileEntry>();
  for (const entry of [...incoming, ...existing]) {
    if (!byPath.has(entry.path)) byPath.set(entry.path, entry);
  }
  return [...byPath.values()];
}

/**
 * Attach every spec-declared `### Modifies` entry to its owning story.
 *
 * Returns the input PRD unchanged (same reference) when the spec declares
 * nothing, or when every entry is an orphan — attaching nothing must not look
 * like a rewrite to callers that compare references.
 */
export function applyModifiedFiles(prd: PRD, specContent: string): ApplyModifiedFilesResult {
  const declared = extractSpecModifiedFiles(specContent);
  if (declared.length === 0) return { prd, orphans: [], invalidPaths: [] };

  const storyIds = new Set(prd.userStories.map((story) => story.id));
  const byStory = new Map<string, ModifiedFileEntry[]>();
  const orphans: SpecModifiedFile[] = [];
  const invalidPaths: SpecModifiedFile[] = [];

  for (const entry of declared) {
    // Checked before ownership: an escaping path is rejected whether or not a
    // story claims it, so a valid group lead-in cannot launder one through.
    if (!isSafeRelativePath(entry.path)) {
      invalidPaths.push(entry);
      continue;
    }
    if (!entry.storyId || !storyIds.has(entry.storyId)) {
      orphans.push(entry);
      continue;
    }
    const entries = byStory.get(entry.storyId) ?? [];
    entries.push({ path: entry.path, reason: entry.reason });
    byStory.set(entry.storyId, entries);
  }
  if (byStory.size === 0) return { prd, orphans, invalidPaths };

  const userStories: UserStory[] = prd.userStories.map((story) => {
    const incoming = byStory.get(story.id);
    return incoming ? { ...story, modifiedFiles: mergeEntries(story.modifiedFiles ?? [], incoming) } : story;
  });
  return { prd: { ...prd, userStories }, orphans, invalidPaths };
}
