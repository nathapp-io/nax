import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import { botGit } from "@/bot/git";
import { computeLineage } from "@/bot/lineage";
import { unrecordedPushes } from "@/bot/unrecorded-pushes";

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await botGit(args, cwd);
  expect(result.exitCode).toBe(0);
  return result.stdout.trim();
}

async function commit(repo: string, files: Readonly<Record<string, string>>, message: string): Promise<string> {
  for (const [path, body] of Object.entries(files)) await Bun.write(join(repo, path), body);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

describe("unrecorded pushes on a real checkout (#3069)", () => {
  test("a hand fix of an open finding's file gets lineage; other commits and merges do not", async () => {
    await withTempDir(async (repo) => {
      await git(repo, ["init", "-q", "-b", "main"]);
      await git(repo, ["config", "user.email", "test@example.com"]);
      await git(repo, ["config", "user.name", "Test"]);
      await commit(repo, { "src/a.ts": "one\n", "src/b.ts": "b\n" }, "target");
      await git(repo, ["checkout", "-q", "-b", "topic"]);
      const reviewed = await commit(repo, { "src/a.ts": "one\ntwo\n" }, "pr change");
      const fix = await commit(repo, { "src/a.ts": "one\ntwo\nguard\n" }, "hand fix of f-a");
      await commit(repo, { "src/b.ts": "b\nfeature\n" }, "unrelated feature");
      await git(repo, ["checkout", "-q", "main"]);
      await commit(repo, { "src/c.ts": "c\n" }, "target moves on");
      await git(repo, ["checkout", "-q", "topic"]);
      await git(repo, ["merge", "-q", "--no-edit", "main"]);
      const head = await git(repo, ["rev-parse", "HEAD"]);

      const entries = await unrecordedPushes({
        worktree: repo,
        rangeBase: reviewed,
        head,
        recorded: [],
        open: [{ key: "f-a", path: "src/a.ts", issue: "lock leaks", generation: 1 }],
      });

      expect(entries).toEqual([
        {
          base: reviewed,
          sha: fix,
          at: "",
          unrecorded: true,
          items: [{ key: "f-a", generation: 1, issue: "lock leaks" }],
        },
      ]);
      const lineage = await computeLineage({
        targets: [{ key: "f-new", file: "src/a.ts", line: 3 }],
        entries,
        worktree: repo,
        head,
      });
      expect(lineage.lineage.get("f-new")).toEqual({ generation: 2, parents: ["f-a"], pushSha: fix, unrecorded: true });
    });
  });
});
