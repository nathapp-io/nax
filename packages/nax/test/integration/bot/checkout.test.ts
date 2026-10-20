import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { changedPaths, type PrCheckout, preparePrCheckout } from "@/bot/checkout";
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
async function prepare(pinBaseFiles = false): Promise<PrCheckout> {
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
  checkout = await preparePrCheckout({ repoRoot: repo, ref, info, suffix: "test", pinBaseFiles });
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
});

describe("preparePrCheckout", () => {
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
