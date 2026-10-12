/**
 * Finish A §4: a stopped (or crashed) fix session's edits are set aside, never committed.
 *
 * The base is `git stash create` (a commit object of the current tree that moves no ref
 * and leaves the stash list alone) or HEAD when the tree is clean. Pre-existing tracked
 * edits are therefore part of the base and are never overwritten. On set-aside the
 * session's changes (tracked diff against the base, plus files it created) are saved
 * as a patch, then exactly those paths are restored and those files removed. Never
 * `git clean`, never `reset --hard`. Every step after the snapshot is best-effort and
 * recorded on the returned record (`restored: false` whenever a read or restore failed);
 * nothing here throws.
 */
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getSafeLogger } from "@/logger";
import { tryParseLLMJson } from "@/utils/llm-json";
import type { AuditTarget } from "./audit";
import { isHandoffNote } from "./fix";
import { insideRoot } from "./safe-path";
import { chunks, gitLiteral, listBaseTree, listChanged, listUntracked, numstatPaths, repoRoot } from "./set-aside-git";
import type { FixBase, HandoffLimit, HandoffNote, HandoffRecord } from "./types";
import { _setAsideDeps, restoreUntracked } from "./untracked-snapshot";

export {
  _setAsideDeps,
  restoreUntracked,
  snapshotUntracked,
  UNTRACKED_FILE_MAX,
  UNTRACKED_TOTAL_MAX,
} from "./untracked-snapshot";

const PATCH = "changes.patch";
const NOTE = "note.json";
const META = "meta.json";

const git = gitLiteral;

export function handoffDir(audit: AuditTarget, n: number): string {
  return join(audit.auditDir, `${audit.runId}.handoff-${n}`);
}

function warn(message: string, err: unknown): void {
  getSafeLogger()?.warn("finish", message, { storyId: "_run", error: errorMessage(err) });
}

/**
 * Null (the step must fail, spec §4.1) when HEAD cannot be read, or when the tree has
 * tracked changes and `git stash create` could not snapshot them: falling back to HEAD
 * then would overwrite those edits on restore.
 */
export async function captureFixBase(workdir: string): Promise<FixBase | null> {
  const root = await repoRoot(workdir);
  const head = await git(["rev-parse", "HEAD"], root);
  if (head.exitCode !== 0) return null;
  const headSha = head.stdout.trim();
  const stash = await git(["stash", "create"], root);
  const snapshot = stash.exitCode === 0 ? stash.stdout.trim() : "";
  if (snapshot === "") {
    const tracked = await git(["diff", "--name-only", "HEAD"], root);
    if (tracked.exitCode !== 0 || tracked.stdout.trim() !== "") return null;
  }
  const untrackedBefore = await listUntracked(root);
  if (untrackedBefore === null) return null;
  return { baseSha: snapshot || headSha, headSha, untrackedBefore };
}

async function addIntent(root: string, created: string[]): Promise<void> {
  for (const group of chunks(created)) await git(["add", "-N", "--", ...group], root);
}

async function dropIntent(root: string, created: string[]): Promise<void> {
  for (const group of chunks(created)) await git(["reset", "-q", "--", ...group], root);
}

/** git writes the patch itself (`--output`), so its bytes are never decoded as text. */
async function savePatch(root: string, dir: string, baseSha: string, created: string[]): Promise<boolean> {
  await addIntent(root, created);
  try {
    const diff = await git(["diff", "--binary", "--no-renames", `--output=${join(dir, PATCH)}`, baseSha], root);
    return diff.exitCode === 0;
  } finally {
    await dropIntent(root, created).catch(() => undefined);
  }
}

async function restoreKnown(root: string, baseSha: string, inBase: string[]): Promise<boolean> {
  let ok = true;
  for (const group of chunks(inBase)) {
    const res = await git(["restore", `--source=${baseSha}`, "--staged", "--worktree", "--", ...group], root);
    ok = ok && res.exitCode === 0;
  }
  return ok;
}

/** Removes one entry (a file or the symlink itself, never a symlink's target) after checking its parent is still inside the root. */
async function removeEntry(root: string, rel: string): Promise<boolean> {
  const file = join(root, rel);
  if (!(await insideRoot(root, file))) return false;
  if (!(await lstat(file).catch(() => null))) return true;
  return _setAsideDeps.remove(file).then(
    () => true,
    () => false,
  );
}

