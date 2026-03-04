/**
 * Smart Test Runner — 3-Pass Discovery Tests
 *
 * Tests:
 * - Pass 1: path convention mapping (mapSourceToTests)
 * - Pass 2: import-grep fallback (importGrepFallback)
 * - Pass 3: full-suite fallback
 * - Custom testFilePatterns
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { importGrepFallback, mapSourceToTests } from "../../../src/verification/smart-runner";

describe("Pass 1: mapSourceToTests (path convention)", () => {
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

  test("returns empty array when no test files exist (triggers Pass 2 at caller)", async () => {
    mockFileExists([]);
    const result = await mapSourceToTests(["src/routing/strategies/llm.ts"], "/repo");
    expect(result).toEqual([]);
  });

  test("returns empty array for empty sourceFiles", async () => {
    mockFileExists([]);
    const result = await mapSourceToTests([], "/repo");
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pass 2: import-grep fallback
// ---------------------------------------------------------------------------

describe("Pass 2: importGrepFallback", () => {
  let originalFile: typeof Bun.file;
  let originalGlob: typeof Bun.Glob;

  beforeEach(() => {
    originalFile = Bun.file;
    originalGlob = Bun.Glob;
  });

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: restoring originals
    (Bun as any).file = originalFile;
    // biome-ignore lint/suspicious/noExplicitAny: restoring originals
    (Bun as any).Glob = originalGlob;
  });

  function mockGlob(files: string[]) {
    // biome-ignore lint/suspicious/noExplicitAny: mocking Glob
    (Bun as any).Glob = class {
      scan(_workdir: string): AsyncIterable<string> {
        return {
          [Symbol.asyncIterator]() {
            let i = 0;
            return {
              async next() {
                if (i < files.length) return { value: files[i++], done: false };
                return { value: undefined as unknown as string, done: true };
              },
            };
          },
        };
      }
    };
  }

  function mockFileContent(contentMap: Record<string, string>) {
    // biome-ignore lint/suspicious/noExplicitAny: mocking
    (Bun as any).file = (path: string) => ({
      exists: () => Promise.resolve(path in contentMap),
      text: () => Promise.resolve(contentMap[path] ?? ""),
    });
  }

  test("returns empty array when sourceFiles is empty", async () => {
    const result = await importGrepFallback([], "/repo", ["test/**/*.test.ts"]);
    expect(result).toEqual([]);
  });

  test("returns empty array when testFilePatterns is empty", async () => {
    const result = await importGrepFallback(["src/foo/bar.ts"], "/repo", []);
    expect(result).toEqual([]);
  });

  test("matches test file that imports the source by basename path", async () => {
    mockGlob(["test/unit/routing.test.ts"]);
    mockFileContent({
      "/repo/test/unit/routing.test.ts": `import { route } from "../../src/routing/strategies/llm";`,
    });

    const result = await importGrepFallback(
      ["src/routing/strategies/llm.ts"],
      "/repo",
      ["test/**/*.test.ts"],
    );

    expect(result).toEqual(["/repo/test/unit/routing.test.ts"]);
  });

  test("matches test file that imports by full path segment", async () => {
    mockGlob(["test/unit/routing.test.ts"]);
    mockFileContent({
      "/repo/test/unit/routing.test.ts": `import something from "../../../routing/strategies/llm";`,
    });

    const result = await importGrepFallback(
      ["src/routing/strategies/llm.ts"],
      "/repo",
      ["test/**/*.test.ts"],
    );

    expect(result).toEqual(["/repo/test/unit/routing.test.ts"]);
  });

  test("does not match test file with no import reference", async () => {
    mockGlob(["test/unit/other.test.ts"]);
    mockFileContent({
      "/repo/test/unit/other.test.ts": `import { something } from "../../src/other/module";`,
    });

    const result = await importGrepFallback(
      ["src/routing/strategies/llm.ts"],
      "/repo",
      ["test/**/*.test.ts"],
    );

    expect(result).toEqual([]);
  });

  test("returns multiple matching test files", async () => {
    mockGlob(["test/unit/a.test.ts", "test/unit/b.test.ts"]);
    mockFileContent({
      "/repo/test/unit/a.test.ts": `import { fn } from "../src/utils/helper";`,
      "/repo/test/unit/b.test.ts": `import { fn } from "../../src/utils/helper";`,
    });

    const result = await importGrepFallback(
      ["src/utils/helper.ts"],
      "/repo",
      ["test/**/*.test.ts"],
    );

    expect(result).toContain("/repo/test/unit/a.test.ts");
    expect(result).toContain("/repo/test/unit/b.test.ts");
    expect(result).toHaveLength(2);
  });

  test("skips test files that cannot be read", async () => {
    mockGlob(["test/unit/broken.test.ts", "test/unit/ok.test.ts"]);
    // biome-ignore lint/suspicious/noExplicitAny: mocking
    (Bun as any).file = (path: string) => ({
      exists: () => Promise.resolve(true),
      text: () => {
        if (path.includes("broken")) throw new Error("read error");
        return Promise.resolve(`import { fn } from "../src/utils/helper";`);
      },
    });

    const result = await importGrepFallback(
      ["src/utils/helper.ts"],
      "/repo",
      ["test/**/*.test.ts"],
    );

    // broken.test.ts is skipped, ok.test.ts matches
    expect(result).toEqual(["/repo/test/unit/ok.test.ts"]);
  });

  test("does not add the same file twice if multiple terms match", async () => {
    mockGlob(["test/unit/routing.test.ts"]);
    // Content contains both "/llm" and "routing/strategies/llm"
    mockFileContent({
      "/repo/test/unit/routing.test.ts": `import { classify } from "../../src/routing/strategies/llm";`,
    });

    const result = await importGrepFallback(
      ["src/routing/strategies/llm.ts"],
      "/repo",
      ["test/**/*.test.ts"],
    );

    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Pass 3: full-suite fallback (empty return triggers full-suite at caller)
// ---------------------------------------------------------------------------

describe("Pass 3: full-suite fallback (empty return from both passes)", () => {
  let originalFile: typeof Bun.file;
  let originalGlob: typeof Bun.Glob;

  beforeEach(() => {
    originalFile = Bun.file;
    originalGlob = Bun.Glob;
  });

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: restoring originals
    (Bun as any).file = originalFile;
    // biome-ignore lint/suspicious/noExplicitAny: restoring originals
    (Bun as any).Glob = originalGlob;
  });

  test("importGrepFallback returns empty array when no test files match any pattern", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: mocking Glob
    (Bun as any).Glob = class {
      scan(_workdir: string): AsyncIterable<string> {
        return {
          [Symbol.asyncIterator]() {
            return { async next() { return { value: undefined as unknown as string, done: true }; } };
          },
        };
      }
    };

    const result = await importGrepFallback(
      ["src/foo/bar.ts"],
      "/repo",
      ["test/**/*.test.ts"],
    );

    expect(result).toEqual([]);
  });

  test("importGrepFallback returns empty array when no scanned test files import the module", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: mocking Glob
    (Bun as any).Glob = class {
      scan(_workdir: string): AsyncIterable<string> {
        let done = false;
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                if (!done) { done = true; return { value: "test/unit/unrelated.test.ts", done: false }; }
                return { value: undefined as unknown as string, done: true };
              },
            };
          },
        };
      }
    };
    // biome-ignore lint/suspicious/noExplicitAny: mocking
    (Bun as any).file = (_path: string) => ({
      text: () => Promise.resolve(`import { x } from "../src/completely/different";`),
    });

    const result = await importGrepFallback(
      ["src/foo/bar.ts"],
      "/repo",
      ["test/**/*.test.ts"],
    );

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Custom testFilePatterns
// ---------------------------------------------------------------------------

