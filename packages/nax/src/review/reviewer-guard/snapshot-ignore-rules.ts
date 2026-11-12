/**
 * nax#2552: put the snapshot-time ignore rules back before the restore-time working-tree comparison.
 *
 * The comparison runs `git add -A` into a throwaway index, which honours the .gitignore files as
 * they are NOW. A reviewer that appended `planted*` to .gitignore (or created a `sub/.gitignore`
 * holding `*`) would make its own files invisible to the comparison and survive the restore. So
 * every .gitignore the snapshot tree knows is reset to its snapshot content and every .gitignore
 * the reviewer added is removed, and only then is the working tree compared. The repo-level
 * `.git/info/exclude` and `core.excludesFile` are outside this reset: the sandbox denies
 * `.git/info` and `.git/config` (policy-builder gitDenies), so a sandboxed reviewer cannot move them.
 *
 * nax#1439: a tool the reviewer runs may drop its own .gitignore inside a directory the repository
 * already ignores (`.venv/.gitignore`, `.mypy_cache/.gitignore`, `node_modules/.bun/.../.gitignore`).
 * Such a file can only affect paths that are already ignored, so it cannot hide the reviewer's work
 * from the comparison: it is left in place and not reported. Which directory is ignored is read from
 * the SNAPSHOT-time rules only: every added .gitignore is parked aside while they are classified, so
 * one added rule (`sub/.gitignore` holding `*`) can never vouch for another (`sub/.cache/.gitignore`)
 * and keep the reviewer's own files out of the comparison.
 */
