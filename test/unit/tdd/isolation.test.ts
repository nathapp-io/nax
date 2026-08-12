import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getChangedFiles } from "@/tdd";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  await proc.exited;
}

describe("getChangedFiles", () => {
  let dir: string;

  beforeEach(async () => {
    dir = makeTempDir("nax-isolation-getchanged-");
    await Bun.write(`${dir}/tracked.txt`, "v1");
    await git(dir, ["init", "-q"]);
    await git(dir, ["config", "user.email", "t@t"]);
    await git(dir, ["config", "user.name", "t"]);
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-qm", "base"]);
  });

  afterEach(() => {
    cleanupTempDir(dir);
  });

  // BUG-34: `git diff --name-only` alone is blind to untracked files — a
  // TDD session's brand-new stub/test file must still show up so isolation
  // checks can catch it.
  test("includes untracked (new) files alongside tracked modifications", async () => {
    await Bun.write(`${dir}/tracked.txt`, "v2"); // modified — visible via git diff
    await Bun.write(`${dir}/brand-new.ts`, "export const x = 1;"); // untracked — the regression

    const changed = await getChangedFiles(dir, "HEAD");

    expect(new Set(changed)).toEqual(new Set(["tracked.txt", "brand-new.ts"]));
  });

  test("dedupes when a file appears in both diff and status output", async () => {
    await Bun.write(`${dir}/tracked.txt`, "v2");

    const changed = await getChangedFiles(dir, "HEAD");

    expect(changed.filter((f) => f === "tracked.txt")).toHaveLength(1);
  });

  test("returns only tracked changes when there are no untracked files", async () => {
    await Bun.write(`${dir}/tracked.txt`, "v2");

    const changed = await getChangedFiles(dir, "HEAD");

    expect(changed).toEqual(["tracked.txt"]);
  });
});
