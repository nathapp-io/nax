/**
 * Unit tests for autoCommitIfDirty
 *
 * Covers monorepo subdir guard: workdir = git root, workdir = subdir (monorepo), and unrelated dir.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { _gitDeps, autoCommitIfDirty } from "@/utils/git";
import { withDepsRestore } from "@test/helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

type SpawnResult = {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  stdin: { write: () => number; end: () => void; flush: () => void };
  exited: Promise<number>;
  pid: number;
  kill: () => void;
};

function makeProc(stdout: string, exitCode = 0): SpawnResult {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(stdout);
  return {
    stdout: new ReadableStream({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    }),
    stderr: new ReadableStream({
      start(c) {
        c.close();
      },
    }),
    stdin: { write: () => 0, end: () => {}, flush: () => {} },
    exited: Promise.resolve(exitCode),
    pid: 1,
    kill: () => {},
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("autoCommitIfDirty", () => {
  const calls: { cmd: string[]; cwd?: string }[] = [];

  withDepsRestore(_gitDeps, ["spawn"]);
  beforeEach(() => {
    calls.length = 0;
  });

  test("commits when workdir is the git root", async () => {
    const gitRoot = "/repo";
    _gitDeps.spawn = mock((cmd: string[], opts?: { cwd?: string }) => {
      calls.push({ cmd, cwd: opts?.cwd });
      if (cmd.includes("rev-parse")) return makeProc(`${gitRoot}\n`);
      if (cmd.includes("status")) return makeProc(" M src/foo.ts\n");
      return makeProc("");
    }) as unknown as typeof _gitDeps.spawn;

    await autoCommitIfDirty(gitRoot, "tdd", "implementer", "US-001");

    const addCall = calls.find((c) => c.cmd.includes("add"));
    expect(addCall).toBeDefined();
    expect(calls.some((c) => c.cmd.includes("commit"))).toBe(true);
  });

  test("commits using 'git add -A' from gitRoot even when workdir is a monorepo package subdir", async () => {
    // Regression: previously used 'git add .' from packageDir, which silently
    // skipped files outside packageDir (e.g. monorepo root package.json after
    // 'bun add'), leaving them permanently dirty and causing false-positive
    // escalations in the review dirty-file check.
    const gitRoot = "/repo";
    const workdir = "/repo/apps/cli";
    _gitDeps.spawn = mock((cmd: string[], opts?: { cwd?: string }) => {
      calls.push({ cmd, cwd: opts?.cwd });
      if (cmd.includes("rev-parse")) return makeProc(`${gitRoot}\n`);
      if (cmd.includes("status")) return makeProc(" M src/config.ts\n");
      return makeProc("");
    }) as unknown as typeof _gitDeps.spawn;

    await autoCommitIfDirty(workdir, "tdd", "implementer", "US-004");

    const addCall = calls.find((c) => c.cmd.includes("add"));
    expect(addCall?.cmd).toEqual(["git", "add", "-A"]);
    expect(addCall?.cwd).toBe(gitRoot);
    expect(calls.some((c) => c.cmd.includes("commit"))).toBe(true);
  });

  test("uses 'git add -A' from gitRoot when workdir is the repo root", async () => {
    const gitRoot = "/repo";
    _gitDeps.spawn = mock((cmd: string[], opts?: { cwd?: string }) => {
      calls.push({ cmd, cwd: opts?.cwd });
      if (cmd.includes("rev-parse")) return makeProc(`${gitRoot}\n`);
      if (cmd.includes("status")) return makeProc(" M src/index.ts\n");
      return makeProc("");
    }) as unknown as typeof _gitDeps.spawn;

    await autoCommitIfDirty(gitRoot, "tdd", "test-writer", "US-001");

    const addCall = calls.find((c) => c.cmd.includes("add"));
    expect(addCall?.cmd).toEqual(["git", "add", "-A"]);
    expect(addCall?.cwd).toBe(gitRoot);
  });

  test("skips commit when workdir is unrelated to git root", async () => {
    const gitRoot = "/other-repo";
    const workdir = "/my-project";
    _gitDeps.spawn = mock((cmd: string[], opts?: { cwd?: string }) => {
      calls.push({ cmd, cwd: opts?.cwd });
      if (cmd.includes("rev-parse")) return makeProc(`${gitRoot}\n`);
      return makeProc("");
    }) as unknown as typeof _gitDeps.spawn;

    await autoCommitIfDirty(workdir, "tdd", "implementer", "US-001");

    expect(calls.some((c) => c.cmd.includes("commit"))).toBe(false);
  });

  test("skips commit when working tree is clean", async () => {
    const gitRoot = "/repo";
    _gitDeps.spawn = mock((cmd: string[], opts?: { cwd?: string }) => {
      calls.push({ cmd, cwd: opts?.cwd });
      if (cmd.includes("rev-parse")) return makeProc(`${gitRoot}\n`);
      if (cmd.includes("status")) return makeProc(""); // clean
      return makeProc("");
    }) as unknown as typeof _gitDeps.spawn;

    await autoCommitIfDirty(gitRoot, "tdd", "implementer", "US-001");

    expect(calls.some((c) => c.cmd.includes("commit"))).toBe(false);
  });

  // Issue 5 (#369): warn→debug when auto-committing after agent session
  test("logs at debug level (not warn) when auto-committing dirty files", async () => {
    const gitRoot = "/repo";
    _gitDeps.spawn = mock((cmd: string[], opts?: { cwd?: string }) => {
      calls.push({ cmd, cwd: opts?.cwd });
      if (cmd.includes("rev-parse")) return makeProc(`${gitRoot}\n`);
      if (cmd.includes("status")) return makeProc(" M src/foo.ts\n");
      return makeProc("");
    }) as unknown as typeof _gitDeps.spawn;

    let warnCalled = false;
    let debugCalled = false;
    const origGetSafeLogger = _gitDeps.getSafeLogger;
    _gitDeps.getSafeLogger = mock(() => ({
      warn: () => {
        warnCalled = true;
      },
      debug: () => {
        debugCalled = true;
      },
    })) as unknown as typeof _gitDeps.getSafeLogger;

    try {
      await autoCommitIfDirty(gitRoot, "tdd", "implementer", "US-001");
      expect(warnCalled).toBe(false);
      expect(debugCalled).toBe(true);
    } finally {
      _gitDeps.getSafeLogger = origGetSafeLogger;
    }
  });
});
