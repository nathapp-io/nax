/**
 * Per-session temp directories under a run-owned root (US-001, US-004).
 *
 * A stray `/tmp/tsconfig.json` survived an NBF restore and turned a later
 * story's full-suite gate red. Launcher-driven Bash/Exec commands now run with
 * `TMPDIR`/`TMP`/`TEMP` pointing at `<parent>/<runId>/<sessionName>`, which the
 * run deletes when it ends. The directory is a flat child of the run root, so
 * the run's own `runTmpRoot(runId)` is the only prefix a cleanup needs to
 * remove — never a `/tmp/nax*` sweep, because a concurrent run's live
 * directories share that prefix.
 *
 * The parent is `/tmp/nax`, one shared directory that is easier to find and
 * list than a flat `/tmp/nax-<runId>`. It is shared, so it cannot be created
 * once and trusted: a `/tmp/nax` made by one OS user is not writable by
 * another. The parent is therefore re-resolved on EVERY call from three host
 * facts the `_sessionTmpDeps` seam exposes, with no cache, and anything nax
 * cannot vouch for falls back to a per-user `/tmp/nax-<uid>`.
 *
 * The root is the literal `/tmp` (not `os.tmpdir()`): callers record and assert
 * this machine-stable location, and the OS inherits the rest.
 */
import { accessSync, constants, lstatSync } from "node:fs";

/** The literal temp root both parents hang off. */
const TMP_ROOT = "/tmp";

/** The shared parent every resolvable case nests under; `mkdir -p` in the launcher creates it. */
const SHARED_TMP_PARENT = `${TMP_ROOT}/nax`;

/**
 * The three synchronous host calls {@link runTmpRoot} resolves its parent
 * through. Injectable so tests can pin a host (see docs/architecture/conventions.md §2).
 */
export const _sessionTmpDeps = {
  lstat: (path: string) => lstatSync(path),
  access: (path: string, mode: number): void => {
    accessSync(path, mode);
  },
  // `process.getuid` is POSIX-only and this module's `/tmp` paths already assume
  // POSIX; the fallback keeps the type total without claiming a real uid.
  uid: (): number => process.getuid?.() ?? 0,
};

/**
 * True when `/tmp/nax` is a real directory the current user can write and
 * search. Absence is NOT this case: an absent parent is a usable shared parent
 * (the launcher creates it), and every other failure means the path is there in
 * a shape nax cannot vouch for.
 */
function isUsableSharedParent(): boolean {
  try {
    const stats = _sessionTmpDeps.lstat(SHARED_TMP_PARENT);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
  } catch (err) {
    // ENOENT is the one failure that means "create /tmp/nax".
    return (err as NodeJS.ErrnoException).code === "ENOENT";
  }
  try {
    _sessionTmpDeps.access(SHARED_TMP_PARENT, constants.W_OK | constants.X_OK);
    return true;
  } catch {
    // Unwritable or unsearchable by this user: the fallback covers it, so the
    // errno carries no decision the caller does not already make.
    return false;
  }
}

/** `/tmp/nax` when the shared parent is usable, `/tmp/nax-<uid>` otherwise. */
function tmpParent(): string {
  return isUsableSharedParent() ? SHARED_TMP_PARENT : `${TMP_ROOT}/nax-${_sessionTmpDeps.uid()}`;
}

/**
 * Any character outside `[A-Za-z0-9_.-]` collapses to `_`, so a part can never
 * contain a separator. `.` survives because real run ids carry one (the
 * millisecond field of `buildRunId`'s ISO stamp), but a part that is nothing
 * BUT dots would name the parent — so it collapses to `_` as well.
 */
function sanitizePart(part: string): string {
  return part.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^\.+$/, "_");
}

/** `<parent>/<runId>` — the per-run parent of every session temp directory. */
export function runTmpRoot(runId: string): string {
  return `${tmpParent()}/${sanitizePart(runId)}`;
}

/**
 * `<root>/<sessionName>`, the session part reduced to [A-Za-z0-9_.-] (others
 * become "_"). Takes an ALREADY-RESOLVED run root so a caller that needs the
 * root too (the sandbox policy) resolves the parent once and cannot observe it
 * flip between two calls.
 */
export function sessionTmpDirUnder(root: string, sessionName: string): string {
  return `${root}/${sanitizePart(sessionName)}`;
}

/** `<parent>/<runId>/<sessionName>`, each part reduced to [A-Za-z0-9_.-] (others become "_"). */
export function sessionTmpDir(runId: string, sessionName: string): string {
  return sessionTmpDirUnder(runTmpRoot(runId), sessionName);
}
