/**
 * Ref capture/restore for the reviewer guard (nax#2500, ruling R15). Refs and the
 * stash are shared by every worktree of a repository, so restore moves ONLY this
 * worktree's own HEAD (its branch ref and symbolic pointer, or the detached sha).
 * Every other branch, tag and stash entry is left alone and merely reported.
 */
import { git, symbolicHead } from "./deps";

export type RefEntry = readonly [name: string, sha: string];

const REPLACE_PREFIX = "refs/replace/";

async function forEachRef(cwd: string, patterns: readonly string[]): Promise<RefEntry[]> {
  const out = await git(["for-each-ref", "--format=%(refname)%00%(objectname)", ...patterns], cwd);
  if (out === "") return [];
  return out.split("\n").map((line): RefEntry => {
    const [name = "", sha = ""] = line.split("\0");
    return [name, sha];
  });
}

/** Every ref under refs/heads and refs/tags, as [refname, objectname] pairs. */
export function listRefs(cwd: string): Promise<RefEntry[]> {
  return forEachRef(cwd, ["refs/heads", "refs/tags"]);
}

/** Names of every refs/replace/* entry. */
export async function listReplaceRefs(cwd: string): Promise<string[]> {
  return (await forEachRef(cwd, [REPLACE_PREFIX])).map(([name]) => name);
}

export async function listStashes(cwd: string): Promise<string[]> {
  const out = await git(["stash", "list", "--format=%H"], cwd);
  return out === "" ? [] : out.split("\n");
}

export interface RefState {
  readonly head: string;
  readonly symbolicHead: string | undefined;
  readonly refs: readonly RefEntry[];
  readonly replaceRefs: readonly string[];
}

/** Put this worktree's own HEAD back. Returns whether anything moved. */
export async function restoreOwnHead(snap: RefState, cwd: string): Promise<boolean> {
  const head = await git(["rev-parse", "-q", "--verify", "HEAD"], cwd, true);
  const symbolic = await symbolicHead(cwd);
  if (snap.symbolicHead === undefined) {
    if (head === snap.head && symbolic === undefined) return false;
    await git(["update-ref", "--no-deref", "HEAD", snap.head], cwd);
    return true;
  }
  let changed = false;
  // HEAD first: re-pointing it off a branch makes that branch free to move or delete.
  if (symbolic !== snap.symbolicHead) {
    await git(["symbolic-ref", "HEAD", snap.symbolicHead], cwd);
    changed = true;
  }
  const branch = (await listRefs(cwd)).find(([name]) => name === snap.symbolicHead);
  if (branch?.[1] !== snap.head) {
    await git(["update-ref", snap.symbolicHead, snap.head], cwd);
    changed = true;
  }
  return changed;
}

/** Delete refs/replace/* entries that appeared during the turn (they can rewrite history reads). */
export async function removeAddedReplaceRefs(snap: RefState, cwd: string): Promise<boolean> {
  const before = new Set(snap.replaceRefs);
  const added = (await listReplaceRefs(cwd)).filter((name) => !before.has(name));
  for (const name of added) await git(["update-ref", "-d", name], cwd);
  return added.length > 0;
}

/** Branch/tag differences from the snapshot, for the log only: "added|moved|deleted <ref>". */
export async function diffRefsLeft(snap: RefState, cwd: string): Promise<string[]> {
  const current = new Map(await listRefs(cwd));
  const wanted = new Map(snap.refs);
  const left: string[] = [];
  for (const [name, sha] of current) {
    if (!wanted.has(name)) left.push(`added ${name}`);
    else if (wanted.get(name) !== sha) left.push(`moved ${name}`);
  }
  for (const name of wanted.keys()) if (!current.has(name)) left.push(`deleted ${name}`);
  return left;
}

/** Stash differences from the snapshot, for the log only: "added|missing <sha>". Never modifies the stash. */
export async function diffStashesLeft(snapshot: readonly string[], cwd: string): Promise<string[]> {
  const before = new Set(snapshot);
  const now = await listStashes(cwd);
  const present = new Set(now);
  return [
    ...now.filter((sha) => !before.has(sha)).map((sha) => `added ${sha}`),
    ...snapshot.filter((sha) => !present.has(sha)).map((sha) => `missing ${sha}`),
  ];
}
