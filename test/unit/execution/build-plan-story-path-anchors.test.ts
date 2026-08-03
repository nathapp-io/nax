/**
 * #1451 — `story.workdir` was joined onto a path that already ended in it.
 *
 * `CallContext.packageDir` comes from `PipelineContext.workdir`, which
 * `iteration-runner.ts` builds as `join(<repo root>, story.workdir)`. The old code
 * treated it as the repo root and joined `story.workdir` again, so in every monorepo
 * story both anchors handed to `validateMockStructureFiles` named a non-existent
 * directory and `resolveTestFilePatterns` missed `.nax/mono/<pkg>/config.json`.
 *
 * The end-to-end assertions below drive the REAL `validateMockStructureFiles` and
 * `resolveTestFilePatterns` against a temp monorepo, so they fail on the old anchors
 * regardless of how the pair is computed.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveStoryPathAnchors } from "@/execution";
import { validateMockStructureFiles } from "@/operations";
import { resolveTestFilePatterns } from "@/test-runners";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

describe("resolveStoryPathAnchors (#1451)", () => {
  test("package-dir shape: derives the repo root by stripping story.workdir", () => {
    expect(resolveStoryPathAnchors("/repo/apps/api", "apps/api")).toEqual({
      repoRoot: "/repo",
      packageDir: "/repo/apps/api",
    });
  });

  test("package-dir shape: single-segment workdir", () => {
    expect(resolveStoryPathAnchors("/repo/packages", "packages")).toEqual({
      repoRoot: "/repo",
      packageDir: "/repo/packages",
    });
  });

  test("repo-root shape is still accepted — story.workdir is joined as before", () => {
    expect(resolveStoryPathAnchors("/repo", "apps/api")).toEqual({
      repoRoot: "/repo",
      packageDir: "/repo/apps/api",
    });
  });

  test("empty / absent story.workdir collapses both anchors (single-package repo)", () => {
    expect(resolveStoryPathAnchors("/repo", undefined)).toEqual({ repoRoot: "/repo", packageDir: "/repo" });
    expect(resolveStoryPathAnchors("/repo", "")).toEqual({ repoRoot: "/repo", packageDir: "/repo" });
    expect(resolveStoryPathAnchors("/repo", ".")).toEqual({ repoRoot: "/repo", packageDir: "/repo" });
  });

  test("tolerates a trailing separator and a ./ prefix on story.workdir", () => {
    expect(resolveStoryPathAnchors("/repo/apps/api", "./apps/api/")).toEqual({
      repoRoot: "/repo",
      packageDir: "/repo/apps/api",
    });
  });

  test("a trailing separator on the package dir does not defeat suffix detection", () => {
    // Both sides of the comparison must be canonical — otherwise this falls through to the
    // repo-root branch and reinstates the #1451 double-join.
    expect(resolveStoryPathAnchors("/repo/apps/api/", "apps/api")).toEqual({
      repoRoot: "/repo",
      packageDir: "/repo/apps/api",
    });
  });

  test("normalizes redundant segments in the package dir", () => {
    expect(resolveStoryPathAnchors("/repo/./apps/api", "apps/api")).toEqual({
      repoRoot: "/repo",
      packageDir: "/repo/apps/api",
    });
  });
});

describe("#1451 end-to-end — real resolver and validator against a temp monorepo", () => {
  /** Repo with a per-package pattern override and one real test file. */
  async function makeMonorepo(): Promise<string> {
    const root = await makeTempDir("nax-1451-");
    await Bun.write(
      join(root, ".nax/config.json"),
      JSON.stringify({ execution: { smartTestRunner: { testFilePatterns: ["test/**/*.spec.ts"] } } }),
    );
    await Bun.write(
      join(root, ".nax/mono/apps/api/config.json"),
      JSON.stringify({ execution: { smartTestRunner: { testFilePatterns: ["tests/**/*.py"] } } }),
    );
    await Bun.write(join(root, "apps/api/tests/test_lifespan.py"), "# test\n");
    return root;
  }

  test("per-package testFilePatterns are found (old anchors fell back to root patterns)", async () => {
    const root = await makeMonorepo();
    try {
      const { repoRoot } = resolveStoryPathAnchors(join(root, "apps/api"), "apps/api");
      const resolved = await resolveTestFilePatterns({} as never, repoRoot, "apps/api");
      expect(resolved.globs).toEqual(["tests/**/*.py"]);
    } finally {
      await cleanupTempDir(root);
    }
  });

  test.each([
    ["repo-relative", "apps/api/tests/test_lifespan.py"],
    ["package-relative", "tests/test_lifespan.py"],
  ])("a mock_structure declaration for an existing file is accepted (%s path)", async (_label, declared) => {
    const root = await makeMonorepo();
    try {
      const { repoRoot, packageDir } = resolveStoryPathAnchors(join(root, "apps/api"), "apps/api");
      const resolved = await resolveTestFilePatterns({} as never, repoRoot, "apps/api");

      const { valid, invalid } = await validateMockStructureFiles(
        [{ reason: "mock_structure", file: declared, files: [declared], reasonDetail: "mock moved" } as never],
        resolved,
        packageDir,
        { repoRoot },
      );

      expect(invalid).toHaveLength(0);
      expect(valid).toHaveLength(1);
    } finally {
      await cleanupTempDir(root);
    }
  });

  test("a declaration for a file that genuinely does not exist is still rejected", async () => {
    const root = await makeMonorepo();
    try {
      const { repoRoot, packageDir } = resolveStoryPathAnchors(join(root, "apps/api"), "apps/api");
      const resolved = await resolveTestFilePatterns({} as never, repoRoot, "apps/api");

      const declared = "tests/test_absent.py";
      const { valid, invalid } = await validateMockStructureFiles(
        [{ reason: "mock_structure", file: declared, files: [declared], reasonDetail: "x" } as never],
        resolved,
        packageDir,
        { repoRoot },
      );

      expect(valid).toHaveLength(0);
      expect(invalid).toHaveLength(1);
    } finally {
      await cleanupTempDir(root);
    }
  });
});
