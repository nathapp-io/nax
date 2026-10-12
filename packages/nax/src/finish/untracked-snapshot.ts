/**
 * Finish A §4.1 / §4.2 step 5: the snapshot of pre-existing untracked files and the
 * put-back after a stopped session. Nothing here follows a symlink, and a user's file
 * is removed only after a copy of it has been kept.
 */
import { copyFile, lstat, mkdir, realpath, rm, unlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { NaxError } from "@/errors";
import { insideRoot } from "./safe-path";
import { repoRoot } from "./set-aside-git";
import type { UntrackedEntry, UntrackedSnapshot } from "./types";

export const UNTRACKED_FILE_MAX = 1_048_576;
export const UNTRACKED_TOTAL_MAX = 20_971_520;

export const _setAsideDeps = {
  remove: (path: string): Promise<void> => unlink(path),
  limits: { fileMax: UNTRACKED_FILE_MAX, totalMax: UNTRACKED_TOTAL_MAX },
};

/** Copies a regular file (never through a symlink). False when the source is missing, not a regular file, or the copy failed. */
async function copyFileInto(src: string, dest: string): Promise<boolean> {
  try {
    if (!(await lstat(src)).isFile()) return false;
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
    return true;
  } catch {
    return false;
  }
}

const realOrResolved = (path: string): Promise<string> => realpath(path).catch(() => resolve(path));

/**
 * Spec §4.1: copy pre-existing untracked, non-ignored files (as listed by `git status`,
 * so ignored files such as node_modules are never included) into `dir`, within
 * `_setAsideDeps.limits`. Every regular file is recorded with its size and mtime, so a
 * change is detectable even when it was too big to copy. Symlinks are not recorded and
 * never copied through.
 */
export async function snapshotUntracked(workdir: string, paths: string[], dir: string): Promise<UntrackedSnapshot> {
  const root = await repoRoot(workdir);
  const [target, realRoot] = await Promise.all([realOrResolved(dir), realOrResolved(root)]);
  if (target === realRoot || realRoot.startsWith(target + sep)) {
    throw new NaxError(
      `Refusing to clear snapshot directory "${dir}": it is the repository root or above it`,
      "FINISH_SNAPSHOT_DIR_UNSAFE",
      {
        stage: "finish",
        dir,
        root,
      },
    );
  }
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  const { fileMax, totalMax } = _setAsideDeps.limits;
  const files: UntrackedEntry[] = [];
  let total = 0;
  for (const path of paths) {
    const st = await lstat(join(root, path)).catch(() => null);
    if (!st?.isFile()) continue;
    const fits = st.size <= fileMax && total + st.size <= totalMax;
    const saved = fits && (await copyFileInto(join(root, path), join(dir, path)));
    if (saved) total += st.size;
    files.push({ path, size: st.size, mtimeMs: st.mtimeMs, saved });
  }
  return { dir, files };
}

type Lstat = Awaited<ReturnType<typeof lstat>>;

function unchanged(st: Lstat | null, e: UntrackedEntry): boolean {
  return st?.isFile() === true && st.size === e.size && st.mtimeMs === e.mtimeMs;
}

/** Writes the snapshot copy back over `dest`: a symlink there is unlinked first, so the copy never lands on its target. */
async function putBack(root: string, from: string, dest: string): Promise<boolean> {
  try {
    if (!(await insideRoot(root, dest))) return false;
    const st = await lstat(dest).catch(() => null);
    if (st && !st.isFile()) await unlink(dest);
    return await copyFileInto(from, dest);
  } catch {
    return false;
  }
}

export interface UntrackedRestore {
  restored: string[];
  movedAside: string[];
  /** Changed files that could not be handled safely; left exactly as the session left them. */
  failed: string[];
}

/**
 * Spec §4.2 step 5: a pre-existing untracked file the session changed keeps its edit in
 * `<handoff>/untracked-modified/` and is put back from the snapshot. Without a snapshot
 * (over the cap) it is moved into the handoff instead, so `git add -A` can never commit
 * the half-edit. A file is only ever removed after its edit was copied into the handoff.
 */
export async function restoreUntracked(
  workdir: string,
  snapshot: UntrackedSnapshot | undefined,
  handoffPath: string,
): Promise<UntrackedRestore> {
  const out: UntrackedRestore = { restored: [], movedAside: [], failed: [] };
  const root = await repoRoot(workdir);
  for (const e of snapshot?.files ?? []) {
    const file = join(root, e.path);
    if (!(await insideRoot(root, file))) {
      out.failed.push(e.path); // a directory on the way was swapped for a symlink: touch nothing
      continue;
    }
    const st = await lstat(file).catch(() => null);
    if (unchanged(st, e)) continue;
    const kept = !st?.isFile() || (await copyFileInto(file, join(handoffPath, "untracked-modified", e.path)));
    if (!kept) {
      out.failed.push(e.path);
    } else if (e.saved && snapshot && (await putBack(root, join(snapshot.dir, e.path), file))) {
      out.restored.push(e.path);
    } else if (!e.saved && st) {
      const removed = await _setAsideDeps.remove(file).then(
        () => true,
        () => false,
      );
      (removed ? out.movedAside : out.failed).push(e.path);
    } else {
      out.failed.push(e.path);
    }
  }
  return out;
}
