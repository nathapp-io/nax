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
  test("refuses untracked files even when status.showUntrackedFiles is no", async () => {
    await withTempDir(async (repo) => {
      await git(repo, ["init", "-b", "feat/x"]);
      await git(repo, ["config", "user.email", "test@example.com"]);
      await git(repo, ["config", "user.name", "Test"]);
      await Bun.write(join(repo, "tracked.txt"), "base");
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "base"]);
      await git(repo, ["config", "status.showUntrackedFiles", "no"]);
      await Bun.write(join(repo, "notes.txt"), "user notes");
      expect(await git(repo, ["status", "--porcelain"])).toBe("");
      await expect(
        prepareInPlaceCheckout({
          repoRoot: repo,
          ref: { forge: "github", host: "github.com", repo: "o/r", number: 42 },
          info: {
            number: 42,
            title: "PR",
            body: "",
            url: "",
            state: "open",
            draft: false,
            author: { login: "a" },
            baseRef: "main",
            headRef: "feat/x",
            headSha: "head",
            crossRepo: false,
          },
          suffix: "real",
        }),
      ).rejects.toMatchObject({
        code: "BOT_IN_PLACE_REFUSED",
        message: expect.stringContaining("working tree is not clean"),
      });
      expect(await Bun.file(join(repo, "notes.txt")).text()).toBe("user notes");
    });
  });
  test.each(["PR head", "ledger commit", "reverted source commit"])(
    "AC-19/F1: real checkout safety with %s",
    async (localHistory) => {
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
        if (localHistory === "reverted source commit") {
          await Bun.write(join(repo, "src/a.ts"), "local change");
          await git(repo, ["commit", "-am", "local source change"]);
          await git(repo, ["revert", "--no-edit", "HEAD"]);
          expect(await git(repo, ["diff", "--name-only", headSha, "HEAD"])).toBe("");
        } else if (localHistory === "ledger commit") {
          await Bun.write(join(featureDir(repo, "f"), "decisions.jsonl"), "{}\n");
          await git(repo, ["add", "."]);
          await git(repo, ["commit", "-m", "local ledger"]);
        }
        const startHead = await git(repo, ["rev-parse", "HEAD"]);
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
        const input = {
          repoRoot: repo,
          ref: { forge: "github" as const, host: "github.com", repo: "o/r", number: 42 },
          info,
          suffix: "real",
        };
        if (localHistory === "reverted source commit") {
          await expect(prepareInPlaceCheckout(input)).rejects.toMatchObject({
            code: "BOT_IN_PLACE_REFUSED",
            message: expect.stringContaining("commits the PR does not have"),
          });
          expect(await git(repo, ["symbolic-ref", "--short", "HEAD"])).toBe("feat/x");
          expect(await git(repo, ["status", "--porcelain"])).toBe("");
          expect(await git(repo, ["rev-parse", "HEAD"])).toBe(startHead);
          for (const name of Object.values(checkoutRefs(42, "real")))
            expect(await git(repo, ["for-each-ref", name])).toBe("");
          return;
        }
        const result = await prepareInPlaceCheckout(input);
        try {
          expect(result.worktree).toBe(repo);
          expect(result.startHead).toBe(startHead);
          expect(result.changedFiles).toEqual(["src/a.ts"]);
        } finally {
          await result.dispose();
        }
        expect(await git(repo, ["symbolic-ref", "--short", "HEAD"])).toBe("feat/x");
        expect(await git(repo, ["status", "--porcelain"])).toBe("");
        expect(await git(repo, ["rev-parse", "HEAD"])).toBe(startHead);
        await expect(lstat(result.snapshotDir)).rejects.toMatchObject({ code: "ENOENT" });
        for (const name of Object.values(checkoutRefs(42, "real")))
          expect(await git(repo, ["for-each-ref", name])).toBe("");
      });
    },
  );
});
