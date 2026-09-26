/**
 * Working-tree snapshot helpers against a real git repository (US-002).
 *
 * `snapshotWorkingTree` / `changedPathsBetween` / `diffBetween`
 * (`src/review/fix-review/tree-snapshot.ts`) exist because the review collectors
 * cannot answer "what did this fix change in the working tree?": the helpers in
 * `src/review/diff-utils.ts` are pinned to `<ref>..HEAD`, and
 * `captureWorkingTreeChanges` returns `[]` on any git failure while listing
 * every untracked file, pre-existing ones included.
 *
 * Real git in a throwaway repository is the point of these tests — the contract
 * is about what git reports (tree ids, repo-root-relative path spelling,
 * `.gitignore` handling, a non-zero exit) and only git can evidence it. The
 * repository's own state is never touched: every fixture lives under a
 * `makeTempDir()` directory, and the fixture repo is a fresh `git init`.
 *
 * AC7's "workdir is the package subdirectory" case pins the subtle part: git
 * prints repo-root-relative paths even when the process cwd is the package, and
 * the fix review needs that spelling (ADR-032).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertNaxError, cleanupTempDir, makeTempDir, withTempDir } from "@test/helpers";
import { NaxError } from "@/errors";
import {
  _treeSnapshotDeps,
  changedPathsBetween,
  diffBetween,
  snapshotWorkingTree,
} from "@/review/fix-review/tree-snapshot";

let testDir: string;
let repo: string;

/** Run git in the throwaway fixture. Throws on a non-zero exit, so a broken fixture cannot look like a failing assertion. */
async function git(args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`[fix-review-tree-fixture] git ${args.join(" ")} exited ${exitCode}: ${stderr.trim()}`);
  }
  return stdout.trim();
}

function write(relPath: string, contents: string): void {
  const abs = join(repo, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, contents);
}

/**
 * Settle a promise into its rejection reason (or `undefined` when it resolved),
 * so a call that should reject is asserted on instead of awaited blindly.
 */
async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return err;
  }
}

beforeEach(async () => {
  testDir = makeTempDir("fix-review-tree-");
  repo = join(testDir, "repo");
  mkdirSync(repo, { recursive: true });

  await git(["init"]);
  await git(["config", "user.email", "fix-review@example.com"]);
  await git(["config", "user.name", "Fix Review"]);

  write(".gitignore", "*.log\nbuild/\n");
  write("src/a.ts", "export const a = 1;\n");
  write("packages/a/src/x.ts", "export const x = 1;\n");
  write("packages/b/src/y.ts", "export const y = 1;\n");
  await git(["add", "."]);
  await git(["commit", "-m", "chore: initial commit"]);
});

afterEach(() => {
  cleanupTempDir(testDir);
});

