import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { _isolationDeps, getChangedFiles } from "@/tdd";
import { getAddedLinesPerFile } from "@/tdd/isolation";

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

describe("getChangedFiles", () => {
  let dir: string;

  beforeEach(async () => {
    dir = makeTempDir("nax-isolation-getchanged-");
    await Bun.write(`${dir}/tracked.txt`, "v1");
    await git(dir, ["init", "-q"]);
    await git(dir, ["config", "user.email", "t@t"]);
    await git(dir, ["config", "user.name", "t"]);
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-qm", "base"]);
  });

  afterEach(() => {
    cleanupTempDir(dir);
  });

  // BUG-34: `git diff --name-only` alone is blind to untracked files — a
  // TDD session's brand-new stub/test file must still show up so isolation
  // checks can catch it.
  test("includes untracked (new) files alongside tracked modifications", async () => {
    await Bun.write(`${dir}/tracked.txt`, "v2"); // modified — visible via git diff
    await Bun.write(`${dir}/brand-new.ts`, "export const x = 1;"); // untracked — the regression

    const changed = await getChangedFiles(dir, "HEAD");

    expect(new Set(changed)).toEqual(new Set(["tracked.txt", "brand-new.ts"]));
  });

  test("dedupes when a file appears in both diff and status output", async () => {
    await Bun.write(`${dir}/tracked.txt`, "v2");

    const changed = await getChangedFiles(dir, "HEAD");

    expect(changed.filter((f) => f === "tracked.txt")).toHaveLength(1);
  });

  test("returns only tracked changes when there are no untracked files", async () => {
    await Bun.write(`${dir}/tracked.txt`, "v2");

    const changed = await getChangedFiles(dir, "HEAD");

    expect(changed).toEqual(["tracked.txt"]);
  });
});

// BUG-31: a wedged git (NFS / lock contention) must not stall the TDD
// isolation stage indefinitely. `_isolationDeps.timeoutMs` is injected short
// here (mirrors `_gitDeps.timeoutRetryGitTimeoutMs` in `src/utils/git.ts`) so
// this test asserts the SIGKILL contract without burning the full 10s
// production timeout in wall-clock.
describe("runGitBounded (via getChangedFiles / getAddedLinesPerFile)", () => {
  let origSpawn: typeof _isolationDeps.spawn;
  let origTimeoutMs: typeof _isolationDeps.timeoutMs;
  let killed: boolean;

  function makeHungProc() {
    killed = false;
    let resolveExited: (code: number) => void = () => {};
    return {
      // Simulates real Bun.spawn behaviour: proc.kill() resolves the exited
      // promise (128 + SIGKILL(9) = 137), so the `await proc.exited` in
      // runGitBounded unblocks instead of hanging forever on a mock.
      exited: new Promise<number>((r) => {
        resolveExited = r;
      }),
      stdout: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      stderr: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      pid: 0,
      kill: () => {
        killed = true;
        resolveExited(137);
      },
    };
  }

  beforeEach(() => {
    origSpawn = _isolationDeps.spawn;
    origTimeoutMs = _isolationDeps.timeoutMs;
    _isolationDeps.timeoutMs = 50;
  });

  afterEach(() => {
    _isolationDeps.spawn = origSpawn;
    _isolationDeps.timeoutMs = origTimeoutMs;
  });

  test("getChangedFiles rejects and SIGKILLs the process when git hangs", async () => {
    _isolationDeps.spawn = mock(() => makeHungProc()) as unknown as typeof _isolationDeps.spawn; // test-ratchet-allow: as-unknown-as

    await expect(getChangedFiles("/tmp/does-not-matter", "HEAD")).rejects.toThrow(/timed out/);
    expect(killed).toBe(true);
  });

  test("getAddedLinesPerFile rejects when git hangs", async () => {
    _isolationDeps.spawn = mock(() => makeHungProc()) as unknown as typeof _isolationDeps.spawn; // test-ratchet-allow: as-unknown-as

    await expect(getAddedLinesPerFile("/tmp/does-not-matter", "HEAD")).rejects.toThrow(/timed out/);
    expect(killed).toBe(true);
  });
});
