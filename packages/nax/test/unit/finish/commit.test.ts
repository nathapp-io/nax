import { describe, expect, test } from "bun:test";
import { assertCaughtInstanceOf, withDepsRestore } from "@test/helpers";
import { NaxError } from "@/errors";
import { _finishGitDeps, commitAndPush, commitFixes, PUSH_TIMEOUT_MS } from "@/finish";

type GitCall = { args: string[]; workdir: string; timeoutMs?: number };
type GitResult = { stdout: string; stderr: string; exitCode: number };

withDepsRestore(_finishGitDeps, ["git", "randomUUID"]);

/** Records every call so a test can assert argv shape and per-call timeout. */
function makeGitStub(handler: (call: GitCall) => GitResult) {
  const calls: GitCall[] = [];
  const git = async (args: string[], workdir: string, timeoutMs?: number): Promise<GitResult> => {
    const call = { args, workdir, timeoutMs };
    calls.push(call);
    return handler(call);
  };
  return { git, calls };
}

const ok = (stdout = ""): GitResult => ({ stdout, stderr: "", exitCode: 0 });
const fail = (stderr = "boom"): GitResult => ({ stdout: "", stderr, exitCode: 1 });
/** `git diff --cached --quiet` exits 1 when the index differs from HEAD. */
const isStagedCheck = (args: string[]): boolean => args[0] === "diff" && args.includes("--cached");
const staged = (): GitResult => ({ stdout: "", stderr: "", exitCode: 1 });

describe("_finishGitDeps.git argv — no leading 'git' element", () => {
  test("commitFixes on a clean tree calls status and rev-parse without a leading 'git'", async () => {
    const { git, calls } = makeGitStub((call) => {
      if (call.args[0] === "rev-parse") return ok("abc123\n");
      if (call.args[0] === "status") return ok("");
      return ok();
    });
    _finishGitDeps.git = git;

    await commitFixes("/repo", "message");

    for (const call of calls) {
      expect(call.args[0]).not.toBe("git");
    }
  });
});

describe("commitFixes", () => {
  test("a clean tree commits nothing and returns shaBefore === shaAfter", async () => {
    const { git } = makeGitStub((call) => {
      if (call.args[0] === "rev-parse") return ok("deadbeef\n");
      if (call.args[0] === "status") return ok("");
      return ok();
    });
    _finishGitDeps.git = git;

    const result = await commitFixes("/repo", "fix: nothing to do");

    expect(result.committed).toBe(false);
    expect(result.shaBefore).toBe("deadbeef");
    expect(result.shaAfter).toBe("deadbeef");
  });

  test("a dirty tree runs add -A then commit", async () => {
    const { git, calls } = makeGitStub((call) => {
      if (call.args[0] === "rev-parse") return ok("newsha\n");
      if (call.args[0] === "status") return ok(" M src/a.ts\n");
      if (isStagedCheck(call.args)) return staged();
      return ok();
    });
    _finishGitDeps.git = git;

    const result = await commitFixes("/repo", "fix: dirty tree");

    expect(result.committed).toBe(true);
    const addCall = calls.find((c) => c.args[0] === "add");
    expect(addCall?.args).toEqual(["add", "-A", "--", ":/"]);
    const commitCall = calls.find((c) => c.args[0] === "commit");
    expect(commitCall?.args).toEqual(["commit", "-m", "fix: dirty tree"]);
  });

  test("skipHooks adds --no-verify to the commit argv", async () => {
    const { git, calls } = makeGitStub((call) => {
      if (call.args[0] === "rev-parse") return ok("sha\n");
      if (call.args[0] === "status") return ok(" M src/a.ts\n");
      if (isStagedCheck(call.args)) return staged();
      return ok();
    });
    _finishGitDeps.git = git;

    await commitFixes("/repo", "fix: checkpoint", { skipHooks: true });

    const commitCall = calls.find((c) => c.args[0] === "commit");
    expect(commitCall?.args).toEqual(["commit", "-m", "fix: checkpoint", "--no-verify"]);
  });

  test("a failing git commit throws NaxError", async () => {
    const { git } = makeGitStub((call) => {
      if (call.args[0] === "rev-parse") return ok("sha\n");
      if (call.args[0] === "status") return ok(" M src/a.ts\n");
      if (isStagedCheck(call.args)) return staged();
      if (call.args[0] === "add") return ok();
      if (call.args[0] === "commit") return fail("pre-commit hook rejected");
      return ok();
    });
    _finishGitDeps.git = git;

    const result = commitFixes("/repo", "fix: bad commit");
    await expect(result).rejects.toThrow(NaxError);
    await expect(result).rejects.toMatchObject({ code: "FINISH_GIT_COMMIT_FAILED" });
  });

  test("a failing git add throws NaxError before attempting commit", async () => {
    const { git, calls } = makeGitStub((call) => {
      if (call.args[0] === "rev-parse") return ok("sha\n");
      if (call.args[0] === "status") return ok(" M src/a.ts\n");
      if (isStagedCheck(call.args)) return staged();
      if (call.args[0] === "add") return fail("disk full");
      return ok();
    });
    _finishGitDeps.git = git;

    await expect(commitFixes("/repo", "fix: bad add")).rejects.toThrow(NaxError);
    expect(calls.some((c) => c.args[0] === "commit")).toBe(false);
  });

  test("#2210: nothing staged after add returns uncommitted and never runs a status-printing commit", async () => {
    const { git, calls } = makeGitStub((call) => {
      if (call.args[0] === "rev-parse") return ok("sha\n");
      if (call.args[0] === "status") return ok(" M sub\n");
      return ok(); // diff --cached --quiet exits 0: the index matches HEAD
    });
    _finishGitDeps.git = git;

    const result = await commitFixes("/repo", "fix: only a dirty submodule");

    expect(result).toEqual({ committed: false, shaBefore: "sha", shaAfter: "sha" });
    expect(calls.some((c) => c.args[0] === "commit")).toBe(false);
  });

  test("#2210: an unanswerable staged check throws instead of committing", async () => {
    const { git, calls } = makeGitStub((call) => {
      if (call.args[0] === "rev-parse") return ok("sha\n");
      if (call.args[0] === "status") return ok(" M src/a.ts\n");
      if (isStagedCheck(call.args)) return { stdout: "", stderr: "fatal", exitCode: 128 };
      return ok();
    });
    _finishGitDeps.git = git;

    await expect(commitFixes("/repo", "fix: x")).rejects.toThrow(NaxError);
    expect(calls.some((c) => c.args[0] === "commit")).toBe(false);
  });

  test("a failing git status throws NaxError", async () => {
    const { git } = makeGitStub((call) => {
      if (call.args[0] === "rev-parse") return ok("sha\n");
      if (call.args[0] === "status") return fail("not a git repo");
      return ok();
    });
    _finishGitDeps.git = git;

    await expect(commitFixes("/repo", "fix: bad status")).rejects.toThrow(NaxError);
  });
});