describe("snapshotWorkingTree", () => {
  test("AC1: returns the tree id of HEAD for a clean repository", async () => {
    const headTree = await git(["rev-parse", "HEAD^{tree}"]);

    expect(await snapshotWorkingTree(repo)).toBe(headTree);
  });

  test("AC1: an ignored untracked file leaves the snapshot equal to HEAD's tree", async () => {
    const headTree = await git(["rev-parse", "HEAD^{tree}"]);
    write("src/debug.log", "noise\n");
    write("build/out.txt", "noise\n");

    expect(await snapshotWorkingTree(repo)).toBe(headTree);
  });

  test("AC6: leaves staged paths and working-tree status untouched when tracked and untracked changes exist", async () => {
    write("src/a.ts", "export const a = 2;\n");
    await git(["add", "src/a.ts"]);
    write("src/a.ts", "export const a = 3;\n"); // staged, then edited again
    write("src/new.ts", "export const n = 1;\n"); // untracked

    const statusBefore = await git(["status", "--porcelain"]);
    const stagedBefore = await git(["diff", "--cached"]);
    expect(statusBefore).toContain("src/a.ts"); // sanity: the fixture is dirty

    const tree = await snapshotWorkingTree(repo);

    // Asserted so a no-op cannot pass this test: not disturbing the index is
    // only meaningful once the snapshot actually ran.
    expect(tree).toMatch(/^[0-9a-f]{40}$/);
    expect(await git(["status", "--porcelain"])).toBe(statusBefore);
    expect(await git(["diff", "--cached"])).toBe(stagedBefore);
  });

  test("AC6: leaves a staged-only change in the repository index", async () => {
    write("src/a.ts", "export const a = 2;\n");
    await git(["add", "src/a.ts"]);

    const statusBefore = await git(["status", "--porcelain"]);
    const stagedBefore = await git(["diff", "--cached"]);

    const tree = await snapshotWorkingTree(repo);

    expect(tree).toMatch(/^[0-9a-f]{40}$/);
    expect(await git(["status", "--porcelain"])).toBe(statusBefore);
    expect(await git(["diff", "--cached"])).toBe(stagedBefore);
  });

  test("AC9: rejects with FIX_REVIEW_GIT_FAILED outside a git repository", async () => {
    await withTempDir(async (outsideRepo) => {
      const err = await captureRejection(snapshotWorkingTree(outsideRepo));

      expect(err).toBeInstanceOf(NaxError);
      assertNaxError(err, "snapshotWorkingTree outside a git repository");
      expect(err.code).toBe("FIX_REVIEW_GIT_FAILED");
    });
  });

  test("reclaims its throwaway index directory with a recursive rm", async () => {
    const rmCalls: { path: string; options?: { recursive?: boolean; force?: boolean } }[] = [];
    const origRm = _treeSnapshotDeps.rm;
    Object.assign(_treeSnapshotDeps, {
      rm: async (path: string, options?: { recursive?: boolean; force?: boolean }) => {
        rmCalls.push({ path, options });
        return origRm(path, options);
      },
    });
    try {
      await snapshotWorkingTree(repo);
    } finally {
      Object.assign(_treeSnapshotDeps, { rm: origRm });
    }

    // A non-recursive `fs.rm` on a directory rejects ERR_FS_EISDIR and would
    // leave the temp dir behind on every snapshot; the options are load-bearing.
    expect(rmCalls).toHaveLength(1);
    expect(rmCalls[0]?.options).toEqual({ recursive: true, force: true });
    expect(existsSync(rmCalls[0]?.path ?? "")).toBe(false);
  });
});

