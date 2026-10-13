/**
 * nax#2500: snapshot and restore a repository around reviewer turns. The working
 * tree (tracked + untracked, .gitignore honoured) is captured as a tree object
 * without touching the real index (snapshotWorkingTree); the index as its own tree;
 * HEAD, its symbolic ref and the stash list as ids. Restore touches only paths
 * that changed, never .nax run state (the #2497 keeper owns it) and never ignored paths.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { NaxError } from "@/errors";
import { changedPathsBetween, snapshotWorkingTree } from "@/review/fix-review/tree-snapshot";
import { runHardenedGit } from "@/utils/hardened-git";

export interface RepoSnapshot {
  readonly toplevel: string;
  readonly tree: string;
  readonly indexTree: string;
  readonly head: string;
  readonly symbolicHead: string | undefined;
  readonly stashes: readonly string[];
}

export interface RestoreReport {
  readonly paths: readonly string[];
  readonly indexRestored: boolean;
  readonly headRestored: boolean;
  readonly stashesDropped: number;
}

export const _snapshotDeps = { rm, snapshotWorkingTree, changedPathsBetween, git: runHardenedGit };

const STAGE = "reviewer-guard";

async function git(args: readonly string[], cwd: string, allowFail = false): Promise<string> {
  const r = await _snapshotDeps.git(args, cwd);
  if (r.exitCode !== 0 && !allowFail) {
    throw new NaxError(`[${STAGE}] git ${args.join(" ")} failed: ${r.stderr.trim()}`, "REVIEWER_GUARD_GIT_FAILED", {
      stage: STAGE,
      cwd,
    });
  }
  return r.exitCode === 0 ? r.stdout.trim() : "";
}

export function isRunStatePath(path: string): boolean {
  return path === ".nax" || path.startsWith(".nax/") || path.includes("/.nax/");
}

export async function takeRepoSnapshot(workdir: string): Promise<RepoSnapshot> {
  const toplevel = await git(["rev-parse", "--show-toplevel"], workdir);
  const [tree, indexTree, head, symbolic, stashList] = await Promise.all([
    _snapshotDeps.snapshotWorkingTree(toplevel),
    git(["write-tree"], toplevel),
    git(["rev-parse", "HEAD"], toplevel),
    git(["symbolic-ref", "-q", "HEAD"], toplevel, true),
    git(["stash", "list", "--format=%H"], toplevel),
  ]);
  return {
    toplevel,
    tree,
    indexTree,
    head,
    symbolicHead: symbolic === "" ? undefined : symbolic,
    stashes: stashList === "" ? [] : stashList.split("\n"),
  };
}

async function restoreRefs(snap: RepoSnapshot): Promise<boolean> {
  const head = await git(["rev-parse", "HEAD"], snap.toplevel);
  const symbolic = (await git(["symbolic-ref", "-q", "HEAD"], snap.toplevel, true)) || undefined;
  let changed = false;
  if (snap.symbolicHead !== undefined) {
    const branchSha = await git(["rev-parse", snap.symbolicHead], snap.toplevel);
    if (branchSha !== snap.head) {
      await git(["update-ref", snap.symbolicHead, snap.head], snap.toplevel);
      changed = true;
    }
    if (symbolic !== snap.symbolicHead) {
      await git(["symbolic-ref", "HEAD", snap.symbolicHead], snap.toplevel);
      changed = true;
    }
  } else if (head !== snap.head || symbolic !== undefined) {
    await git(["update-ref", "--no-deref", "HEAD", snap.head], snap.toplevel);
    changed = true;
  }
  return changed;
}

async function dropNewStashes(snap: RepoSnapshot): Promise<number> {
  const now = await git(["stash", "list", "--format=%H"], snap.toplevel);
  const added = (now === "" ? [] : now.split("\n")).filter((sha) => !snap.stashes.includes(sha));
  for (const sha of added) {
    const list = (await git(["stash", "list", "--format=%H"], snap.toplevel)).split("\n");
    const at = list.indexOf(sha);
    if (at >= 0) await git(["stash", "drop", "-q", `stash@{${at}}`], snap.toplevel);
  }
  return added.length;
}

export async function restoreRepoSnapshot(snap: RepoSnapshot): Promise<RestoreReport> {
  // Order is load-bearing: refs, then stashes, then the tree comparison (snapshotWorkingTree
  // seeds from HEAD, so HEAD must be back first), then the index.
  const headRestored = await restoreRefs(snap);
  const stashesDropped = await dropNewStashes(snap);
  const current = await _snapshotDeps.snapshotWorkingTree(snap.toplevel);
  const changed = (await _snapshotDeps.changedPathsBetween(snap.toplevel, snap.tree, current)).filter(
    (p) => !isRunStatePath(p),
  );
  const inSnapshot = await Promise.all(
    changed.map(
      async (p) => (await _snapshotDeps.git(["cat-file", "-e", `${snap.tree}:${p}`], snap.toplevel)).exitCode === 0,
    ),
  );
  const restore = changed.filter((_, i) => inSnapshot[i]);
  const remove = changed.filter((_, i) => !inSnapshot[i]);
  if (restore.length > 0) {
    await git(["checkout", snap.tree, "--", ...restore.map((p) => `:(top,literal)${p}`)], snap.toplevel);
  }
  for (const p of remove) await _snapshotDeps.rm(join(snap.toplevel, p), { force: true });
  const indexNow = await git(["write-tree"], snap.toplevel);
  const indexRestored = indexNow !== snap.indexTree;
  // `checkout <tree> -- paths` also writes index entries, so read-tree runs whenever paths were restored.
  if (indexRestored || restore.length > 0) {
    await git(["read-tree", snap.indexTree], snap.toplevel);
    await git(["update-index", "-q", "--refresh"], snap.toplevel, true);
  }
  return { paths: changed, indexRestored, headRestored, stashesDropped };
}
