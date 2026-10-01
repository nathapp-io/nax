/**
 * restoreDeletedNaxPaths — best-effort restore of deleted/renamed `.nax/` paths
 * before the snapshot auto-commit stages the tree.
 *
 * Driven by a fake git runner so the exact commands can be asserted. The
 * HEAD-existence guard (#2303) is the behaviour under test: a path HEAD does
 * not hold has no nax state to protect, so it must never reach `git checkout`.
 */

import { describe, expect, test } from "bun:test";
import { makeLogger } from "@test/helpers";
import { type GitRunner, restoreDeletedNaxPaths } from "@/utils/nax-path-restore";

const ROOT = "/repo";

interface RunnerCall {
  args: string[];
  cwd: string;
}

/** Fake runner: `cat-file -e HEAD:<p>` succeeds only for paths in `inHead`; other commands exit `otherExit`. */
function makeRunner(inHead: readonly string[], otherExit = 0): { run: GitRunner; calls: RunnerCall[] } {
  const calls: RunnerCall[] = [];
  const run: GitRunner = async (args, cwd) => {
    calls.push({ args, cwd });
    if (args[0] === "cat-file") {
      const path = args[2].replace(/^HEAD:/, "");
      return { exitCode: inHead.includes(path) ? 0 : 128, stderr: "" };
    }
    return { exitCode: otherExit, stderr: otherExit === 0 ? "" : "boom" };
  };
  return { run, calls };
}

function ctx(run: GitRunner, logger = makeLogger()) {
  return { gitRoot: ROOT, run, logger, stage: "execution", role: "implementer", storyId: "US-001" };
}

const checkouts = (calls: RunnerCall[]) => calls.filter((c) => c.args[0] === "checkout").map((c) => c.args);

describe("restoreDeletedNaxPaths", () => {
  test("restores an unstaged deletion of a path that HEAD holds, from the index", async () => {
    const { run, calls } = makeRunner([".nax/features/f/prd.json"]);

    await restoreDeletedNaxPaths(" D .nax/features/f/prd.json\n", ctx(run));

    expect(checkouts(calls)).toEqual([["checkout", "--", ".nax/features/f/prd.json"]]);
    expect(calls.every((c) => c.cwd === ROOT)).toBe(true);
  });

  test("restores a staged deletion from HEAD", async () => {
    const { run, calls } = makeRunner([".nax/features/f/prd.json"]);

    await restoreDeletedNaxPaths("D  .nax/features/f/prd.json\n", ctx(run));

    expect(checkouts(calls)).toEqual([["checkout", "HEAD", "--", ".nax/features/f/prd.json"]]);
  });

  test("restores the OLD path of a rename", async () => {
    const { run, calls } = makeRunner([".nax/old.json"]);

    await restoreDeletedNaxPaths("R  .nax/old.json -> .nax/new.json\n", ctx(run));

    expect(checkouts(calls)).toEqual([["checkout", "HEAD", "--", ".nax/old.json"]]);
  });

  test("never checks out a path that HEAD does not hold, and says so at debug (#2303)", async () => {
    // A status combination the parser lets through but HEAD cannot satisfy: the
    // guard is the second line of defence behind the parser's `A` skip.
    const logger = makeLogger();
    const { run, calls } = makeRunner([]);

    await restoreDeletedNaxPaths(" D .nax/features/f/prd.json\n", ctx(run, logger));

    expect(checkouts(calls)).toEqual([]);
    const skip = logger.calls.find((c) => c.level === "debug");
    expect(skip?.data).toMatchObject({ path: ".nax/features/f/prd.json", storyId: "US-001", role: "implementer" });
    expect(logger.calls.some((c) => c.level === "error")).toBe(false);
  });

  test("fails open when the HEAD probe gives no answer (timeout-style exit), so the restore still runs", async () => {
    const run: GitRunner = async (args) => ({ exitCode: args[0] === "cat-file" ? 1 : 0, stderr: "" });
    const calls: string[][] = [];
    const spy: GitRunner = async (args, cwd) => {
      calls.push(args);
      return run(args, cwd);
    };

    await restoreDeletedNaxPaths(" D .nax/features/f/prd.json\n", ctx(spy));

    expect(calls.filter((c) => c[0] === "checkout")).toEqual([["checkout", "--", ".nax/features/f/prd.json"]]);
  });

  test("restores the paths HEAD holds and skips the ones it does not, in the same batch", async () => {
    const { run, calls } = makeRunner([".nax/keep.json"]);

    await restoreDeletedNaxPaths(" D .nax/gone.json\n D .nax/keep.json\n", ctx(run));

    expect(checkouts(calls)).toEqual([["checkout", "--", ".nax/keep.json"]]);
  });

  test("logs the restore at error level, and a failed checkout again with the exit code", async () => {
    const logger = makeLogger();
    const { run } = makeRunner([".nax/keep.json"], 1);

    await restoreDeletedNaxPaths(" D .nax/keep.json\n", ctx(run, logger));

    const errors = logger.calls.filter((c) => c.level === "error");
    expect(errors.map((c) => c.message)).toEqual([
      "Restoring deleted .nax/ path before auto-commit",
      "Failed to restore .nax/ path before auto-commit",
    ]);
    expect(errors[1].data).toMatchObject({ path: ".nax/keep.json", exitCode: 1, stderr: "boom", storyId: "US-001" });
  });

  test("does nothing for a status with no .nax/ deletions, and tolerates a missing logger", async () => {
    const { run, calls } = makeRunner([]);

    await restoreDeletedNaxPaths(" M src/a.ts\n?? new.ts\n", { ...ctx(run), logger: null });

    expect(calls).toEqual([]);
  });
});