describe("changedPathsBetween", () => {
  test("AC2: reports the edited tracked file", async () => {
    write("src/a.ts", "export const a = 2;\n");

    const paths = await changedPathsBetween(repo, "HEAD", await snapshotWorkingTree(repo));

    expect(paths).toEqual(["src/a.ts"]);
  });

  test("AC2: two identical tree-ishes differ in nothing", async () => {
    const tree = await snapshotWorkingTree(repo);

    expect(tree).toMatch(/^[0-9a-f]{40}$/);
    expect(await changedPathsBetween(repo, tree, tree)).toEqual([]);
  });

  test("AC3: reports an untracked file in a nested directory", async () => {
    write("src/nested/deep.ts", "export const deep = 1;\n");

    const paths = await changedPathsBetween(repo, "HEAD", await snapshotWorkingTree(repo));

    expect(paths).toContain("src/nested/deep.ts");
    expect(paths).not.toContain("src/a.ts");
  });

  test("AC3: reports every untracked file alongside the tracked edit", async () => {
    write("src/a.ts", "export const a = 2;\n");
    write("src/new.ts", "export const n = 1;\n");
    write("src/second.ts", "export const second = 1;\n");

    const paths = await changedPathsBetween(repo, "HEAD", await snapshotWorkingTree(repo));

    expect(paths).toContain("src/a.ts");
    expect(paths).toContain("src/new.ts");
    expect(paths).toContain("src/second.ts");
  });

  test("AC4: omits gitignored files but still reports a non-ignored sibling", async () => {
    write("src/ignored.log", "noise\n"); // *.log
    write("build/out.txt", "noise\n"); // build/
    write("src/kept.ts", "export const kept = 1;\n");

    const paths = await changedPathsBetween(repo, "HEAD", await snapshotWorkingTree(repo));

    expect(paths).not.toContain("src/ignored.log");
    expect(paths).not.toContain("build/out.txt");
    expect(paths).toContain("src/kept.ts");
  });

  test("AC5: omits an untracked file that existed before both snapshots", async () => {
    write("src/pre-existing.ts", "export const p = 1;\n");
    const before = await snapshotWorkingTree(repo);
    write("src/a.ts", "export const a = 2;\n");
    const after = await snapshotWorkingTree(repo);

    const paths = await changedPathsBetween(repo, before, after);

    expect(paths).toContain("src/a.ts");
    expect(paths).not.toContain("src/pre-existing.ts");
  });

  test("AC5: reports an untracked file created between the two snapshots", async () => {
    write("src/pre-existing.ts", "export const p = 1;\n");
    const before = await snapshotWorkingTree(repo);
    write("src/a.ts", "export const a = 2;\n");
    write("src/newer.ts", "export const newer = 1;\n");
    const after = await snapshotWorkingTree(repo);

    const paths = await changedPathsBetween(repo, before, after);

    expect(paths).toContain("src/a.ts");
    expect(paths).toContain("src/newer.ts");
    expect(paths).not.toContain("src/pre-existing.ts");
  });

  test("AC7: reports repo-root-relative paths when the workdir is a package subdirectory", async () => {
    write("packages/a/src/x.ts", "export const x = 2;\n");
    const pkgDir = join(repo, "packages/a");

    const paths = await changedPathsBetween(pkgDir, "HEAD", await snapshotWorkingTree(pkgDir));

    expect(paths).toEqual(["packages/a/src/x.ts"]);
  });

  test("AC7: reports an untracked file inside the package with its repo-root-relative path", async () => {
    write("packages/a/src/new.ts", "export const n = 1;\n");
    const pkgDir = join(repo, "packages/a");

    const paths = await changedPathsBetween(pkgDir, "HEAD", await snapshotWorkingTree(pkgDir));

    expect(paths).toEqual(["packages/a/src/new.ts"]);
  });

  test("AC8: rejects with FIX_REVIEW_GIT_FAILED for an unknown from ref", async () => {
    const err = await captureRejection(changedPathsBetween(repo, "no-such-ref", "HEAD"));

    expect(err).toBeInstanceOf(NaxError);
    assertNaxError(err, "changedPathsBetween with an unknown from ref");
    expect(err.code).toBe("FIX_REVIEW_GIT_FAILED");
  });

  test("AC8: rejects with FIX_REVIEW_GIT_FAILED for an unknown to ref rather than reporting no changes", async () => {
    const err = await captureRejection(changedPathsBetween(repo, "HEAD", "no-such-ref"));

    expect(err).toBeInstanceOf(NaxError);
    assertNaxError(err, "changedPathsBetween with an unknown to ref");
    expect(err.code).toBe("FIX_REVIEW_GIT_FAILED");
  });

  test("AC9: rejects with FIX_REVIEW_GIT_FAILED outside a git repository", async () => {
    await withTempDir(async (outsideRepo) => {
      const err = await captureRejection(changedPathsBetween(outsideRepo, "HEAD", "HEAD"));

      expect(err).toBeInstanceOf(NaxError);
      assertNaxError(err, "changedPathsBetween outside a git repository");
      expect(err.code).toBe("FIX_REVIEW_GIT_FAILED");
    });
  });
});

