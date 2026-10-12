/**
 * Finish A §4: a stopped (or crashed) fix session's edits are set aside, never committed.
 *
 * The base is `git stash create` (a commit object of the current tree that moves no ref
 * and leaves the stash list alone) or HEAD when the tree is clean. Pre-existing tracked
 * edits are therefore part of the base and are never overwritten. On set-aside the
 * session's changes (tracked diff against the base, plus files it created) are saved
 * as a patch, then exactly those paths are restored and those files removed. Never
 * `git clean`, never `reset --hard`. Every step after the snapshot is best-effort and
 * recorded on the returned record; nothing here throws.
 */
import { copyFile, mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getSafeLogger } from "@/logger";
import { tryParseLLMJson } from "@/utils/llm-json";
import type { AuditTarget } from "./audit";
import { _finishGitDeps } from "./commit";
import { isHandoffNote } from "./fix/handoff-note";
import type { FixBase, HandoffLimit, HandoffNote, HandoffRecord, UntrackedEntry, UntrackedSnapshot } from "./types";

export const UNTRACKED_FILE_MAX = 1_048_576;
export const UNTRACKED_TOTAL_MAX = 20_971_520;

export const _setAsideDeps = {
  remove: (path: string): Promise<void> => unlink(path),
  limits: { fileMax: UNTRACKED_FILE_MAX, totalMax: UNTRACKED_TOTAL_MAX },
};

async function copyInto(src: string, dest: string): Promise<boolean> {
  try {
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
    return true;
  } catch {
    return false; // a missing source (the session deleted the file) is not an error here
  }
}

/**
 * Spec §4.1: copy pre-existing untracked, non-ignored files (as listed by `git status`,
 * so ignored files such as node_modules are never included) into `dir`, within
 * `_setAsideDeps.limits`. Every file is recorded with its size and mtime, so a change
 * is detectable even when it was too big to copy.
 */
export async function snapshotUntracked(workdir: string, paths: string[], dir: string): Promise<UntrackedSnapshot> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  const { fileMax, totalMax } = _setAsideDeps.limits;
  const files: UntrackedEntry[] = [];
  let total = 0;
  for (const path of paths) {
    const st = await stat(join(workdir, path)).catch(() => null);
    if (!st?.isFile()) continue;
    const fits = st.size <= fileMax && total + st.size <= totalMax;
    const saved = fits && (await copyInto(join(workdir, path), join(dir, path)));
    if (saved) total += st.size;
    files.push({ path, size: st.size, mtimeMs: st.mtimeMs, saved });
  }
  return { dir, files };
}

async function changedSince(workdir: string, e: UntrackedEntry): Promise<boolean> {
  const st = await stat(join(workdir, e.path)).catch(() => null);
  return !st || st.size !== e.size || st.mtimeMs !== e.mtimeMs;
}

/**
 * Spec §4.2 step 5: a pre-existing untracked file the session changed keeps its edit in
 * `<handoff>/untracked-modified/` and is put back from the snapshot. Without a snapshot
 * (over the cap) it is moved into the handoff instead, so `git add -A` can never commit
 * the half-edit.
 */
export async function restoreUntracked(
  workdir: string,
  snapshot: UntrackedSnapshot | undefined,
  handoffPath: string,
): Promise<{ restored: string[]; movedAside: string[] }> {
  const restored: string[] = [];
  const movedAside: string[] = [];
  for (const e of snapshot?.files ?? []) {
    if (!(await changedSince(workdir, e))) continue;
    await copyInto(join(workdir, e.path), join(handoffPath, "untracked-modified", e.path));
    if (e.saved && (await copyInto(join(snapshot?.dir ?? "", e.path), join(workdir, e.path)))) {
      restored.push(e.path);
    } else {
      await _setAsideDeps.remove(join(workdir, e.path)).catch(() => undefined);
      movedAside.push(e.path);
    }
  }
  return { restored, movedAside };
}

const PATCH = "changes.patch";
const NOTE = "note.json";
const META = "meta.json";

const git = (args: string[], cwd: string) => _finishGitDeps.git(args, cwd);
const lines = (s: string): string[] =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

export function handoffDir(audit: AuditTarget, n: number): string {
  return join(audit.auditDir, `${audit.runId}.handoff-${n}`);
}

async function untracked(workdir: string): Promise<string[]> {
  const res = await git(["status", "--porcelain=v1", "-uall"], workdir);
  if (res.exitCode !== 0) return [];
  return res.stdout
    .split("\n")
    .filter((l) => l.startsWith("?? "))
    .map((l) => l.slice(3).trim());
}

/**
 * Null (the step must fail, spec §4.1) when HEAD cannot be read, or when the tree has
 * tracked changes and `git stash create` could not snapshot them: falling back to HEAD
 * then would overwrite those edits on restore.
 */
export async function captureFixBase(workdir: string): Promise<FixBase | null> {
  const head = await git(["rev-parse", "HEAD"], workdir);
  if (head.exitCode !== 0) return null;
  const headSha = head.stdout.trim();
  const stash = await git(["stash", "create"], workdir);
  const snapshot = stash.exitCode === 0 ? stash.stdout.trim() : "";
  if (snapshot === "") {
    const tracked = await git(["diff", "--name-only", "HEAD"], workdir);
    if (tracked.exitCode !== 0 || tracked.stdout.trim() !== "") return null;
  }
  return { baseSha: snapshot || headSha, headSha, untrackedBefore: await untracked(workdir) };
}

