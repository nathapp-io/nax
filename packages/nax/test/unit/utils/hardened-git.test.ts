import { afterEach, describe, expect, test } from "bun:test";
import { symbolicHead } from "@/review/reviewer-guard/deps";
import type { SpawnResult } from "@/utils/bun-deps";
import { _hardenedGitDeps, HARDENED_GIT_TIMEOUT_EXIT, runHardenedGit } from "@/utils/hardened-git";

const realSpawn = _hardenedGitDeps.spawn;
const realTimeout = _hardenedGitDeps.timeoutMs;
afterEach(() => {
  _hardenedGitDeps.spawn = realSpawn;
  _hardenedGitDeps.timeoutMs = realTimeout;
});

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.close();
    },
  });
}

/** A git that never exits until it is killed. */
function hangingSpawn(): (cmd: string[]) => SpawnResult {
  return () => {
    let release: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
      release = resolve;
    });
    return { stdout: emptyStream(), stderr: emptyStream(), exited, pid: 1, kill: () => release(137) };
  };
}

describe("runHardenedGit timeout", () => {
  test("a timed-out git reports the distinct timeout exit code and timedOut", async () => {
    _hardenedGitDeps.spawn = hangingSpawn();
    _hardenedGitDeps.timeoutMs = 5;
    const r = await runHardenedGit(["status"], "/tmp");
    expect(r.exitCode).toBe(HARDENED_GIT_TIMEOUT_EXIT);
    expect(r.exitCode).not.toBe(1);
    expect(r.timedOut).toBe(true);
    expect(r.stderr).toContain("timed out");
  });

  test("symbolicHead throws on a timed-out git instead of reporting a detached HEAD", async () => {
    _hardenedGitDeps.spawn = hangingSpawn();
    _hardenedGitDeps.timeoutMs = 5;
    await expect(symbolicHead("/tmp")).rejects.toThrow(/timed out/);
  });
});
