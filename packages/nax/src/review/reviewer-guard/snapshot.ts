/**
 * nax#2500: snapshot and restore a repository around reviewer turns. The working
 * tree (tracked + untracked, .gitignore honoured) is captured as a tree object
 * without touching the real index (snapshotWorkingTree); the index as its own tree;
 * HEAD, its symbolic ref, every branch/tag, refs/replace and the stash list as ids.
 * Restore touches only paths that changed, never run state the #2497 keeper owns and
 * never ignored paths. Refs and the stash are shared by all worktrees of a repo, so
 * only this worktree's own HEAD is restored; other refs/stash entries are only reported.
 * Each restore phase is failure-isolated: a failure is recorded and later phases still run.
 */
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { classifyRunStatePath } from "@/runstate/store";
import { _snapshotDeps, git, gitRaw, symbolicHead } from "./deps";
import { listIgnoreFiles, restoreIgnoreRules, type TreeEntry } from "./snapshot-ignore-rules";
import {
  diffRefsLeft,
  diffStashesLeft,
  listRefs,
  listReplaceRefs,
  listStashes,
  type RefEntry,
  removeAddedReplaceRefs,
  restoreOwnHead,
} from "./snapshot-refs";

export { _snapshotDeps } from "./deps";

export interface RepoSnapshot {
  readonly toplevel: string;
  readonly tree: string;
  readonly indexTree: string;
  readonly head: string;
  readonly symbolicHead: string | undefined;
  readonly refs: readonly RefEntry[];
  readonly replaceRefs: readonly string[];
  readonly stashes: readonly string[];
  /** Every .gitignore at snapshot time, ignored ones included; `null` when it could not be listed (nax#2552). */
  readonly ignoreFiles: readonly string[] | null;
}

export interface RestoreReport {
  readonly paths: readonly string[];
  readonly indexRestored: boolean;
  readonly headRestored: boolean;
  /** Branch/tag changes made during the turn that were left alone: "added|moved|deleted <ref>". */
  readonly refsLeft: readonly string[];
  /** Stash changes made during the turn that were left alone: "added|missing <sha>". */
  readonly stashLeft: readonly string[];
  /** Phases or paths that could not be restored; empty on a clean restore. */
  readonly failures: readonly string[];
}

const CHECKOUT_CHUNK = 500;

/** True when the #2497 run-state keeper owns this repo-relative path. */
export function isKeeperOwnedPath(toplevel: string, rel: string): boolean {
  return classifyRunStatePath(join(toplevel, rel)) !== null;
}

export async function takeRepoSnapshot(workdir: string): Promise<RepoSnapshot> {
  const toplevel = await git(["rev-parse", "--show-toplevel"], workdir);
  const [tree, indexTree, head, symbolic, refs, replaceRefs, stashes, ignoreFiles] = await Promise.all([
    _snapshotDeps.snapshotWorkingTree(toplevel),
    git(["write-tree"], toplevel),
    git(["rev-parse", "HEAD"], toplevel),
    symbolicHead(toplevel),
    listRefs(toplevel),
    listReplaceRefs(toplevel),
    listStashes(toplevel),
    listIgnoreFiles(toplevel).then(
      (files) => [...files],
      () => null,
    ),
  ]);
  return { toplevel, tree, indexTree, head, symbolicHead: symbolic, refs, replaceRefs, stashes, ignoreFiles };
}

