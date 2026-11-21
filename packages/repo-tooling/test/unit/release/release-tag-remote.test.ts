import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
// biome-ignore lint/style/noRestrictedImports: the release fixture is a test helper inside this package, not an entry
import { makeReleaseCliFixture, type ReleaseCliFixture } from "../../helpers/release-cli-fixture";

/** The stubs are skipped, so the push really reaches the fixture's bare origin. */
const REAL_GIT = { PATH: "/usr/bin:/bin" };
const TAG = "refs/tags/v0.84.0";
const MAIN = "refs/heads/main";

function withFixture(fn: (f: ReleaseCliFixture) => void | Promise<void>): Promise<void> {
  const f = makeReleaseCliFixture();
  return (async () => {
    try {
      await fn(f);
    } finally {
      cleanupTempDir(f.dir);
    }
  })();
}

function originDir(f: ReleaseCliFixture): string {
  return join(f.dir, "origin.git");
}

function originGit(f: ReleaseCliFixture, ...args: string[]): { status: number | null; out: string } {
  const result = spawnSync("/usr/bin/git", args, { cwd: originDir(f), encoding: "utf8" });
  if (result.error) throw result.error;
  return { status: result.status, out: result.stdout.trim() };
}

/** A ref read inside the bare origin; undefined when the ref does not exist. */
function originRef(f: ReleaseCliFixture, ref: string): string | undefined {
  const result = originGit(f, "rev-parse", "--verify", "--quiet", ref);
  return result.status === 0 ? result.out : undefined;
}

/** One commit on the fixture's main that origin/main does not have. */
function localOnlyCommit(f: ReleaseCliFixture): void {
  f.write("packages/nax/README.md", "local only\n");
  f.git("add", "-A");
  f.git("commit", "-m", "local only");
}

/** Tags HEAD, pushes the tag to origin, drops the local tag and moves HEAD on, so origin is one tag ahead. */
function originTagBehindHead(f: ReleaseCliFixture): string {
  const parent = f.git("rev-parse", "HEAD");
  f.git("tag", "v0.84.0");
  f.git("push", "--quiet", "origin", "v0.84.0");
  f.git("tag", "-d", "v0.84.0");
  localOnlyCommit(f);
  f.git("push", "--quiet", "origin", "main");
  return parent;
}

interface Rerun {
  failed: { status: number | null; output: string };
  second: { status: number | null; output: string };
  head: string;
}

/** Points origin's push URL at a missing path, tags, restores the URL and tags again. */
function tagAfterFailedPush(f: ReleaseCliFixture): Rerun {
  const head = f.git("rev-parse", "HEAD");
  f.git("remote", "set-url", "--push", "origin", join(f.dir, "missing.git"));
  const failed = f.run(["tag"], "y\n", REAL_GIT);
  f.git("remote", "set-url", "--push", "origin", originDir(f));
  return { failed, second: f.run(["tag"], "y\n", REAL_GIT), head };
}

