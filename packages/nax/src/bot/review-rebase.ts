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
 * the code around it (B2).
 *
 * Three lines of context are not a location by themselves: a file can repeat the same block (two
 * branches of one function, a copied fixture) and then the same window fits both copies, so a change
 * moved from one copy to the other compares equal. `makePatchEquivalent` therefore checks the matched
 * window against the file each range actually produced — `git show <commit>:<path>` — and answers
 * "different" unless it occurs exactly once, so an ambiguous window gets the full review it needs (B2).
 *
 * A binary change is different again: the diff spells out no content for it, so two different binaries
 * read identically and `patchIdentity` answers `null`, which the caller reads as "no comparable patch"
 * and reviews in full rather than as equivalent (B1).
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
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const ONE_LINE = "1";

const FILE_HEADER_PREFIX = "diff --git ";
const OLD_PATH_PREFIX = "--- ";
const NEW_PATH_PREFIX = "+++ ";
const QUOTE = '"';
/** What git prints for the side of a change that did not exist. */
const ABSENT_PATH = "/dev/null";
/** Git prefixes the old side's path with the tree it came from; the rest of the header is the path. */
const OLD_TREE_PREFIX = "a/";

/**
 * The hunk header without its start line numbers; its counts and its function scope stay. Two places
 * whose scope and surrounding context lines are identical are indistinguishable in a diff — they hold
 * the same text in the same file — which is why the window is then checked against the file itself.
 */
function hunkIdentity(line: string): string {
  const match = HUNK_HEADER.exec(line);
  if (match === null) return line;
  const [, , oldCount, , newCount, scope] = match;
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

/** One changed file: the path it had before the change (`null` when the patch creates it), and its hunks. */
interface DiffFile {
  readonly oldPath: string | null;
  /** A path git quoted (an unusual name) cannot be re-read, so its hunks stay unverified. */
  readonly unreadable: boolean;
  readonly hunks: readonly (readonly string[])[];
}

interface MutableDiffFile {
  oldPath: string | null;
  unreadable: boolean;
  readonly hunks: string[][];
}

/** The path an old-side header names, or `null` for a side that did not exist. */
function oldPathOf(header: string): { readonly path: string | null; readonly readable: boolean } {
  const raw = header.slice(OLD_PATH_PREFIX.length);
  if (raw === ABSENT_PATH) return { path: null, readable: true };
  // A quoted name is printed escaped; reading it back is not worth a guess, and the caller fails closed.
  if (raw.startsWith(QUOTE)) return { path: null, readable: false };
  return { path: raw.startsWith(OLD_TREE_PREFIX) ? raw.slice(OLD_TREE_PREFIX.length) : raw, readable: true };
}

/** One hunk's body lines, delimited by the counts its header states rather than by their markers. */
function readHunk(
  lines: readonly string[],
  start: number,
  header: RegExpExecArray,
): { readonly body: string[]; readonly next: number } {
  let oldLeft = header[2] === undefined ? 1 : Number(header[2]);
  let newLeft = header[4] === undefined ? 1 : Number(header[4]);
  const body: string[] = [];
  let index = start;
  while ((oldLeft > 0 || newLeft > 0) && index < lines.length) {
    const line = lines[index] ?? "";
    index++;
    // `\ No newline at end of file` is a note about the line before it, not a line of the file.
    if (line.startsWith("\\")) continue;
    body.push(line);
    if (!line.startsWith("+")) oldLeft--;
    if (!line.startsWith("-")) newLeft--;
  }
  return { body, next: index };
}

/** The changed files of one diff, with each hunk's body. */
function parseFiles(diff: string): DiffFile[] {
  const lines = diff.split("\n");
  const files: MutableDiffFile[] = [];
  let current: MutableDiffFile | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.startsWith(FILE_HEADER_PREFIX)) {
      current = { oldPath: null, unreadable: false, hunks: [] };
      files.push(current);
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith(OLD_PATH_PREFIX)) {
      const named = oldPathOf(line);
      current.oldPath = named.path;
      if (!named.readable) current.unreadable = true;
      continue;
    }
    if (line.startsWith(NEW_PATH_PREFIX)) {
      // The new side only has to be readable; a change it creates is located by its path alone.
      if (line.slice(NEW_PATH_PREFIX.length).startsWith(QUOTE)) current.unreadable = true;
      continue;
    }
    const header = HUNK_HEADER.exec(line);
    if (header === null) continue;
    const { body, next } = readHunk(lines, index + 1, header);
    current.hunks.push(body);
    index = next - 1;
  }
  return files;
}

