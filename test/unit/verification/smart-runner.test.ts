import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _gitDeps } from "../../../src/utils/git";
import { withDepsRestore } from "../../helpers/deps";
import {
  _gitUtilDeps,
  buildSmartTestCommand,
  getChangedNonTestFiles,
  getChangedTestFiles,
  importGrepFallback,
  mapSourceToTests,
} from "../../../src/verification/smart-runner";

// ---------------------------------------------------------------------------
// buildSmartTestCommand
// ---------------------------------------------------------------------------

describe("buildSmartTestCommand", () => {
  test("returns original command when testFiles is empty", () => {
    const result = buildSmartTestCommand([], "bun test test/");
    expect(result).toBe("bun test test/");
  });

  test("replaces last path argument with specific test file", () => {
    const result = buildSmartTestCommand(["test/unit/foo.test.ts"], "bun test test/");
    expect(result).toBe("bun test test/unit/foo.test.ts");
  });

  test("joins multiple test files with spaces", () => {
    const result = buildSmartTestCommand(
      ["test/unit/foo.test.ts", "test/unit/bar.test.ts"],
      "bun test test/",
    );
    expect(result).toBe("bun test test/unit/foo.test.ts test/unit/bar.test.ts");
  });

  test("appends test files when command has no path argument", () => {
    const result = buildSmartTestCommand(["test/unit/foo.test.ts"], "bun test");
    expect(result).toBe("bun test test/unit/foo.test.ts");
  });

  test("replaces last path-like token even when flags precede it", () => {
    const result = buildSmartTestCommand(
      ["test/unit/foo.test.ts"],
      "bun test --coverage test/",
    );
    expect(result).toBe("bun test --coverage test/unit/foo.test.ts");
  });

  test("preserves trailing flags after path argument (BUG-043)", () => {
    const result = buildSmartTestCommand(
      ["test/unit/foo.test.ts"],
      "bun test test/ --timeout=60000",
    );
    expect(result).toBe("bun test test/unit/foo.test.ts --timeout=60000");
  });

  test("preserves trailing flags with multiple test files", () => {
    const result = buildSmartTestCommand(
      ["test/unit/foo.test.ts", "test/unit/bar.test.ts"],
      "bun test test/ --timeout=60000 --bail",
    );
    expect(result).toBe("bun test test/unit/foo.test.ts test/unit/bar.test.ts --timeout=60000 --bail");
  });
});

// ---------------------------------------------------------------------------
// Helpers to mock Bun.spawn (used internally via the "bun" import alias)
// ---------------------------------------------------------------------------

function makeProc(stdout: string, exitCode: number) {
  return {
    exited: Promise.resolve(exitCode),
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stdout));
        controller.close();
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// mapSourceToTests
// ---------------------------------------------------------------------------

