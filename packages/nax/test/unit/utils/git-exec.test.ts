import { afterEach, describe, expect, test } from "bun:test";
import { gitExecModule as gitExec } from "@nathapp/nax-agent/internal";
import { makeSpawn } from "@test/helpers";
import * as gitModule from "@/utils/git";

describe("utils/git-exec", () => {
  const originalSpawn = gitExec._gitDeps.spawn;
  afterEach(() => {
    gitExec._gitDeps.spawn = originalSpawn;
  });

  test("git.ts re-exports the same _gitDeps object", () => {
    expect(gitModule._gitDeps).toBe(gitExec._gitDeps);
    expect(gitModule.gitWithTimeout).toBe(gitExec.gitWithTimeout);
    expect(gitModule.getGitRoot).toBe(gitExec.getGitRoot);
    expect(gitModule.GIT_TIMEOUT_MS).toBe(gitExec.GIT_TIMEOUT_MS);
  });

  test("a spawn patched through @/utils/git intercepts gitWithTimeout from @/utils/git-exec", async () => {
    const seen: string[][] = [];
    gitModule._gitDeps.spawn = makeSpawn(({ cmd }) => {
      seen.push(cmd);
      return "abc\n";
    }).spawn;

    const result = await gitExec.gitWithTimeout(["rev-parse", "HEAD"], "/tmp");
    expect(result).toEqual({ stdout: "abc\n", stderr: "", exitCode: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("rev-parse");
  });
});