/**
 * Paths the base knows are restored from it; paths it does not know (the session `git add`ed them)
 * are unstaged and removed. A pre-existing untracked file is only unstaged here: it is never deleted
 * without a kept copy, so `restoreUntracked` decides its fate.
 */
async function restorePaths(root: string, base: FixBase, tracked: string[], created: string[]): Promise<boolean> {
  const known = await listBaseTree(root, base.baseSha);
  if (known === null) return false; // cannot tell which paths the base has: touch nothing
  const preexisting = new Set(base.untrackedBefore);
  const inBase = tracked.filter((p) => known.has(p));
  const added = tracked.filter((p) => !known.has(p));
  let ok = await restoreKnown(root, base.baseSha, inBase);
  for (const group of chunks(added)) await git(["rm", "-q", "--cached", "--ignore-unmatch", "--", ...group], root);
  for (const path of [...added.filter((p) => !preexisting.has(p)), ...created]) {
    ok = (await removeEntry(root, path)) && ok;
  }
  return ok;
}

async function writeMeta(record: HandoffRecord): Promise<void> {
  await writeFile(join(record.dir, META), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

interface SetAsideArgs {
  workdir: string;
  audit: AuditTarget;
  n: number;
  base: FixBase;
  phase: HandoffRecord["phase"];
  limit: HandoffLimit;
  findingIds: string[];
  note?: HandoffNote;
  now: () => string;
}

function newRecord(args: SetAsideArgs, dir: string, created: string[], changedPaths: string[]): HandoffRecord {
  return {
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
    untrackedFailed: [],
  };
}

async function saveWork(args: SetAsideArgs, root: string, record: HandoffRecord): Promise<void> {
  try {
    await mkdir(record.dir, { recursive: true });
    if (args.note) {
      await writeFile(join(record.dir, NOTE), `${JSON.stringify(args.note, null, 2)}\n`, "utf8");
      record.hasNote = true;
    }
    record.patchSaved = await savePatch(root, record.dir, args.base.baseSha, record.newUntracked);
  } catch (err) {
    warn("Set-aside could not save the stopped session's work", err);
  }
}

export async function setAside(args: SetAsideArgs): Promise<HandoffRecord> {
  const dir = handoffDir(args.audit, args.n);
  const root = await repoRoot(args.workdir);
  const before = new Set(args.base.untrackedBefore);
  const untracked = await listUntracked(root);
  const changed = await listChanged(root, args.base.baseSha);
  const created = (untracked ?? []).filter((p) => !before.has(p));
  const record = newRecord(args, dir, created, changed ?? []);
  await saveWork(args, root, record);
  const pathsRestored = await restorePaths(root, args.base, record.changedPaths, created).catch((err) => {
    warn("Set-aside could not restore the worktree", err);
    return false;
  });
  const out = await restoreUntracked(args.workdir, args.base.untrackedSnapshot, dir).catch((err) => {
    warn("Set-aside could not restore pre-existing untracked files", err);
    return { restored: [], movedAside: [], failed: ["(restore error)"] };
  });
  record.untrackedRestored = out.restored;
  record.untrackedMovedAside = out.movedAside;
  record.untrackedFailed = out.failed;
  record.restored = pathsRestored && untracked !== null && changed !== null && out.failed.length === 0;
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
  const root = await repoRoot(workdir);
  const patch = join(record.dir, PATCH);
  const check = await git(["apply", "--check", "--whitespace=nowarn", patch], root);
  if (check.exitCode !== 0) return { applied: false, files: [] };
  const apply = await git(["apply", "--whitespace=nowarn", patch], root);
  if (apply.exitCode !== 0) {
    warn("Set-aside re-apply failed after a clean check", apply.stderr.trim());
    return { applied: false, files: [] };
  }
  const stat = await git(["apply", "--numstat", "-z", patch], root);
  return { applied: true, files: numstatPaths(stat.stdout) };
}

export async function markHandoffConsumed(record: HandoffRecord): Promise<HandoffRecord> {
  const next = { ...record, consumed: true };
  await writeMeta(next).catch((err) => warn("Set-aside could not update meta.json", err));
  return next;
}

/** Record on disk whether the next attempt managed to re-apply this handoff. */
export async function markHandoffReapplied(record: HandoffRecord, reapplied: boolean): Promise<HandoffRecord> {
  const next = { ...record, reapplied };
  await writeMeta(next).catch((err) => warn("Set-aside could not update meta.json", err));
  return next;
}
