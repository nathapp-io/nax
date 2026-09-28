import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { gitWithTimeout } from "@/utils/git";
import { type GitRunResult, gitlinkSafeAdd, hasStagedChanges, parseGitlinks } from "@/utils/git-add";
import { gitSpawnEnv } from "@/utils/git-env";

const OK: GitRunResult = { stdout: "", stderr: "", exitCode: 0 };

describe("parseGitlinks", () => {
  test("keeps only mode-160000 entries, once each, with paths as printed", () => {
    const out = [
      "100644 aaaa 0\ta.txt",
      "160000 bbbb 0\tvendor/nested repo",
      "160000 cccc 1\tconflicted",
      "160000 dddd 2\tconflicted",
      "",
    ].join("\0");
    expect(parseGitlinks(out)).toEqual(["vendor/nested repo", "conflicted"]);
  });

  test("an empty listing has no gitlinks", () => {
    expect(parseGitlinks("")).toEqual([]);
  });
});

describe("hasStagedChanges", () => {
  test.each([
    [{ ...OK, exitCode: 1 }, true],
    [OK, false],
    [{ ...OK, exitCode: 128 }, undefined],
    [{ ...OK, exitCode: 1, timedOut: true }, undefined],
  ])("maps %j to %p", async (result, expected) => {
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      return result;
    };
    expect(await hasStagedChanges(run, "/r")).toBe(expected);
    expect(calls).toEqual([["diff", "--cached", "--quiet"]]);
  });
});

describe("gitlinkSafeAdd argv", () => {
  function recorder(lsFiles: GitRunResult): { calls: string[][]; run: typeof gitWithTimeout } {
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      return args[0] === "ls-files" ? lsFiles : OK;
    };
    return { calls, run };
  }

  test("with no gitlinks it is one plain add over the whole tree", async () => {
    const { calls, run } = recorder(OK);
    await gitlinkSafeAdd(run, "/r", { flags: ["-A"] });
    expect(calls).toEqual([
      ["ls-files", "--stage", "-z", "--", ":/"],
      ["add", "-A", "--", ":/"],
    ]);
  });

  test("excludes each gitlink literally from add, then restages it with update-index", async () => {
    const { calls, run } = recorder({ ...OK, stdout: "160000 bbbb 0\tsub*\0" });
    await gitlinkSafeAdd(run, "/r", { pathspecs: ["src", "sub*"] });
    expect(calls).toEqual([
      ["ls-files", "--stage", "-z", "--", "src", "sub*"],
      ["add", "--", "src", "sub*", ":(exclude,literal)sub*"],
      ["update-index", "--add", "--remove", "--", "sub*"],
    ]);
  });

  test("fails closed, without adding, when the gitlink listing fails or times out", async () => {
    for (const listing of [
      { ...OK, exitCode: 128, stderr: "fatal" },
      { ...OK, timedOut: true },
    ]) {
      const { calls, run } = recorder(listing);
      const r = await gitlinkSafeAdd(run, "/r", { flags: ["-A"] });
      expect(r.exitCode).not.toBe(0);
      expect(calls.map((c) => c[0])).toEqual(["ls-files"]);
    }
  });
});

/**
 * #2210: an agent-made nested repo, committed as a gitlink, whose own config
 * names a filter driver. Any git that checks the gitlink for dirtiness runs
 * `git status` inside it, which runs the driver on the modified file.
 */
// The same fixture (top repo with a gitlink to a nested repo that has a
// filter driver) is needed by every test below. Building it from scratch
// per test is ~500 ms of git init / config / commit work; instead, build it
// once in beforeAll and `cp -R` a fresh copy to each test's temp dir, then
// rewrite the per-test filter driver and config. Per-test setup drops from
// ~500 ms to ~10 ms.
let gitAddTemplateDir: string;
beforeAll(() => {
  gitAddTemplateDir = makeTempDir("git-add-tmpl-");
  const tmplTop = join(gitAddTemplateDir, "top");
  const tmplMarker = join(gitAddTemplateDir, "filter-ran");
  const tmplFilter = join(gitAddTemplateDir, "filter.sh");
  writeFileSync(tmplFilter, `#!/bin/sh\ntouch "${tmplMarker}"\ncat\n`);
  Bun.spawnSync(["chmod", "+x", tmplFilter]);
  // The template's nested repo points its filter driver at a path inside
  // the template dir; each test rewrites that path via `git config` to its
  // own driver after copying.
  Bun.spawnSync(["git", "init", "-q", "top"], { cwd: gitAddTemplateDir });
  Bun.spawnSync(["git", "config", "user.email", "t@t"], { cwd: tmplTop });
  Bun.spawnSync(["git", "config", "user.name", "t"], { cwd: tmplTop });
  writeFileSync(join(tmplTop, "a.txt"), "a\n");
  Bun.spawnSync(["git", "add", "a.txt"], { cwd: tmplTop });
  Bun.spawnSync(["git", "commit", "-qm", "init"], { cwd: tmplTop });
  Bun.spawnSync(["git", "init", "-q", "nested"], { cwd: tmplTop });
  Bun.spawnSync(["git", "config", "user.email", "t@t"], { cwd: join(tmplTop, "nested") });
  Bun.spawnSync(["git", "config", "user.name", "t"], { cwd: join(tmplTop, "nested") });
  Bun.spawnSync(["git", "config", "filter.x.clean", tmplFilter], { cwd: join(tmplTop, "nested") });
  writeFileSync(join(tmplTop, "nested", ".gitattributes"), "* filter=x\n");
  writeFileSync(join(tmplTop, "nested", "f.txt"), "v0\n");
  Bun.spawnSync(["git", "add", "."], { cwd: join(tmplTop, "nested") });
  Bun.spawnSync(["git", "commit", "-qm", "nested"], { cwd: join(tmplTop, "nested") });
  Bun.spawnSync(["git", "add", "nested"], { cwd: tmplTop });
  Bun.spawnSync(["git", "commit", "-qm", "gitlink"], { cwd: tmplTop });
  // The nested repo's own `git add` above ran its filter (against the
  // template's marker); remove that marker so each per-test cp doesn't see
  // it left behind.
  try {
    unlinkSync(tmplMarker);
  } catch {
    // marker not present — fine
  }
});
afterAll(() => cleanupTempDir(gitAddTemplateDir));

