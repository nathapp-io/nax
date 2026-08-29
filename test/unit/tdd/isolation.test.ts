import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeSpawn, makeTempDir } from "@test/helpers";
import { NaxError } from "@/errors";
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

  beforeEach(() => {
    origSpawn = _isolationDeps.spawn;
    origTimeoutMs = _isolationDeps.timeoutMs;
    _isolationDeps.timeoutMs = 50;
    killed = false;
    // Simulates real Bun.spawn behaviour via the shared stub: proc.kill()
    // resolves the exited promise (128 + SIGKILL(9) = 137), so the
    // `await proc.exited` in runGitBounded unblocks instead of hanging
    // forever on a mock.
    _isolationDeps.spawn = makeSpawn(() => ({
      hang: true,
      killResolvesExited: true,
      onKill: () => {
        killed = true;
      },
    })).spawn;
  });

  afterEach(() => {
    _isolationDeps.spawn = origSpawn;
    _isolationDeps.timeoutMs = origTimeoutMs;
  });

  test("getChangedFiles rejects and SIGKILLs the process when git hangs", async () => {
    await expect(getChangedFiles("/tmp/does-not-matter", "HEAD")).rejects.toThrow(/timed out/);
    expect(killed).toBe(true);
  });

  test("getAddedLinesPerFile rejects when git hangs", async () => {
    await expect(getAddedLinesPerFile("/tmp/does-not-matter", "HEAD")).rejects.toThrow(/timed out/);
    expect(killed).toBe(true);
  });
});

// US-002: a failed `git diff --numstat` must surface through a NaxError with
// code "GIT_ERROR" carrying git stderr — not be silently turned into an empty
// Map. The empty Map was previously read as "no additions, no stub violations"
// and a git hiccup was reported as a test-writer offence.
describe("getAddedLinesPerFile (US-002: loud git failures)", () => {
  let origSpawn: typeof _isolationDeps.spawn;

  beforeEach(() => {
    origSpawn = _isolationDeps.spawn;
  });

  afterEach(() => {
    _isolationDeps.spawn = origSpawn;
  });

  // AC1 — numstat exit 1 with stderr "fatal: bad revision 'HEAD'" must
  // reject with NaxError code "GIT_ERROR" whose message contains the stderr.
  test("rejects with NaxError code GIT_ERROR when numstat exits non-zero", async () => {
    _isolationDeps.spawn = makeSpawn(() => ({
      stdout: "",
      stderr: "fatal: bad revision 'HEAD'\n",
      exitCode: 1,
    })).spawn;

    let caught: unknown;
    try {
      await getAddedLinesPerFile("/tmp/does-not-matter", "HEAD");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(NaxError);
    if (!(caught instanceof NaxError)) throw new Error("expected NaxError");
    expect(caught.code).toBe("GIT_ERROR");
    expect(caught.message).toContain("bad revision");
  });

  // AC2 — numstat exit 0 with stdout "3\t0\tsrc/a.ts" must resolve to a map
  // mapping "src/a.ts" to 3. Sanity-check the success path stays untouched.
  test("returns a Map mapping path to added lines on numstat success", async () => {
    _isolationDeps.spawn = makeSpawn(() => ({
      stdout: "3\t0\tsrc/a.ts\n",
      exitCode: 0,
    })).spawn;

    const result = await getAddedLinesPerFile("/tmp/does-not-matter", "HEAD");

    expect(result.get("src/a.ts")).toBe(3);
  });
});
