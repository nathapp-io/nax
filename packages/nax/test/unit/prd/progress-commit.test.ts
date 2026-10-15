/**
 * `commitPrdProgress` / `savePrdProgress` — PRD progress commits (#2533).
 *
 * Every story status write lands in `prd.json`. Without a commit of its own
 * that status sits in the working tree as a file the next story's agent did not
 * touch, the next `autoCommitIfDirty` sweeps it into the wrong story's commit,
 * and a stray `git checkout .` resets a finished story to `pending` (#2490).
 *
 * These are the seam-level behaviours: the argv shape, the single warn, the
 * never-throws contract, and the save-before-commit order. The consequences
 * against a real repository are in test/integration/prd/progress-commit-git.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makePRD, makeStory, makeTempDir, withWarnSpy } from "@test/helpers";
import { _prdCommitDeps, commitPrdProgress, markStoryPassed, savePRD, savePrdProgress } from "@/prd";
import type { PrdGitResult } from "@/prd/progress-commit";

const ORIG_GIT = _prdCommitDeps.git;

const OPTIONS = { prdPath: "/repo/.nax/features/f/prd.json", feature: "f", storyId: "US-001", label: "passed" };

/**
 * Install a git stub. Every call's argv is recorded; `override` wins when it
 * returns a reply, so a single step can be made to fail.
 *
 * The default replies are the answers of a repository where the PRD is tracked,
 * modified and committable: `check-ignore` exits 1 ("not ignored"),
 * `diff --cached --quiet` exits 1 ("something is staged").
 */
function stubGit(override?: (args: string[]) => PrdGitResult | undefined): string[][] {
  const calls: string[][] = [];
  _prdCommitDeps.git = async (args: string[]) => {
    calls.push(args);
    const custom = override?.(args);
    if (custom) return custom;
    if (args[0] === "check-ignore") return { stdout: "", stderr: "", exitCode: 1 };
    if (args[0] === "diff") return { stdout: "", stderr: "", exitCode: 1 };
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  return calls;
}

afterEach(() => {
  _prdCommitDeps.git = ORIG_GIT;
});

describe("commitPrdProgress — git argv", () => {
  test("passes --no-verify to git commit and never a [skip ci] message", async () => {
    const calls = stubGit();

    const committed = await commitPrdProgress(OPTIONS);

    expect(committed).toBe(true);
    const commit = calls.find((args) => args[0] === "commit");
    expect(commit).toBeDefined();
    expect(commit).toContain("--no-verify");
    expect(commit).toContain("chore(f): progress US-001 passed");
    // A skipped required check blocks a merge, which is why commitLedger omits it too.
    expect(calls.flat().some((arg) => arg.includes("[skip ci]"))).toBe(false);
  });

  test("scopes every step to the PRD's own directory and basename", async () => {
    // The pathspec is what keeps an unrelated staged edit out of the commit, and
    // the cwd is what keeps it in the PRD's own repository.
    const calls = stubGit();

    await commitPrdProgress(OPTIONS);

    expect(calls.map((args) => args[0])).toEqual(["check-ignore", "add", "diff", "commit"]);
    for (const args of calls) {
      expect(args.at(-1)).toBe("prd.json");
    }
  });

  test("returns false without committing when the PRD carries no staged change", async () => {
    const calls = stubGit((args) => (args[0] === "diff" ? { stdout: "", stderr: "", exitCode: 0 } : undefined));

    const committed = await commitPrdProgress(OPTIONS);

    expect(committed).toBe(false);
    expect(calls.some((args) => args[0] === "commit")).toBe(false);
  });
});

describe("commitPrdProgress — failure handling", () => {
  test("logs exactly one warn carrying the story id and returns false when the commit fails", async () => {
    stubGit((args) => (args[0] === "commit" ? { stdout: "", stderr: "fatal: boom", exitCode: 1 } : undefined));

    await withWarnSpy(async (warnSpy) => {
      const committed = await commitPrdProgress(OPTIONS);

      expect(committed).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[2]?.storyId).toBe("US-001");
    });
  });

  test("logs one warn and returns false when git itself throws", async () => {
    _prdCommitDeps.git = async () => {
      throw new Error("spawn git ENOENT");
    };

    await withWarnSpy(async (warnSpy) => {
      const committed = await commitPrdProgress(OPTIONS);

      expect(committed).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[2]?.storyId).toBe("US-001");
    });
  });

  test("returns false, stops at check-ignore and logs no warn when the PRD is ignored", async () => {
    // A gitignored PRD cannot be committed and is not a failure: the ignore
    // check runs FIRST so the expected `add` refusal is never reached, and the
    // log stays quiet. (A failed `add` for any other reason is a real failure.)
    const calls = stubGit((args) =>
      args[0] === "check-ignore" ? { stdout: "prd.json", stderr: "", exitCode: 0 } : undefined,
    );

    await withWarnSpy(async (warnSpy) => {
      const committed = await commitPrdProgress(OPTIONS);

      expect(committed).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    });
    expect(calls.map((args) => args[0])).toEqual(["check-ignore"]);
  });

  test("logs one warn when staging the PRD fails for a reason other than an ignore rule", async () => {
    stubGit((args) => (args[0] === "add" ? { stdout: "", stderr: "fatal: index locked", exitCode: 128 } : undefined));

    await withWarnSpy(async (warnSpy) => {
      const committed = await commitPrdProgress(OPTIONS);

      expect(committed).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[2]?.storyId).toBe("US-001");
    });
  });
});

describe("savePrdProgress", () => {
  let workdir: string;
  let prdPath: string;

  beforeEach(() => {
    workdir = makeTempDir("nax-prd-progress-");
    prdPath = join(workdir, "prd.json");
  });

  afterEach(() => {
    cleanupTempDir(workdir);
  });

  test("writes the PRD to disk before the first git step runs", async () => {
    const prd = makePRD({
      feature: "f",
      userStories: [makeStory({ id: "US-001", status: "pending", passes: false })],
    });
    await savePRD(prd, prdPath);

    // Read the file back from inside the git seam: whatever is on disk at the
    // first git call is what savePrdProgress had already written. A commit that
    // ran first would find the previous status here.
    const statusAtFirstGitCall: string[] = [];
    const calls: string[][] = [];
    _prdCommitDeps.git = async (args: string[]) => {
      calls.push(args);
      statusAtFirstGitCall.push((await Bun.file(prdPath).json()).userStories[0].status);
      if (args[0] === "check-ignore") return { stdout: "", stderr: "", exitCode: 1 };
      if (args[0] === "diff") return { stdout: "", stderr: "", exitCode: 1 };
      return { stdout: "", stderr: "", exitCode: 0 };
    };

    markStoryPassed(prd, "US-001");
    await savePrdProgress(prd, prdPath, "US-001", "passed");

    expect(statusAtFirstGitCall[0]).toBe("passed");
    // The feature in the subject comes from the PRD, not from the caller.
    expect(calls.find((args) => args[0] === "commit")).toContain("chore(f): progress US-001 passed");
  });

  test("still saves the PRD when the commit cannot be created", async () => {
    _prdCommitDeps.git = async () => ({ stdout: "", stderr: "fatal: not a git repository", exitCode: 128 });
    const prd = makePRD({ feature: "f" });

    await savePrdProgress(prd, prdPath, "US-001", "passed");

    expect(await Bun.file(prdPath).exists()).toBe(true);
    expect((await Bun.file(prdPath).json()).feature).toBe("f");
  });
});
