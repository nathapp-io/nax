import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NaxError } from "@/errors";
import { isKeeperOwnedPath, restoreRepoSnapshot, takeRepoSnapshot } from "@/review/reviewer-guard";
import { _snapshotDeps } from "@/review/reviewer-guard/snapshot";

import { RunStateKeeper, registerKeeper, runStateWrite, unregisterKeeper } from "@/runstate/store";

const deps = { ..._snapshotDeps };
const keepers: RunStateKeeper[] = [];
const dirs: string[] = [];
afterEach(async () => {
  Object.assign(_snapshotDeps, deps);
  for (const keeper of keepers.splice(0)) unregisterKeeper(keeper);
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
  return git(d, "rev-parse", "--show-toplevel");
}

describe("reviewer tree snapshot (nax#2500)", () => {
  test("clean tree, nothing changed: no-op report", async () => {
    const d = await repo();
    const snap = await takeRepoSnapshot(d);
    expect(await restoreRepoSnapshot(snap)).toEqual({
      paths: [],
      indexRestored: false,
      headRestored: false,
      refsLeft: [],
      stashLeft: [],
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
    const keeper = new RunStateKeeper("test", "f");
    keepers.push(keeper);
    registerKeeper(keeper);
    for (const name of ["prd.json", "status.json"]) {
      const path = join(d, ".nax", "features", "f", name);
      await runStateWrite(path, { content: "{}\n" }, () => writeFile(path, "{}\n"));
    }
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

  test("stash push by the reviewer: tree restored, stash entry left and reported", async () => {
    const d = await repo();
    await writeFile(join(d, "a.txt"), "wip\n");
    const snap = await takeRepoSnapshot(d);
    await git(d, "stash", "push", "-q");
    const report = await restoreRepoSnapshot(snap);
    expect(report.stashLeft.length).toBe(1);
    expect((await git(d, "stash", "list")).split("\n").length).toBe(1);
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
    expect(report.refsLeft).toEqual(["added refs/heads/side"]);
  });

  test("other branches and tags are never moved, created or deleted; the diff is reported", async () => {
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
    const report = await restoreRepoSnapshot(snap);
    expect(await git(d, "rev-parse", "main")).toBe(base);
    expect(await git(d, "rev-parse", "other")).toBe(fresh);
    expect(await git(d, "tag", "--list")).toBe("t");
    expect(await git(d, "branch", "--list", "gone")).toBe("");
    expect([...report.refsLeft].sort()).toEqual([
      "added refs/tags/t",
      "deleted refs/heads/gone",
      "moved refs/heads/other",
    ]);
  });

  test("a pre-existing stash popped by the reviewer is not stored back, only reported", async () => {
    const d = await repo();
    await writeFile(join(d, "a.txt"), "stashed\n");
    await git(d, "stash", "push", "-q");
    const sha = await git(d, "rev-parse", "stash@{0}");
    const snap = await takeRepoSnapshot(d);
    await git(d, "stash", "pop", "-q");
    const report = await restoreRepoSnapshot(snap);
    expect(report.failures).toEqual([]);
    expect(await git(d, "stash", "list")).toBe("");
    expect(report.stashLeft).toEqual([`missing ${sha}`]);
    expect(await readFile(join(d, "a.txt"), "utf8")).toBe("a\n");
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

describe("reviewer ignore-rule edits cannot hide files from the restore (#2552)", () => {
  test("appending a pattern to .gitignore and creating a matching file: the file is removed, the rule reverted", async () => {
    const d = await repo();
    const snap = await takeRepoSnapshot(d);
    await writeFile(join(d, ".gitignore"), "ignored/\nplanted*\n");
    await writeFile(join(d, "planted1.sh"), "echo planted\n");
    const report = await restoreRepoSnapshot(snap);
    expect(existsSync(join(d, "planted1.sh"))).toBe(false);
    expect(await readFile(join(d, ".gitignore"), "utf8")).toBe("ignored/\n");
    expect([...report.paths].sort()).toEqual([".gitignore", "planted1.sh"]);
    expect(report.failures).toEqual([]);
    expect(await git(d, "status", "--porcelain")).toBe("");
  });

  test("a reviewer-created nested .gitignore that ignores itself and its siblings is removed with them", async () => {
    const d = await repo();
    const snap = await takeRepoSnapshot(d);
    await mkdir(join(d, "sub"), { recursive: true });
    await writeFile(join(d, "sub", ".gitignore"), "*\n");
    await writeFile(join(d, "sub", "hook.sh"), "echo planted\n");
    const report = await restoreRepoSnapshot(snap);
    expect(existsSync(join(d, "sub", "hook.sh"))).toBe(false);
    expect(existsSync(join(d, "sub", ".gitignore"))).toBe(false);
    expect([...report.paths].sort()).toEqual(["sub/.gitignore", "sub/hook.sh"]);
  });

  // The node_modules/x/.gitignore and .pytest_cache/.gitignore case: an ignored .gitignore the review never
  // touched is not the reviewer's, so a clean restore keeps it and reports nothing.
  test("a pre-existing .gitignore inside an ignored directory survives a clean restore", async () => {
    const d = await repo();
    await mkdir(join(d, "ignored", "pkg"), { recursive: true });
    await writeFile(join(d, "ignored", "pkg", ".gitignore"), "*.log\n");
    const snap = await takeRepoSnapshot(d);
    const report = await restoreRepoSnapshot(snap);
    expect(report.paths).toEqual([]);
    expect(existsSync(join(d, "ignored", "pkg", ".gitignore"))).toBe(true);
  });

  test("with no snapshot-time .gitignore list, a reviewer-added visible one is still removed (fail closed)", async () => {
    const d = await repo();
    const snap = { ...(await takeRepoSnapshot(d)), ignoreFiles: null };
    await writeFile(join(d, ".gitignore"), "ignored/\nplanted*\n");
    await mkdir(join(d, "pkg2"), { recursive: true });
    await writeFile(join(d, "pkg2", ".gitignore"), "x\n");
    await writeFile(join(d, "planted1.sh"), "echo planted\n");
    const report = await restoreRepoSnapshot(snap);
    expect(existsSync(join(d, "pkg2", ".gitignore"))).toBe(false);
    expect(existsSync(join(d, "planted1.sh"))).toBe(false);
    expect(report.failures.some((f) => f.includes("snapshot-time .gitignore list unavailable"))).toBe(true);
  });

  test("a pre-existing ignored path stays untouched after a clean restore", async () => {
    const d = await repo();
    await mkdir(join(d, "ignored"), { recursive: true });
    await writeFile(join(d, "ignored", "cache"), "x\n");
    const snap = await takeRepoSnapshot(d);
    const report = await restoreRepoSnapshot(snap);
    expect(report.paths).toEqual([]);
    expect(existsSync(join(d, "ignored", "cache"))).toBe(true);
  });
});

describe("US-007 defensive restore", () => {
  test.each(["snapshotWorkingTree", "changedPathsBetween"] as const)(
    "AC1-5: %s failure restores snapshot blobs only and retains diagnostics",
    async (seam) => {
      const d = await repo();
      const held = "packages/x/.nax/features/f/prd.json";
      await mkdir(join(d, "packages/x/.nax/features/f"), { recursive: true });
      await writeFile(join(d, held), "snapshot state");
      await git(d, "add", "-A");
      await git(d, "update-index", "--add", "--cacheinfo", `160000,${await git(d, "rev-parse", "HEAD")},nest`);
      const snap = { ...(await takeRepoSnapshot(d)), tree: await git(d, "write-tree") };
      const keeper = new RunStateKeeper("test", "f");
      keepers.push(keeper);
      registerKeeper(keeper);
      await runStateWrite(join(d, held), { content: "live state" }, () => writeFile(join(d, held), "live state"));
      await writeFile(join(d, "a.txt"), "reviewer edit");
      await writeFile(join(d, "new.txt"), "untracked");
      const checkouts: string[] = [];
      _snapshotDeps.git = async (args, cwd) => {
        if (args[0] === "checkout") checkouts.push(...args.slice(3));
        return deps.git(args, cwd);
      };
      _snapshotDeps[seam] = async () => {
        throw new Error("snapshot comparison failed");
      };
      const report = await restoreRepoSnapshot(snap);
      expect(await readFile(join(d, "a.txt"), "utf8")).toBe("a\n");
      expect(report).toMatchObject({ fallback: "tracked-only", paths: [".gitignore", "a.txt", "pkg/b.txt"] });
      expect(report.failures).toContain("tree: snapshot comparison failed");
      expect(checkouts).toContain(":(top,literal)a.txt");
      expect(checkouts).not.toContain(`:(top,literal)${held}`);
      expect(checkouts).not.toContain(":(top,literal)nest");
      expect(await readFile(join(d, held), "utf8")).toBe("live state");
      expect(existsSync(join(d, "new.txt"))).toBe(true);
      expect(isKeeperOwnedPath(d, held)).toBe(true);
    },
  );

  test("AC8-9: only a live keeper entry exempts a path, not its shape or feature", () => {
    const rel = "packages/x/.nax/features/f/prd.json";
    expect(isKeeperOwnedPath("/repo", rel)).toBe(false);
    const keeper = new RunStateKeeper("test", "f");
    keepers.push(keeper);
    registerKeeper(keeper);
    expect(isKeeperOwnedPath("/repo", rel)).toBe(false);
    keeper.record(
      join("/repo", rel),
      { root: "/repo/packages/x", feature: "f", kind: "prd", rel: ".nax/features/f/prd.json" },
      "{}",
    );
    expect(isKeeperOwnedPath("/repo", rel)).toBe(true);
    unregisterKeeper(keeper);
    expect(isKeeperOwnedPath("/repo", rel)).toBe(false);
  });

  test.each([false, true])("AC6-7: index.lock wait, held through deadline=%s", async (held) => {
    const d = await repo();
    const snap = await takeRepoSnapshot(d);
    await writeFile(join(d, "a.txt"), "reviewer");
    const lock = join(d, await git(d, "rev-parse", "--git-path", "index.lock"));
    await writeFile(lock, "locked");
    let now = 0;
    const sleeps: number[] = [];
    Object.assign(_snapshotDeps, {
      now: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += ms;
        if (!held && now === 200) await rm(lock);
      },
    });
    const report = await restoreRepoSnapshot(snap);
    expect(sleeps.length).toBe(held ? 50 : 2);
    expect(sleeps.every((ms) => ms === 100)).toBe(true);
    expect(report.failures.includes("index.lock held")).toBe(held);
    if (!held) {
      expect(report.failures).toEqual([]);
      expect(await readFile(join(d, "a.txt"), "utf8")).toBe("a\n");
    }
  });
});
