import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRunStatePath, restoreRepoSnapshot, takeRepoSnapshot } from "@/review/reviewer-guard";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim();
}

async function repo(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "nax-rguard-"));
  dirs.push(d);
  await git(d, "init", "-q", "-b", "main");
  await writeFile(join(d, ".gitignore"), "ignored/\n");
  await writeFile(join(d, "a.txt"), "a\n");
  await mkdir(join(d, "pkg"), { recursive: true });
  await writeFile(join(d, "pkg", "b.txt"), "b\n");
  await git(d, "add", "-A");
  await git(d, "commit", "-q", "-m", "seed");
  return d;
}

describe("reviewer tree snapshot (nax#2500)", () => {
  test("clean tree, nothing changed: no-op report", async () => {
    const d = await repo();
    const snap = await takeRepoSnapshot(d);
    expect(await restoreRepoSnapshot(snap)).toEqual({
      paths: [],
      indexRestored: false,
      headRestored: false,
      stashesDropped: 0,
    });
  });

  test("tracked edit is restored; staged-vs-unstaged split preserved", async () => {
    const d = await repo();
    await writeFile(join(d, "a.txt"), "staged\n");
    await git(d, "add", "a.txt");
    await writeFile(join(d, "a.txt"), "staged+unstaged\n");
    const snap = await takeRepoSnapshot(d);
    await writeFile(join(d, "a.txt"), "reviewer edit\n");
    await git(d, "add", "a.txt");
    const report = await restoreRepoSnapshot(snap);
    expect(report.paths).toEqual(["a.txt"]);
    expect(await readFile(join(d, "a.txt"), "utf8")).toBe("staged+unstaged\n");
    expect(await git(d, "show", ":a.txt")).toBe("staged");
  });

  test("new untracked file deleted; pre-existing untracked file restored; ignored path kept", async () => {
    const d = await repo();
    await writeFile(join(d, "pre.txt"), "pre\n");
    const snap = await takeRepoSnapshot(d);
    await writeFile(join(d, "pre.txt"), "changed\n");
    await writeFile(join(d, "new.txt"), "new\n");
    await mkdir(join(d, "ignored"), { recursive: true });
    await writeFile(join(d, "ignored", "cache"), "x\n");
    const report = await restoreRepoSnapshot(snap);
    expect([...report.paths].sort()).toEqual(["new.txt", "pre.txt"]);
    expect(existsSync(join(d, "new.txt"))).toBe(false);
    expect(await readFile(join(d, "pre.txt"), "utf8")).toBe("pre\n");
    expect(existsSync(join(d, "ignored", "cache"))).toBe(true);
    expect(await git(d, "status", "--porcelain")).toBe("?? pre.txt");
  });

  test(".nax paths are left to the run-state keeper", async () => {
    const d = await repo();
    const snap = await takeRepoSnapshot(d);
    await mkdir(join(d, ".nax"), { recursive: true });
    await writeFile(join(d, ".nax", "x.json"), "{}\n");
    const report = await restoreRepoSnapshot(snap);
    expect(report.paths).toEqual([]);
    expect(existsSync(join(d, ".nax", "x.json"))).toBe(true);
    expect(isRunStatePath(".nax/x.json")).toBe(true);
    expect(isRunStatePath("packages/p/.nax/y")).toBe(true);
    expect(isRunStatePath("src/nax.ts")).toBe(false);
  });

  test("a commit by the reviewer is undone (HEAD and branch ref restored)", async () => {
    const d = await repo();
    const before = await git(d, "rev-parse", "HEAD");
    const snap = await takeRepoSnapshot(d);
    await writeFile(join(d, "a.txt"), "x\n");
    await git(d, "commit", "-qam", "reviewer");
    const report = await restoreRepoSnapshot(snap);
    expect(report.headRestored).toBe(true);
    expect(await git(d, "rev-parse", "HEAD")).toBe(before);
    expect(await readFile(join(d, "a.txt"), "utf8")).toBe("a\n");
    expect(await git(d, "status", "--porcelain")).toBe("");
  });

  test("checkout -b by the reviewer: HEAD re-pointed at the original branch", async () => {
    const d = await repo();
    const snap = await takeRepoSnapshot(d);
    await git(d, "checkout", "-q", "-b", "side");
    await restoreRepoSnapshot(snap);
    expect(await git(d, "symbolic-ref", "--short", "HEAD")).toBe("main");
  });

  test("stash push by the reviewer: entry dropped and tree restored", async () => {
    const d = await repo();
    await writeFile(join(d, "a.txt"), "wip\n");
    const snap = await takeRepoSnapshot(d);
    await git(d, "stash", "push", "-q");
    const report = await restoreRepoSnapshot(snap);
    expect(report.stashesDropped).toBe(1);
    expect(await git(d, "stash", "list")).toBe("");
    expect(await readFile(join(d, "a.txt"), "utf8")).toBe("wip\n");
  });

  test("package workdir maps to the toplevel; paths are repo-root-relative", async () => {
    const d = await repo();
    const snap = await takeRepoSnapshot(join(d, "pkg"));
    expect(snap.toplevel).toBe(await git(d, "rev-parse", "--show-toplevel"));
    await writeFile(join(d, "a.txt"), "edit from pkg session\n");
    expect((await restoreRepoSnapshot(snap)).paths).toEqual(["a.txt"]);
  });
});