async function savePatch(workdir: string, dir: string, baseSha: string, created: string[]): Promise<boolean> {
  if (created.length > 0) await git(["add", "-N", "--", ...created], workdir);
  const diff = await git(["diff", "--binary", baseSha], workdir);
  if (created.length > 0) await git(["reset", "-q", "--", ...created], workdir);
  if (diff.exitCode !== 0) return false;
  await writeFile(join(dir, PATCH), diff.stdout, "utf8");
  return true;
}

/** Paths the base knows are restored from it; paths it does not know (the session `git add`ed them) are unstaged and removed. */
async function restorePaths(workdir: string, baseSha: string, tracked: string[], created: string[]): Promise<boolean> {
  const inBase: string[] = [];
  const added: string[] = [];
  for (const path of tracked) {
    const known = await git(["cat-file", "-e", `${baseSha}:${path}`], workdir);
    (known.exitCode === 0 ? inBase : added).push(path);
  }
  let ok = true;
  if (inBase.length > 0) {
    const res = await git(["restore", `--source=${baseSha}`, "--staged", "--worktree", "--", ...inBase], workdir);
    ok = res.exitCode === 0;
  }
  if (added.length > 0) await git(["rm", "-q", "--cached", "--ignore-unmatch", "--", ...added], workdir);
  for (const path of [...added, ...created]) await _setAsideDeps.remove(join(workdir, path)).catch(() => undefined);
  return ok;
}

async function writeMeta(record: HandoffRecord): Promise<void> {
  await writeFile(join(record.dir, META), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

function warn(message: string, err: unknown): void {
  getSafeLogger()?.warn("finish", message, { storyId: "_run", error: errorMessage(err) });
}

export async function setAside(args: {
  workdir: string;
  audit: AuditTarget;
  n: number;
  base: FixBase;
  phase: HandoffRecord["phase"];
  limit: HandoffLimit;
  findingIds: string[];
  note?: HandoffNote;
  now: () => string;
}): Promise<HandoffRecord> {
  const dir = handoffDir(args.audit, args.n);
  const before = new Set(args.base.untrackedBefore);
  const created = (await untracked(args.workdir)).filter((p) => !before.has(p));
  const changed = await git(["diff", "--name-only", args.base.baseSha], args.workdir);
  const changedPaths = changed.exitCode === 0 ? lines(changed.stdout) : [];
  const record: HandoffRecord = {
    n: args.n,
    dir,
    phase: args.phase,
    limit: args.limit,
    baseSha: args.base.baseSha,
    headSha: args.base.headSha,
    findingIds: args.findingIds,
    newUntracked: created,
    changedPaths,
    stoppedAt: args.now(),
    hasNote: false,
    patchSaved: false,
    restored: false,
    consumed: false,
    untrackedRestored: [],
    untrackedMovedAside: [],
  };
  try {
    await mkdir(dir, { recursive: true });
    if (args.note) {
      await writeFile(join(dir, NOTE), `${JSON.stringify(args.note, null, 2)}\n`, "utf8");
      record.hasNote = true;
    }
    record.patchSaved = await savePatch(args.workdir, dir, args.base.baseSha, created);
  } catch (err) {
    warn("Set-aside could not save the stopped session's work", err);
  }
  record.restored = await restorePaths(args.workdir, args.base.baseSha, changedPaths, created).catch((err) => {
    warn("Set-aside could not restore the worktree", err);
    return false;
  });
  const untrackedOut = await restoreUntracked(args.workdir, args.base.untrackedSnapshot, dir).catch((err) => {
    warn("Set-aside could not restore pre-existing untracked files", err);
    return { restored: [], movedAside: [] };
  });
  record.untrackedRestored = untrackedOut.restored;
  record.untrackedMovedAside = untrackedOut.movedAside;
  await writeMeta(record).catch((err) => warn("Set-aside could not write meta.json", err));
  return record;
}

export async function readHandoffNote(record: HandoffRecord): Promise<HandoffNote | undefined> {
  if (!record.hasNote) return undefined;
  const text = await readFile(join(record.dir, NOTE), "utf8").catch(() => null);
  const parsed = text ? tryParseLLMJson<unknown>(text) : null;
  return isHandoffNote(parsed) ? parsed : undefined;
}

/** All-or-nothing: `git apply --check` first; on any failure nothing is touched. */
export async function reapplyHandoff(
  workdir: string,
  record: HandoffRecord,
): Promise<{ applied: boolean; files: string[] }> {
  if (!record.patchSaved) return { applied: false, files: [] };
  const patch = join(record.dir, PATCH);
  const check = await git(["apply", "--check", "--whitespace=nowarn", patch], workdir);
  if (check.exitCode !== 0) return { applied: false, files: [] };
  const apply = await git(["apply", "--whitespace=nowarn", patch], workdir);
  if (apply.exitCode !== 0) return { applied: false, files: [] };
  const stat = await git(["apply", "--numstat", patch], workdir);
  const files = lines(stat.stdout)
    .map((l) => l.split("\t")[2] ?? "")
    .filter(Boolean);
  return { applied: true, files };
}

export async function markHandoffConsumed(record: HandoffRecord): Promise<HandoffRecord> {
  const next = { ...record, consumed: true };
  await writeMeta(next).catch((err) => warn("Set-aside could not update meta.json", err));
  return next;
}