function isAbsent(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Remove a reviewer-created path. Symlinks are unlinked, never followed. */
async function removePath(abs: string): Promise<void> {
  let isLink: boolean;
  try {
    isLink = (await _snapshotDeps.lstat(abs)).isSymbolicLink();
  } catch (err) {
    if (isAbsent(err)) return;
    throw err;
  }
  try {
    await _snapshotDeps.rm(abs, isLink ? { force: true } : { recursive: true, force: true });
  } catch (err) {
    if (!isAbsent(err)) throw err;
  }
}

/** Snapshot entries by path: type "commit" is a gitlink, anything else a regular blob. */
async function snapshotEntries(snap: RepoSnapshot): Promise<Map<string, TreeEntry>> {
  const out = await gitRaw(["ls-tree", "-r", "-z", snap.tree], snap.toplevel);
  const entries = new Map<string, TreeEntry>();
  for (const rec of out.split("\0")) {
    const tab = rec.indexOf("\t");
    if (tab < 0) continue;
    const [, type = "", sha = ""] = rec.slice(0, tab).split(" ");
    entries.set(rec.slice(tab + 1), { type, sha });
  }
  return entries;
}

async function restoreTree(snap: RepoSnapshot, failures: string[]): Promise<{ paths: string[]; restored: boolean }> {
  const entries = await snapshotEntries(snap);
  // Reset the ignore rules first: the comparison below honours them, and a reviewer-edited
  // .gitignore would otherwise hide the reviewer's own files from it (nax#2552).
  const ruleChanges = await restoreIgnoreRules(
    {
      toplevel: snap.toplevel,
      tree: snap.tree,
      entries,
      known: snap.ignoreFiles === null ? null : new Set(snap.ignoreFiles),
      skip: (p) => isKeeperOwnedPath(snap.toplevel, p),
      remove: removePath,
    },
    failures,
  );
  const current = await _snapshotDeps.snapshotWorkingTree(snap.toplevel);
  const diffed = (await _snapshotDeps.changedPathsBetween(snap.toplevel, snap.tree, current)).filter(
    (p) => !isKeeperOwnedPath(snap.toplevel, p),
  );
  const changed = [...new Set([...ruleChanges, ...diffed])];
  if (changed.length === 0) return { paths: [], restored: false };
  // A nested repo (gitlink) in the snapshot cannot be re-created from a tree: leave it.
  const restore = diffed.filter((p) => entries.get(p) !== undefined && entries.get(p)?.type !== "commit");
  const remove = diffed.filter((p) => entries.get(p) === undefined);
  // Removals first: a file/dir swap must clear the obstructing path before checkout.
  for (const p of remove) {
    await removePath(join(snap.toplevel, p)).catch((err) => failures.push(`remove ${p}: ${errorMessage(err)}`));
  }
  for (let i = 0; i < restore.length; i += CHECKOUT_CHUNK) {
    const chunk = restore.slice(i, i + CHECKOUT_CHUNK);
    await git(["checkout", snap.tree, "--", ...chunk.map((p) => `:(top,literal)${p}`)], snap.toplevel).catch((err) =>
      failures.push(`checkout ${chunk.length} path(s): ${errorMessage(err)}`),
    );
  }
  return { paths: changed, restored: restore.length > 0 || ruleChanges.length > 0 };
}

async function restoreIndex(snap: RepoSnapshot, force: boolean): Promise<boolean> {
  let indexRestored = true;
  try {
    indexRestored = (await git(["write-tree"], snap.toplevel)) !== snap.indexTree;
  } catch {
    // Unwritable index (e.g. unmerged entries): treat as changed and overwrite it below.
  }
  // `checkout <tree> -- paths` also writes index entries, so read-tree runs whenever paths were restored.
  if (indexRestored || force) {
    await git(["read-tree", snap.indexTree], snap.toplevel);
    await git(["update-index", "-q", "--refresh"], snap.toplevel, true);
  }
  return indexRestored;
}

export async function restoreRepoSnapshot(snap: RepoSnapshot): Promise<RestoreReport> {
  const failures: string[] = [];
  const phase = async <T>(name: string, fallback: T, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      failures.push(`${name}: ${errorMessage(err)}`);
      return fallback;
    }
  };
  // Order is load-bearing: own HEAD and replace refs first, then the tree comparison
  // (snapshotWorkingTree seeds from HEAD, so HEAD must be back first), then the index.
  // Refs and stash diffs are read-only reports (nax#2500 R15).
  const headMoved = await phase("refs", false, () => restoreOwnHead(snap, snap.toplevel));
  const replaceRemoved = await phase("replace-refs", false, () => removeAddedReplaceRefs(snap, snap.toplevel));
  const refsLeft = await phase("refs-report", [] as string[], () => diffRefsLeft(snap, snap.toplevel));
  const stashLeft = await phase("stash-report", [] as string[], () => diffStashesLeft(snap.stashes, snap.toplevel));
  const tree = await phase("tree", { paths: [] as string[], restored: false }, () => restoreTree(snap, failures));
  const indexRestored = await phase("index", false, () => restoreIndex(snap, tree.restored));
  return {
    paths: tree.paths,
    indexRestored,
    headRestored: headMoved || replaceRemoved,
    refsLeft,
    stashLeft,
    failures,
  };
}
