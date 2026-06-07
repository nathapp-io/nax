// test/unit/tdd/capture-snapshot-ref.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _rollbackDeps, captureSnapshotRef } from "../../../src/tdd/rollback";

describe("captureSnapshotRef", () => {
  let origAutoCommit: typeof _rollbackDeps.autoCommitIfDirty;
  let origSpawn: typeof _rollbackDeps.spawn;

  beforeEach(() => {
    origAutoCommit = _rollbackDeps.autoCommitIfDirty;
    origSpawn = _rollbackDeps.spawn;
  });

  afterEach(() => {
    _rollbackDeps.autoCommitIfDirty = origAutoCommit;
    _rollbackDeps.spawn = origSpawn;
  });

  test("commits dirty state then returns HEAD sha", async () => {
    const calls: string[][] = [];
    _rollbackDeps.autoCommitIfDirty = async () => { calls.push(["autoCommitIfDirty"]); };
    _rollbackDeps.spawn = ((args: string[]) => {
      calls.push(args);
      return { stdout: new Response("cafebabecafebabecafebabecafebabecafebabe\n").body, exited: Promise.resolve(0) };
    }) as unknown as typeof Bun.spawn;

    const sha = await captureSnapshotRef("/tmp/x", "us-001");
    expect(sha).toBe("cafebabecafebabecafebabecafebabecafebabe");
    expect(calls[0]).toEqual(["autoCommitIfDirty"]); // commit BEFORE rev-parse
    expect(calls[1]).toEqual(["git", "rev-parse", "HEAD"]);
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
