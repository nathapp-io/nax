/**
 * Patch identity, and whether two ranges carry the same patch (US-003).
 *
 * A PR rebased onto a later base keeps its change while every commit sha changes, so an ancestry check
 * answers "this head does not descend from the reviewed head" for a patch the earlier review already
 * read. `git diff -U0` text is that patch; `patchIdentity` reduces it to what survives a rebase — file
 * headers, hunk bodies, added and removed lines — and drops the two facts a rebase always rewrites: the
 * `index ` blob ids and each hunk header's line numbers.
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

/** A diff line whose content a rebase rewrites even when the patch itself is unchanged. */
const INDEX_LINE_PREFIX = "index ";
const HUNK_HEADER_PREFIX = "@@ ";
const REDUCED_HUNK_HEADER = "@@";

/** The diff text with the facts a rebase rewrites removed. */
function identityLines(diff: string): string[] {
  return diff
    .split("\n")
    .filter((line) => !line.startsWith(INDEX_LINE_PREFIX))
    .map((line) => (line.startsWith(HUNK_HEADER_PREFIX) ? REDUCED_HUNK_HEADER : line));
}

/**
 * sha256 of a `git diff -U0` text with the rebase-unstable facts removed; `null` for an empty diff. A
 * caller must treat `null` as "no patch to compare", never as an identity equal to another `null`.
 */
export function patchIdentity(diff: string): string | null {
  if (diff.trim() === "") return null;
  return createHash("sha256").update(identityLines(diff).join("\n")).digest("hex");
}

/**
 * The identity of one range's diff, or `undefined` when git could not produce it. A non-zero exit means
 * an object the range names is not in this checkout (a reviewed head force-pushed away and gc'd, or
 * reviewed on another machine): nothing to compare, and never a fetch.
 */
async function diffIdentity(run: typeof botGit, dir: string, range: PatchRange): Promise<string | null | undefined> {
  const { exitCode, stdout } = await run(["diff", "--no-color", "--no-ext-diff", "-U0", range.base, range.head], dir);
  if (exitCode !== 0) return undefined;
  return patchIdentity(stdout);
}

/** Default `_botReviewDeps.patchEquivalent`: diff both ranges through `run` and compare their identities. */
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
