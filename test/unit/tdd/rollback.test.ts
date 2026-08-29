/**
 * Tests for rollbackToRef (BUG-07: snapshot-diff clean).
 *
 * `git clean -fd` deletes every untracked file in the workdir, including ones
 * that predate the phase being rolled back (the user's `.env`, WIP notes).
 * rollbackToRef now deletes only the untracked paths that appeared SINCE the
 * `untrackedBefore` snapshot was captured — diffing two `getUntrackedPaths()`
 * calls instead of shelling out to `git clean`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { assertCaughtInstanceOf, assertNaxError, makeSpawn, makeSpawnResult } from "@test/helpers";
import { _rollbackDeps, captureSnapshotRef, rollbackToRef } from "@/tdd/rollback";
import { byCodePoint } from "@/utils/sort";

function makeResetSpawn(exitCode = 0) {
  return makeSpawn(() => ({ exitCode })).spawn;
}

describe("rollbackToRef", () => {
  let origSpawn: typeof _rollbackDeps.spawn;
  let origGetUntrackedPaths: typeof _rollbackDeps.getUntrackedPaths;
  let origGetGitRoot: typeof _rollbackDeps.getGitRoot;
  let origRm: typeof _rollbackDeps.rm;

  beforeEach(() => {
    origSpawn = _rollbackDeps.spawn;
    origGetUntrackedPaths = _rollbackDeps.getUntrackedPaths;
    origGetGitRoot = _rollbackDeps.getGitRoot;
    origRm = _rollbackDeps.rm;
    _rollbackDeps.getGitRoot = async () => "/repo";
  });

  afterEach(() => {
    _rollbackDeps.spawn = origSpawn;
    _rollbackDeps.getUntrackedPaths = origGetUntrackedPaths;
    _rollbackDeps.getGitRoot = origGetGitRoot;
    _rollbackDeps.rm = origRm;
  });

  test("deletes only untracked paths that appeared since the snapshot", async () => {
    _rollbackDeps.spawn = makeResetSpawn(0);
    _rollbackDeps.getUntrackedPaths = async () => ["stray-agent-file.ts", "scratch/notes.md"];
    const removed: string[] = [];
    _rollbackDeps.rm = (async (path: string) => {
      removed.push(path);
    }) as typeof _rollbackDeps.rm;

    await rollbackToRef("/repo", "HEAD~1", []);

    expect(removed.sort(byCodePoint)).toEqual(
      ["/repo/scratch/notes.md", "/repo/stray-agent-file.ts"].sort(byCodePoint),
    );
  });

  test("leaves pre-existing untracked paths alone (the .env case)", async () => {
    _rollbackDeps.spawn = makeResetSpawn(0);
    // ".env" was untracked at snapshot time AND is still untracked after reset —
    // reset --hard never touches untracked files, so it appears in both lists.
    _rollbackDeps.getUntrackedPaths = async () => [".env", "agent-created.ts"];
    const removed: string[] = [];
    _rollbackDeps.rm = (async (path: string) => {
      removed.push(path);
    }) as typeof _rollbackDeps.rm;

    await rollbackToRef("/repo", "HEAD~1", [".env"]);

    expect(removed).toEqual(["/repo/agent-created.ts"]);
  });

  test("deletes nothing when every untracked path predates the snapshot", async () => {
    _rollbackDeps.spawn = makeResetSpawn(0);
    _rollbackDeps.getUntrackedPaths = async () => [".env", "notes.md"];
    const removed: string[] = [];
    _rollbackDeps.rm = (async (path: string) => {
      removed.push(path);
    }) as typeof _rollbackDeps.rm;

    await rollbackToRef("/repo", "HEAD~1", [".env", "notes.md"]);

    expect(removed).toEqual([]);
  });

  test("a failed deletion is logged and does not stop the other deletions", async () => {
    _rollbackDeps.spawn = makeResetSpawn(0);
    _rollbackDeps.getUntrackedPaths = async () => ["a.ts", "b.ts"];
    const removed: string[] = [];
    _rollbackDeps.rm = (async (path: string) => {
      if (path.endsWith("a.ts")) throw new Error("EACCES");
      removed.push(path);
    }) as typeof _rollbackDeps.rm;

    await rollbackToRef("/repo", "HEAD~1", []);

    expect(removed).toEqual(["/repo/b.ts"]);
  });

  test("throws when git reset --hard fails", async () => {
    _rollbackDeps.spawn = makeResetSpawn(128);
    let getUntrackedCalled = false;
    _rollbackDeps.getUntrackedPaths = async () => {
      getUntrackedCalled = true;
      return [];
    };

    let thrown: unknown;
    try {
      await rollbackToRef("/repo", "HEAD~1", []);
    } catch (err) {
      thrown = err;
    }
    assertCaughtInstanceOf(thrown, Error, "rollbackToRef rejection");
    // Cleanup never runs after a failed reset.
    expect(getUntrackedCalled).toBe(false);
  });

  test("skips untracked cleanup entirely when the baseline snapshot is null (unknown, not empty)", async () => {
    _rollbackDeps.spawn = makeResetSpawn(0);
    let getUntrackedNowCalled = false;
    _rollbackDeps.getUntrackedPaths = async () => {
      getUntrackedNowCalled = true;
      return ["should-not-be-considered.ts"];
    };
    const removed: string[] = [];
    _rollbackDeps.rm = (async (path: string) => {
      removed.push(path);
    }) as typeof _rollbackDeps.rm;

    // null baseline: the pre-phase snapshot failed — an unknown baseline must
    // never be treated as "nothing pre-existed" (that would delete real files).
    await rollbackToRef("/repo", "HEAD~1", null);

    expect(removed).toEqual([]);
    // The reset still runs to completion — only the untracked sweep is skipped,
    // and it's skipped before even reading the post-reset state.
    expect(getUntrackedNowCalled).toBe(false);
  });

  test("skips untracked cleanup when the post-reset untracked read fails", async () => {
    _rollbackDeps.spawn = makeResetSpawn(0);
    _rollbackDeps.getUntrackedPaths = async () => null;
    const removed: string[] = [];
    _rollbackDeps.rm = (async (path: string) => {
      removed.push(path);
    }) as typeof _rollbackDeps.rm;

    await rollbackToRef("/repo", "HEAD~1", []);

    expect(removed).toEqual([]);
  });

  test("resolves untracked paths against the real git root, not workdir, in a monorepo subdirectory", async () => {
    _rollbackDeps.spawn = makeResetSpawn(0);
    _rollbackDeps.getUntrackedPaths = async () => ["pkg/app/stray-agent-file.ts"];
    _rollbackDeps.getGitRoot = async () => "/repo";
    const removed: string[] = [];
    _rollbackDeps.rm = (async (path: string) => {
      removed.push(path);
    }) as typeof _rollbackDeps.rm;

    // workdir is a package subdirectory; porcelain paths (from getGitRoot) are root-relative.
    await rollbackToRef("/repo/pkg/app", "HEAD~1", []);

    expect(removed).toEqual(["/repo/pkg/app/stray-agent-file.ts"]);
  });

  test("falls back to workdir when getGitRoot cannot determine the repo root", async () => {
    _rollbackDeps.spawn = makeResetSpawn(0);
    _rollbackDeps.getUntrackedPaths = async () => ["stray.ts"];
    _rollbackDeps.getGitRoot = async () => null;
    const removed: string[] = [];
    _rollbackDeps.rm = (async (path: string) => {
      removed.push(path);
    }) as typeof _rollbackDeps.rm;

    await rollbackToRef("/repo", "HEAD~1", []);

    expect(removed).toEqual(["/repo/stray.ts"]);
  });
});

// ---------------------------------------------------------------------------
// Subprocess-deadline tests — a wedged `git reset --hard` or `git rev-parse
// HEAD` must not leave rollbackToRef / captureSnapshotRef pending. They mirror
// the established SIGKILL-after-timeout pattern from gitWithTimeout /
// _isolationDeps: armed timer → killProcessGroup(proc.pid, "SIGKILL") on
// expiry → caller settles.
// ---------------------------------------------------------------------------

describe("rollbackToRef — bounded `git reset --hard` (hang-path)", () => {
  let origSpawn: typeof _rollbackDeps.spawn;
  let origGetUntrackedPaths: typeof _rollbackDeps.getUntrackedPaths;
  let origTimeoutMs: typeof _rollbackDeps.timeoutMs;
  let origKillProcessGroup: typeof _rollbackDeps.killProcessGroup;
  let killedPid: number | undefined;
  let killedSignal: NodeJS.Signals | number | undefined;

  beforeEach(() => {
    origSpawn = _rollbackDeps.spawn;
    origGetUntrackedPaths = _rollbackDeps.getUntrackedPaths;
    origTimeoutMs = _rollbackDeps.timeoutMs;
    origKillProcessGroup = _rollbackDeps.killProcessGroup;
    killedPid = undefined;
    killedSignal = undefined;
  });

  afterEach(() => {
    _rollbackDeps.spawn = origSpawn;
    _rollbackDeps.getUntrackedPaths = origGetUntrackedPaths;
    _rollbackDeps.timeoutMs = origTimeoutMs;
    _rollbackDeps.killProcessGroup = origKillProcessGroup;
  });

  test("rejects rather than remaining pending when `git reset --hard` never exits", async () => {
    _rollbackDeps.timeoutMs = 50;
    const proc = makeSpawnResult({ hang: true, pid: 7777, killResolvesExited: true });
    _rollbackDeps.spawn = makeSpawn(() => proc).spawn;
    _rollbackDeps.killProcessGroup = ((pid, signal) => {
      killedPid = pid;
      killedSignal = signal;
      // Simulate the OS reaping the process once its group is killed —
      // `proc.exited` resolves via `killResolvesExited`, mirroring
      // worktree/dependencies.test.ts.
      proc.kill();
      return true;
    }) as typeof _rollbackDeps.killProcessGroup;

    let thrown: unknown;
    try {
      await rollbackToRef("/repo", "HEAD~1", null);
    } catch (err) {
      thrown = err;
    }
    assertCaughtInstanceOf(thrown, Error, "rollbackToRef rejection on hang");
    // Message must name the rollback failure — caller-facing diagnostic.
    expect((thrown as Error).message).toMatch(/rollback/i);
    // The hung child must be killed via the process group (matches
    // verification/executor.ts and worktree/dependencies.ts).
    expect(killedPid).toBe(7777);
    expect(killedSignal).toBe("SIGKILL");
  });

  test("does not invoke untracked cleanup when the reset hung (the reset already failed)", async () => {
    _rollbackDeps.timeoutMs = 50;
    let getUntrackedCalled = false;
    const proc = makeSpawnResult({ hang: true, pid: 7778, killResolvesExited: true });
    _rollbackDeps.spawn = makeSpawn(() => proc).spawn;
    _rollbackDeps.killProcessGroup = (() => {
      proc.kill();
      return true;
    }) as typeof _rollbackDeps.killProcessGroup;
    _rollbackDeps.getUntrackedPaths = async () => {
      getUntrackedCalled = true;
      return [];
    };

    try {
      await rollbackToRef("/repo", "HEAD~1", []);
    } catch {
      // Expected — the rejection itself is what the test above asserts on.
    }

    expect(getUntrackedCalled).toBe(false);
  });
});

describe("captureSnapshotRef — bounded `git rev-parse HEAD` (hang-path)", () => {
  let origSpawn: typeof _rollbackDeps.spawn;
  let origTimeoutMs: typeof _rollbackDeps.timeoutMs;
  let origKillProcessGroup: typeof _rollbackDeps.killProcessGroup;
  let killedPid: number | undefined;

  beforeEach(() => {
    origSpawn = _rollbackDeps.spawn;
    origTimeoutMs = _rollbackDeps.timeoutMs;
    origKillProcessGroup = _rollbackDeps.killProcessGroup;
    killedPid = undefined;
  });

  afterEach(() => {
    _rollbackDeps.spawn = origSpawn;
    _rollbackDeps.timeoutMs = origTimeoutMs;
    _rollbackDeps.killProcessGroup = origKillProcessGroup;
  });

  test("rejects with NaxError code SNAPSHOT_REF_FAILED when `git rev-parse HEAD` never exits", async () => {
    _rollbackDeps.timeoutMs = 50;
    const proc = makeSpawnResult({ hang: true, pid: 8888, killResolvesExited: true });
    _rollbackDeps.spawn = makeSpawn(() => proc).spawn;
    _rollbackDeps.killProcessGroup = ((pid) => {
      killedPid = pid;
      proc.kill();
      return true;
    }) as typeof _rollbackDeps.killProcessGroup;

    let thrown: unknown;
    try {
      await captureSnapshotRef("/repo", "US-001");
    } catch (err) {
      thrown = err;
    }
    assertNaxError(thrown, "captureSnapshotRef rejection on hang");
    expect((thrown as { code: string }).code).toBe("SNAPSHOT_REF_FAILED");
    expect(killedPid).toBe(8888);
  });
});