describe("mapSourceToTests", () => {
  let originalFile: typeof Bun.file;

  beforeEach(() => {
    originalFile = Bun.file;
  });

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: restoring original
    (Bun as any).file = originalFile;
  });

  function mockFileExists(existingPaths: string[]) {
    // biome-ignore lint/suspicious/noExplicitAny: mocking
    (Bun as any).file = (path: string) => ({
      exists: () => Promise.resolve(existingPaths.includes(path)),
    });
  }

  test("maps src/foo/bar.ts to test/unit/foo/bar.test.ts", async () => {
    mockFileExists(["/repo/test/unit/foo/bar.test.ts"]);

    const result = await mapSourceToTests(["src/foo/bar.ts"], "/repo");

    expect(result).toEqual(["/repo/test/unit/foo/bar.test.ts"]);
  });

  test("also checks test/integration/ path", async () => {
    mockFileExists(["/repo/test/integration/foo/bar.test.ts"]);

    const result = await mapSourceToTests(["src/foo/bar.ts"], "/repo");

    expect(result).toEqual(["/repo/test/integration/foo/bar.test.ts"]);
  });

  test("returns both unit and integration when both exist", async () => {
    mockFileExists([
      "/repo/test/unit/foo/bar.test.ts",
      "/repo/test/integration/foo/bar.test.ts",
    ]);

    const result = await mapSourceToTests(["src/foo/bar.ts"], "/repo");

    expect(result).toEqual([
      "/repo/test/unit/foo/bar.test.ts",
      "/repo/test/integration/foo/bar.test.ts",
    ]);
  });

  test("only returns files that exist on disk", async () => {
    // Only unit test exists, integration does not
    mockFileExists(["/repo/test/unit/utils/helper.test.ts"]);

    const result = await mapSourceToTests(["src/utils/helper.ts"], "/repo");

    expect(result).toEqual(["/repo/test/unit/utils/helper.test.ts"]);
    expect(result).not.toContain("/repo/test/integration/utils/helper.test.ts");
  });

  test("returns empty array when no test files match", async () => {
    mockFileExists([]); // nothing exists

    const result = await mapSourceToTests(["src/foo/bar.ts"], "/repo");

    expect(result).toEqual([]);
  });

  test("returns empty array for empty sourceFiles input", async () => {
    mockFileExists(["/repo/test/unit/foo/bar.test.ts"]);

    const result = await mapSourceToTests([], "/repo");

    expect(result).toEqual([]);
  });

  test("handles multiple source files and aggregates results", async () => {
    mockFileExists([
      "/repo/test/unit/foo/bar.test.ts",
      "/repo/test/unit/baz/qux.test.ts",
    ]);

    const result = await mapSourceToTests(
      ["src/foo/bar.ts", "src/baz/qux.ts"],
      "/repo",
    );

    expect(result).toEqual([
      "/repo/test/unit/foo/bar.test.ts",
      "/repo/test/unit/baz/qux.test.ts",
    ]);
  });

  test("single-package behaviour unchanged when packagePrefix is undefined", async () => {
    mockFileExists(["/repo/test/unit/foo/bar.test.ts"]);

    const result = await mapSourceToTests(["src/foo/bar.ts"], "/repo", undefined);

    expect(result).toEqual(["/repo/test/unit/foo/bar.test.ts"]);
  });
});

describe("importGrepFallback", () => {
  let originalGlob: typeof Bun.Glob;
  let originalFile: typeof Bun.file;

  beforeEach(() => {
    originalGlob = Bun.Glob;
    originalFile = Bun.file;
  });

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: restoring original
    (Bun as any).Glob = originalGlob;
    // biome-ignore lint/suspicious/noExplicitAny: restoring original
    (Bun as any).file = originalFile;
  });

  test("matches nested monorepo src imports after stripping prefix before src/", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: mocking Bun.Glob
    (Bun as any).Glob = class {
      constructor(_pattern: string) {}
      async *scan(_workdir: string) {
        yield "test/unit/auth/service.test.ts";
      }
    };

    // biome-ignore lint/suspicious/noExplicitAny: mocking Bun.file
    (Bun as any).file = (path: string) => ({
      text: async () =>
        path === "/repo/test/unit/auth/service.test.ts"
          ? "import { service } from '../../src/auth/service';"
          : "",
    });

    const result = await importGrepFallback(
      ["packages/api/src/auth/service.ts"],
      "/repo",
      ["test/**/*.test.ts"],
    );

    expect(result).toEqual(["/repo/test/unit/auth/service.test.ts"]);
  });
});

