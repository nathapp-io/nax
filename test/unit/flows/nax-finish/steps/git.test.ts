import { afterEach, describe, expect, test } from "bun:test";
import { _gitDeps, commitAndPush } from "@flows/nax-finish/steps/git";
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