describe("commitAndPush", () => {
  test("pushes with --set-upstream origin <branch>", async () => {
    const { git, calls } = makeGitStub((call) => {
      if (call.args[0] === "rev-parse") return ok("sha\n");
      if (call.args[0] === "status") return ok("");
      return ok();
    });
    _finishGitDeps.git = git;

    const result = await commitAndPush("/repo", "feat/x", "fix: terminal commit");

    expect(result.pushed).toBe(true);
    const pushCall = calls.find((c) => c.args[0] === "push");
    expect(pushCall?.args).toEqual(["push", "--set-upstream", "origin", "feat/x"]);
  });

  test("uses PUSH_TIMEOUT_MS for the push call, not the default", async () => {
    const { git, calls } = makeGitStub((call) => {
      if (call.args[0] === "rev-parse") return ok("sha\n");
      if (call.args[0] === "status") return ok("");
      return ok();
    });
    _finishGitDeps.git = git;

    await commitAndPush("/repo", "feat/x", "fix: terminal commit");

    const pushCall = calls.find((c) => c.args[0] === "push");
    expect(pushCall?.timeoutMs).toBe(PUSH_TIMEOUT_MS);
  });

  test("the terminal commit path does not pass --no-verify (skipHooks off)", async () => {
    const { git, calls } = makeGitStub((call) => {
      if (call.args[0] === "rev-parse") return ok("sha\n");
      if (call.args[0] === "status") return ok(" M src/a.ts\n");
      if (isStagedCheck(call.args)) return staged();
      return ok();
    });
    _finishGitDeps.git = git;

    await commitAndPush("/repo", "feat/x", "fix: terminal commit");

    const commitCall = calls.find((c) => c.args[0] === "commit");
    expect(commitCall?.args).toEqual(["commit", "-m", "fix: terminal commit"]);
  });

  test("the push is unconditional even when nothing new was committed", async () => {
    const { git, calls } = makeGitStub((call) => {
      if (call.args[0] === "rev-parse") return ok("sha\n");
      if (call.args[0] === "status") return ok("");
      return ok();
    });
    _finishGitDeps.git = git;

    const result = await commitAndPush("/repo", "feat/x", "fix: nothing new");

    expect(result.committed).toBe(false);
    expect(result.pushed).toBe(true);
    expect(calls.some((c) => c.args[0] === "push")).toBe(true);
  });

  test("a failing push throws NaxError", async () => {
    const { git } = makeGitStub((call) => {
      if (call.args[0] === "rev-parse") return ok("sha\n");
      if (call.args[0] === "status") return ok("");
      if (call.args[0] === "push") return fail("remote rejected");
      return ok();
    });
    _finishGitDeps.git = git;

    await expect(commitAndPush("/repo", "feat/x", "fix: push fails")).rejects.toThrow(NaxError);
  });

  test("pushes the bound commit to the branch ref when sourceSha is given (F1)", async () => {
    const { git, calls } = makeGitStub((call) => {
      if (call.args[0] === "rev-parse") return ok("moved\n");
      if (call.args[0] === "status") return ok("");
      return ok();
    });
    _finishGitDeps.git = git;

    await commitAndPush("/repo", "feat/x", "chore: send flow to koda", { skipCommit: true, sourceSha: "0123abcd" });

    const pushCall = calls.find((c) => c.args[0] === "push");
    expect(pushCall?.args).toEqual(["push", "--set-upstream", "origin", "0123abcd:refs/heads/feat/x"]);
  });

  test("a branch that moved to another commit does not change what is pushed (F1)", async () => {
    // `rev-parse` every call: the branch has been advanced between the caller's
    // check and this push. The refspec carries the approved commit, so the pushed
    // object is the same either way.
    const { git, calls } = makeGitStub((call) => {
      if (call.args[0] === "rev-parse") return ok("advanced-while-the-card-was-open\n");
      if (call.args[0] === "status") return ok("");
      return ok();
    });
    _finishGitDeps.git = git;

    await commitAndPush("/repo", "feat/x", "chore: send flow to koda", { skipCommit: true, sourceSha: "approved" });

    const pushCall = calls.find((c) => c.args[0] === "push");
    expect(pushCall?.args.at(-1)).toBe("approved:refs/heads/feat/x");
  });

  test("the plain push still names the branch when no sourceSha is given", async () => {
    const { git, calls } = makeGitStub((call) => {
      if (call.args[0] === "rev-parse") return ok("sha\n");
      if (call.args[0] === "status") return ok("");
      return ok();
    });
    _finishGitDeps.git = git;

    await commitAndPush("/repo", "feat/x", "fix: still the branch");

    const pushCall = calls.find((c) => c.args[0] === "push");
    expect(pushCall?.args).toEqual(["push", "--set-upstream", "origin", "feat/x"]);
  });

  test("pushes to the resolved remote URL when one is given (F1)", async () => {
    const { git, calls } = makeGitStub((call) => {
      if (call.args[0] === "rev-parse") return ok("moved\n");
      if (call.args[0] === "status") return ok("");
      return ok();
    });
    _finishGitDeps.git = git;

    await commitAndPush("/repo", "feat/x", "chore: send flow to koda", {
      skipCommit: true,
      sourceSha: "0123abcd",
      remote: "git@github.com:o/r.git",
    });

    // A fresh alias is rewritten once into the verified URL; that replacement is
    // not itself rewritten. An explicit pushurl also bypasses pushInsteadOf.
    const bound = calls[0]?.args.at(-2);
    expect(bound).toMatch(/^nax-bound-/);
    expect(calls[0]?.args).toEqual([
      "-c",
      `remote.${bound}.url=${bound}://push`,
      "-c",
      `remote.${bound}.pushurl=${bound}://push`,
      "-c",
      `url.git@github.com:o/r.git.insteadOf=${bound}://push`,
      "push",
      "--set-upstream",
      bound,
      "0123abcd:refs/heads/feat/x",
    ]);
    expect(calls[0]?.timeoutMs).toBe(PUSH_TIMEOUT_MS);
  });

  test("a push failure names the branch, never the remote a credential may sit in (F1)", async () => {
    const { git } = makeGitStub((call) => {
      if (call.args[0] === "rev-parse") return ok("sha\n");
      if (call.args[0] === "status") return ok("");
      if (call.args.includes("push")) return fail("remote rejected");
      return ok();
    });
    _finishGitDeps.git = git;
    const credential = "https://x-access-token:secret-token@github.com/o/r.git";

    const caught = await commitAndPush("/repo", "feat/x", "chore: send flow to koda", {
      skipCommit: true,
      sourceSha: "0123abcd",
      remote: credential,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    assertCaughtInstanceOf(caught, NaxError, "the push rejection");

    expect(caught.message).toContain('git push of "feat/x" failed');
    expect(caught.message).not.toContain("secret-token");
    expect(JSON.stringify(caught.context)).not.toContain("secret-token");
  });
});