describe("getChangedNonTestFiles", () => {
  withDepsRestore(_gitDeps, ["spawn"]);
  withDepsRestore(_gitUtilDeps, ["getGitRoot"]);

  // Default: git root lookup returns null — no extra prefix stripping.
  beforeEach(() => {
    _gitUtilDeps.getGitRoot = mock(async (_wd: string) => null);
  });

  afterEach(() => {
    mock.restore();
  });

  test("returns changed non-test files without src/ or extension restrictions", async () => {
    const gitOutput = [
      "src/verification/smart-runner.ts",
      "pkg/auth/service.go",
      "scripts/bootstrap.sh",
      "src/utils/git.ts",
      "README.md",
      "src/index.js",
      "test/unit/foo.test.ts",
      "src/config/schema.ts",
    ].join("\n");

    // biome-ignore lint/suspicious/noExplicitAny: mocking _gitDeps
    _gitDeps.spawn = mock(() => makeProc(gitOutput, 0)) as unknown as typeof _gitDeps.spawn;

    const result = await getChangedNonTestFiles("/fake/repo", undefined, undefined, [/\.test\.ts$/]);

    expect(result).toEqual([
      "src/verification/smart-runner.ts",
      "pkg/auth/service.go",
      "scripts/bootstrap.sh",
      "src/utils/git.ts",
      "README.md",
      "src/index.js",
      "src/config/schema.ts",
    ]);
  });

  test("returns empty array when git exits with non-zero code", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: mocking _gitDeps
    _gitDeps.spawn = mock(() => makeProc("", 128)) as unknown as typeof _gitDeps.spawn;

    const result = await getChangedNonTestFiles("/fake/repo");

    expect(result).toEqual([]);
  });

  test("returns empty array when git throws (e.g. not a repo)", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: mocking _gitDeps
    _gitDeps.spawn = mock(() => {
      throw new Error("git not found");
    }) as unknown as typeof _gitDeps.spawn;

    const result = await getChangedNonTestFiles("/fake/repo");

    expect(result).toEqual([]);
  });

  test("returns all changed files when testFileRegex is empty", async () => {
    const gitOutput = ["src/foo.js", "pkg/bar.rs", "src/baz.ts"].join("\n");

    // biome-ignore lint/suspicious/noExplicitAny: mocking _gitDeps
    _gitDeps.spawn = mock(() => makeProc(gitOutput, 0)) as unknown as typeof _gitDeps.spawn;

    const result = await getChangedNonTestFiles("/fake/repo");

    expect(result).toEqual(["src/foo.js", "pkg/bar.rs", "src/baz.ts"]);
  });

  test("returns empty array when no files changed", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: mocking _gitDeps
    _gitDeps.spawn = mock(() => makeProc("", 0)) as unknown as typeof _gitDeps.spawn;

    const result = await getChangedNonTestFiles("/fake/repo");

    expect(result).toEqual([]);
  });

  // MW-006: package prefix scoping
  test("filters to packagePrefix/ when packagePrefix is set", async () => {
    const gitOutput = [
      "src/index.ts",
      "packages/api/src/auth.ts",
      "packages/api/pkg/auth.go",
      "packages/web/src/app.ts",
    ].join("\n");

    // biome-ignore lint/suspicious/noExplicitAny: mocking _gitDeps
    _gitDeps.spawn = mock(() => makeProc(gitOutput, 0)) as unknown as typeof _gitDeps.spawn;

    const result = await getChangedNonTestFiles("/fake/repo", undefined, "packages/api");

    expect(result).toEqual(["packages/api/src/auth.ts", "packages/api/pkg/auth.go"]);
  });

  test("returns all files when packagePrefix is undefined", async () => {
    const gitOutput = ["src/index.ts", "packages/api/src/auth.ts"].join("\n");

    // biome-ignore lint/suspicious/noExplicitAny: mocking _gitDeps
    _gitDeps.spawn = mock(() => makeProc(gitOutput, 0)) as unknown as typeof _gitDeps.spawn;

    const result = await getChangedNonTestFiles("/fake/repo", undefined, undefined);

    expect(result).toEqual(["src/index.ts", "packages/api/src/auth.ts"]);
  });

  test("returns empty when packagePrefix does not match any changed files", async () => {
    const gitOutput = ["src/index.ts", "packages/web/src/app.ts"].join("\n");

    // biome-ignore lint/suspicious/noExplicitAny: mocking _gitDeps
    _gitDeps.spawn = mock(() => makeProc(gitOutput, 0)) as unknown as typeof _gitDeps.spawn;

    const result = await getChangedNonTestFiles("/fake/repo", undefined, "packages/api");

    expect(result).toEqual([]);
  });

  // Issue #557 — co-located test files should be excluded when testFileRegex is provided
  test("excludes co-located test files when testFileRegex is provided", async () => {
    const gitOutput = [
      "packages/lib/src/util.ts",
      "packages/lib/src/util.test.ts",
    ].join("\n");

    // biome-ignore lint/suspicious/noExplicitAny: mocking _gitDeps
    _gitDeps.spawn = mock(() => makeProc(gitOutput, 0)) as unknown as typeof _gitDeps.spawn;

    const result = await getChangedNonTestFiles("/fake/repo", undefined, "packages/lib", [/\.test\.ts$/]);

    expect(result).toEqual(["packages/lib/src/util.ts"]);
  });

  test("returns all changed files when testFileRegex is empty (backward-compatible)", async () => {
    const gitOutput = [
      "packages/lib/src/util.ts",
      "packages/lib/src/util.test.ts",
      "packages/lib/pkg/util.go",
    ].join("\n");

    // biome-ignore lint/suspicious/noExplicitAny: mocking _gitDeps
    _gitDeps.spawn = mock(() => makeProc(gitOutput, 0)) as unknown as typeof _gitDeps.spawn;

    const result = await getChangedNonTestFiles("/fake/repo", undefined, "packages/lib");

    // Without testFileRegex: all changed package files are returned
    expect(result).toContain("packages/lib/src/util.ts");
    expect(result).toContain("packages/lib/src/util.test.ts");
    expect(result).toContain("packages/lib/pkg/util.go");
  });

  // Issue #565 — git root ≠ project root
  test("filters correctly when project root is nested inside git root", async () => {
    // Scenario: nax-dogfood is the git root, fixtures/monorepo-tiny is the project root.
    // git diff returns paths relative to the git root, so they include the extra prefix.
    const gitOutput = [
      "fixtures/monorepo-tiny/packages/lib/src/util.ts",
      "fixtures/monorepo-tiny/packages/lib/src/util.test.ts",
      "other-package/src/index.ts",
    ].join("\n");

    _gitUtilDeps.getGitRoot = mock(async () => "/big-repo");
    // biome-ignore lint/suspicious/noExplicitAny: mocking _gitDeps
    _gitDeps.spawn = mock(() => makeProc(gitOutput, 0)) as unknown as typeof _gitDeps.spawn;

    const result = await getChangedNonTestFiles(
      "/big-repo/fixtures/monorepo-tiny",
      undefined,
      "packages/lib",
      [/\.test\.ts$/],
      undefined,
      "/big-repo/fixtures/monorepo-tiny", // repoRoot
    );

    expect(result).toEqual(["packages/lib/src/util.ts"]);
  });

  test("behavior unchanged when project root equals git root", async () => {
    const gitOutput = [
      "packages/lib/src/util.ts",
      "packages/lib/src/util.test.ts",
    ].join("\n");

    // biome-ignore lint/suspicious/noExplicitAny: mocking _gitDeps
    _gitDeps.spawn = mock(() => makeProc(gitOutput, 0)) as unknown as typeof _gitDeps.spawn;
    // default stub already returns workdir as git root — no override needed

    const result = await getChangedNonTestFiles(
      "/fake/repo",
      undefined,
      "packages/lib",
      [/\.test\.ts$/],
      undefined,
      "/fake/repo", // repoRoot equals git root — no offset
    );

    expect(result).toEqual(["packages/lib/src/util.ts"]);
  });
});

