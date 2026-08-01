import { afterEach, describe, expect, test } from "bun:test";
import { _gitDeps, commitAndPush, commitFixes } from "@flows/nax-finish/steps/git";
import type { RunResult } from "@flows/nax-finish/types";

const ok = (stdout = ""): RunResult => ({ exitCode: 0, stdout, stderr: "" });
const originalRun = _gitDeps.run;
afterEach(() => {
  _gitDeps.run = originalRun;
});

const argvOf = (calls: string[][]) => calls.map((c) => c.join(" "));

describe("commitAndPush", () => {
  test("commits the fix nodes' working-tree edits, then pushes the branch", async () => {
    const calls: string[][] = [];
    _gitDeps.run = async (cmd) => {
      calls.push(cmd);
      return cmd.includes("--porcelain") ? ok(" M src/foo.ts\n?? src/bar.ts\n") : ok();
    };
    const r = await commitAndPush("/repo", "feat/x", "fix(x): nax-finish automated fixes");
    expect(r).toEqual({ committed: true, pushed: true });
    const argv = argvOf(calls);
    expect(argv).toContain("git add -A");
    expect(argv).toContain("git commit -m fix(x): nax-finish automated fixes");
    expect(argv).toContain("git push --set-upstream origin feat/x");
    // add/commit must precede the push
    expect(argv.indexOf("git add -A")).toBeLessThan(argv.indexOf("git push --set-upstream origin feat/x"));
  });

  test("pushes even with a clean tree, so the remote reflects HEAD", async () => {
    const calls: string[][] = [];
    _gitDeps.run = async (cmd) => {
      calls.push(cmd);
      return ok("");
    };
    const r = await commitAndPush("/repo", "feat/x", "msg");
    expect(r).toEqual({ committed: false, pushed: true });
    const argv = argvOf(calls);
    expect(argv.some((c) => c.startsWith("git commit"))).toBe(false);
    expect(argv).toContain("git push --set-upstream origin feat/x");
  });

  test("throws a coded error when the push is rejected", async () => {
    _gitDeps.run = async (cmd) =>
      cmd.includes("push") ? { exitCode: 1, stdout: "", stderr: "non-fast-forward" } : ok("");
    await expect(commitAndPush("/repo", "feat/x", "msg")).rejects.toThrow(/non-fast-forward/);
  });

  test("throws when the commit fails", async () => {
    _gitDeps.run = async (cmd) => {
      if (cmd.includes("--porcelain")) return ok(" M a.ts\n");
      if (cmd.includes("commit")) return { exitCode: 1, stdout: "", stderr: "pre-commit hook failed" };
      return ok("");
    };
    await expect(commitAndPush("/repo", "feat/x", "msg")).rejects.toThrow(/pre-commit hook failed/);
  });

  test("throws when git status itself fails", async () => {
    _gitDeps.run = async () => ({ exitCode: 128, stdout: "", stderr: "not a git repository" });
    await expect(commitAndPush("/repo", "feat/x", "msg")).rejects.toThrow(/not a git repository/);
  });
});

describe("commitFixes", () => {
  test("commits the working tree so the next review's diff includes the fix", async () => {
    const calls: string[][] = [];
    _gitDeps.run = async (cmd) => {
      calls.push(cmd);
      return cmd.includes("--porcelain") ? ok(" M apps/api/_calendar.py\n?? apps/api/tests/test_new.py\n") : ok();
    };
    const r = await commitFixes("/repo", "fix(x): nax-finish spec fixes");
    expect(r).toMatchObject({ committed: true });
    const argv = argvOf(calls);
    // -A, not -u: a fix that adds a new test file must be committed too, or the
    // reviewer's `git diff base...HEAD` still cannot see it.
    expect(argv).toContain("git add -A");
    expect(argv).toContain("git commit -m fix(x): nax-finish spec fixes");
  });

  test("never pushes — mid-loop commits stay local until a terminal node", async () => {
    const calls: string[][] = [];
    _gitDeps.run = async (cmd) => {
      calls.push(cmd);
      return cmd.includes("--porcelain") ? ok(" M a.ts\n") : ok();
    };
    await commitFixes("/repo", "msg");
    expect(argvOf(calls).some((c) => c.startsWith("git push"))).toBe(false);
  });

  test("is a no-op on a clean tree, so a fix node that changed nothing makes no commit", async () => {
    const calls: string[][] = [];
    _gitDeps.run = async (cmd) => {
      calls.push(cmd);
      return ok("");
    };
    const r = await commitFixes("/repo", "msg");
    expect(r).toMatchObject({ committed: false });
    expect(argvOf(calls).some((c) => c.startsWith("git commit"))).toBe(false);
  });

  test("throws a coded error when the commit fails", async () => {
    _gitDeps.run = async (cmd) => {
      if (cmd.includes("--porcelain")) return ok(" M a.ts\n");
      if (cmd.includes("commit")) return { exitCode: 1, stdout: "", stderr: "pre-commit hook failed" };
      return ok("");
    };
    await expect(commitFixes("/repo", "msg")).rejects.toThrow(/pre-commit hook failed/);
  });

  // A mid-loop commit is an internal checkpoint, not shipped history. Letting a
  // repo's pre-commit hook run there means a hook that rejects an intermediate
  // state (a lint error the gate loop would go on to fix) kills the whole flow
  // with no result file — a failure mode that did not exist when the only
  // commit was at a terminal node.
  test("skipHooks passes --no-verify so an intermediate state cannot kill the flow", async () => {
    const calls: string[][] = [];
    _gitDeps.run = async (cmd) => {
      calls.push(cmd);
      return cmd.includes("--porcelain") ? ok(" M a.ts\n") : ok("");
    };
    await commitFixes("/repo", "msg", { skipHooks: true });
    expect(argvOf(calls)).toContain("git commit -m msg --no-verify");
  });

  test("hooks run by default — the terminal commit is real history", async () => {
    const calls: string[][] = [];
    _gitDeps.run = async (cmd) => {
      calls.push(cmd);
      return cmd.includes("--porcelain") ? ok(" M a.ts\n") : ok("");
    };
    await commitAndPush("/repo", "feat/x", "msg");
    expect(argvOf(calls).some((c) => c.includes("--no-verify"))).toBe(false);
  });
});
