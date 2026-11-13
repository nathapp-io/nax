import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import { commitAndPush } from "@/finish";
import { gitWithTimeout } from "@/utils/git";

async function git(args: string[], repoRoot: string): Promise<string> {
  const result = await gitWithTimeout(args, repoRoot);
  if (result.exitCode !== 0) throw new Error(`fixture git failed: ${result.stderr}`);
  return result.stdout.trim();
}

describe("commitAndPush — bound destination with real Git", () => {
  test.each(["insteadOf", "pushInsteadOf", "both"])(
    "a %s rewrite changed after URL resolution cannot redirect the push (F1)",
    async (rule) => {
      await withTempDir(async (root) => {
        const approved = join(root, "approved.git");
        const unapproved = join(root, "unapproved.git");
        await git(["init", "--bare", approved], root);
        await git(["init", "--bare", unapproved], root);
        await git(["init", "-b", "feat/x"], root);
        await git(
          ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial"],
          root,
        );
        await git(["remote", "add", "origin", approved], root);
        const sha = await git(["rev-parse", "HEAD"], root);
        const rules = rule === "both" ? ["insteadOf", "pushInsteadOf"] : [rule];
        for (const kind of rules) await git(["config", `url.${approved}.${kind}`, approved], root);
        const resolved = await git(["remote", "get-url", "--push", "origin"], root);
        expect(resolved).toBe(approved);
        // Only now does configuration change, before commitAndPush starts.
        // Both full-URL and broad-prefix rewrites are hostile.
        for (const kind of rules) {
          await git(["config", "--unset-all", `url.${approved}.${kind}`], root);
          await git(["config", "--add", `url.${unapproved}.${kind}`, resolved], root);
          await git(["config", "--add", `url.${unapproved}.${kind}`, "nax-bound-"], root);
        }

        await commitAndPush(root, "feat/x", "unused", { skipCommit: true, sourceSha: sha, remote: resolved });

        expect(await git(["--git-dir", approved, "rev-parse", "refs/heads/feat/x"], root)).toBe(sha);
        expect(await git(["--git-dir", unapproved, "for-each-ref", "--format=%(refname)"], root)).toBe("");
        expect(await git(["config", "--get-regexp", "^remote\\."], root)).toBe(
          `remote.origin.url ${approved}\nremote.origin.fetch +refs/heads/*:refs/remotes/origin/*`,
        );
      });
    },
  );
});