import { basename, dirname, join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import { _snapshotDeps, git, gitRaw, STAGE } from "./deps";

const IGNORE_FILE = ".gitignore";
const IGNORE_PATHSPEC = `:(top,glob)**/${IGNORE_FILE}`;
const CHUNK = 500;
/**
 * Suffix an added `.gitignore` is parked under while the classification runs. git does not read it as a
 * rule file, so the classification below sees the snapshot-time rules and nothing else.
 */
const HOLD_SUFFIX = ".nax-restore-hold";
/** Bounded search for a free parking name; a directory holding 100 of them is not worth more renames. */
const MAX_HOLD_ATTEMPTS = 100;

/** One snapshot-tree entry: its git object type ("commit" = gitlink) and blob id. */
export interface TreeEntry {
  readonly type: string;
  readonly sha: string;
}

export interface IgnoreRuleRestore {
  readonly toplevel: string;
  readonly tree: string;
  readonly entries: ReadonlyMap<string, TreeEntry>;
  /**
   * Every .gitignore present when the snapshot was taken, ignored ones included (`node_modules/x/.gitignore`,
   * `.pytest_cache/.gitignore`). Only a .gitignore outside this list is the reviewer's and removed. `null`
   * (the list could not be read) still removes every VISIBLE added one — the snapshot tree holds every
   * visible file, so those can only be the reviewer's — and keeps only the ignored ones, as a failure.
   */
  readonly known: ReadonlySet<string> | null;
  readonly skip: (path: string) => boolean;
  readonly remove: (absolutePath: string) => Promise<void>;
}

export async function listIgnoreFiles(toplevel: string): Promise<Set<string>> {
  // Visible files (tracked + untracked) and the ones a rule hides, e.g. a nested `*` file hiding itself.
  const [visible, hidden] = await Promise.all([
    gitRaw(["ls-files", "-z", "-c", "-o", "--exclude-standard", "--", IGNORE_PATHSPEC], toplevel),
    gitRaw(["ls-files", "-z", "-o", "-i", "--exclude-standard", "--", IGNORE_PATHSPEC], toplevel),
  ]);
  return new Set([...visible.split("\0"), ...hidden.split("\0")].filter(isIgnoreFile));
}

/**
 * git does not descend into a nested repository or worktree; `ls-files -o` reports the directory
 * itself (`.nax-wt/bot-x/`) whatever the pathspec. Taken for a reviewer-added .gitignore, it was
 * deleted recursively (nax#2681). Only a path whose basename is exactly `.gitignore` is one.
 */
function isIgnoreFile(p: string): boolean {
  return !p.endsWith("/") && basename(p) === IGNORE_FILE;
}

async function listVisibleIgnoreFiles(toplevel: string): Promise<Set<string>> {
  const visible = await gitRaw(["ls-files", "-z", "-c", "-o", "--exclude-standard", "--", IGNORE_PATHSPEC], toplevel);
  return new Set(visible.split("\0").filter(isIgnoreFile));
}

async function currentShas(toplevel: string, paths: readonly string[]): Promise<Map<string, string>> {
  const shas = new Map<string, string>();
  for (let i = 0; i < paths.length; i += CHUNK) {
    const chunk = paths.slice(i, i + CHUNK);
    const lines = (await git(["hash-object", "--no-filters", "--", ...chunk], toplevel)).split("\n");
    for (const [j, p] of chunk.entries()) shas.set(p, lines[j] ?? "");
  }
  return shas;
}

/** Reset every .gitignore to its snapshot state; returns the paths changed. Failures are recorded, never thrown. */
export async function restoreIgnoreRules(ctx: IgnoreRuleRestore, failures: string[]): Promise<string[]> {
  const { toplevel, entries } = ctx;
  try {
    const current = [...(await listIgnoreFiles(toplevel))].filter((p) => !ctx.skip(p));
    const wanted = [...entries]
      .filter(([p, e]) => basename(p) === IGNORE_FILE && e.type !== "commit" && !ctx.skip(p))
      .map(([p]) => p);
    const wantedSet = new Set(wanted);
    const known = ctx.known ?? (await listVisibleIgnoreFiles(toplevel));
    if (ctx.known === null) failures.push("ignore-rules: snapshot-time .gitignore list unavailable; ignored ones kept");
    const added =
      ctx.known === null
        ? current.filter((p) => !wantedSet.has(p) && known.has(p))
        : current.filter((p) => !wantedSet.has(p) && !known.has(p));
    // The snapshot's own ignore files go back FIRST: the classification below reads the restored
    // rules, so a pattern the reviewer appended must already be gone (nax#1439).
    const stale = await resetKnownIgnoreFiles(ctx, wanted, new Set(current), failures);
    const removed = await removeAddedIgnoreFiles(ctx, added, failures);
    return [...removed, ...stale];
  } catch (err) {
    failures.push(`ignore-rules: ${errorMessage(err)}`);
    return [];
  }
}

/** Put the snapshot's own .gitignore files back; returns the ones that differed. */
async function resetKnownIgnoreFiles(
  ctx: IgnoreRuleRestore,
  wanted: readonly string[],
  present: ReadonlySet<string>,
  failures: string[],
): Promise<string[]> {
  const { toplevel, tree, entries } = ctx;
  const live = wanted.filter((p) => present.has(p));
  const shas = await currentShas(toplevel, live);
  const stale = wanted.filter((p) => !present.has(p) || shas.get(p) !== entries.get(p)?.sha);
  for (let i = 0; i < stale.length; i += CHUNK) {
    const chunk = stale.slice(i, i + CHUNK);
    await git(["checkout", tree, "--", ...chunk.map((p) => `:(top,literal)${p}`)], toplevel).catch((err) =>
      failures.push(`checkout ${chunk.length} ignore file(s): ${errorMessage(err)}`),
    );
  }
  return stale;
}

/**
 * Remove the .gitignore files the reviewer added, except one inside a directory the SNAPSHOT-time rules
 * ignore (nax#1439): it can only affect already-ignored paths, so it hides nothing from the comparison.
 *
 * Every added file is parked under `HOLD_SUFFIX` before any of them is classified. Otherwise one added
 * rule file decides another's fate: a reviewer-written `sub/.gitignore` holding `*` makes `sub/.cache`
 * look ignored, so `sub/.cache/.gitignore` would be kept and its `*` would hide the reviewer's own
 * `sub/.cache/planted.txt` from the comparison. Parked, git reads only the restored rules.
 *
 * Every exit code but 0 — 1, "not ignored", and 128, "no answer" — keeps today's removal.
 */
async function removeAddedIgnoreFiles(
  ctx: IgnoreRuleRestore,
  added: readonly string[],
  failures: string[],
): Promise<string[]> {
  const removed = new Set<string>();
  const parked = await parkAddedIgnoreFiles(ctx, added, failures, removed);
  for (const [path, held] of parked) {
    if (await isInsideIgnoredDirectory(ctx.toplevel, path)) {
      await unparkIgnoreFile(ctx, path, held, failures);
      continue;
    }
    await ctx.remove(join(ctx.toplevel, held)).catch((err) => failures.push(`remove ${path}: ${errorMessage(err)}`));
    removed.add(path);
  }
  return [...removed];
}

/**
 * Move every added .gitignore aside, so no added rule can influence the classification. One that cannot
 * be moved is removed instead and reported: a live rule could hide the reviewer's work, so this fails
 * toward restoring the tree.
 *
 * The parking name is reserved, never assumed free (B6): `rename` overwrites silently, so a file already
 * sitting at `<path>.nax-restore-hold` (a tool's own, or a leftover of an interrupted restore) was
 * destroyed by the parking move and then removed with the parked rule — with no path or failure reported.
 */
async function parkAddedIgnoreFiles(
  ctx: IgnoreRuleRestore,
  added: readonly string[],
  failures: string[],
  removed: Set<string>,
): Promise<Map<string, string>> {
  const parked = new Map<string, string>();
  for (const path of added) {
    try {
      const held = await reserveHoldPath(ctx.toplevel, path);
      await _snapshotDeps.rename(join(ctx.toplevel, path), join(ctx.toplevel, held));
      parked.set(path, held);
    } catch (err) {
      failures.push(`park ${path}: ${errorMessage(err)}`);
      await ctx.remove(join(ctx.toplevel, path)).catch((e) => failures.push(`remove ${path}: ${errorMessage(e)}`));
      removed.add(path);
    }
  }
  return parked;
}

/** The first `<path>.nax-restore-hold[.N]` no file occupies, so parking never overwrites anything. */
async function reserveHoldPath(toplevel: string, path: string): Promise<string> {
  for (let attempt = 0; attempt < MAX_HOLD_ATTEMPTS; attempt++) {
    const candidate = `${path}${HOLD_SUFFIX}${attempt === 0 ? "" : `.${attempt}`}`;
    if (!(await isOccupied(join(toplevel, candidate)))) return candidate;
  }
  throw new NaxError(
    `[${STAGE}] ${MAX_HOLD_ATTEMPTS} restore-hold names are taken by ${path}`,
    "REVIEWER_GUARD_RESTORE_HOLD",
    { stage: STAGE, path },
  );
}

/** A path exists, or cannot be shown to be absent — anything but ENOENT/ENOTDIR counts as occupied. */
async function isOccupied(absolutePath: string): Promise<boolean> {
  try {
    await _snapshotDeps.lstat(absolutePath);
    return true;
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

/** Put a tool-written .gitignore back where it was; a failed move is reported, never silent. */
async function unparkIgnoreFile(ctx: IgnoreRuleRestore, path: string, held: string, failures: string[]): Promise<void> {
  try {
    await _snapshotDeps.rename(join(ctx.toplevel, held), join(ctx.toplevel, path));
  } catch (err) {
    failures.push(`restore ${path}: ${errorMessage(err)}`);
    await ctx.remove(join(ctx.toplevel, held)).catch((e) => failures.push(`remove ${path}: ${errorMessage(e)}`));
  }
}

/** True when the directory holding this repo-relative .gitignore is itself ignored, read from the raw seam. */
async function isInsideIgnoredDirectory(toplevel: string, path: string): Promise<boolean> {
  // No trailing slash: `check-ignore -- sub/` reports a directory as ignored because of a `*` inside
  // `sub/.gitignore`, which would keep exactly the self-hiding file AC-3 must remove.
  const r = await _snapshotDeps.git(["check-ignore", "-q", "--", dirname(path)], toplevel);
  return r.exitCode === 0;
}
