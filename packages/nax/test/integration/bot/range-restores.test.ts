import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { withTempDir } from "@test/helpers";
import { botGit } from "@/bot/git";
import { readRangeRestores } from "@/bot/range-restores";

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await botGit(args, cwd);
  expect(result.exitCode).toBe(0);
  return result.stdout.trim();
}

function lines(count: number, prefix: string): string {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`)
    .join("\n")
    .concat("\n");
}

async function commit(repo: string, files: Readonly<Record<string, string>>, message: string): Promise<string> {
  for (const [path, body] of Object.entries(files)) await Bun.write(join(repo, path), body);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

describe("readRangeRestores on a real checkout (#3050)", () => {
  test("a hand reset after fix rounds is reported against the merge base", async () => {
    await withTempDir(async (repo) => {
      await git(repo, ["init", "-q", "-b", "main"]);
      await git(repo, ["config", "user.email", "test@example.com"]);
      await git(repo, ["config", "user.name", "Test"]);
      const target = lines(10, "base");
      const mergeBase = await commit(repo, { "src/a.ts": target, "src/b.ts": "b\n" }, "target");
      await git(repo, ["checkout", "-q", "-b", "topic"]);
      // Fix rounds grow src/a.ts by 30 lines; the reviewed head is the last of them.
      const reviewed = await commit(repo, { "src/a.ts": target + lines(30, "fix") }, "fix rounds");
      // A plain commit (no force push) takes src/a.ts back to the target plus 2 lines and grows src/b.ts.
      await commit(repo, { "src/a.ts": target + lines(2, "small"), "src/b.ts": "b\nmore\n" }, "reset");

      const result = await readRangeRestores(botGit, repo, { mergeBase, rangeBase: reviewed });

      expect(result).toEqual([{ path: "src/a.ts", now: 2, before: 30 }]);
    });
  });
});