// ---------------------------------------------------------------------------
// getChangedTestFiles — Issue #557
// ---------------------------------------------------------------------------

describe("getChangedTestFiles", () => {
  withDepsRestore(_gitDeps, ["spawn"]);
  withDepsRestore(_gitUtilDeps, ["getGitRoot"]);

  // Default: git root lookup returns null — no extra prefix stripping.
  beforeEach(() => {
    _gitUtilDeps.getGitRoot = mock(async (_wd: string) => null);
  });

  afterEach(() => {
    mock.restore();
  });

  const TS_TEST_REGEX = [/\.test\.ts$/, /\.spec\.ts$/];

  test("returns absolute paths of changed co-located test files", async () => {
    const gitOutput = [
      "packages/lib/src/util.ts",
      "packages/lib/src/util.test.ts",
    ].join("\n");

    // biome-ignore lint/suspicious/noExplicitAny: mocking _gitDeps
    _gitDeps.spawn = mock(() => makeProc(gitOutput, 0)) as unknown as typeof _gitDeps.spawn;

    const result = await getChangedTestFiles("/fake/repo/packages/lib", "/fake/repo", undefined, "packages/lib", TS_TEST_REGEX);

    expect(result).toEqual(["/fake/repo/packages/lib/src/util.test.ts"]);
  });

  test("returns absolute paths of changed separated test files", async () => {
    const gitOutput = [
      "packages/lib/src/util.ts",
      "packages/lib/test/unit/util.test.ts",
    ].join("\n");

    // biome-ignore lint/suspicious/noExplicitAny: mocking _gitDeps
    _gitDeps.spawn = mock(() => makeProc(gitOutput, 0)) as unknown as typeof _gitDeps.spawn;

    const result = await getChangedTestFiles("/fake/repo/packages/lib", "/fake/repo", undefined, "packages/lib", TS_TEST_REGEX);

    expect(result).toEqual(["/fake/repo/packages/lib/test/unit/util.test.ts"]);
  });

  test("detects both co-located and separated test files in the same diff", async () => {
    const gitOutput = [
      "packages/lib/src/util.test.ts",
      "packages/lib/test/unit/other.test.ts",
    ].join("\n");

    // biome-ignore lint/suspicious/noExplicitAny: mocking _gitDeps
    _gitDeps.spawn = mock(() => makeProc(gitOutput, 0)) as unknown as typeof _gitDeps.spawn;

    const result = await getChangedTestFiles("/fake/repo/packages/lib", "/fake/repo", undefined, "packages/lib", TS_TEST_REGEX);

    expect(result).toHaveLength(2);
    expect(result).toContain("/fake/repo/packages/lib/src/util.test.ts");
    expect(result).toContain("/fake/repo/packages/lib/test/unit/other.test.ts");
  });

  test("scopes to packagePrefix — ignores test files from other packages", async () => {
    const gitOutput = [
      "packages/lib/src/util.test.ts",
      "packages/app/src/index.test.ts",
    ].join("\n");

    // biome-ignore lint/suspicious/noExplicitAny: mocking _gitDeps
    _gitDeps.spawn = mock(() => makeProc(gitOutput, 0)) as unknown as typeof _gitDeps.spawn;

    const result = await getChangedTestFiles("/fake/repo/packages/lib", "/fake/repo", undefined, "packages/lib", TS_TEST_REGEX);

    expect(result).toEqual(["/fake/repo/packages/lib/src/util.test.ts"]);
  });

  test("returns empty when no test files changed", async () => {
    const gitOutput = ["packages/lib/src/util.ts"].join("\n");

    // biome-ignore lint/suspicious/noExplicitAny: mocking _gitDeps
    _gitDeps.spawn = mock(() => makeProc(gitOutput, 0)) as unknown as typeof _gitDeps.spawn;

    const result = await getChangedTestFiles("/fake/repo/packages/lib", "/fake/repo", undefined, "packages/lib", TS_TEST_REGEX);

    expect(result).toEqual([]);
  });

  test("returns empty when testFileRegex is empty", async () => {
    const gitOutput = ["packages/lib/src/util.test.ts"].join("\n");

    // biome-ignore lint/suspicious/noExplicitAny: mocking _gitDeps
    _gitDeps.spawn = mock(() => makeProc(gitOutput, 0)) as unknown as typeof _gitDeps.spawn;

    const result = await getChangedTestFiles("/fake/repo/packages/lib", "/fake/repo", undefined, "packages/lib", []);

    expect(result).toEqual([]);
  });

  test("returns empty when git exits with non-zero code", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: mocking _gitDeps
    _gitDeps.spawn = mock(() => makeProc("", 128)) as unknown as typeof _gitDeps.spawn;

    const result = await getChangedTestFiles("/fake/repo", "/fake/repo", undefined, undefined, TS_TEST_REGEX);

    expect(result).toEqual([]);
  });

  test("works without packagePrefix for single-package repos", async () => {
    const gitOutput = ["src/util.ts", "test/unit/util.test.ts"].join("\n");

    // biome-ignore lint/suspicious/noExplicitAny: mocking _gitDeps
    _gitDeps.spawn = mock(() => makeProc(gitOutput, 0)) as unknown as typeof _gitDeps.spawn;

    const result = await getChangedTestFiles("/repo", "/repo", undefined, undefined, TS_TEST_REGEX);

    expect(result).toEqual(["/repo/test/unit/util.test.ts"]);
  });

  test("is language-agnostic — detects Go test files via regex", async () => {
    const gitOutput = [
      "packages/backend/pkg/auth/auth.go",
      "packages/backend/pkg/auth/auth_test.go",
    ].join("\n");

    // biome-ignore lint/suspicious/noExplicitAny: mocking _gitDeps
    _gitDeps.spawn = mock(() => makeProc(gitOutput, 0)) as unknown as typeof _gitDeps.spawn;

    const result = await getChangedTestFiles(
      "/repo/packages/backend",
      "/repo",
      undefined,
      "packages/backend",
      [/_test\.go$/],
    );

    expect(result).toEqual(["/repo/packages/backend/pkg/auth/auth_test.go"]);
  });

  // Issue #565 — git root ≠ project root
  test("filters correctly when project root is nested inside git root", async () => {
    // git diff returns paths relative to the true git root (big-repo),
    // but packagePrefix is relative to the project root (fixtures/monorepo-tiny).
    const gitOutput = [
      "fixtures/monorepo-tiny/packages/lib/src/util.ts",
      "fixtures/monorepo-tiny/packages/lib/src/util.test.ts",
      "other/src/index.test.ts",
    ].join("\n");

    _gitUtilDeps.getGitRoot = mock(async () => "/big-repo");
    // biome-ignore lint/suspicious/noExplicitAny: mocking _gitDeps
    _gitDeps.spawn = mock(() => makeProc(gitOutput, 0)) as unknown as typeof _gitDeps.spawn;

    const result = await getChangedTestFiles(
      "/big-repo/fixtures/monorepo-tiny",
      "/big-repo/fixtures/monorepo-tiny",
      undefined,
      "packages/lib",
      [/\.test\.ts$/],
    );

    expect(result).toEqual(["/big-repo/fixtures/monorepo-tiny/packages/lib/src/util.test.ts"]);
  });

  test("behavior unchanged when project root equals git root", async () => {
    const gitOutput = [
      "packages/lib/src/util.ts",
      "packages/lib/src/util.test.ts",
    ].join("\n");

    // biome-ignore lint/suspicious/noExplicitAny: mocking _gitDeps
    _gitDeps.spawn = mock(() => makeProc(gitOutput, 0)) as unknown as typeof _gitDeps.spawn;
    // default stub already returns workdir as git root — no override needed

    const result = await getChangedTestFiles(
      "/fake/repo",
      "/fake/repo",
      undefined,
      "packages/lib",
      [/\.test\.ts$/],
    );

    expect(result).toEqual(["/fake/repo/packages/lib/src/util.test.ts"]);
  });
});
