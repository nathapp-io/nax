import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeSpawn, withDepsRestore } from "@test/helpers";
import { _gitDeps } from "@/utils/git";
import {
  _gitUtilDeps,
  buildSmartTestCommand,
  getChangedNonTestFiles,
  getChangedTestFiles,
  importGrepFallback,
  mapSourceToTests,
} from "@/verification/smart-runner";

// ---------------------------------------------------------------------------
// buildSmartTestCommand
// ---------------------------------------------------------------------------

describe("buildSmartTestCommand", () => {
  test.each([
    ["empty testFiles returns original command", [], "bun test test/", "bun test test/"],
    [
      "single test file replaces last path",
      ["test/unit/foo.test.ts"],
      "bun test test/",
      "bun test 'test/unit/foo.test.ts'",
    ],
    [
      "multiple test files joined with spaces",
      ["test/unit/foo.test.ts", "test/unit/bar.test.ts"],
      "bun test test/",
      "bun test 'test/unit/foo.test.ts' 'test/unit/bar.test.ts'",
    ],
    ["no path arg — appends test files", ["test/unit/foo.test.ts"], "bun test", "bun test 'test/unit/foo.test.ts'"],
    [
      "flags before path — replaces last path-like token",
      ["test/unit/foo.test.ts"],
      "bun test --coverage test/",
      "bun test --coverage 'test/unit/foo.test.ts'",
    ],
    [
      "preserves trailing flags after path (BUG-043)",
      ["test/unit/foo.test.ts"],
      "bun test test/ --timeout=60000",
      "bun test 'test/unit/foo.test.ts' --timeout=60000",
    ],
    [
      "preserves trailing flags with multiple files",
      ["test/unit/foo.test.ts", "test/unit/bar.test.ts"],
      "bun test test/ --timeout=60000 --bail",
      "bun test 'test/unit/foo.test.ts' 'test/unit/bar.test.ts' --timeout=60000 --bail",
    ],
  ])("%s", (_label, testFiles, command, expected) => {
    const result = buildSmartTestCommand(testFiles as string[], command);
    expect(result).toBe(expected);
  });

  // BUG-18: `--config <path>` (and other path-taking flags) must never be
  // replaced by scoped test files — the config path is not a positional arg.
  test.each([
    [
      "vitest --config <path> — appends scoped tests instead of clobbering the config flag",
      ["test/unit/foo.test.ts"],
      "vitest run --config ./vitest.config.ts",
      "vitest run --config ./vitest.config.ts 'test/unit/foo.test.ts'",
    ],
    [
      "jest --config <path> followed by a flag — config preserved",
      ["test/unit/foo.test.ts"],
      "jest --config config/jest.config.js --runInBand",
      "jest --config config/jest.config.js --runInBand 'test/unit/foo.test.ts'",
    ],
    [
      "combined --config=<path> form — config preserved",
      ["test/unit/foo.test.ts"],
      "jest --config=config/jest.config.js",
      "jest --config=config/jest.config.js 'test/unit/foo.test.ts'",
    ],
    [
      "a genuine trailing positional path after --config is still replaced",
      ["test/unit/foo.test.ts"],
      "jest --config config/jest.config.js test/",
      "jest --config config/jest.config.js 'test/unit/foo.test.ts'",
    ],
  ])("%s", (_label, testFiles, command, expected) => {
    const result = buildSmartTestCommand(testFiles as string[], command);
    expect(result).toBe(expected);
  });

  // ENH-2: pnpm/turbo/nx monorepo scoping flags take a path argument and must
  // never be replaced by scoped test files.
  test.each([
    [
      "pnpm --filter ./packages/api — filter preserved, tests appended",
      ["packages/api/test/unit/foo.test.ts"],
      "pnpm --filter ./packages/api test",
      "pnpm --filter ./packages/api test 'packages/api/test/unit/foo.test.ts'",
    ],
    [
      "pnpm --filter=<pkg> combined form — filter preserved",
      ["test/unit/foo.test.ts"],
      "pnpm --filter=@scope/api test",
      "pnpm --filter=@scope/api test 'test/unit/foo.test.ts'",
    ],
    [
      "pnpm -F ./packages/api short form — filter preserved",
      ["packages/api/test/unit/foo.test.ts"],
      "pnpm -F ./packages/api test",
      "pnpm -F ./packages/api test 'packages/api/test/unit/foo.test.ts'",
    ],
    [
      "turbo --filter <pkg> followed by a flag — filter preserved",
      ["test/unit/foo.test.ts"],
      "turbo run test --filter=@scope/api --continue",
      "turbo run test --filter=@scope/api --continue 'test/unit/foo.test.ts'",
    ],
    [
      "pnpm --dir packages/api — dir preserved, tests appended",
      ["test/unit/foo.test.ts"],
      "pnpm --dir packages/api test",
      "pnpm --dir packages/api test 'test/unit/foo.test.ts'",
    ],
  ])("%s", (_label, testFiles, command, expected) => {
    const result = buildSmartTestCommand(testFiles as string[], command);
    expect(result).toBe(expected);
  });

  // BUG-26 (D-18): the smart-runner heuristic replaces the last path-like
  // token with scoped test files. When the candidate is an interpreter's
  // script operand (e.g. `node ./scripts/run-tests.js`), replacing it with
  // `node 'test/unit/foo.test.ts'` runs the wrong thing. Fail-safe: append
  // instead of replacing — worst case runs a superset, never the wrong target.
  test.each([
    [
      "node ./scripts/run-tests.js — appends scoped tests",
      ["test/unit/foo.test.ts"],
      "node ./scripts/run-tests.js",
      "node ./scripts/run-tests.js 'test/unit/foo.test.ts'",
    ],
    [
      "bun ./scripts/run-tests.ts — appends scoped tests",
      ["test/unit/foo.test.ts"],
      "bun ./scripts/run-tests.ts",
      "bun ./scripts/run-tests.ts 'test/unit/foo.test.ts'",
    ],
    [
      "python ./run_tests.py — appends scoped tests",
      ["test/unit/foo.test.ts"],
      "python ./run_tests.py",
      "python ./run_tests.py 'test/unit/foo.test.ts'",
    ],
    ["npx jest — appends scoped tests", ["test/unit/foo.test.ts"], "npx jest", "npx jest 'test/unit/foo.test.ts'"],
  ])("BUG-26: %s", (_label, testFiles, command, expected) => {
    const result = buildSmartTestCommand(testFiles as string[], command);
    expect(result).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Helpers to mock Bun.spawn (used internally via the "bun" import alias)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// mapSourceToTests
// ---------------------------------------------------------------------------

describe("mapSourceToTests", () => {
  let originalFile: typeof Bun.file;

  beforeEach(() => {
    originalFile = Bun.file;
  });

  afterEach(() => {
    Object.assign(Bun, { file: originalFile });
  });

  function mockFileExists(existingPaths: string[]) {
    Object.assign(Bun, {
      file: (path: string) => ({
        exists: () => Promise.resolve(existingPaths.includes(path)),
      }),
    });
  }

  test("maps src/foo/bar.ts to unit path; also checks integration path; returns both when both exist; only returns files on disk", async () => {
    mockFileExists(["/repo/test/unit/foo/bar.test.ts"]);
    expect(await mapSourceToTests(["src/foo/bar.ts"], "/repo")).toEqual(["/repo/test/unit/foo/bar.test.ts"]);

    mockFileExists(["/repo/test/integration/foo/bar.test.ts"]);
    expect(await mapSourceToTests(["src/foo/bar.ts"], "/repo")).toEqual(["/repo/test/integration/foo/bar.test.ts"]);

    mockFileExists(["/repo/test/unit/foo/bar.test.ts", "/repo/test/integration/foo/bar.test.ts"]);
    expect(await mapSourceToTests(["src/foo/bar.ts"], "/repo")).toEqual([
      "/repo/test/unit/foo/bar.test.ts",
      "/repo/test/integration/foo/bar.test.ts",
    ]);

    mockFileExists(["/repo/test/unit/utils/helper.test.ts"]);
    const diskOnly = await mapSourceToTests(["src/utils/helper.ts"], "/repo");
    expect(diskOnly).toEqual(["/repo/test/unit/utils/helper.test.ts"]);
    expect(diskOnly).not.toContain("/repo/test/integration/utils/helper.test.ts");
  });

  test.each([
    ["no test files match", () => mockFileExists([]), ["src/foo/bar.ts"] as string[]],
    ["empty sourceFiles input", () => mockFileExists(["/repo/test/unit/foo/bar.test.ts"]), [] as string[]],
  ])("returns empty array when %s", async (_label, setup, files) => {
    setup();
    const result = await mapSourceToTests(files, "/repo");
    expect(result).toEqual([]);
  });

  test("handles multiple source files and aggregates results", async () => {
    mockFileExists(["/repo/test/unit/foo/bar.test.ts", "/repo/test/unit/baz/qux.test.ts"]);

    const result = await mapSourceToTests(["src/foo/bar.ts", "src/baz/qux.ts"], "/repo");

    expect(result).toEqual(["/repo/test/unit/foo/bar.test.ts", "/repo/test/unit/baz/qux.test.ts"]);
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
    Object.assign(Bun, { Glob: originalGlob });
    Object.assign(Bun, { file: originalFile });
  });

  test("matches nested monorepo src imports after stripping prefix before src/", async () => {
    Object.assign(Bun, {
      Glob: class {
        async *scan(_workdir: string) {
          yield "test/unit/auth/service.test.ts";
        }
      },
    });

    Object.assign(Bun, {
      file: (path: string) => ({
        text: async () =>
          path === "/repo/test/unit/auth/service.test.ts" ? "import { service } from '../../src/auth/service';" : "",
      }),
    });

    const result = await importGrepFallback(["packages/api/src/auth/service.ts"], "/repo", ["test/**/*.test.ts"]);

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

    _gitDeps.spawn = makeSpawn(() => gitOutput).spawn;

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

  test.each([
    [
      "exits with non-zero code",
      () => {
        _gitDeps.spawn = makeSpawn(() => ({ exitCode: 128, stdout: "" })).spawn;
      },
    ],
    [
      "throws (not a repo)",
      () => {
        _gitDeps.spawn = makeSpawn(() => {
          throw new Error("git not found");
        }).spawn;
      },
    ],
  ])("returns empty array when git %s", async (_label, setup) => {
    setup();
    const result = await getChangedNonTestFiles("/fake/repo");
    expect(result).toEqual([]);
  });

  test("returns all changed files when testFileRegex is empty", async () => {
    const gitOutput = ["src/foo.js", "pkg/bar.rs", "src/baz.ts"].join("\n");

    _gitDeps.spawn = makeSpawn(() => gitOutput).spawn;

    const result = await getChangedNonTestFiles("/fake/repo");

    expect(result).toEqual(["src/foo.js", "pkg/bar.rs", "src/baz.ts"]);
  });

  test("returns empty array when no files changed", async () => {
    _gitDeps.spawn = makeSpawn(() => "").spawn;

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

    _gitDeps.spawn = makeSpawn(() => gitOutput).spawn;

    const result = await getChangedNonTestFiles("/fake/repo", undefined, "packages/api");

    expect(result).toEqual(["packages/api/src/auth.ts", "packages/api/pkg/auth.go"]);
  });

  test("returns all files when packagePrefix is undefined", async () => {
    const gitOutput = ["src/index.ts", "packages/api/src/auth.ts"].join("\n");

    _gitDeps.spawn = makeSpawn(() => gitOutput).spawn;

    const result = await getChangedNonTestFiles("/fake/repo", undefined, undefined);

    expect(result).toEqual(["src/index.ts", "packages/api/src/auth.ts"]);
  });

  test("returns empty when packagePrefix does not match any changed files", async () => {
    const gitOutput = ["src/index.ts", "packages/web/src/app.ts"].join("\n");

    _gitDeps.spawn = makeSpawn(() => gitOutput).spawn;

    const result = await getChangedNonTestFiles("/fake/repo", undefined, "packages/api");

    expect(result).toEqual([]);
  });

  // Issue #557 — co-located test files should be excluded when testFileRegex is provided
  test("excludes co-located test files when testFileRegex is provided", async () => {
    const gitOutput = ["packages/lib/src/util.ts", "packages/lib/src/util.test.ts"].join("\n");

    _gitDeps.spawn = makeSpawn(() => gitOutput).spawn;

    const result = await getChangedNonTestFiles("/fake/repo", undefined, "packages/lib", [/\.test\.ts$/]);

    expect(result).toEqual(["packages/lib/src/util.ts"]);
  });

  test("returns all changed files when testFileRegex is empty (backward-compatible)", async () => {
    const gitOutput = ["packages/lib/src/util.ts", "packages/lib/src/util.test.ts", "packages/lib/pkg/util.go"].join(
      "\n",
    );

    _gitDeps.spawn = makeSpawn(() => gitOutput).spawn;

    const result = await getChangedNonTestFiles("/fake/repo", undefined, "packages/lib");

    // Without testFileRegex: all changed package files are returned
    expect(result).toContain("packages/lib/src/util.ts");
    expect(result).toContain("packages/lib/src/util.test.ts");
    expect(result).toContain("packages/lib/pkg/util.go");
  });

  // Issue #565 — git root ≠ project root
  test("filters correctly when project root is nested inside git root; behavior unchanged when roots are equal", async () => {
    // Scenario 1: nax-dogfood is the git root, fixtures/monorepo-tiny is the project root.
    _gitUtilDeps.getGitRoot = mock(async () => "/big-repo");
    _gitDeps.spawn = makeSpawn(() =>
      [
        "fixtures/monorepo-tiny/packages/lib/src/util.ts",
        "fixtures/monorepo-tiny/packages/lib/src/util.test.ts",
        "other-package/src/index.ts",
      ].join("\n"),
    ).spawn;
    expect(
      await getChangedNonTestFiles(
        "/big-repo/fixtures/monorepo-tiny",
        undefined,
        "packages/lib",
        [/\.test\.ts$/],
        undefined,
        "/big-repo/fixtures/monorepo-tiny",
      ),
    ).toEqual(["packages/lib/src/util.ts"]);

    // Scenario 2: project root equals git root — no offset
    _gitUtilDeps.getGitRoot = mock(async (_wd: string) => null);
    _gitDeps.spawn = makeSpawn(() => ["packages/lib/src/util.ts", "packages/lib/src/util.test.ts"].join("\n")).spawn;
    expect(
      await getChangedNonTestFiles("/fake/repo", undefined, "packages/lib", [/\.test\.ts$/], undefined, "/fake/repo"),
    ).toEqual(["packages/lib/src/util.ts"]);
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

  test("returns absolute paths of co-located, separated, and both test file layouts", async () => {
    _gitDeps.spawn = makeSpawn(() => ["packages/lib/src/util.ts", "packages/lib/src/util.test.ts"].join("\n")).spawn;
    expect(
      await getChangedTestFiles("/fake/repo/packages/lib", "/fake/repo", undefined, "packages/lib", TS_TEST_REGEX),
    ).toEqual(["/fake/repo/packages/lib/src/util.test.ts"]);

    _gitDeps.spawn = makeSpawn(() =>
      ["packages/lib/src/util.ts", "packages/lib/test/unit/util.test.ts"].join("\n"),
    ).spawn;
    expect(
      await getChangedTestFiles("/fake/repo/packages/lib", "/fake/repo", undefined, "packages/lib", TS_TEST_REGEX),
    ).toEqual(["/fake/repo/packages/lib/test/unit/util.test.ts"]);

    _gitDeps.spawn = makeSpawn(() =>
      ["packages/lib/src/util.test.ts", "packages/lib/test/unit/other.test.ts"].join("\n"),
    ).spawn;
    const both = await getChangedTestFiles(
      "/fake/repo/packages/lib",
      "/fake/repo",
      undefined,
      "packages/lib",
      TS_TEST_REGEX,
    );
    expect(both).toHaveLength(2);
    expect(both).toContain("/fake/repo/packages/lib/src/util.test.ts");
    expect(both).toContain("/fake/repo/packages/lib/test/unit/other.test.ts");
  });

  test("scopes to packagePrefix — ignores test files from other packages", async () => {
    const gitOutput = ["packages/lib/src/util.test.ts", "packages/app/src/index.test.ts"].join("\n");

    _gitDeps.spawn = makeSpawn(() => gitOutput).spawn;

    const result = await getChangedTestFiles(
      "/fake/repo/packages/lib",
      "/fake/repo",
      undefined,
      "packages/lib",
      TS_TEST_REGEX,
    );

    expect(result).toEqual(["/fake/repo/packages/lib/src/util.test.ts"]);
  });

  test.each([
    [
      "no test files changed",
      () => {
        _gitDeps.spawn = makeSpawn(() => "packages/lib/src/util.ts").spawn;
      },
      "packages/lib" as const,
      TS_TEST_REGEX,
    ],
    [
      "testFileRegex is empty",
      () => {
        _gitDeps.spawn = makeSpawn(() => "packages/lib/src/util.test.ts").spawn;
      },
      "packages/lib" as const,
      [] as RegExp[],
    ],
    [
      "git exits with non-zero code",
      () => {
        _gitDeps.spawn = makeSpawn(() => ({ exitCode: 128, stdout: "" })).spawn;
      },
      undefined,
      TS_TEST_REGEX,
    ],
  ])("returns empty when %s", async (_label, setup, prefix, regex) => {
    setup();
    const workdir = prefix ? "/fake/repo/packages/lib" : "/fake/repo";
    const result = await getChangedTestFiles(workdir, "/fake/repo", undefined, prefix, regex);
    expect(result).toEqual([]);
  });

  test("works without packagePrefix for single-package repos", async () => {
    const gitOutput = ["src/util.ts", "test/unit/util.test.ts"].join("\n");

    _gitDeps.spawn = makeSpawn(() => gitOutput).spawn;

    const result = await getChangedTestFiles("/repo", "/repo", undefined, undefined, TS_TEST_REGEX);

    expect(result).toEqual(["/repo/test/unit/util.test.ts"]);
  });

  test("is language-agnostic — detects Go test files via regex", async () => {
    const gitOutput = ["packages/backend/pkg/auth/auth.go", "packages/backend/pkg/auth/auth_test.go"].join("\n");

    _gitDeps.spawn = makeSpawn(() => gitOutput).spawn;

    const result = await getChangedTestFiles("/repo/packages/backend", "/repo", undefined, "packages/backend", [
      /_test\.go$/,
    ]);

    expect(result).toEqual(["/repo/packages/backend/pkg/auth/auth_test.go"]);
  });

  // Issue #565 — git root ≠ project root
  test("filters correctly when project root is nested inside git root; behavior unchanged when roots are equal", async () => {
    // Scenario 1: git root differs from project root — paths include extra prefix
    _gitUtilDeps.getGitRoot = mock(async () => "/big-repo");
    _gitDeps.spawn = makeSpawn(() =>
      [
        "fixtures/monorepo-tiny/packages/lib/src/util.ts",
        "fixtures/monorepo-tiny/packages/lib/src/util.test.ts",
        "other/src/index.test.ts",
      ].join("\n"),
    ).spawn;
    expect(
      await getChangedTestFiles(
        "/big-repo/fixtures/monorepo-tiny",
        "/big-repo/fixtures/monorepo-tiny",
        undefined,
        "packages/lib",
        [/\.test\.ts$/],
      ),
    ).toEqual(["/big-repo/fixtures/monorepo-tiny/packages/lib/src/util.test.ts"]);

    // Scenario 2: project root equals git root — no offset
    _gitUtilDeps.getGitRoot = mock(async (_wd: string) => null);
    _gitDeps.spawn = makeSpawn(() => ["packages/lib/src/util.ts", "packages/lib/src/util.test.ts"].join("\n")).spawn;
    expect(await getChangedTestFiles("/fake/repo", "/fake/repo", undefined, "packages/lib", [/\.test\.ts$/])).toEqual([
      "/fake/repo/packages/lib/src/util.test.ts",
    ]);
  });
});
