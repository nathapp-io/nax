/** Ref and stash capture/restore for the reviewer guard (nax#2500). */
import { git, symbolicHead } from "./deps";

export type RefEntry = readonly [name: string, sha: string];

const STASH_STORE_MESSAGE = "restored by nax reviewer guard";

/** Every ref under refs/heads and refs/tags, as [refname, objectname] pairs. */
export async function listRefs(cwd: string): Promise<RefEntry[]> {
  const out = await git(["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads", "refs/tags"], cwd);
  if (out === "") return [];
  return out.split("\n").map((line): RefEntry => {
    const [name = "", sha = ""] = line.split("\0");
    return [name, sha];
  });
}

export async function listStashes(cwd: string): Promise<string[]> {
  const out = await git(["stash", "list", "--format=%H"], cwd);
  return out === "" ? [] : out.split("\n");
}

export interface RefState {
  readonly head: string;
  readonly symbolicHead: string | undefined;
  readonly refs: readonly RefEntry[];
}

/** Put HEAD, its symbolic ref and every branch/tag back. Returns whether anything moved. */
export async function restoreRefs(snap: RefState, cwd: string): Promise<boolean> {
  let changed = false;
  const head = await git(["rev-parse", "-q", "--verify", "HEAD"], cwd, true);
  const symbolic = await symbolicHead(cwd);
  // HEAD first: re-pointing it off a branch makes that branch free to move or delete.
  if (snap.symbolicHead !== undefined) {
    if (symbolic !== snap.symbolicHead) {
      await git(["symbolic-ref", "HEAD", snap.symbolicHead], cwd);
      changed = true;
    }
  } else if (head !== snap.head || symbolic !== undefined) {
    await git(["update-ref", "--no-deref", "HEAD", snap.head], cwd);
    changed = true;
  }
  const current = new Map(await listRefs(cwd));
  const wanted = new Map(snap.refs);
  for (const [name, sha] of wanted) {
    if (current.get(name) === sha) continue;
    await git(["update-ref", name, sha], cwd);
    changed = true;
  }
  for (const name of current.keys()) {
    if (wanted.has(name)) continue;
    await git(["update-ref", "-d", name], cwd);
    changed = true;
  }
  return changed;
}

/** Drop stash entries the reviewer added; store back ones it popped or dropped. */
export async function restoreStashes(snapshot: readonly string[], cwd: string): Promise<number> {
  const before = new Set(snapshot);
  const now = await listStashes(cwd);
  const added = now.filter((sha) => !before.has(sha));
  for (const sha of added) {
    const at = (await listStashes(cwd)).indexOf(sha);
    if (at >= 0) await git(["stash", "drop", "-q", `stash@{${at}}`], cwd);
  }
  const present = new Set(await listStashes(cwd));
  // `stash list` is newest first; store oldest first so the order is rebuilt.
  for (const sha of [...snapshot].reverse()) {
    if (!present.has(sha)) await git(["stash", "store", "-m", STASH_STORE_MESSAGE, sha], cwd);
  }
  return added.length;
}