describe("diffBetween", () => {
  test("AC10: returns the fix's changed line and no hunk for a file under .nax/", async () => {
    write("src/a.ts", 'export const greeting = "hello from the fix";\n');
    write(".nax/state.json", '{"status":"running"}\n');

    const diff = await diffBetween(repo, "HEAD", await snapshotWorkingTree(repo));

    expect(diff).toContain('export const greeting = "hello from the fix";');
    expect(diff).not.toContain(".nax");
  });

  test("AC10: excludes .nax/ paths that are tracked, not only untracked ones", async () => {
    write(".nax/tracked.json", '{"v":1}\n');
    await git(["add", ".nax/tracked.json"]);
    await git(["commit", "-m", "chore: track a nax state file"]);
    write("src/a.ts", 'export const greeting = "hello from the fix";\n');
    write(".nax/tracked.json", '{"v":2}\n');

    const diff = await diffBetween(repo, "HEAD", await snapshotWorkingTree(repo));

    expect(diff).toContain('export const greeting = "hello from the fix";');
    expect(diff).not.toContain(".nax");
  });

  test("AC10: rejects with FIX_REVIEW_GIT_FAILED for an unknown ref rather than returning an empty diff", async () => {
    const err = await captureRejection(diffBetween(repo, "no-such-ref", "HEAD"));

    expect(err).toBeInstanceOf(NaxError);
    assertNaxError(err, "diffBetween with an unknown ref");
    expect(err.code).toBe("FIX_REVIEW_GIT_FAILED");
  });
});

/**
 * #2210: a nested repository the agent created can name a filter driver in its
 * own config. A plain `git add -A` dirty-checks every gitlink by running git
 * inside it, which runs that driver under nax's unsandboxed git. The snapshot
 * must stage gitlinks without recursing, and still record the nested HEAD.
 */
