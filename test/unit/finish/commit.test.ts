import { describe, expect, test } from "bun:test";
import { NaxError } from "@/errors";
import {
  PUSH_TIMEOUT_MS,
  _finishGitDeps,
  buildCommitRound,
  commitAndPush,
  commitFixes,
  commitRoundOutcome,
  filesInCommit,
} from "@/finish";

type GitCall = { args: string[]; workdir: string; timeoutMs?: number };
type GitResult = { stdout: string; stderr: string; exitCode: number };

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
      return ok();
    });
    _finishGitDeps.git = git;

    const result = await commitFixes("/repo", "fix: dirty tree");

    expect(result.committed).toBe(true);
    const addCall = calls.find((c) => c.args[0] === "add");
    expect(addCall?.args).toEqual(["add", "-A"]);
    const commitCall = calls.find((c) => c.args[0] === "commit");
    expect(commitCall?.args).toEqual(["commit", "-m", "fix: dirty tree"]);
  });

  test("skipHooks adds --no-verify to the commit argv", async () => {
    const { git, calls } = makeGitStub((call) => {
      if (call.args[0] === "rev-parse") return ok("sha\n");
      if (call.args[0] === "status") return ok(" M src/a.ts\n");
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
      if (call.args[0] === "add") return ok();
      if (call.args[0] === "commit") return fail("pre-commit hook rejected");
      return ok();
    });
    _finishGitDeps.git = git;

    await expect(commitFixes("/repo", "fix: bad commit")).rejects.toThrow(NaxError);
  });

  test("a failing git add throws NaxError before attempting commit", async () => {
    const { git, calls } = makeGitStub((call) => {
      if (call.args[0] === "rev-parse") return ok("sha\n");
      if (call.args[0] === "status") return ok(" M src/a.ts\n");
      if (call.args[0] === "add") return fail("disk full");
      return ok();
    });
    _finishGitDeps.git = git;

    await expect(commitFixes("/repo", "fix: bad add")).rejects.toThrow(NaxError);
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

describe("filesInCommit", () => {
  test("returns the repo-relative paths touched by a commit", async () => {
    const { git, calls } = makeGitStub((call) => {
      if (call.args[0] === "show") return ok("src/a.ts\nsrc/b.ts\n");
      return ok();
    });
    _finishGitDeps.git = git;

    const files = await filesInCommit("/repo", "abc123");

    expect(files).toEqual(["src/a.ts", "src/b.ts"]);
    const showCall = calls.find((c) => c.args[0] === "show");
    expect(showCall?.args).toEqual(["show", "--name-only", "--format=", "abc123"]);
    expect(showCall?.args[0]).not.toBe("git");
  });

  test("returns an empty array when the show command fails", async () => {
    const { git } = makeGitStub(() => fail("bad sha"));
    _finishGitDeps.git = git;

    expect(await filesInCommit("/repo", "bad-sha")).toEqual([]);
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
});

describe("buildCommitRound / commitRoundOutcome", () => {
  test("commitRoundOutcome: spec and quality phases produce 'fixed'", () => {
    expect(commitRoundOutcome("spec", "changed")).toBe("fixed");
    expect(commitRoundOutcome("quality", "changed")).toBe("fixed");
  });

  test("commitRoundOutcome: gate and acceptance phases produce 'no-reviewer'", () => {
    expect(commitRoundOutcome("gate", "changed")).toBe("no-reviewer");
    expect(commitRoundOutcome("acceptance", "changed")).toBe("no-reviewer");
  });

  test("buildCommitRound omits sha and failing when absent, not nulled", () => {
    const round = buildCommitRound({
      phase: "spec",
      committed: false,
      route: "unchanged",
      findings: [],
      now: "2026-08-18T00:00:00.000Z",
    });

    expect("sha" in round).toBe(false);
    expect("failing" in round).toBe(false);
    expect(round).not.toHaveProperty("attempt");
  });

  test("buildCommitRound sets sha only when committed and shaAfter is present", () => {
    const round = buildCommitRound({
      phase: "spec",
      committed: true,
      route: "changed",
      findings: [],
      shaAfter: "abc123",
      now: "2026-08-18T00:00:00.000Z",
    });

    expect(round.sha).toBe("abc123");
  });

  test("buildCommitRound carries failing gate commands when provided", () => {
    const round = buildCommitRound({
      phase: "gate",
      committed: true,
      route: "changed",
      findings: [],
      failing: ["lint", "test"],
      shaAfter: "sha2",
      now: "2026-08-18T00:00:00.000Z",
    });

    expect(round.failing).toEqual(["lint", "test"]);
    expect(round.outcome).toBe("no-reviewer");
  });
});
