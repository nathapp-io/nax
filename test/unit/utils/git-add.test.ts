import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { gitWithTimeout } from "@/utils/git";
import { type GitRunResult, gitlinkSafeAdd, parseGitlinks } from "@/utils/git-add";
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
    const driver = join(dir, "filter.sh");
    await Bun.write(driver, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
    Bun.spawnSync(["chmod", "+x", driver]);
    git(["init", "-q", "top"], dir);
    git(["config", "user.email", "t@t"], top);
    git(["config", "user.name", "t"], top);
    await Bun.write(join(top, "a.txt"), "a\n");
    git(["add", "a.txt"], top);
    git(["commit", "-qm", "init"], top);

    const nested = join(top, "nested");
    git(["init", "-q", "nested"], top);
    git(["config", "user.email", "t@t"], nested);
    git(["config", "user.name", "t"], nested);
    git(["config", "filter.x.clean", driver], nested);
    await Bun.write(join(nested, ".gitattributes"), "* filter=x\n");
    await Bun.write(join(nested, "f.txt"), "v0\n");
    git(["add", "."], nested);
    git(["commit", "-qm", "nested"], nested);
    git(["add", "nested"], top);
    git(["commit", "-qm", "gitlink"], top);
    // The nested repo's own `git add` above ran its filter; start each test clean.
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
