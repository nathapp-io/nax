import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { lstat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeLogger, makeTempDir } from "@test/helpers";
import { _checkoutDeps, changedPaths, type PrCheckout, preparePrCheckout } from "@/bot/checkout";
import { resolveFeatureSpec } from "@/cli/features-resolve";
import { featureDir } from "@/config";
import type { PrInfo, PrRef } from "@/forge";
import { _workflowDeps } from "@/workflow/step-context";

let repo: string;
let checkout: PrCheckout | undefined;
const ref: PrRef = { forge: "github", host: "github.com", repo: "o/r", number: 42 };
async function git(argv: string[], cwd = repo): Promise<string> {
  const proc = Bun.spawn(["git", ...argv], { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(err);
  return out.trim();
}
async function commit(): Promise<string> {
  await git(["add", "."]);
  await git(["commit", "-m", "fixture"]);
  return git(["rev-parse", "HEAD"]);
}
async function prepare(pinBaseFiles = false, suffix = "test"): Promise<PrCheckout> {
  const headSha = await git(["rev-parse", "HEAD"]);
  await git(["update-ref", "refs/pull/42/head", headSha]);
  const info: PrInfo = {
    number: 42,
    title: "PR",
    body: "",
    url: "",
    state: "open",
    draft: false,
    author: { login: "a" },
    baseRef: "main",
    headRef: "topic",
    headSha,
    crossRepo: true,
  };
  checkout = await preparePrCheckout({ repoRoot: repo, ref, info, suffix, pinBaseFiles });
  return checkout;
}
beforeEach(async () => {
  repo = makeTempDir("bot-checkout-");
  checkout = undefined;
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test"]);
  await git(["remote", "add", "origin", repo]);
  await Bun.write(join(repo, "src/a.ts"), "base");
  await commit();
  await git(["checkout", "-b", "topic"]);
});
afterEach(async () => {
  await checkout?.dispose();
  cleanupTempDir(repo);
  mock.restore();
});

describe("preparePrCheckout parent cleanup and reservation", () => {
  test("US-013 AC-9/11 removes the empty parent only through rmdir", async () => {
    const prepared = await prepare();
    const remove = spyOn(_checkoutDeps, "rmdir");
    const recursiveRemove = spyOn(_checkoutDeps, "rm");
    await prepared.dispose();
    checkout = undefined;
    const parent = join(repo, ".nax-wt");
    expect(remove).toHaveBeenCalledWith(parent);
    expect(recursiveRemove).not.toHaveBeenCalledWith(parent);
    await expect(lstat(parent)).rejects.toMatchObject({ code: "ENOENT" });
  });
  test("US-013 AC-10 preserves another active checkout", async () => {
    const first = await prepare();
    const second = await prepare(false, "other");
    await first.dispose();
    expect((await lstat(join(repo, ".nax-wt"))).isDirectory()).toBe(true);
    expect(await git(["rev-parse", "HEAD"], second.worktree)).toBe(await git(["rev-parse", "HEAD"]));
  });
  test.each(["ENOTEMPTY", "EEXIST", "ENOENT"])("US-013 AC-16 ignores parent rmdir %s without warning", async (code) => {
    const prepared = await prepare();
    const logger = makeLogger();
    const warn = spyOn(logger, "warn");
    spyOn(_checkoutDeps, "getLogger").mockReturnValue(logger);
    const remove = spyOn(_checkoutDeps, "rmdir").mockRejectedValue(Object.assign(new Error(code), { code }));
    await prepared.dispose();
    checkout = undefined;
    expect(remove).toHaveBeenCalledWith(join(repo, ".nax-wt"));
    expect(warn).not.toHaveBeenCalled();
  });
  test("US-013 AC-12 retries a reservation lost to parent cleanup once", async () => {
    const reserve = _checkoutDeps.reserveWorktree;
    const calls = spyOn(_checkoutDeps, "reserveWorktree")
      .mockRejectedValueOnce(Object.assign(new Error("parent vanished"), { code: "ENOENT" }))
      .mockImplementationOnce(reserve);
    const prepared = await prepare();
    expect(calls).toHaveBeenCalledTimes(2);
    expect(calls.mock.calls[0]).toEqual(calls.mock.calls[1]);
    expect(await git(["rev-parse", "HEAD"], prepared.worktree)).toBe(await git(["rev-parse", "HEAD"]));
  });
  test("US-013 AC-13 never retries a reservation collision", async () => {
    const error = Object.assign(new Error("collision"), { code: "EEXIST" });
    const reserve = spyOn(_checkoutDeps, "reserveWorktree").mockRejectedValue(error);
    await expect(prepare()).rejects.toBe(error);
    expect(reserve).toHaveBeenCalledTimes(1);
  });
  test("US-013 AC-17 propagates the second reservation failure", async () => {
    const second = Object.assign(new Error("second failure"), { code: "ENOENT" });
    const reserve = spyOn(_checkoutDeps, "reserveWorktree")
      .mockRejectedValueOnce(Object.assign(new Error("first failure"), { code: "ENOENT" }))
      .mockRejectedValueOnce(second);
    await expect(prepare()).rejects.toBe(second);
    expect(reserve).toHaveBeenCalledTimes(2);
  });
});
describe("preparePrCheckout", () => {
  test("US-003 AC-22/23: overlapping fetch cannot redirect base and disposal deletes checkout refs", async () => {
    const base = await git(["rev-parse", "main"]);
    await Bun.write(join(repo, "src/a.ts"), "unrelated PR 99");
    const other = await commit();
    await git(["update-ref", "refs/pull/99/head", other]);
    await Bun.write(join(repo, "src/a.ts"), "PR 42");
    await commit();
    const run = _checkoutDeps.runGit;
    spyOn(_checkoutDeps, "runGit").mockImplementation(async (argv, cwd, timeoutMs) => {
      const result = await run(argv, cwd, timeoutMs);
      if (argv[0] === "fetch") await git(["fetch", "origin", "refs/pull/99/head"]);
      return result;
    });
    const prepared = await prepare();
    expect(await git(["rev-parse", "FETCH_HEAD"])).toBe(other);
    expect(prepared.baseSha).toBe(base);
    expect(prepared.baseSha).not.toBe(other);
    const list = () => git(["for-each-ref", "--format=%(refname)", "refs/nax-bot/pr-42/"]);
    expect((await list()).split("\n").filter((name) => name.includes("checkout-"))).toHaveLength(2);
    await prepared.dispose();
    checkout = undefined;
    expect(await list()).not.toContain("checkout-");
  });
  test("B4: a suffix collision never deletes a retained checkout or recovery work", async () => {
    const retained = await prepare();
    retained.retain?.();
    await Bun.write(join(retained.worktree, "recovery.txt"), "unfinished recovery work");
    await retained.dispose();
    try {
      await expect(prepare()).rejects.toThrow();
      expect(await Bun.file(join(retained.worktree, "recovery.txt")).text()).toBe("unfinished recovery work");
      expect(await git(["rev-parse", "HEAD"], retained.worktree)).toBe(await git(["rev-parse", "HEAD"]));
      expect(await git(["worktree", "list", "--porcelain"])).toContain(retained.worktree);
    } finally {
      await git(["worktree", "remove", "--force", retained.worktree]).catch(() => {});
      checkout = undefined;
    }
  });
  test("AC-10/12/19: changed source, shared excludes and complete disposal", async () => {
    await Bun.write(join(repo, "src/a.ts"), "head");
    await commit();
    const prepared = await prepare();
    expect(prepared.changedFiles).toEqual(["src/a.ts"]);
    expect(prepared.hasBaseNax).toBe(false);
    await Bun.write(join(featureDir(prepared.worktree, "bot-pr-42"), "workflow/r1/report.md"), "report");
    expect(await git(["status", "--porcelain"], prepared.worktree)).toBe("");
    expect(await lstat(prepared.snapshotDir).then(() => true)).toBe(true);
    await prepared.dispose();
    checkout = undefined;
    expect(
      await lstat(prepared.worktree).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(
      await lstat(prepared.snapshotDir).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });
  test("AC-13/14/15/16: review instructions come from base and head symlinks vanish", async () => {
    await git(["checkout", "main"]);
    await Bun.write(join(repo, ".nax/rules/base.md"), "base rule");
    await Bun.write(join(repo, "AGENTS.md"), "base agents");
    await commit();
    await git(["checkout", "topic"]);
    await git(["merge", "main"]);
    await Bun.write(join(repo, ".nax/rules/evil.md"), "evil");
    await Bun.write(join(repo, "AGENTS.md"), "head agents");
    await Bun.write(join(repo, "packages/x/CLAUDE.md"), "evil instructions");
    await symlink("/etc/hosts", join(repo, "link"));
    await commit();
    const prepared = await prepare(true);
    expect(await Bun.file(join(prepared.worktree, ".nax/rules/base.md")).text()).toBe("base rule");
    expect(await Bun.file(join(prepared.worktree, ".nax/rules/evil.md")).exists()).toBe(false);
    expect(await Bun.file(join(prepared.worktree, "AGENTS.md")).text()).toBe("base agents");
    expect(await Bun.file(join(prepared.worktree, "packages/x/CLAUDE.md")).exists()).toBe(false);
    expect(
      await lstat(join(prepared.worktree, "link")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });
  test.each([
    [".nax", ".nax/rules"],
    [".github", ".github/copilot-instructions.md"],
  ])("F1: review tolerates a regular file named %s in the head", async (parent, pinnedPath) => {
    await Bun.write(join(repo, parent), "head file");
    await commit();
    const prepared = await prepare(true);
    expect(await Bun.file(join(prepared.worktree, parent)).text()).toBe("head file");
    const missingCode = await lstat(join(prepared.worktree, pinnedPath)).then(
      () => "exists",
      (error: NodeJS.ErrnoException) => error.code,
    );
    expect(missingCode).toBe("ENOTDIR");
  });
  test("AC-17: trusted fix checkout retains head rules", async () => {
    await Bun.write(join(repo, ".nax/rules/evil.md"), "head rule");
    await commit();
    const prepared = await prepare(false);
    expect(await Bun.file(join(prepared.worktree, ".nax/rules/evil.md")).text()).toBe("head rule");
  });
});
describe("changedPaths", () => {
  test("partial commit failure retains unfinished work and stops before gates/push", async () => {
    const { _fixStepsDeps } = await import("@/bot/fix-steps");
    const { BOT_FIX_GRAPH, _botFixDeps } = await import("@/bot/fix-run");
    const { runStepGraph } = await import("@/step-graph");
    const originalNodes = { ..._botFixDeps };
    const nodes: string[] = [];
    _botFixDeps.reportStep = async () => {
      nodes.push("report");
      return { patch: {}, exit: "done" };
    };
    _botFixDeps.gatesStep = async () => {
      nodes.push("gates");
      throw new Error("gates must not run");
    };
    _botFixDeps.pushStep = async () => {
      nodes.push("push");
      throw new Error("push must not run");
    };
    const { makeBotFixEnv } = await import("@test/helpers");
    const prepared = await prepare();
    const env = makeBotFixEnv([{ kind: "finding", key: "f-1", issue: "fix", severity: "minor" }]);
    const realEnv = { ...env, checkout: prepared, info: { ...env.info, headSha: await git(["rev-parse", "HEAD"]) } };
    const original = _fixStepsDeps.runBranchFix;
    _fixStepsDeps.runBranchFix = async () => {
      await Bun.write(join(prepared.worktree, "src/a.ts"), "partial");
      await git(["add", "."], prepared.worktree);
      await git(["commit", "-m", "partial fix"], prepared.worktree);
      await Bun.write(join(prepared.worktree, "src/a.ts"), "complete");
      return { autoCommitted: false, dirty: true, failure: "leftover commit failed" };
    };
    try {
      const checked = await runStepGraph(
        BOT_FIX_GRAPH,
        realEnv,
        { step: "fix", timings: {} },
        { persist: async () => {} },
        { aborted: () => false, now: () => Date.now() },
      );
      expect(checked).toMatchObject({
        step: "done",
        outcome: "dirty",
        recoveryPath: prepared.worktree,
        fixFailure: "leftover commit failed",
      });
      expect(nodes).toEqual(["report"]);
      await prepared.dispose();
      expect(await Bun.file(join(prepared.worktree, "src/a.ts")).text()).toBe("complete");
      expect(await git(["show", "HEAD:src/a.ts"], prepared.worktree)).toBe("partial");
    } finally {
      _fixStepsDeps.runBranchFix = original;
      Object.assign(_botFixDeps, originalNodes);
      await git(["worktree", "remove", "--force", prepared.worktree]);
      checkout = undefined;
    }
  });
  test.each([".env.é", '.env."quoted"', ".env.line\nbreak", ".github/workflows/é.yml"])(
    "canonical protected path %s reaches checkStep",
    async (path) => {
      const from = await git(["rev-parse", "HEAD"]);
      await Bun.write(join(repo, path), "forbidden");
      await commit();
      const { checkStep } = await import("@/bot/fix-steps");
      const { makeBotFixEnv } = await import("@test/helpers");
      const env = makeBotFixEnv();
      const result = await checkStep(
        { ...env, checkout: { ...env.checkout, worktree: repo }, info: { ...env.info, headSha: from } },
        { step: "check", timings: {} },
      );
      expect(result).toMatchObject({ exit: "protected", patch: { protectedFiles: [path] } });
      const { sensitivePaths } = await import("@/bot/path-policy");
      if (path.startsWith(".github/")) expect(sensitivePaths(await changedPaths(repo, from))).toEqual([path]);
    },
  );
  test("AC-11: protected rename reports both old and new names", async () => {
    await Bun.write(join(repo, ".github/workflows/ci.yml"), "workflow");
    const from = await commit();
    await git(["mv", ".github/workflows/ci.yml", "docs-ci.yml"]);
    await commit();
    expect(await changedPaths(repo, from)).toEqual([".github/workflows/ci.yml", "docs-ci.yml"]);
  });
});
describe("workflow feature resolution", () => {
  test("AC-23: leaf import preserves feature fixture resolution", async () => {
    await Bun.write(join(repo, ".nax/config.json"), "{}");
    await Bun.write(join(featureDir(repo, "example"), "spec.md"), "# Example\nFeature spec");
    const direct = await resolveFeatureSpec("example", repo);
    expect(direct.specSource?.path).toBe(".nax/features/example/spec.md");
    expect(await _workflowDeps.resolveFeatureSpec("example", repo)).toEqual(direct);
  });
});
