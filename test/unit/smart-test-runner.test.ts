/**
 * STR-007: Smart Test Runner — Config Coercion + 3-Pass Discovery Tests
 *
 * Tests:
 * - Config coercion: boolean → SmartTestRunnerConfig object
 * - Pass 1: path convention mapping (existing behavior)
 * - Pass 2: import-grep fallback
 * - Pass 3: full-suite fallback (empty return from mapSourceToTests + importGrepFallback)
 * - Custom testFilePatterns
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NaxConfigSchema } from "../../src/config/schemas";
import { importGrepFallback, mapSourceToTests } from "../../src/verification/smart-runner";
import type { SmartTestRunnerConfig } from "../../src/config/types";

// ---------------------------------------------------------------------------
// Config coercion: boolean → SmartTestRunnerConfig
// ---------------------------------------------------------------------------

describe("SmartTestRunner config coercion", () => {
  function parseExecution(smartTestRunner: unknown) {
    const minimalConfig = {
      version: 1,
      models: {
        fast: { provider: "anthropic", model: "haiku" },
        balanced: { provider: "anthropic", model: "sonnet" },
        powerful: { provider: "anthropic", model: "opus" },
      },
      autoMode: {
        enabled: true,
        defaultAgent: "claude",
        fallbackOrder: [],
        complexityRouting: { simple: "fast", medium: "balanced", complex: "powerful", expert: "powerful" },
        escalation: { enabled: true, tierOrder: [{ tier: "fast", attempts: 1 }] },
      },
      routing: { strategy: "keyword" },
      execution: {
        maxIterations: 10,
        iterationDelayMs: 0,
        costLimit: 1,
        sessionTimeoutSeconds: 60,
        maxStoriesPerFeature: 10,
        rectification: {
          enabled: true,
          maxRetries: 1,
          fullSuiteTimeoutSeconds: 30,
          maxFailureSummaryChars: 500,
          abortOnIncreasingFailures: true,
        },
        regressionGate: { enabled: true, timeoutSeconds: 30 },
        contextProviderTokenBudget: 100,
        smartTestRunner,
      },
      quality: {
        requireTypecheck: false,
        requireLint: false,
        requireTests: false,
        commands: {},
        forceExit: false,
        detectOpenHandles: false,
        detectOpenHandlesRetries: 0,
        gracePeriodMs: 500,
        drainTimeoutMs: 0,
        shell: "/bin/sh",
        stripEnvVars: [],
        environmentalEscalationDivisor: 2,
      },
      tdd: { maxRetries: 0, autoVerifyIsolation: false, autoApproveVerifier: false },
      constitution: { enabled: false, path: "constitution.md", maxTokens: 100 },
      analyze: { llmEnhanced: false, model: "balanced", fallbackToKeywords: true, maxCodebaseSummaryTokens: 100 },
      review: { enabled: false, checks: [], commands: {} },
      plan: { model: "balanced", outputPath: "spec.md" },
      acceptance: { enabled: false, maxRetries: 0, generateTests: false, testPath: "acceptance.test.ts" },
      context: {
        testCoverage: {
          enabled: false,
          detail: "names-only",
          maxTokens: 50,
          testPattern: "**/*.test.ts",
          scopeToStory: false,
        },
        autoDetect: { enabled: false, maxFiles: 1, traceImports: false },
      },
    };
    return NaxConfigSchema.safeParse(minimalConfig);
  }

  test("boolean true coerces to enabled object with defaults", () => {
    const result = parseExecution(true);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.execution.smartTestRunner).toEqual({
        enabled: true,
        testFilePatterns: ["test/**/*.test.ts"],
        fallback: "import-grep",
      });
    }
  });

  test("boolean false coerces to disabled object with defaults", () => {
    const result = parseExecution(false);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.execution.smartTestRunner).toEqual({
        enabled: false,
        testFilePatterns: ["test/**/*.test.ts"],
        fallback: "import-grep",
      });
    }
  });

  test("omitted field defaults to enabled object", () => {
    const result = parseExecution(undefined);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.execution.smartTestRunner).toEqual({
        enabled: true,
        testFilePatterns: ["test/**/*.test.ts"],
        fallback: "import-grep",
      });
    }
  });

  test("object with enabled: true is preserved as-is", () => {
    const result = parseExecution({
      enabled: true,
      testFilePatterns: ["test/custom/**/*.test.ts"],
      fallback: "import-grep",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.execution.smartTestRunner).toEqual({
        enabled: true,
        testFilePatterns: ["test/custom/**/*.test.ts"],
        fallback: "import-grep",
      });
    }
  });

  test("object with fallback: full-suite is accepted", () => {
    const result = parseExecution({
      enabled: true,
      testFilePatterns: ["test/**/*.test.ts"],
      fallback: "full-suite",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const cfg = result.data.execution.smartTestRunner as SmartTestRunnerConfig;
      expect(cfg.fallback).toBe("full-suite");
    }
  });

  test("custom testFilePatterns are preserved", () => {
    const patterns = ["test/unit/**/*.test.ts", "test/integration/**/*.test.ts"];
    const result = parseExecution({
      enabled: true,
      testFilePatterns: patterns,
      fallback: "import-grep",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const cfg = result.data.execution.smartTestRunner as SmartTestRunnerConfig;
      expect(cfg.testFilePatterns).toEqual(patterns);
    }
  });
});

// ---------------------------------------------------------------------------
// Pass 1: path convention mapping
// ---------------------------------------------------------------------------

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
