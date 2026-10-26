/**
 * nax#2700: the tracked-only fallback must still remove what the reviewer added.
 *
 * The fallback runs when the restore-time comparison (`git add -A` into a throwaway index) fails,
 * and a reviewer can force that failure: a nested repo with no commit (`git init planted`), an
 * unreadable file, or enough files to time it out. Checking out the snapshot paths alone would
 * leave every planted file in place for the next auto-commit. `ls-files` reads no file contents,
 * so the cases that break `add -A` do not break it. `-c` also lists a planted file the reviewer
 * staged, since the real index is restored only after the tree. `--exclude-standard` keeps ignored
 * paths out, the same as the normal path; the ignore rules are already back at snapshot state.
 *
 * A path is the snapshot's when the snapshot's working tree holds it, or when only the snapshot's
 * index holds it and it is ignored: a file the user force-staged under an ignored path. A staged
 * path that was missing from disk is not ignored, so a reviewer recreating it gains nothing. The
 * real index can be forged as raw bytes, so a listed path is refused unless every component is a
 * plain name, none is `.git`, and no parent is a symlink, a non-directory or a snapshot nested repo.
 */
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import { _snapshotDeps, gitRaw, STAGE } from "./deps";
import { listIgnoreFiles, type TreeEntry } from "./snapshot-ignore-rules";

/** Nested repos inside nested repos are unwrapped one level per listing pass. */
const MAX_LISTING_PASSES = 16;

export interface AdditionRemoval {
  readonly toplevel: string;
  readonly entries: ReadonlyMap<string, TreeEntry>;
  /** The snapshot's own index, as a tree. */
  readonly indexTree: string;
  /** Every .gitignore at snapshot time; `null` when it could not be listed. */
  readonly ignoreFiles: readonly string[] | null;
  readonly skip: (path: string) => boolean;
  /** True when keeper-owned run state sits under this `dir/`. */
  readonly keptUnder: (dir: string) => boolean;
  readonly remove: (absolutePath: string) => Promise<void>;
}

interface Known {
  readonly has: (p: string) => boolean;
  /** True when any snapshot path (tree or index) sits under this `dir/`. */
  readonly under: (dir: string) => boolean;
}

function refused(rel: string, why: string): NaxError {
  return new NaxError(`[${STAGE}] refused ${rel}: ${why}`, "REVIEWER_GUARD_UNSAFE_PATH", { stage: STAGE, path: rel });
}

/** Throws unless `rel` stays inside the checkout, outside `.git`, and under real, non-gitlink directories. */
async function assertRemovable(ctx: AdditionRemoval, rel: string): Promise<void> {
  const parts = rel.replace(/\/$/, "").split("/");
  if (parts.some((s) => s === "" || s === "." || s === ".." || s.toLowerCase() === ".git")) {
    throw refused(rel, "not a plain path");
  }
  for (let i = 1; i < parts.length; i++) {
    const parent = parts.slice(0, i).join("/");
    if (ctx.entries.get(parent)?.type === "commit") throw refused(rel, `${parent} is a snapshot nested repo`);
    const stat = await _snapshotDeps.lstat(join(ctx.toplevel, parent)).catch(() => null);
    if (stat === null) return;
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw refused(rel, `parent ${parent} is not a directory`);
  }
}

/** Index entries the current (snapshot-state) ignore rules ignore: force-staged files. */
async function ignoredInIndex(toplevel: string): Promise<Set<string>> {
  const out = await gitRaw(["ls-files", "-z", "-c", "-i", "--exclude-standard"], toplevel);
  return new Set(out.split("\0").filter((p) => p.length > 0));
}

async function knownPaths(ctx: AdditionRemoval): Promise<Known> {
  const listed = await gitRaw(["ls-tree", "-r", "-z", "--name-only", ctx.indexTree], ctx.toplevel);
  const indexOnly = listed.split("\0").filter((p) => p.length > 0 && !ctx.entries.has(p));
  const ignored = await ignoredInIndex(ctx.toplevel);
  const forced = new Set(indexOnly.filter((p) => ignored.has(p)));
  const all = [...ctx.entries.keys(), ...indexOnly];
  return {
    has: (p) =>
      p.endsWith("/") ? ctx.entries.get(p.slice(0, -1))?.type === "commit" : ctx.entries.has(p) || forced.has(p),
    under: (dir) => all.some((p) => p.startsWith(dir)),
  };
}

/**
 * git does not descend into a nested repository, so `ls-files -o` reports it as `dir/`. Only a
 * snapshot gitlink is the snapshot's. Any other is the reviewer's and goes whole, unless snapshot
 * paths or keeper state sit under it: then only its `.git` and every `.gitignore` under it the
 * snapshot did not have are removed, and the next pass lists the files inside one by one.
 */
async function unwrap(ctx: AdditionRemoval, dir: string, removed: string[], failures: string[]): Promise<void> {
  await ctx.remove(join(ctx.toplevel, dir, ".git"));
  removed.push(`${dir}.git`);
  const known = new Set(ctx.ignoreFiles ?? []);
  for (const p of await listIgnoreFiles(ctx.toplevel)) {
    if (!p.startsWith(dir) || known.has(p) || ctx.entries.has(p) || ctx.skip(p)) continue;
    await ctx
      .remove(join(ctx.toplevel, p))
      .then(() => removed.push(p))
      .catch((err) => failures.push(`remove ${p}: ${errorMessage(err)}`));
  }
}

async function removeOnePass(ctx: AdditionRemoval, known: Known, seen: Set<string>, failures: string[]) {
  const listed = await gitRaw(["ls-files", "-z", "-c", "-o", "--exclude-standard"], ctx.toplevel);
  const added = [...new Set(listed.split("\0"))].filter(
    (p) => p.length > 0 && !seen.has(p) && !known.has(p) && !ctx.skip(p),
  );
  const removed: string[] = [];
  const unwrapped: string[] = [];
  for (const p of added) {
    seen.add(p);
    try {
      await assertRemovable(ctx, p);
      if (p.endsWith("/") && (known.under(p) || ctx.keptUnder(p))) {
        await unwrap(ctx, p, removed, failures);
        unwrapped.push(p);
      } else {
        await ctx.remove(join(ctx.toplevel, p));
        removed.push(p);
      }
    } catch (err) {
      failures.push(`remove ${p}: ${errorMessage(err)}`);
    }
  }
  return { removed, unwrapped };
}

/** Remove every visible path the snapshot did not hold; returns the paths removed. Failures are recorded. */
export async function removeAddedPaths(ctx: AdditionRemoval, failures: string[]): Promise<string[]> {
  const removed: string[] = [];
  const seen = new Set<string>();
  try {
    const known = await knownPaths(ctx);
    for (let pass = 0; pass < MAX_LISTING_PASSES; pass++) {
      const result = await removeOnePass(ctx, known, seen, failures);
      removed.push(...result.removed);
      if (result.unwrapped.length === 0) return removed;
    }
    failures.push(`additions: nested repos deeper than ${MAX_LISTING_PASSES} levels left in place`);
  } catch (err) {
    failures.push(`additions: ${errorMessage(err)}`);
  }
  return removed;
}
