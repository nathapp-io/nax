import { describe, expect, test } from "bun:test";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import { prepareInPlaceCheckout } from "@/bot";
import { checkoutRefs } from "@/bot/checkout";
import { featureDir } from "@/config";
import type { PrInfo } from "@/forge";

async function git(repo: string, argv: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...argv], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(err);
  return out.trim();
}
describe("prepareInPlaceCheckout", () => {
  test("AC-19: real fetch and dispose leave branch and clean status unchanged", async () => {
    await withTempDir(async (repo) => {
      await git(repo, ["init", "-b", "main"]);
      await git(repo, ["config", "user.email", "test@example.com"]);
      await git(repo, ["config", "user.name", "Test"]);
      await Bun.write(join(repo, "src/a.ts"), "base");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "base"]);
      await git(repo, ["remote", "add", "origin", repo]);
      await git(repo, ["checkout", "-b", "feat/x"]);
      await Bun.write(join(repo, "src/a.ts"), "PR");
      await git(repo, ["commit", "-am", "PR"]);
      const headSha = await git(repo, ["rev-parse", "HEAD"]);
      await git(repo, ["update-ref", "refs/pull/42/head", headSha]);
      // Run artifacts are excluded before the cleanliness guard.
      await Bun.write(join(featureDir(repo, "f"), "workflow", "run", "artifact.txt"), "run");
      const info: PrInfo = {
        number: 42,
        title: "PR",
        body: "",
        url: "",
        state: "open",
        draft: false,
        author: { login: "a" },
        baseRef: "main",
        headRef: "feat/x",
        headSha,
        crossRepo: false,
      };
      const result = await prepareInPlaceCheckout({
        repoRoot: repo,
        ref: { forge: "github", host: "github.com", repo: "o/r", number: 42 },
        info,
        suffix: "real",
      });
      try {
        expect(result.worktree).toBe(repo);
        expect(result.startHead).toBe(headSha);
        expect(result.changedFiles).toEqual(["src/a.ts"]);
      } finally {
        await result.dispose();
      }
      expect(await git(repo, ["symbolic-ref", "--short", "HEAD"])).toBe("feat/x");
      expect(await git(repo, ["status", "--porcelain"])).toBe("");
      expect(await git(repo, ["rev-parse", "HEAD"])).toBe(headSha);
      await expect(lstat(result.snapshotDir)).rejects.toMatchObject({ code: "ENOENT" });
      for (const name of Object.values(checkoutRefs(42, "real")))
        expect(await git(repo, ["for-each-ref", name])).toBe("");
    });
  });
});