describe("Custom testFilePatterns", () => {
  let originalGlob: typeof Bun.Glob;

  beforeEach(() => {
    originalGlob = Bun.Glob;
  });

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: restoring original
    (Bun as any).Glob = originalGlob;
  });

  test("passes custom testFilePatterns to Bun.Glob", async () => {
    const capturedPatterns: string[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: mocking Glob
    (Bun as any).Glob = class {
      constructor(pattern: string) {
        capturedPatterns.push(pattern);
      }
      scan(_workdir: string): AsyncIterable<string> {
        return {
          [Symbol.asyncIterator]() {
            return { async next() { return { value: undefined as unknown as string, done: true }; } };
          },
        };
      }
    };

    await importGrepFallback(
      ["src/foo/bar.ts"],
      "/repo",
      ["test/unit/**/*.spec.ts", "test/integration/**/*.spec.ts"],
    );

    expect(capturedPatterns).toContain("test/unit/**/*.spec.ts");
    expect(capturedPatterns).toContain("test/integration/**/*.spec.ts");
  });

  test("uses each pattern independently", async () => {
    let scanCount = 0;
    // biome-ignore lint/suspicious/noExplicitAny: mocking Glob
    (Bun as any).Glob = class {
      scan(_workdir: string): AsyncIterable<string> {
        scanCount++;
        return {
          [Symbol.asyncIterator]() {
            return { async next() { return { value: undefined as unknown as string, done: true }; } };
          },
        };
      }
    };

    await importGrepFallback(
      ["src/foo/bar.ts"],
      "/repo",
      ["test/unit/**/*.test.ts", "test/integration/**/*.test.ts", "test/e2e/**/*.test.ts"],
    );

    expect(scanCount).toBe(3);
  });
});
