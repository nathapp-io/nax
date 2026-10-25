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
 */
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import { _snapshotDeps, gitRaw, STAGE } from "./deps";
import type { TreeEntry } from "./snapshot-ignore-rules";

export interface AdditionRemoval {
  readonly toplevel: string;
  readonly entries: ReadonlyMap<string, TreeEntry>;
  readonly skip: (path: string) => boolean;
  readonly remove: (absolutePath: string) => Promise<void>;
}

/**
 * git does not descend into a nested repository, so `ls-files -o` reports it as `dir/`. It is the
 * snapshot's only when the snapshot holds it as a gitlink. A directory the snapshot merely held files
 * under does not count: a `.git` planted there would hide every new file inside it. Removing the whole
 * directory is safe, because the snapshot paths under it are checked out again afterwards.
 */
function isKnown(p: string, entries: ReadonlyMap<string, TreeEntry>): boolean {
  if (!p.endsWith("/")) return entries.has(p);
  return entries.get(p.slice(0, -1))?.type === "commit";
}

/**
 * `-c` lists the real index, which the reviewer can write (`update-index --cacheinfo link/x`), so a
 * listed path can sit under a planted symlink. Removing it would follow the link out of the checkout.
 * Throws when any parent of `rel` below `toplevel` is not a real directory.
 */
async function assertNoLinkedParent(toplevel: string, rel: string): Promise<void> {
  const parts = rel.replace(/\/$/, "").split("/").slice(0, -1);
  for (let i = 1; i <= parts.length; i++) {
    const parent = parts.slice(0, i).join("/");
    const stat = await _snapshotDeps.lstat(join(toplevel, parent)).catch(() => null);
    if (stat === null) return;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new NaxError(`[${STAGE}] parent ${parent} is not a directory`, "REVIEWER_GUARD_LINKED_PARENT", {
        stage: STAGE,
        path: rel,
      });
    }
  }
}

/** Remove every visible path the snapshot did not hold; returns the paths removed. Failures are recorded. */
export async function removeAddedPaths(ctx: AdditionRemoval, failures: string[]): Promise<string[]> {
  let listed: string;
  try {
    listed = await gitRaw(["ls-files", "-z", "-c", "-o", "--exclude-standard"], ctx.toplevel);
  } catch (err) {
    failures.push(`additions: ${errorMessage(err)}`);
    return [];
  }
  const added = [...new Set(listed.split("\0"))].filter(
    (p) => p.length > 0 && !isKnown(p, ctx.entries) && !ctx.skip(p),
  );
  const removed: string[] = [];
  for (const p of added) {
    try {
      await assertNoLinkedParent(ctx.toplevel, p);
      await ctx.remove(join(ctx.toplevel, p));
      removed.push(p);
    } catch (err) {
      failures.push(`remove ${p}: ${errorMessage(err)}`);
    }
  }
  return removed;
}
