import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { NaxError } from "@/errors";
import { listUncommitted, readHead, writeReviewPackage } from "@/workflow/git";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim();
}

async function repo(): Promise<string> {
  const dir = makeTempDir("wf-git-");
  dirs.push(dir);
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "t@t");
  await git(dir, "config", "user.name", "t");
  await Bun.write(join(dir, "a.txt"), "one\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-qm", "seed");
  return dir;
}

describe("workflow git helpers", () => {
  test("package: commit list, stat and a -U10 diff; .nax excluded", async () => {
    const dir = await repo();
    const base = await readHead(dir);
    await Bun.write(join(dir, "a.txt"), "one\ntwo\n");
    await Bun.write(join(dir, ".nax", "x.json"), "{}");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "feat: two");
    const path = join(dir, "out", "package-0.diff");
    await writeReviewPackage(dir, base, path);
    const text = await Bun.file(path).text();
    expect(text).toContain("## Commits");
    expect(text).toContain("feat: two");
    expect(text).toContain("## Stat");
    expect(text).toContain("a.txt");
    expect(text).toContain("+two");
    expect(text).not.toContain(".nax/x.json");
  });

  test("package: an unknown from ref throws WORKFLOW_REVIEW_PACKAGE_FAILED and writes nothing", async () => {
    const dir = await repo();
    const path = join(dir, "out", "package-0.diff");
    const err = await writeReviewPackage(dir, "deadbeef", path).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NaxError);
    expect((err as NaxError).code).toBe("WORKFLOW_REVIEW_PACKAGE_FAILED");
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("listUncommitted names modified and untracked files, not .nax", async () => {
    const dir = await repo();
    await Bun.write(join(dir, "a.txt"), "changed\n");
    await Bun.write(join(dir, "b.txt"), "new\n");
    await Bun.write(join(dir, ".nax", "y.json"), "{}");
    expect((await listUncommitted(dir)).sort((a, b) => a.localeCompare(b))).toEqual(["a.txt", "b.txt"]);
  });
});