/**
 * The block of text the hunk replaced, as it read *before* the change: the context lines and the removed
 * ones, without the marker a diff prefixes them with. They sit consecutively in that side's file, and
 * the added lines are absent from it.
 *
 * This is what a hunk locates itself by, and the reason it is checked against the file: the diff cannot
 * say how many places in the file hold this block. Two branches of one function that repeat the same
 * lines give two candidate places, so the same added line in either of them produces the same diff text
 * (B2), and only the file itself can refuse to call that one patch.
 */
function replacedWindow(hunk: readonly string[]): string {
  return hunk
    .filter((line) => !line.startsWith("+"))
    .map((line) => line.slice(1))
    .join("\n");
}

/** How many times `window` occurs in `text` as whole lines. */
function occurrencesIn(text: string, window: string): number {
  if (window === "") return 1;
  let seen = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(window, from);
    if (at === -1) return seen;
    const after = at + window.length;
    const wholeLine = (at === 0 || text[at - 1] === "\n") && (after === text.length || text[after] === "\n");
    if (wholeLine) seen++;
    from = at + 1;
  }
}

/** One side's file at one commit, or `undefined` when git cannot produce it. */
async function readBlob(
  run: typeof botGit,
  dir: string,
  commit: string,
  path: string,
  cache: Map<string, string | undefined>,
): Promise<string | undefined> {
  const key = `${commit}:${path}`;
  if (cache.has(key)) return cache.get(key);
  const { exitCode, stdout } = await run(["show", key], dir);
  const text = exitCode === 0 ? stdout : undefined;
  cache.set(key, text);
  return text;
}

/**
 * Whether every hunk of these files locates its change at exactly one place in the file it replaced. A
 * window that fits twice leaves which copy changed undecided, and an unreadable file leaves it
 * unverified; both answer `false`, so the caller reviews in full.
 */
async function uniquelyLocated(
  run: typeof botGit,
  dir: string,
  range: PatchRange,
  files: readonly DiffFile[],
): Promise<boolean> {
  const cache = new Map<string, string | undefined>();
  for (const file of files) {
    // Reject unreadable paths before treating a null old path as an absent side.
    if (file.unreadable) return false;
    // A file whose only change is its mode carries no window; a created one replaces no block at all.
    if (file.hunks.length === 0 || file.oldPath === null) continue;
    const text = await readBlob(run, dir, range.base, file.oldPath, cache);
    if (text === undefined) return false;
    if (file.hunks.some((hunk) => occurrencesIn(text, replacedWindow(hunk)) !== 1)) return false;
  }
  return true;
}

interface PatchRead {
  readonly identity: string | null;
  readonly files: readonly DiffFile[];
}

/**
 * One range's diff and its identity, or `undefined` when git could not produce it. A non-zero exit means
 * an object the range names is not in this checkout (a reviewed head force-pushed away and gc'd, or
 * reviewed on another machine): nothing to compare, and never a fetch.
 */
async function readPatch(run: typeof botGit, dir: string, range: PatchRange): Promise<PatchRead | undefined> {
  const { exitCode, stdout } = await run(
    ["diff", "--no-color", "--no-ext-diff", HUNK_CONTEXT, range.base, range.head],
    dir,
  );
  if (exitCode !== 0) return undefined;
  return { identity: patchIdentity(stdout), files: parseFiles(stdout) };
}

/**
 * Default `_botReviewDeps.patchEquivalent`: diff both ranges, compare their identities, then require the
 * matched window to locate its change once in each range's own file. An unreadable range, an empty one,
 * one holding a binary change and one whose window is ambiguous all answer `false`, so the caller
 * reviews in full — the review that costs a run is preferred to one that skips a changed patch.
 */
export function makePatchEquivalent(run: typeof botGit): PatchEquivalent {
  return async (dir, a, b) => {
    const [first, second] = await Promise.all([readPatch(run, dir, a), readPatch(run, dir, b)]);
    if (first === undefined || second === undefined) return false;
    if (first.identity === null || second.identity === null) return false;
    if (first.identity !== second.identity) return false;
    if (!(await uniquelyLocated(run, dir, a, first.files))) return false;
    return uniquelyLocated(run, dir, b, second.files);
  };
}

/**
 * The reviewed head a rebased review's patch came from, as a field to spread into the inputs that
 * report it. An absent one spreads nothing, so every other scope's inputs stay byte-identical.
 */
export function rebasedField(range: { readonly rebasedFrom?: string }): { rebasedFrom?: string } {
  return range.rebasedFrom === undefined ? {} : { rebasedFrom: range.rebasedFrom };
}
