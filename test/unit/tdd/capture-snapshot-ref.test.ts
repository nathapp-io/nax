// test/unit/tdd/capture-snapshot-ref.test.ts
import { describe, expect, test } from "bun:test";
import { captureSnapshotRef } from "../../../src/tdd/rollback";

describe("captureSnapshotRef", () => {
  test("commits dirty state then returns HEAD sha", async () => {
    const calls: string[][] = [];
    const fakeCommit = async () => { calls.push(["autoCommitIfDirty"]); };
    const fakeSpawn = ((args: string[]) => {
      calls.push(args);
      return { stdout: new Response("cafebabecafebabecafebabecafebabecafebabe\n").body, exited: Promise.resolve(0) };
    }) as unknown as typeof Bun.spawn;
    const sha = await captureSnapshotRef("/tmp/x", "us-001", { autoCommitIfDirty: fakeCommit, spawn: fakeSpawn });
    expect(sha).toBe("cafebabecafebabecafebabecafebabecafebabe");
    expect(calls[0]).toEqual(["autoCommitIfDirty"]); // commit BEFORE rev-parse
    expect(calls[1]).toEqual(["git", "rev-parse", "HEAD"]);
  });
});
