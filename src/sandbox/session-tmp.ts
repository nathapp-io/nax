/**
 * Per-session temp directories under a run-owned root (US-004).
 *
 * A stray `/tmp/tsconfig.json` survived an NBF restore and turned a later
 * story's full-suite gate red. Launcher-driven Bash/Exec commands now run with
 * `TMPDIR`/`TMP`/`TEMP` pointing at `/tmp/nax-<runId>/<sessionName>`, which the
 * run deletes when it ends. The directory is a flat child of the run root, so
 * the run's own `runTmpRoot(runId)` is the only prefix a cleanup needs to
 * remove — never a `/tmp/nax-*` sweep, because a concurrent run's live
 * directories share that prefix.
 *
 * The root is the literal `/tmp` (not `os.tmpdir()`): callers record and assert
 * this machine-stable location, and the OS inherits the rest.
 */

const RUN_TMP_PARENT = "/tmp";

/** Any character outside `[A-Za-z0-9_-]` collapses to `_`, so a session part can never name a path. */
function sanitizePart(part: string): string {
  return part.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** `/tmp/nax-<runId>` — the per-run parent of every session temp directory. */
export function runTmpRoot(runId: string): string {
  return `${RUN_TMP_PARENT}/nax-${sanitizePart(runId)}`;
}

/** `/tmp/nax-<runId>/<sessionName>`, each part reduced to [A-Za-z0-9_-] (others become "_"). */
export function sessionTmpDir(runId: string, sessionName: string): string {
  return `${runTmpRoot(runId)}/${sanitizePart(sessionName)}`;
}