describe("snapshotWorkingTree — #2210 nested-repo filter driver", () => {
  let dir: string;
  let top: string;
  let marker: string;

  function run(args: string[], cwd: string): string {
    const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  }

  beforeEach(async () => {
    dir = makeTempDir("fix-review-2210-");
    top = join(dir, "top");
    marker = join(dir, "filter-ran");
    const driver = join(dir, "filter.sh");
    writeFileSync(driver, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
    Bun.spawnSync(["chmod", "+x", driver]);
    run(["init", "-q", "top"], dir);
    run(["config", "user.email", "t@t"], top);
    run(["config", "user.name", "t"], top);
    writeFileSync(join(top, "a.txt"), "a\n");
    run(["add", "a.txt"], top);
    run(["commit", "-qm", "init"], top);

    const nested = join(top, "nested");
    run(["init", "-q", "nested"], top);
    run(["config", "user.email", "t@t"], nested);
    run(["config", "user.name", "t"], nested);
    run(["config", "filter.x.clean", driver], nested);
    writeFileSync(join(nested, ".gitattributes"), "* filter=x\n");
    writeFileSync(join(nested, "f.txt"), "v0\n");
    run(["add", "."], nested);
    run(["commit", "-qm", "nested"], nested);
    run(["add", "nested"], top);
    run(["commit", "-qm", "gitlink"], top);
    // The nested repo's own `git add` above ran its filter; start clean, then
    // dirty the nested file so any dirty check must re-clean it.
    if (existsSync(marker)) Bun.spawnSync(["rm", marker]);
    writeFileSync(join(nested, "f.txt"), "v1\n");
  });
  afterEach(() => cleanupTempDir(dir));

  test("does not run the nested filter, and records the nested HEAD as the gitlink", async () => {
    writeFileSync(join(top, "a.txt"), "changed\n");

    const tree = await snapshotWorkingTree(top);

    expect(existsSync(marker)).toBe(false);
    const nestedHead = run(["rev-parse", "HEAD"], join(top, "nested"));
    expect(run(["ls-tree", tree, "nested"], top)).toContain(`160000 commit ${nestedHead}`);
    expect(run(["cat-file", "-p", `${tree}:a.txt`], top)).toBe("changed");
  });
});

/**
 * Hardening from the discarded NBF commit 268d13fe0 (points 3, 4, 5): the two
 * path helpers must agree on scope, survive awkward file names, and accept
 * SHA-256 object ids.
 */
describe("tree-snapshot hardening", () => {
  test("diffBetween from a package workdir shows the same repo-wide changes changedPathsBetween reports", async () => {
    write("packages/a/src/x.ts", "export const x = 2;\n");
    write("packages/b/src/y.ts", "export const y = 2;\n");
    const pkgDir = join(repo, "packages/a");
    const tree = await snapshotWorkingTree(pkgDir);

    const paths = await changedPathsBetween(pkgDir, "HEAD", tree);
    const diff = await diffBetween(pkgDir, "HEAD", tree);

    expect(paths).toEqual(["packages/a/src/x.ts", "packages/b/src/y.ts"]);
    for (const path of paths) expect(diff).toContain(`+++ b/${path}`);
  });

  test("changedPathsBetween keeps non-ASCII names and surrounding spaces verbatim", async () => {
    write("src/café.ts", "export const c = 1;\n");
    write("src/ spaced .ts", "export const s = 1;\n");

    const paths = await changedPathsBetween(repo, "HEAD", await snapshotWorkingTree(repo));

    expect([...paths].sort()).toEqual(["src/ spaced .ts", "src/café.ts"]);
  });

  test("snapshotWorkingTree accepts a SHA-256 repository's 64-hex tree id", async () => {
    const shaRepo = join(testDir, "sha256");
    mkdirSync(shaRepo, { recursive: true });
    const run = (args: string[]) => {
      const r = Bun.spawnSync(["git", ...args], { cwd: shaRepo, stdout: "pipe", stderr: "pipe" });
      if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    };
    run(["init", "-q", "--object-format=sha256"]);
    run(["config", "user.email", "t@t"]);
    run(["config", "user.name", "t"]);
    writeFileSync(join(shaRepo, "a.txt"), "a\n");
    run(["add", "a.txt"]);
    run(["commit", "-qm", "init"]);
    writeFileSync(join(shaRepo, "a.txt"), "b\n");

    const tree = await snapshotWorkingTree(shaRepo);

    expect(tree).toMatch(/^[0-9a-f]{64}$/);
    expect(await changedPathsBetween(shaRepo, "HEAD", tree)).toEqual(["a.txt"]);
  });
});

/**
 * A wedged git (a huge monorepo `add -A`, a lock held by another process) must
 * not hang the fix review: every git call is bounded, and a timeout surfaces as
 * FIX_REVIEW_GIT_FAILED rather than an unbounded wait.
 */
describe("tree-snapshot git timeout", () => {
  test("a git call that never exits is killed and fails with FIX_REVIEW_GIT_FAILED", async () => {
    const orig = { ..._treeSnapshotDeps };
    let killed = false;
    Object.assign(_treeSnapshotDeps, {
      gitTimeoutMs: 50,
      spawn: () => {
        let exit: (code: number) => void = () => {};
        const exited = new Promise<number>((resolve) => {
          exit = resolve;
        });
        const closed = () => new ReadableStream<Uint8Array>({ start: (c) => c.close() });
        return {
          stdout: closed(),
          stderr: closed(),
          exited,
          pid: 1,
          kill: () => {
            killed = true;
            exit(137);
          },
        };
      },
    });
    try {
      const err = await captureRejection(changedPathsBetween(repo, "HEAD", "HEAD"));
      expect(killed).toBe(true);
      assertNaxError(err, "changedPathsBetween against a wedged git");
      expect(err.code).toBe("FIX_REVIEW_GIT_FAILED");
      expect(err.message).toContain("timed out");
    } finally {
      Object.assign(_treeSnapshotDeps, orig);
    }
  });
});
