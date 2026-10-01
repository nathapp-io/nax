/**
 * Shared stub for the `_sessionTmpDeps` seam (`src/sandbox/session-tmp.ts`).
 *
 * US-001 resolves the run temp root's parent on every call from three host
 * facts: what `lstat("/tmp/nax")` reports, whether `access("/tmp/nax", …)`
 * succeeds, and the current uid. Every test that pins a resolved path has to
 * control all three at once, so that assignment lives here instead of being
 * copy-pasted per file.
 *
 * The deps object is PASSED IN rather than imported. `test/helpers/index.ts` is
 * loaded by almost every suite, so a static import of a src export that does
 * not exist yet would fail those suites at module load instead of failing the
 * one test that actually needs the seam.
 */

/** The three synchronous host calls `runTmpRoot` resolves its parent through. */
export interface SessionTmpDepsLike {
  lstat(path: string): { isDirectory(): boolean; isSymbolicLink(): boolean };
  access(path: string, mode: number): void;
  uid(): number;
}

/** What `lstat("/tmp/nax")` reports when it succeeds. */
export type NaxParentStat = "directory" | "symlink" | "file";

/** An errno a stubbed `lstat` / `access` can fail with. */
export type NaxParentFailure = "ENOENT" | "EACCES" | "ELOOP";

/** Either outcome of `lstat("/tmp/nax")`. */
export type NaxParentKind = NaxParentStat | NaxParentFailure;

/** The host facts a test pins. */
export interface SessionTmpHostFacts {
  /** What `lstat("/tmp/nax")` reports. Defaults to `"directory"`. */
  readonly parent?: NaxParentKind;
  /** When `"EACCES"`, `access("/tmp/nax", …)` throws. Defaults to `"ok"`. */
  readonly access?: "ok" | "EACCES";
  /** What `uid()` returns. Defaults to `501` — a plain non-root user id. */
  readonly uid?: number;
}

/** True for the errno members of {@link NaxParentKind}. */
function isFailure(kind: NaxParentKind): kind is NaxParentFailure {
  return kind === "ENOENT" || kind === "EACCES" || kind === "ELOOP";
}

/** An errno-shaped error, the shape `lstatSync` / `accessSync` actually raise. */
function errnoError(code: NaxParentFailure, syscall: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${syscall} '${path}'`), { code, syscall, path });
}

/**
 * Point `deps` at the given host facts for the current test.
 *
 * Pair with `withDepsRestore(_sessionTmpDeps)` in the enclosing `describe` so
 * the production values come back afterwards.
 */
export function stubSessionTmpDeps(deps: SessionTmpDepsLike, facts: SessionTmpHostFacts = {}): void {
  const parent = facts.parent ?? "directory";
  const access = facts.access ?? "ok";
  const uid = facts.uid ?? 501;

  deps.lstat = (path) => {
    if (isFailure(parent)) throw errnoError(parent, "lstat", path);
    return {
      isDirectory: () => parent === "directory",
      isSymbolicLink: () => parent === "symlink",
    };
  };
  deps.access = (path) => {
    if (access === "EACCES") throw errnoError("EACCES", "access", path);
  };
  deps.uid = () => uid;
}
