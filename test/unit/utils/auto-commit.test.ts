/**
 * Unit tests for autoCommitIfDirty
 *
 * Covers monorepo subdir guard: workdir = git root, workdir = subdir (monorepo), and unrelated dir.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _gitDeps, autoCommitIfDirty } from "../../../src/utils/git";
import { withDepsRestore } from "../../helpers/deps";

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
    stderr: new ReadableStream({ start(c) { c.close(); } }),
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
  const commands: string[][] = [];

  withDepsRestore(_gitDeps, ["spawn"]);
  beforeEach(() => {
    commands.length = 0;
  });

  test("commits when workdir is the git root", async () => {
    const gitRoot = "/repo";
    _gitDeps.spawn = mock((cmd: string[]) => {
      commands.push(cmd);
      if (cmd.includes("rev-parse")) return makeProc(gitRoot + "\n");
      if (cmd.includes("status")) return makeProc(" M src/foo.ts\n");
      return makeProc("");
    }) as typeof _gitDeps.spawn;

    await autoCommitIfDirty(gitRoot, "tdd", "implementer", "US-001");

    const addCmd = commands.find((c) => c.includes("add"));
    expect(addCmd).toBeDefined();
    expect(commands.some((c) => c.includes("commit"))).toBe(true);
  });

  test("commits using 'git add .' (not -A) when workdir is a monorepo package subdir", async () => {
    const gitRoot = "/repo";
    const workdir = "/repo/apps/cli";
    _gitDeps.spawn = mock((cmd: string[]) => {
      commands.push(cmd);
      if (cmd.includes("rev-parse")) return makeProc(gitRoot + "\n");
      if (cmd.includes("status")) return makeProc(" M src/config.ts\n");
      return makeProc("");
    }) as typeof _gitDeps.spawn;

    await autoCommitIfDirty(workdir, "tdd", "implementer", "US-004");

    const addCmd = commands.find((c) => c.includes("add"));
    expect(addCmd).toEqual(["git", "add", "."]);
    expect(commands.some((c) => c.includes("commit"))).toBe(true);
  });

  test("uses 'git add -A' when workdir is the repo root", async () => {
    const gitRoot = "/repo";
    _gitDeps.spawn = mock((cmd: string[]) => {
      commands.push(cmd);
      if (cmd.includes("rev-parse")) return makeProc(gitRoot + "\n");
      if (cmd.includes("status")) return makeProc(" M src/index.ts\n");
      return makeProc("");
    }) as typeof _gitDeps.spawn;

    await autoCommitIfDirty(gitRoot, "tdd", "test-writer", "US-001");

    const addCmd = commands.find((c) => c.includes("add"));
    expect(addCmd).toEqual(["git", "add", "-A"]);
  });

  test("skips commit when workdir is unrelated to git root", async () => {
    const gitRoot = "/other-repo";
    const workdir = "/my-project";
    _gitDeps.spawn = mock((cmd: string[]) => {
      commands.push(cmd);
      if (cmd.includes("rev-parse")) return makeProc(gitRoot + "\n");
      return makeProc("");
    }) as typeof _gitDeps.spawn;

    await autoCommitIfDirty(workdir, "tdd", "implementer", "US-001");

    expect(commands.some((c) => c.includes("commit"))).toBe(false);
  });

  test("skips commit when working tree is clean", async () => {
    const gitRoot = "/repo";
    _gitDeps.spawn = mock((cmd: string[]) => {
      commands.push(cmd);
      if (cmd.includes("rev-parse")) return makeProc(gitRoot + "\n");
      if (cmd.includes("status")) return makeProc(""); // clean
      return makeProc("");
    }) as typeof _gitDeps.spawn;

    await autoCommitIfDirty(gitRoot, "tdd", "implementer", "US-001");

    expect(commands.some((c) => c.includes("commit"))).toBe(false);
  });
});
