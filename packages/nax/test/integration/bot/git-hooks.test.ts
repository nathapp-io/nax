import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeBotFixEnv, makeTempDir } from "@test/helpers";
import { failingOnHead, type PrCheckout, preparePrCheckout, pushStep } from "@/bot";
import { _gateBaselineDeps } from "@/bot/gate-baseline";
import { saveFix } from "@/bot/saved-fix";
import { gitWithTimeout } from "@/utils/git";

let root: string;
let repo: string;
let marker: string;
let head: string;
let checkout: PrCheckout | undefined;
const baselineOriginal = { ..._gateBaselineDeps };

async function git(args: string[], cwd = repo): Promise<string> {
  // Fixture construction deliberately disables hooks; the positive control below does not.
  const result = await gitWithTimeout(args, cwd, undefined, undefined, [
    "git",
    "-c",
    "core.hooksPath=/dev/null",
    ...args,
  ]);
  expect(result.exitCode).toBe(0);
  return result.stdout.trim();
}
async function commit(cwd = repo): Promise<string> {
  await git(["add", "."], cwd);
  await git(["commit", "-m", "fixture"], cwd);
  return git(["rev-parse", "HEAD"], cwd);
}
async function prepare(): Promise<PrCheckout> {
  const env = makeBotFixEnv();
  checkout = await preparePrCheckout({
    repoRoot: repo,
    ref: { ...env.ref, number: 42 },
    info: { ...env.info, number: 42, headSha: head, headRef: "feat/x", baseRef: "main" },
    suffix: "hooks",
    pinBaseFiles: false,
  });
  return checkout;
}
async function resetMarker(): Promise<void> {
  const file = Bun.file(marker);
  if (await file.exists()) await file.delete();
}
beforeEach(async () => {
  root = makeTempDir("bot-hooks-");
  repo = join(root, "repo");
  marker = join(root, "hook-marker");
  checkout = undefined;
  await git(["init", "--bare", join(root, "origin.git")], root);
  await git(["init", "-b", "main", repo], root);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test"]);
  await git(["remote", "add", "origin", join(root, "origin.git")]);
  await Bun.write(join(repo, "source.txt"), "base");
  await commit();
  await git(["push", "origin", "main"]);
  await git(["checkout", "-b", "feat/x"]);
  for (const hook of ["post-checkout", "reference-transaction", "pre-push"]) {
    const path = join(repo, ".husky/_", hook);
    await Bun.write(path, `#!/bin/sh\nprintf '%s\\n' '${hook}' >> '${marker}'\n`);
    await chmod(path, 0o755);
  }
  head = await commit();
  await git(["push", "origin", "HEAD:refs/pull/42/head", "HEAD:refs/heads/feat/x"]);
  await git(["config", "core.hooksPath", ".husky/_"]);
});
afterEach(async () => {
  Object.assign(_gateBaselineDeps, baselineOriginal);
  await checkout?.dispose();
  cleanupTempDir(root);
});

describe("bot git hostile relative hooks", () => {
  test("AC-12 checkout never runs PR hooks", async () => {
    const prepared = await prepare();
    expect(await git(["rev-parse", "HEAD"], prepared.worktree)).toBe(head);
    expect(await Bun.file(marker).exists()).toBe(false);
  });
  test("AC-13/14 push succeeds without running hooks", async () => {
    const prepared = await prepare();
    await resetMarker(); // Isolate push from checkout, which AC-12 covers independently.
    await Bun.write(join(prepared.worktree, "source.txt"), "fix");
    const fix = await commit(prepared.worktree);
    const base = makeBotFixEnv();
    const env = { ...base, checkout: prepared, info: { ...base.info, headRef: "feat/x", headSha: head } };
    expect(await pushStep(env, { step: "push", timings: {} })).toMatchObject({
      patch: { outcome: "pushed", pushedSha: fix },
    });
    expect(await git(["rev-parse", "refs/heads/feat/x"], join(root, "origin.git"))).toBe(fix);
    expect(await Bun.file(marker).exists()).toBe(false);
  });
  test("AC-15 saveFix updates its ref without reference-transaction hooks", async () => {
    await saveFix(
      { repoRoot: repo, outputDir: join(root, "output"), prNumber: 42 },
      {
        version: 1,
        sha: head,
        headSha: head,
        agreedKeys: [],
        outcome: "gates-failed",
        savedAt: new Date().toISOString(),
      },
    );
    expect(await git(["rev-parse", "refs/nax-bot/pr-42/fix"])).toBe(head);
    expect(await Bun.file(marker).exists()).toBe(false);
  });
  test("AC-16 baseline visits head and restores the fix without hooks", async () => {
    const prepared = await prepare();
    await resetMarker();
    await Bun.write(join(prepared.worktree, "source.txt"), "fix");
    const fix = await commit(prepared.worktree);
    let observedHead = "";
    _gateBaselineDeps.runQualityGates = async () => {
      observedHead = await git(["rev-parse", "HEAD"], prepared.worktree);
      return { passed: false, failing: ["test"], ran: ["test"], output: "red" };
    };
    expect(await failingOnHead(prepared.worktree, head, [])).toEqual(["test"]);
    expect(observedHead).toBe(head);
    expect(await git(["rev-parse", "HEAD"], prepared.worktree)).toBe(fix);
    expect(await Bun.file(marker).exists()).toBe(false);
  });
  test("AC-17 unwrapped worktree add proves the committed hooks are live", async () => {
    const result = await gitWithTimeout(["worktree", "add", "--detach", join(root, "control"), "HEAD"], repo);
    expect(result.exitCode).toBe(0);
    expect(await Bun.file(marker).text()).toContain("post-checkout");
  });
});
