import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { restoreRepoSnapshot, takeRepoSnapshot } from "@/review/reviewer-guard";
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
  const d = await realpath(await mkdtemp(join(tmpdir(), "nax-rguard-fb-")));
  dirs.push(d);
  await git(d, "init", "-q", "-b", "main");
  await writeFile(join(d, ".gitignore"), "ignored/\n.nax-wt/\n");
  await writeFile(join(d, "a.txt"), "a\n");
  await git(d, "add", "-A");
  await git(d, "commit", "-q", "-m", "seed");
  return d;
}

// nax#2700: when the restore-time comparison fails, the tracked-only fallback must still
// remove what the reviewer added to a visible path.
describe("reviewer guard tracked-only fallback (nax#2700)", () => {
  test("a commit-less nested repo and a planted file are both removed", async () => {
    const d = await repo();
    const snap = await takeRepoSnapshot(d);
    await writeFile(join(d, "payload.ts"), "planted\n");
    await git(d, "init", "-q", "planted");
    await writeFile(join(d, "a.txt"), "reviewer edit\n");
    const report = await restoreRepoSnapshot(snap);
    expect(report.fallback).toBe("tracked-only");
    expect(existsSync(join(d, "payload.ts"))).toBe(false);
    expect(existsSync(join(d, "planted"))).toBe(false);
    expect(await readFile(join(d, "a.txt"), "utf8")).toBe("a\n");
    expect(report.paths).toEqual(expect.arrayContaining(["payload.ts", "planted/"]));
  });

  test("a planted file the reviewer staged is removed", async () => {
    const d = await repo();
    const snap = await takeRepoSnapshot(d);
    await writeFile(join(d, "staged.ts"), "planted\n");
    await git(d, "add", "staged.ts");
    _snapshotDeps.snapshotWorkingTree = async () => {
      throw new Error("comparison failed");
    };
    const report = await restoreRepoSnapshot(snap);
    expect(report.fallback).toBe("tracked-only");
    expect(existsSync(join(d, "staged.ts"))).toBe(false);
    expect(await git(d, "ls-files", "staged.ts")).toBe("");
  });

  test("snapshot-time untracked files, ignored additions and ignored worktrees are kept", async () => {
    const d = await repo();
    await mkdir(join(d, "keep"), { recursive: true });
    await writeFile(join(d, "keep", "old.txt"), "untracked before the turn\n");
    const snap = await takeRepoSnapshot(d);
    await writeFile(join(d, "keep", "new.txt"), "planted\n");
    await mkdir(join(d, "ignored"), { recursive: true });
    await writeFile(join(d, "ignored", "cache"), "x\n");
    await git(d, "worktree", "add", "-q", "--detach", join(d, ".nax-wt", "bot-x"), "HEAD");
    _snapshotDeps.snapshotWorkingTree = async () => {
      throw new Error("comparison failed");
    };
    const report = await restoreRepoSnapshot(snap);
    expect(report.fallback).toBe("tracked-only");
    expect(await readFile(join(d, "keep", "old.txt"), "utf8")).toBe("untracked before the turn\n");
    expect(existsSync(join(d, "keep", "new.txt"))).toBe(false);
    expect(existsSync(join(d, "ignored", "cache"))).toBe(true);
    expect(existsSync(join(d, ".nax-wt", "bot-x", "a.txt"))).toBe(true);
  });

  // keep/ holds only snapshot-time untracked files; pkg/ holds tracked ones. A planted .git in pkg/
  // does not break the comparison, so the fallback is forced to show it handles that shape too.
  test.each(["keep", "pkg"])(
    "a nested repo planted over the snapshot directory %s/ cannot hide new files",
    async (dir) => {
      const d = await repo();
      await mkdir(join(d, "keep"), { recursive: true });
      await writeFile(join(d, "keep", "old.txt"), "untracked before the turn\n");
      await mkdir(join(d, "pkg"), { recursive: true });
      await writeFile(join(d, "pkg", "b.txt"), "b\n");
      await git(d, "add", "pkg");
      await git(d, "commit", "-q", "-m", "pkg");
      const snap = await takeRepoSnapshot(d);
      await git(join(d, dir), "init", "-q");
      await writeFile(join(d, dir, "payload.ts"), "planted\n");
      if (dir === "pkg") {
        _snapshotDeps.snapshotWorkingTree = async () => {
          throw new Error("comparison failed");
        };
      }
      const report = await restoreRepoSnapshot(snap);
      expect(report.fallback).toBe("tracked-only");
      expect(existsSync(join(d, dir, "payload.ts"))).toBe(false);
      // In keep/ git sees only the nested repo and the whole dir goes; in pkg/ the tracked files keep git
      // listing inside it, so the payload goes but the inert .git (never listed by git) stays.
      expect(existsSync(join(d, dir, ".git"))).toBe(dir === "pkg");
      expect(await readFile(join(d, "keep", "old.txt"), "utf8")).toBe("untracked before the turn\n");
      expect(await readFile(join(d, "pkg", "b.txt"), "utf8")).toBe("b\n");
    },
  );

  // The symlink's name matches a snapshot ignore rule, so `-o` never lists the link itself and only
  // the forged index entry under it reaches the removal.
  test("an index entry under a planted, ignored symlink is not followed outside the checkout", async () => {
    const d = await repo();
    await writeFile(join(d, ".gitignore"), "ignored/\n.nax-wt/\nlinked\n");
    await git(d, "commit", "-qam", "ignore linked");
    const outside = await realpath(await mkdtemp(join(tmpdir(), "nax-rguard-out-")));
    dirs.push(outside);
    await writeFile(join(outside, "victim.txt"), "keep me\n");
    const snap = await takeRepoSnapshot(d);
    await symlink(outside, join(d, "linked"));
    const blob = await git(d, "hash-object", "-w", join(outside, "victim.txt"));
    await git(d, "update-index", "--add", "--cacheinfo", `100644,${blob},linked/victim.txt`);
    _snapshotDeps.snapshotWorkingTree = async () => {
      throw new Error("comparison failed");
    };
    const report = await restoreRepoSnapshot(snap);
    expect(await readFile(join(outside, "victim.txt"), "utf8")).toBe("keep me\n");
    expect(report.failures.some((f) => f.startsWith("remove linked/victim.txt:"))).toBe(true);
  });

  test("a failed listing is recorded and the snapshot paths are still restored", async () => {
    const d = await repo();
    const snap = await takeRepoSnapshot(d);
    await writeFile(join(d, "a.txt"), "reviewer edit\n");
    _snapshotDeps.snapshotWorkingTree = async () => {
      throw new Error("comparison failed");
    };
    _snapshotDeps.git = async (args, cwd) =>
      args[0] === "ls-files" && args.includes("-c")
        ? { exitCode: 1, stdout: "", stderr: "ls-files failed" }
        : deps.git(args, cwd);
    const report = await restoreRepoSnapshot(snap);
    expect(report.fallback).toBe("tracked-only");
    expect(report.failures.some((f) => f.startsWith("additions:"))).toBe(true);
    expect(await readFile(join(d, "a.txt"), "utf8")).toBe("a\n");
  });

  test("a nested repo known to the snapshot is kept", async () => {
    const d = await repo();
    await mkdir(join(d, "nest"), { recursive: true });
    await git(join(d, "nest"), "init", "-q", "-b", "main");
    await writeFile(join(d, "nest", "n.txt"), "n\n");
    await git(join(d, "nest"), "add", "-A");
    await git(join(d, "nest"), "commit", "-q", "-m", "nest seed");
    const snap = await takeRepoSnapshot(d);
    _snapshotDeps.snapshotWorkingTree = async () => {
      throw new Error("comparison failed");
    };
    const report = await restoreRepoSnapshot(snap);
    expect(report.fallback).toBe("tracked-only");
    expect(existsSync(join(d, "nest", "n.txt"))).toBe(true);
  });

  // The real index is reviewer-writable as raw bytes, so a listed path is not trusted to be a path git
  // would ever write: one that leaves the checkout, enters .git, or sits under a snapshot gitlink is refused.
  test("forged index paths outside the checkout, in .git or under a snapshot gitlink are refused", async () => {
    const d = await repo();
    await mkdir(join(d, "nest"), { recursive: true });
    await git(join(d, "nest"), "init", "-q", "-b", "main");
    await writeFile(join(d, "nest", "n.txt"), "n\n");
    await git(join(d, "nest"), "add", "-A");
    await git(join(d, "nest"), "commit", "-q", "-m", "nest seed");
    const victim = `${d}-victim.txt`;
    dirs.push(victim);
    await writeFile(victim, "keep me\n");
    const snap = await takeRepoSnapshot(d);
    const forged = [`../${basename(victim)}`, ".git/HEAD", ".GIT/config", "nest/n.txt", "a/./b", ""].join("\0");
    _snapshotDeps.snapshotWorkingTree = async () => {
      throw new Error("comparison failed");
    };
    _snapshotDeps.git = async (args, cwd) =>
      args[0] === "ls-files" && args.includes("-c") ? { exitCode: 0, stdout: forged, stderr: "" } : deps.git(args, cwd);
    const report = await restoreRepoSnapshot(snap);
    expect(await readFile(victim, "utf8")).toBe("keep me\n");
    expect(existsSync(join(d, ".git", "HEAD"))).toBe(true);
    expect(existsSync(join(d, "nest", "n.txt"))).toBe(true);
    for (const p of [`../${basename(victim)}`, ".git/HEAD", ".GIT/config", "nest/n.txt", "a/./b"]) {
      expect(report.failures.some((f) => f.startsWith(`remove ${p}:`))).toBe(true);
    }
  });

  test("live keeper state inside a planted nested repo is kept; the planted files go", async () => {
    const d = await repo();
    const snap = await takeRepoSnapshot(d);
    await git(d, "init", "-q", "pkgx");
    await writeFile(join(d, "pkgx", "payload.ts"), "planted\n");
    await mkdir(join(d, "pkgx", ".nax", "features", "f"), { recursive: true });
    const keeper = new RunStateKeeper("test", "f");
    keepers.push(keeper);
    registerKeeper(keeper);
    const held = join(d, "pkgx", ".nax", "features", "f", "prd.json");
    await runStateWrite(held, { content: "live state" }, () => writeFile(held, "live state"));
    const report = await restoreRepoSnapshot(snap);
    expect(report.fallback).toBe("tracked-only");
    expect(await readFile(held, "utf8")).toBe("live state");
    expect(existsSync(join(d, "pkgx", "payload.ts"))).toBe(false);
    expect(existsSync(join(d, "pkgx", ".git"))).toBe(false);
  });

  test("an ignored file the user force-staged before the turn is kept", async () => {
    const d = await repo();
    await mkdir(join(d, "ignored"), { recursive: true });
    await writeFile(join(d, "ignored", "forced.txt"), "user work\n");
    await git(d, "add", "-f", "ignored/forced.txt");
    const snap = await takeRepoSnapshot(d);
    _snapshotDeps.snapshotWorkingTree = async () => {
      throw new Error("comparison failed");
    };
    const report = await restoreRepoSnapshot(snap);
    expect(report.fallback).toBe("tracked-only");
    expect(await readFile(join(d, "ignored", "forced.txt"), "utf8")).toBe("user work\n");
    expect(await git(d, "ls-files", "ignored/forced.txt")).toBe("ignored/forced.txt");
  });

  test("a .gitignore planted inside a planted nested repo cannot hide its payload", async () => {
    const d = await repo();
    const snap = await takeRepoSnapshot(d);
    await git(d, "init", "-q", "planted");
    await writeFile(join(d, "planted", ".gitignore"), "*\n");
    await writeFile(join(d, "planted", "payload.ts"), "planted\n");
    const report = await restoreRepoSnapshot(snap);
    expect(report.fallback).toBe("tracked-only");
    expect(existsSync(join(d, "planted"))).toBe(false);
  });

  test("keeper state under a planted nested repo is kept; its planted .gitignore and payload go", async () => {
    const d = await repo();
    const snap = await takeRepoSnapshot(d);
    await git(d, "init", "-q", "pkgx");
    await writeFile(join(d, "pkgx", ".gitignore"), "*\n");
    await writeFile(join(d, "pkgx", "payload.ts"), "planted\n");
    await mkdir(join(d, "pkgx", ".nax", "features", "f"), { recursive: true });
    const keeper = new RunStateKeeper("test", "f");
    keepers.push(keeper);
    registerKeeper(keeper);
    const held = join(d, "pkgx", ".nax", "features", "f", "prd.json");
    await runStateWrite(held, { content: "live state" }, () => writeFile(held, "live state"));
    const report = await restoreRepoSnapshot(snap);
    expect(report.fallback).toBe("tracked-only");
    expect(await readFile(held, "utf8")).toBe("live state");
    expect(existsSync(join(d, "pkgx", "payload.ts"))).toBe(false);
    expect(existsSync(join(d, "pkgx", ".gitignore"))).toBe(false);
  });

  // The snapshot index also holds paths absent from disk (staged, then deleted). Only an ignored one,
  // the force-staged case, is the snapshot's; a reviewer recreating the other kind is removed.
  test("a file recreated at a staged-then-deleted path is removed", async () => {
    const d = await repo();
    await writeFile(join(d, "foo.ts"), "user\n");
    await git(d, "add", "foo.ts");
    await rm(join(d, "foo.ts"));
    const snap = await takeRepoSnapshot(d);
    await writeFile(join(d, "foo.ts"), "planted\n");
    await git(d, "init", "-q", "planted");
    const report = await restoreRepoSnapshot(snap);
    expect(report.fallback).toBe("tracked-only");
    expect(existsSync(join(d, "foo.ts"))).toBe(false);
  });
});
