/**
 * Patch identity, and whether two ranges carry the same patch (US-003).
 *
 * A PR rebased onto a later base keeps its change while every commit sha changes, so an ancestry check
 * answers "this head does not descend from the reviewed head" for a patch the earlier review already
 * read. `git diff` text is that patch; `patchIdentity` keeps what survives a rebase — file headers,
 * hunk bodies, each hunk's line counts and function scope, and the lines around the change — and drops
 * only the two facts a rebase always rewrites: the `index ` blob ids and the hunk headers' start line
 * numbers.
 *
 * What it keeps is what says *where* a change sits. Reducing a header to a bare `@@` threw the function
 * scope away, so the same added line in `first()` and in `second()` compared equal and its review was
 * skipped; the diff is therefore taken with git's own three lines of context, which pin the change to
 * the code around it (B2). A binary change is different again: the diff spells out no content for it,
 * so two different binaries read identically and `patchIdentity` answers `null`, which the caller reads
 * as "no comparable patch" and reviews in full rather than as equivalent (B1).
 *
 * Comparing patches is deliberately narrower than a range-diff: a rebase that also edited the patch gets
 * a different identity, and therefore the full review it needs.
 */
import { createHash } from "node:crypto";
import type { botGit } from "./git";

export interface PatchRange {
  readonly base: string;
  readonly head: string;
}

export type PatchEquivalent = (dir: string, a: PatchRange, b: PatchRange) => Promise<boolean>;

/** The one diff line a rebase always rewrites even when the patch itself is unchanged. */
const INDEX_LINE_PREFIX = "index ";

/**
 * What git prints in place of the content of a change it will not spell out. Two different binary
 * contents produce exactly these words, so no identity can be computed from them.
 */
const BINARY_DIFF_MARKERS: readonly string[] = ["Binary files ", "GIT binary patch"];

/**
 * The context each hunk carries. A rebase shifts start line numbers, so the numbers cannot be part of
 * the identity; the lines around the change are what distinguish one location from another, and three
 * is git's own default.
 */
const HUNK_CONTEXT = "-U3";

/** `@@ -<start>[,<count>] +<start>[,<count>] @@<function scope>`: an omitted count means one line. */
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(.*)$/;
const ONE_LINE = "1";

/**
 * The hunk header without its start line numbers; its counts and its function scope stay. Two places
 * whose scope and surrounding context lines are identical are indistinguishable in a diff — they hold
 * the same text in the same file — which is the ambiguity this comparison tolerates.
 */
function hunkIdentity(line: string): string {
  const match = HUNK_HEADER.exec(line);
  if (match === null) return line;
  const [, oldCount, newCount, scope] = match;
  return `@@ -${oldCount ?? ONE_LINE} +${newCount ?? ONE_LINE} @@${scope}`;
}

/** The identity lines of a diff, or `null` when it carries a change whose content it does not spell out. */
function identityLines(diff: string): string[] | null {
  const lines = diff.split("\n");
  if (lines.some((line) => BINARY_DIFF_MARKERS.some((marker) => line.startsWith(marker)))) return null;
  return lines.filter((line) => !line.startsWith(INDEX_LINE_PREFIX)).map(hunkIdentity);
}

/**
 * sha256 of a `git diff` text with the rebase-unstable facts removed. `null` when there is no comparable
 * patch: an empty diff, or one whose change git states without its content (a binary file). A caller
 * must treat `null` as "no patch to compare", never as an identity equal to another `null`.
 */
export function patchIdentity(diff: string): string | null {
  if (diff.trim() === "") return null;
  const lines = identityLines(diff);
  if (lines === null) return null;
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/**
 * The identity of one range's diff, or `undefined` when git could not produce it. A non-zero exit means
 * an object the range names is not in this checkout (a reviewed head force-pushed away and gc'd, or
 * reviewed on another machine): nothing to compare, and never a fetch.
 */
async function diffIdentity(run: typeof botGit, dir: string, range: PatchRange): Promise<string | null | undefined> {
  const { exitCode, stdout } = await run(
    ["diff", "--no-color", "--no-ext-diff", HUNK_CONTEXT, range.base, range.head],
    dir,
  );
  if (exitCode !== 0) return undefined;
  return patchIdentity(stdout);
}

/**
 * Default `_botReviewDeps.patchEquivalent`: diff both ranges through `run` and compare their identities.
 * An unreadable range, an empty one and one holding a binary change all answer `false`, so the caller
 * reviews in full — the review that costs a run is preferred to one that skips a changed patch.
 */
export function makePatchEquivalent(run: typeof botGit): PatchEquivalent {
  return async (dir, a, b) => {
    const [first, second] = await Promise.all([diffIdentity(run, dir, a), diffIdentity(run, dir, b)]);
    if (first === undefined || second === undefined || first === null || second === null) return false;
    return first === second;
  };
}

/**
 * The reviewed head a rebased review's patch came from, as a field to spread into the inputs that
 * report it. An absent one spreads nothing, so every other scope's inputs stay byte-identical.
 */
export function rebasedField(range: { readonly rebasedFrom?: string }): { rebasedFrom?: string } {
  return range.rebasedFrom === undefined ? {} : { rebasedFrom: range.rebasedFrom };
}
