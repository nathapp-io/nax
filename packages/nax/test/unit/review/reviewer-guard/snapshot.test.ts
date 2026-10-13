import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NaxError } from "@/errors";
import { isKeeperOwnedPath, restoreRepoSnapshot, takeRepoSnapshot } from "@/review/reviewer-guard";
import { _snapshotDeps } from "@/review/reviewer-guard/snapshot";

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
      failures: [],
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

  test("keeper-owned run state is left; other .nax files (config, rules) are reverted", async () => {
    const d = await repo();
    await mkdir(join(d, ".nax", "rules"), { recursive: true });
    await writeFile(join(d, ".nax", "config.json"), "{}\n");
    await writeFile(join(d, ".nax", "rules", "r.md"), "r\n");
    await git(d, "add", "-A");
    await git(d, "commit", "-q", "-m", "nax cfg");
    const snap = await takeRepoSnapshot(d);
    await writeFile(join(d, ".nax", "config.json"), '{"evil":true}\n');
    await writeFile(join(d, ".nax", "rules", "r.md"), "evil\n");
    await mkdir(join(d, ".nax", "features", "f"), { recursive: true });
    await writeFile(join(d, ".nax", "features", "f", "prd.json"), "{}\n");
    await writeFile(join(d, ".nax", "features", "f", "status.json"), "{}\n");
    const report = await restoreRepoSnapshot(snap);
    expect([...report.paths].sort()).toEqual([".nax/config.json", ".nax/rules/r.md"]);
    expect(await readFile(join(d, ".nax", "config.json"), "utf8")).toBe("{}\n");
    expect(existsSync(join(d, ".nax", "features", "f", "prd.json"))).toBe(true);
    expect(isKeeperOwnedPath(d, ".nax/features/f/prd.json")).toBe(true);
    expect(isKeeperOwnedPath(d, ".nax/config.json")).toBe(false);
    expect(isKeeperOwnedPath(d, "src/nax.ts")).toBe(false);
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

  test("file -> directory swap is restored", async () => {
    const d = await repo();
    const snap = await takeRepoSnapshot(d);
    await rm(join(d, "a.txt"));
    await mkdir(join(d, "a.txt"));
    await writeFile(join(d, "a.txt", "y"), "y\n");
    const report = await restoreRepoSnapshot(snap);
    expect(report.failures).toEqual([]);
    expect(await readFile(join(d, "a.txt"), "utf8")).toBe("a\n");
    expect(await git(d, "status", "--porcelain")).toBe("");
  });

  test("directory -> file swap is restored", async () => {
    const d = await repo();
    const snap = await takeRepoSnapshot(d);
    await rm(join(d, "pkg"), { recursive: true });
    await writeFile(join(d, "pkg"), "now a file\n");
    const report = await restoreRepoSnapshot(snap);
    expect(report.failures).toEqual([]);
    expect(await readFile(join(d, "pkg", "b.txt"), "utf8")).toBe("b\n");
    expect(await git(d, "status", "--porcelain")).toBe("");
  });

  test("a nested repo (gitlink) created by the reviewer is removed", async () => {
    const d = await repo();
    const snap = await takeRepoSnapshot(d);
    await mkdir(join(d, "nest"));
    await git(join(d, "nest"), "init", "-q", "-b", "main");
    await writeFile(join(d, "nest", "n.txt"), "n\n");
    await git(join(d, "nest"), "add", "-A");
    await git(join(d, "nest"), "commit", "-q", "-m", "n");
    const report = await restoreRepoSnapshot(snap);
    expect(report.failures).toEqual([]);
    expect(report.paths).toEqual(["nest"]);
    expect(existsSync(join(d, "nest"))).toBe(false);
  });

  test("paths with a leading dash, a space and unicode round-trip", async () => {
    const d = await repo();
    const names = ["-dash.txt", "sp ace.txt", "uni\u00e9\u4e2d.txt"];
    for (const n of names) await writeFile(join(d, n), "orig\n");
    await git(d, "add", "-A");
    await git(d, "commit", "-q", "-m", "odd names");
    const snap = await takeRepoSnapshot(d);
    for (const n of names) await writeFile(join(d, n), "edited\n");
    const report = await restoreRepoSnapshot(snap);
    expect([...report.paths].sort()).toEqual([...names].sort());
    for (const n of names) expect(await readFile(join(d, n), "utf8")).toBe("orig\n");
    expect(await git(d, "status", "--porcelain")).toBe("");
  });

  test("a tracked dir replaced by a symlink to an outside dir leaves the outside dir untouched", async () => {
    const d = await repo();
    const outside = await mkdtemp(join(tmpdir(), "nax-rguard-out-"));
    dirs.push(outside);
    await writeFile(join(outside, "b.txt"), "outside\n");
    const snap = await takeRepoSnapshot(d);
    await rm(join(d, "pkg"), { recursive: true });
    await symlink(outside, join(d, "pkg"));
    const report = await restoreRepoSnapshot(snap);
    expect(report.failures).toEqual([]);
    expect(await readFile(join(outside, "b.txt"), "utf8")).toBe("outside\n");
    expect(await readFile(join(d, "pkg", "b.txt"), "utf8")).toBe("b\n");
    expect(await git(d, "status", "--porcelain")).toBe("");
  });

  test("detached-HEAD snapshot plus a reviewer commit: HEAD detached at the original commit", async () => {
    const d = await repo();
    const before = await git(d, "rev-parse", "HEAD");
    await git(d, "checkout", "-q", "--detach");
    const snap = await takeRepoSnapshot(d);
    expect(snap.symbolicHead).toBeUndefined();
    await writeFile(join(d, "a.txt"), "x\n");
    await git(d, "commit", "-qam", "reviewer");
    const report = await restoreRepoSnapshot(snap);
    expect(report.headRestored).toBe(true);
    expect(await git(d, "rev-parse", "HEAD")).toBe(before);
    expect(await git(d, "branch", "--show-current")).toBe("");
    expect(await git(d, "status", "--porcelain")).toBe("");
  });

  test("reviewer deletes the current branch: branch recreated and HEAD re-pointed", async () => {
    const d = await repo();
    const before = await git(d, "rev-parse", "HEAD");
    const snap = await takeRepoSnapshot(d);
    await git(d, "checkout", "-q", "-b", "side");
    await git(d, "branch", "-D", "main");
    const report = await restoreRepoSnapshot(snap);
    expect(report.failures).toEqual([]);
    expect(await git(d, "symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(await git(d, "rev-parse", "main")).toBe(before);
    expect(await git(d, "branch", "--list", "side")).toBe("");
  });

  test("moved branch reverted, new tag removed, deleted branch recreated", async () => {
    const d = await repo();
    const base = await git(d, "rev-parse", "HEAD");
    await git(d, "branch", "other");
    await git(d, "branch", "gone");
    const snap = await takeRepoSnapshot(d);
    await writeFile(join(d, "a.txt"), "n\n");
    await git(d, "commit", "-qam", "new");
    const fresh = await git(d, "rev-parse", "HEAD");
    await git(d, "branch", "-f", "other", fresh);
    await git(d, "tag", "t");
    await git(d, "branch", "-D", "gone");
    await restoreRepoSnapshot(snap);
    expect(await git(d, "rev-parse", "other")).toBe(base);
    expect(await git(d, "rev-parse", "gone")).toBe(base);
    expect(await git(d, "tag", "--list")).toBe("");
  });

  test("a pre-existing stash popped by the reviewer is stored back", async () => {
    const d = await repo();
    await writeFile(join(d, "a.txt"), "stashed\n");
    await git(d, "stash", "push", "-q");
    const sha = await git(d, "rev-parse", "stash@{0}");
    const snap = await takeRepoSnapshot(d);
    await git(d, "stash", "pop", "-q");
    const report = await restoreRepoSnapshot(snap);
    expect(report.failures).toEqual([]);
    expect(await git(d, "stash", "list", "--format=%H")).toBe(sha);
    expect(await readFile(join(d, "a.txt"), "utf8")).toBe("a\n");
    expect(await git(d, "status", "--porcelain")).toBe("");
  });

  test("empty repo: takeRepoSnapshot throws a NaxError", async () => {
    const d = await mkdtemp(join(tmpdir(), "nax-rguard-empty-"));
    dirs.push(d);
    await git(d, "init", "-q", "-b", "main");
    await expect(takeRepoSnapshot(d)).rejects.toBeInstanceOf(NaxError);
  });

  test("a failing rm is recorded in failures while the index is still restored", async () => {
    const d = await repo();
    await writeFile(join(d, "a.txt"), "staged\n");
    await git(d, "add", "a.txt");
    const snap = await takeRepoSnapshot(d);
    await writeFile(join(d, "a.txt"), "reviewer\n");
    await git(d, "add", "a.txt");
    await writeFile(join(d, "new.txt"), "new\n");
    await git(d, "add", "new.txt");
    const realRm = _snapshotDeps.rm;
    _snapshotDeps.rm = async () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    };
    try {
      const report = await restoreRepoSnapshot(snap);
      expect(report.failures.length).toBe(1);
      expect(report.failures[0]).toContain("new.txt");
      expect(report.indexRestored).toBe(true);
      expect(await git(d, "show", ":a.txt")).toBe("staged");
      expect(await git(d, "ls-files", "new.txt")).toBe("");
    } finally {
      _snapshotDeps.rm = realRm;
    }
  });
});