describe("release tag against a bare origin", () => {
  test("a fresh fixture's origin follows main and holds no tags", () =>
    withFixture((f) => {
      expect(originRef(f, MAIN)).toBe(f.git("rev-parse", "HEAD"));
      expect(originGit(f, "tag", "--list").out).toBe("");
      expect(f.git("status", "--porcelain")).toBe("");
    }));

  test("a confirmed tag lands on origin at origin/main", () =>
    withFixture((f) => {
      const result = f.run(["tag"], "y\n", REAL_GIT);
      expect(result.status).toBe(0);
      expect(originRef(f, TAG)).toBe(originRef(f, MAIN));
    }));

  test("refuses a local-only commit that origin/main does not have", () =>
    withFixture((f) => {
      localOnlyCommit(f);
      const result = f.run(["tag"], "y\n", REAL_GIT);
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("does not match origin/main");
    }));

  test("a refused local-only commit tags nothing on origin", () =>
    withFixture((f) => {
      localOnlyCommit(f);
      f.run(["tag"], "y\n", REAL_GIT);
      expect(originRef(f, TAG)).toBeUndefined();
    }));

  test("a refused local-only commit leaves no local tag", () =>
    withFixture((f) => {
      localOnlyCommit(f);
      f.run(["tag"], "y\n", REAL_GIT);
      expect(f.git("tag", "--list", "v0.84.0")).toBe("");
    }));

  test("a commit that lands while the confirmation waits is refused", () =>
    withFixture(async (f) => {
      const result = await f.runPaused(["tag"], () => localOnlyCommit(f), REAL_GIT);
      expect(result.prompted).toBe(true);
      expect(result.status).not.toBe(0);
      expect(originRef(f, TAG)).toBeUndefined();
      expect(f.git("tag", "--list", "v0.84.0")).toBe("");
    }));

  test("a local tag that appears while the confirmation waits is refused", () =>
    withFixture(async (f) => {
      let tagCommit = "";
      const result = await f.runPaused(
        ["tag"],
        () => {
          localOnlyCommit(f);
          tagCommit = f.git("rev-parse", "HEAD");
          f.git("tag", "v0.84.0");
          f.git("reset", "--hard", "HEAD~1");
        },
        REAL_GIT,
      );
      expect(result.prompted).toBe(true);
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("not at HEAD");
      expect(f.git("rev-parse", "v0.84.0")).toBe(tagCommit);
      expect(originRef(f, TAG)).toBeUndefined();
    }));

  test("refuses when origin/main holds a commit local main lacks", () =>
    withFixture((f) => {
      const clone = makeTempDir("release-clone-");
      try {
        execFileSync("/usr/bin/git", ["clone", "--quiet", f.dir, clone], { stdio: ["ignore", "pipe", "pipe"] });
        const cloneGit = (...args: string[]) =>
          execFileSync("/usr/bin/git", args, { cwd: clone, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        cloneGit("config", "user.name", "Second Clone");
        cloneGit("config", "user.email", "second@example.invalid");
        writeFileSync(join(clone, "ahead.md"), "ahead\n");
        cloneGit("add", "-A");
        cloneGit("commit", "-m", "ahead of the fixture");
        cloneGit("push", "--quiet", originDir(f), "main");
        const result = f.run(["tag"], "y\n", REAL_GIT);
        expect(result.status).not.toBe(0);
        expect(originRef(f, TAG)).toBeUndefined();
      } finally {
        cleanupTempDir(clone);
      }
    }));

  test("a failed tag push exits non-zero and keeps the local tag at HEAD", () =>
    withFixture((f) => {
      const { failed, head } = tagAfterFailedPush(f);
      expect(failed.status).not.toBe(0);
      expect(f.git("rev-parse", "v0.84.0")).toBe(head);
    }));

  test("a rerun after the failed push succeeds", () =>
    withFixture((f) => {
      expect(tagAfterFailedPush(f).second.status).toBe(0);
    }));

  test("a rerun after the failed push delivers the tag at HEAD", () =>
    withFixture((f) => {
      const { head } = tagAfterFailedPush(f);
      expect(originRef(f, TAG)).toBe(head);
    }));

  test("refuses a tag origin already holds", () =>
    withFixture((f) => {
      originTagBehindHead(f);
      const result = f.run(["tag"], "y\n", REAL_GIT);
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("already exists on origin");
    }));

  test("a refused existing remote tag leaves local and origin untouched", () =>
    withFixture((f) => {
      const parent = originTagBehindHead(f);
      f.run(["tag"], "y\n", REAL_GIT);
      expect(f.git("tag", "--list", "v0.84.0")).toBe("");
      expect(originRef(f, TAG)).toBe(parent);
    }));

  test("a local tag at another commit is refused before confirmation", () =>
    withFixture((f) => {
      const original = f.git("rev-parse", "HEAD");
      f.git("tag", "v0.84.0");
      localOnlyCommit(f);
      const result = f.run(["tag"], "n\n");
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("not at HEAD");
      expect(f.git("rev-parse", "v0.84.0")).toBe(original);
    }));

  test("a dry run names the tag and needs no origin", () =>
    withFixture((f) => {
      f.git("remote", "set-url", "origin", join(f.dir, "missing.git"));
      const result = f.run(["--dry-run", "tag"]);
      expect(result.status).toBe(0);
      expect(result.output).toContain("v0.84.0");
    }));

  test("a declined confirmation aborts without reading origin", () =>
    withFixture((f) => {
      f.git("remote", "set-url", "origin", join(f.dir, "missing.git"));
      const result = f.run(["tag"], "n\n");
      expect(result.status).toBe(0);
      expect(result.output).toContain("Aborted.");
    }));

  test("an unreachable origin fails the run and tags nothing", () =>
    withFixture((f) => {
      f.git("remote", "set-url", "origin", join(f.dir, "missing.git"));
      const result = f.run(["tag"], "y\n", REAL_GIT);
      expect(result.status).not.toBe(0);
      expect(result.output).toContain("ls-remote");
      expect(f.git("tag", "--list", "v0.84.0")).toBe("");
    }));

  test("an origin without a main branch is refused", () =>
    withFixture((f) => {
      const empty = makeTempDir("release-empty-origin-");
      try {
        execFileSync("/usr/bin/git", ["init", "--bare", "--quiet", empty], { stdio: ["ignore", "pipe", "pipe"] });
        f.git("remote", "set-url", "origin", empty);
        const result = f.run(["tag"], "y\n", REAL_GIT);
        expect(result.status).not.toBe(0);
        expect(result.output).toContain("does not match origin/main");
        expect(f.git("tag", "--list", "v0.84.0")).toBe("");
      } finally {
        cleanupTempDir(empty);
      }
    }));
});
