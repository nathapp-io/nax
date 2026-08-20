// test/unit/tdd/capture-snapshot-ref.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _rollbackDeps, captureSnapshotRef } from "@/tdd/rollback";

describe("captureSnapshotRef", () => {
  let origAutoCommit: typeof _rollbackDeps.autoCommitIfDirty;
  let origSpawn: typeof _rollbackDeps.spawn;
  let origGetUntrackedPaths: typeof _rollbackDeps.getUntrackedPaths;

  beforeEach(() => {
    origAutoCommit = _rollbackDeps.autoCommitIfDirty;
    origSpawn = _rollbackDeps.spawn;
    origGetUntrackedPaths = _rollbackDeps.getUntrackedPaths;
  });

  afterEach(() => {
    _rollbackDeps.autoCommitIfDirty = origAutoCommit;
    _rollbackDeps.spawn = origSpawn;
    _rollbackDeps.getUntrackedPaths = origGetUntrackedPaths;
  });

  test("commits dirty state then returns HEAD sha plus the untracked-paths snapshot (BUG-07)", async () => {
    const calls: string[][] = [];
    _rollbackDeps.autoCommitIfDirty = async () => { calls.push(["autoCommitIfDirty"]); };
    _rollbackDeps.spawn = ((args: string[]) => {
      calls.push(args);
      return { stdout: new Response("cafebabecafebabecafebabecafebabecafebabe\n").body, exited: Promise.resolve(0) };
    }) as unknown as typeof Bun.spawn;
    _rollbackDeps.getUntrackedPaths = async () => {
      calls.push(["getUntrackedPaths"]);
      return [".env"];
    };

    const result = await captureSnapshotRef("/tmp/x", "us-001");
    expect(result.sha).toBe("cafebabecafebabecafebabecafebabecafebabe");
    expect(result.untrackedBefore).toEqual([".env"]);
    // commit BEFORE rev-parse, and the untracked snapshot is taken AFTER the
    // commit (so files the commit swept up don't leak into the baseline).
    expect(calls[0]).toEqual(["autoCommitIfDirty"]);
    expect(calls[1]).toEqual(["git", "rev-parse", "HEAD"]);
    expect(calls[2]).toEqual(["getUntrackedPaths"]);
  });

  test("throws NaxError when git rev-parse fails", async () => {
    _rollbackDeps.autoCommitIfDirty = async () => {};
    _rollbackDeps.spawn = (() => ({
      stdout: new Response("").body,
      exited: Promise.resolve(128),
    })) as unknown as typeof Bun.spawn;

    let threw = false;
    try {
      await captureSnapshotRef("/tmp/x", "us-001");
    } catch (err) {
      threw = true;
      expect((err as Error).message).toContain("non-blocking-fix snapshot");
    }
    expect(threw).toBe(true);
  });
});
