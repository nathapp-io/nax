/**
 * paths.ts — memory mirror directory resolution.
 *
 * Covers US-002 AC-1..AC-12: the per-project mirror segment + hash suffix, the
 * shared user directory, collision resistance across same-named repositories,
 * symlink equality, the basename fallback and the `MEMORY_REPO_ROOT_UNRESOLVED`
 * refusal.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, symlinkSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { assertNaxError, cleanupTempDir, makeTempDir } from "@test/helpers";
import { _memoryPathsDeps, memoryDirs, memoryProjectSegment } from "@/memory";

/** First 8 lowercase hex characters of the SHA-256 of a canonical repo root. */
function hash8(canonicalRoot: string): string {
  return createHash("sha256").update(canonicalRoot, "utf8").digest("hex").slice(0, 8);
}

describe("memoryProjectSegment", () => {
  test("replaces every character outside [A-Za-z0-9._-] with a dash", () => {
    expect(memoryProjectSegment("team/api v2")).toBe("team-api-v2");
  });

  test("keeps dots and underscores intact", () => {
    expect(memoryProjectSegment("nax-monorepo.v1_x")).toBe("nax-monorepo.v1_x");
  });
});

describe("memoryDirs", () => {
  const tempDirs: string[] = [];
  let savedGlobalEnv: string | undefined;
  let originalRealpath: typeof _memoryPathsDeps.realpath;
  let globalDir: string;
  let repoRoot: string;

  function makeDir(prefix: string): string {
    const dir = makeTempDir(prefix);
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    globalDir = makeDir("nax-memory-global-");
    repoRoot = join(makeDir("nax-memory-repo-"), "api");
    mkdirSync(repoRoot, { recursive: true });

    savedGlobalEnv = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;

    originalRealpath = _memoryPathsDeps.realpath;
  });

  afterEach(() => {
    _memoryPathsDeps.realpath = originalRealpath;
    if (savedGlobalEnv === undefined) {
      delete process.env.NAX_GLOBAL_CONFIG_DIR;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = savedGlobalEnv;
    }
    for (const dir of tempDirs.splice(0)) cleanupTempDir(dir);
  });

  test("returns projectDir under <globalDir>/memory/projects/<name>-<hash8>", async () => {
    const dirs = await memoryDirs({ config: { name: "api" }, repoRoot });

    expect(dirs.projectDir).toBe(join(globalDir, "memory", "projects", `api-${hash8(await realpath(repoRoot))}`));
  });

  test("returns userDir under <globalDir>/memory/user", async () => {
    const dirs = await memoryDirs({ config: { name: "api" }, repoRoot });

    expect(dirs.userDir).toBe(join(globalDir, "memory", "user"));
  });

  test("returns root equal to <globalDir>/memory", async () => {
    const dirs = await memoryDirs({ config: { name: "api" }, repoRoot });

    expect(dirs.root).toBe(join(globalDir, "memory"));
  });

  test("gives two repositories sharing a basename different projectDir values", async () => {
    const first = join(makeDir("nax-memory-parent-a-"), "api");
    const second = join(makeDir("nax-memory-parent-b-"), "api");
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });

    const firstDirs = await memoryDirs({ config: {}, repoRoot: first });
    const secondDirs = await memoryDirs({ config: {}, repoRoot: second });

    expect(firstDirs.projectDir).not.toBe(secondDirs.projectDir);
  });

  test("resolves a symlinked checkout to the same projectDir as the real path", async () => {
    const linkParent = makeDir("nax-memory-link-");
    const link = join(linkParent, "linked-checkout");
    symlinkSync(repoRoot, link, "dir");

    const realDirs = await memoryDirs({ config: {}, repoRoot });
    const linkedDirs = await memoryDirs({ config: {}, repoRoot: link });

    expect(linkedDirs.projectDir).toBe(realDirs.projectDir);
  });

  test("falls back to the repository basename when config carries no name", async () => {
    const dirs = await memoryDirs({ config: {}, repoRoot });

    expect(dirs.projectDir).toBe(
      join(globalDir, "memory", "projects", `${basename(repoRoot)}-${hash8(await realpath(repoRoot))}`),
    );
  });

  test("throws MEMORY_REPO_ROOT_UNRESOLVED when realpath rejects", async () => {
    _memoryPathsDeps.realpath = async () => {
      throw new Error("ENOENT: no such file or directory");
    };

    const caught = await memoryDirs({ config: {}, repoRoot }).catch((err: unknown) => err);

    assertNaxError(caught, "memoryDirs rejection");
    expect(caught.code).toBe("MEMORY_REPO_ROOT_UNRESOLVED");
  });

  test("carries the realpath rejection as context.cause", async () => {
    const rejection = new Error("ENOENT: no such file or directory");
    _memoryPathsDeps.realpath = async () => {
      throw rejection;
    };

    const caught = await memoryDirs({ config: {}, repoRoot }).catch((err: unknown) => err);

    assertNaxError(caught, "memoryDirs rejection");
    expect(caught.context?.cause).toBe(rejection);
  });

  test("stamps context.stage as memory and keeps the caller repoRoot", async () => {
    _memoryPathsDeps.realpath = async () => {
      throw new Error("EACCES: permission denied");
    };

    const caught = await memoryDirs({ config: {}, repoRoot }).catch((err: unknown) => err);

    assertNaxError(caught, "memoryDirs rejection");
    expect(caught.context?.stage).toBe("memory");
    expect(caught.context?.repoRoot).toBe(repoRoot);
  });
});