describe("#2210 nested-repo filter driver never runs under nax's git", () => {
  let dir: string;
  let top: string;
  let marker: string;
  let bump = 0;

  function git(args: string[], cwd: string): void {
    const r = Bun.spawnSync(["git", ...args], { cwd, env: gitSpawnEnv() });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  }

  /** Changes the nested file (content and mtime), so the next dirty check must re-clean it. */
  async function dirtyNested(): Promise<void> {
    bump += 1;
    await Bun.write(join(top, "nested", "f.txt"), `v${bump}\n`);
  }

  async function clearMarker(): Promise<void> {
    if (await Bun.file(marker).exists()) await Bun.file(marker).delete();
  }

  async function ran(): Promise<boolean> {
    return Bun.file(marker).exists();
  }

  beforeEach(async () => {
    dir = makeTempDir("git-add-");
    top = join(dir, "top");
    marker = join(dir, "filter-ran");

    // Copy the pre-built template (built in beforeAll) into this test's temp
    // dir, then rewrite the per-test filter driver and config.
    cpSync(join(gitAddTemplateDir, "top"), top, { recursive: true });
    const driver = join(dir, "filter.sh");
    await Bun.write(driver, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
    Bun.spawnSync(["chmod", "+x", driver]);
    git(["config", "filter.x.clean", driver], join(top, "nested"));
    bump = 0;
    await clearMarker();
  });
  afterEach(() => cleanupTempDir(dir));

  test("control: a bare `git add -A` does run the nested filter", async () => {
    await dirtyNested();
    git(["add", "-A"], top);
    expect(await ran()).toBe(true);
  });

  test.each([[["status", "--porcelain"]], [["diff", "--name-only", "HEAD"]], [["commit", "-qam", "c"]]])(
    "gitWithTimeout %j does not run it",
    async (args) => {
      await Bun.write(join(top, "a.txt"), "changed\n");
      await dirtyNested();
      const r = await gitWithTimeout(args, top);
      expect(r.exitCode).toBe(0);
      expect(await ran()).toBe(false);
    },
  );

  describe("with an agent-written `.gitmodules` that sets `ignore = none`", () => {
    // Config is only a default: this per-submodule entry overrides the env's
    // diff.ignoreSubmodules, so only the command-line flag holds.
    beforeEach(async () => {
      await Bun.write(
        join(top, ".gitmodules"),
        '[submodule "n"]\n\tpath = nested\n\turl = ./nested\n\tignore = none\n',
      );
      git(["add", ".gitmodules"], top);
      git(["commit", "-qm", "gitmodules"], top);
    });

    test("control: the env hardening alone does run the nested filter", async () => {
      await dirtyNested();
      Bun.spawnSync(["git", "status", "--porcelain"], { cwd: top, env: gitSpawnEnv() });
      expect(await ran()).toBe(true);
    });

    test.each([[["status", "--porcelain"]], [["diff", "--name-only", "HEAD"]], [["-C", ".", "diff", "HEAD"]]])(
      "gitWithTimeout %j does not run it",
      async (args) => {
        await dirtyNested();
        const r = await gitWithTimeout(args, top);
        expect(r.exitCode).toBe(0);
        expect(await ran()).toBe(false);
      },
    );

    test("hasStagedChanges answers without running it, both ways", async () => {
      await dirtyNested();
      expect(await hasStagedChanges(gitWithTimeout, top)).toBe(false);
      await Bun.write(join(top, "a.txt"), "changed\n");
      git(["add", "a.txt"], top);
      await dirtyNested();
      expect(await hasStagedChanges(gitWithTimeout, top)).toBe(true);
      expect(await ran()).toBe(false);
    });
  });

  test("gitlinkSafeAdd -A does not run it and still stages the gitlink's new HEAD", async () => {
    await Bun.write(join(top, "a.txt"), "changed\n");
    await dirtyNested();
    git(["commit", "-qam", "bump"], join(top, "nested"));
    await clearMarker();
    await dirtyNested();
    const r = await gitlinkSafeAdd(gitWithTimeout, top, { flags: ["-A"] });
    expect(r.exitCode).toBe(0);
    expect(await ran()).toBe(false);
    const staged = Bun.spawnSync(["git", "diff", "--cached", "--name-only"], { cwd: top, env: gitSpawnEnv() });
    expect(staged.stdout.toString().trim().split("\n").sort()).toEqual(["a.txt", "nested"]);
  });
});
