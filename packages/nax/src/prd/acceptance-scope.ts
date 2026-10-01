/**
 * Which user stories count when acceptance work sizes itself against a PRD.
 *
 * Four call sites open-coded the same predicate — `acceptance-setup.ts`
 * (fingerprint criteria), `acceptance.ts` (per-package story counts),
 * `test-path.ts` (package grouping) and `acceptance-loop.ts` (total AC count).
 * They had drifted: three excluded decomposed parents and one did not, and all
 * four carried comments describing `US-FIX-*` in the present tense.
 *
 * The two exclusions have very different lifetimes, which is why they are
 * separate predicates here rather than one clause:
 *
 * - **Decomposed parents are live.** A decomposed story's acceptance criteria
 *   are fully covered by its children, so counting the parent as well inflates
 *   every total with duplicates.
 *
 * - **`US-FIX-*` stories are a compatibility guard, not a live case.** Nothing
 *   has produced one since #331 (2026-04-10), which replaced fix-story PRD
 *   mutation with in-place `runFixCycle` rectification; ADR-022 formalised it
 *   and `src/acceptance/fix-generator.ts` was deleted outright. The guard stays
 *   because a `prd.json` is user data with **no `schemaVersion` and no id
 *   validation** — one written by an older nax loads unchanged today, and a
 *   feature resumed across that upgrade would otherwise fold its fix stories
 *   into acceptance fingerprints and AC totals. Cheap insurance against a shape
 *   this repo can no longer create but a user's disk still can.
 *
 * Do not "clean up" `isLegacyFixStory` on the strength of a `grep` for a
 * producer. The producer is genuinely gone; the persisted data is the caller.
 *
 * ONE CALLER DIVERGES ON PURPOSE. `acceptance-loop.ts`'s `totalACs` filters
 * with `isLegacyFixStory` alone, so it still counts decomposed parents. That
 * total is the denominator the diagnosis step reports against; narrowing it to
 * `isInAcceptanceScope` would change a reported number, which is a behaviour
 * change and not part of deduplicating a predicate. Recorded here rather than
 * fixed in passing — decide it on its own evidence.
 */
import type { UserStory } from "./types";

/** Id prefix the pre-ADR-022 acceptance loop gave the fix stories it appended. */
const LEGACY_FIX_STORY_PREFIX = "US-FIX-";

/**
 * A fix story appended to a PRD by a nax older than #331 (2026-04-10).
 *
 * Anchored to the prefix: `US-002-FIX` and `BUG-FIX-001` are ordinary stories
 * and must not be swept up.
 */
export function isLegacyFixStory(story: UserStory): boolean {
  return story.id.startsWith(LEGACY_FIX_STORY_PREFIX);
}

/**
 * Whether a story's acceptance criteria should be counted once, on their own
 * behalf — the predicate acceptance sizing, grouping and fingerprinting share.
 */
export function isInAcceptanceScope(story: UserStory): boolean {
  return !isLegacyFixStory(story) && story.status !== "decomposed";
}
