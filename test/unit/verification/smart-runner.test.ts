import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

// Dynamic imports used intentionally: mock.module() in verify-smart-runner.test.ts (which runs
// before this file alphabetically) poisons the ESM registry. Static imports capture the mock
// binding at eval time. Dynamic imports inside beforeAll resolve AFTER the other file's afterAll
// restores the real module, guaranteeing we test the real implementation.
let buildSmartTestCommand: (testFiles: string[], baseCommand: string) => string;
let mapSourceToTests: (sourceFiles: string[], workdir: string) => Promise<string[]>;
let getChangedSourceFiles: (workdir: string) => Promise<string[]>;

beforeAll(async () => {
  const mod = await import("../../../src/verification/smart-runner");
  buildSmartTestCommand = mod.buildSmartTestCommand;
  mapSourceToTests = mod.mapSourceToTests;
  getChangedSourceFiles = mod.getChangedSourceFiles;
});

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
});

describe("getChangedSourceFiles", () => {
  let originalSpawn: typeof Bun.spawn;

  beforeEach(() => {
    originalSpawn = Bun.spawn;
  });

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: restoring original
    (Bun as any).spawn = originalSpawn;
  });

  test("returns only .ts files under src/", async () => {
    const gitOutput = [
      "src/verification/smart-runner.ts",
      "src/utils/git.ts",
      "README.md",
      "src/index.js",
      "test/unit/foo.test.ts",
      "src/config/schema.ts",
    ].join("\n");

    // biome-ignore lint/suspicious/noExplicitAny: mocking
    (Bun as any).spawn = mock(() => makeProc(gitOutput, 0));

    const result = await getChangedSourceFiles("/fake/repo");

    expect(result).toEqual([
      "src/verification/smart-runner.ts",
      "src/utils/git.ts",
      "src/config/schema.ts",
    ]);
  });

  test("returns empty array when git exits with non-zero code", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: mocking
    (Bun as any).spawn = mock(() => makeProc("", 128));

    const result = await getChangedSourceFiles("/fake/repo");

    expect(result).toEqual([]);
  });

  test("returns empty array when git throws (e.g. not a repo)", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: mocking
    (Bun as any).spawn = mock(() => {
      throw new Error("git not found");
    });

    const result = await getChangedSourceFiles("/fake/repo");

    expect(result).toEqual([]);
  });

  test("filters out non-.ts src files", async () => {
    const gitOutput = ["src/foo.js", "src/bar.tsx", "src/baz.ts"].join("\n");

    // biome-ignore lint/suspicious/noExplicitAny: mocking
    (Bun as any).spawn = mock(() => makeProc(gitOutput, 0));

    const result = await getChangedSourceFiles("/fake/repo");

    expect(result).toEqual(["src/baz.ts"]);
  });

  test("returns empty array when no files changed", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: mocking
    (Bun as any).spawn = mock(() => makeProc("", 0));

    const result = await getChangedSourceFiles("/fake/repo");

    expect(result).toEqual([]);
  });
});
