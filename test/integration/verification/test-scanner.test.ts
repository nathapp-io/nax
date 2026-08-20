import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type TestFileInfo,
  deriveTestPatterns,
  extractTestStructure,
  formatTestSummary,
  generateTestCoverageSummary,
  scanTestFiles,
  truncateToTokenBudget,
} from "@/context/test-scanner";
import { makeTempDir } from "@test/helpers";

describe("extractTestStructure", () => {
  test("extracts describe and test blocks", () => {
    const source = `
describe("Store", () => {
  test("creates a record", () => {});
  test("reads a record", () => {});
});

describe("Validation", () => {
  it("rejects empty name", () => {});
});
`;
    const result = extractTestStructure(source);
    expect(result.testCount).toBe(3);
    expect(result.describes).toHaveLength(2);
    expect(result.describes[0].name).toBe("Store");
    expect(result.describes[0].tests).toEqual(["creates a record", "reads a record"]);
    expect(result.describes[1].name).toBe("Validation");
    expect(result.describes[1].tests).toEqual(["rejects empty name"]);
  });

  test("handles single-quoted and backtick strings", () => {
    const single = extractTestStructure(`describe('Auth', () => { it('logs in', () => {}); });`);
    expect(single.describes[0].name).toBe("Auth");
    expect(single.describes[0].tests).toEqual(["logs in"]);

    const backtick = extractTestStructure("describe(`Math utils`, () => { test(`adds numbers`, () => {}); });");
    expect(backtick.describes[0].name).toBe("Math utils");
  });

  test("handles top-level tests without describe", () => {
    const source = `
test("standalone test 1", () => {});
test("standalone test 2", () => {});
`;
    const result = extractTestStructure(source);
    expect(result.testCount).toBe(2);
    expect(result.describes).toHaveLength(1);
    expect(result.describes[0].name).toBe("(top-level)");
    expect(result.describes[0].tests).toHaveLength(2);
  });

  test("returns empty for no tests; handles single describe with nested test", () => {
    const empty = extractTestStructure("export function helper() { return 42; }");
    expect(empty.testCount).toBe(0);
    expect(empty.describes).toHaveLength(0);

    const mixed = extractTestStructure(`describe("Suite", () => { test("in suite", () => {}); });`);
    expect(mixed.testCount).toBe(1);
    expect(mixed.describes).toHaveLength(1);
  });
});

describe("formatTestSummary", () => {
  const files: TestFileInfo[] = [
    {
      relativePath: "test/store.test.ts",
      testCount: 5,
      describes: [{ name: "CRUD", tests: ["create", "read", "update", "delete", "upsert"] }],
    },
    {
      relativePath: "test/validation.test.ts",
      testCount: 3,
      describes: [{ name: "Input validation", tests: ["required name", "max length", "type check"] }],
    },
  ];

  test("all three detail levels produce correct output; header and empty input", () => {
    const namesOnly = formatTestSummary(files, "names-only");
    expect(namesOnly).toContain("test/store.test.ts");
    expect(namesOnly).toContain("(5 tests)");
    expect(namesOnly).toContain("test/validation.test.ts");
    expect(namesOnly).toContain("(3 tests)");
    expect(namesOnly).not.toContain("CRUD");
    expect(namesOnly).toContain("8 tests across 2 files");
    expect(namesOnly).toContain("DO NOT duplicate");

    const namesAndCounts = formatTestSummary(files, "names-and-counts");
    expect(namesAndCounts).toContain("CRUD (5 tests)");
    expect(namesAndCounts).toContain("Input validation (3 tests)");
    expect(namesAndCounts).not.toContain("create");

    const describeBlocks = formatTestSummary(files, "describe-blocks");
    expect(describeBlocks).toContain("create");
    expect(describeBlocks).toContain("read");
    expect(describeBlocks).toContain("required name");

    expect(formatTestSummary([], "names-only")).toBe("");
  });
});

describe("truncateToTokenBudget", () => {
  const files: TestFileInfo[] = [
    {
      relativePath: "test/store.test.ts",
      testCount: 10,
      describes: [{ name: "CRUD", tests: Array.from({ length: 10 }, (_, i) => `test ${i}`) }],
    },
    {
      relativePath: "test/auth.test.ts",
      testCount: 8,
      describes: [{ name: "Auth", tests: Array.from({ length: 8 }, (_, i) => `auth test ${i}`) }],
    },
  ];

  test("uses preferred detail when within budget; falls back and truncates when budget is too tight", () => {
    const large = truncateToTokenBudget(files, 5000, "describe-blocks");
    expect(large.detail).toBe("describe-blocks");
    expect(large.truncated).toBe(false);

    expect(truncateToTokenBudget(files, 50, "describe-blocks").truncated).toBe(true);
    const tiny = truncateToTokenBudget(files, 10, "describe-blocks");
    expect(tiny.truncated).toBe(true);
    expect(tiny.summary).toContain("test files");
  });
});

describe("deriveTestPatterns", () => {
  test("derives test patterns from source file paths", () => {
    const contextFiles = ["src/health.service.ts", "src/db/connection.ts"];
    const patterns = deriveTestPatterns(contextFiles);

    // Should generate patterns for health.service.ts
    expect(patterns).toContain("health.service.test.ts");
    expect(patterns).toContain("health.service.spec.ts");
    expect(patterns).toContain("health.test.ts"); // Simple basename without .service

    // Should generate patterns for connection.ts
    expect(patterns).toContain("connection.test.ts");
    expect(patterns).toContain("connection.spec.ts");
  });

  test.each([
    ["plain .ts", ["src/utils.ts"], ["utils.test.ts", "utils.spec.ts", "utils.test.js", "utils.spec.js"]],
    [
      "tsx/jsx extensions",
      ["src/component.tsx", "src/script.jsx"],
      ["component.test.tsx", "component.spec.tsx", "script.test.jsx", "script.spec.jsx"],
    ],
  ] as const)("generates patterns for %s", (_label, contextFiles, expected) => {
    const patterns = deriveTestPatterns([...contextFiles]);
    for (const p of expected) expect(patterns).toContain(p);
  });

  test("strips common suffixes; returns empty for empty input; deduplicates patterns", () => {
    const patterns = deriveTestPatterns(["src/user.service.ts", "src/api.controller.ts", "src/app.module.ts"]);
    expect(patterns).toContain("user.service.test.ts");
    expect(patterns).toContain("user.test.ts");
    expect(patterns).toContain("api.controller.test.ts");
    expect(patterns).toContain("api.test.ts");

    expect(deriveTestPatterns([])).toEqual([]);

    const deduped = deriveTestPatterns(["src/foo.ts", "src/foo.service.ts"]);
    expect(deduped.filter((p) => p === "foo.test.ts")).toHaveLength(1);
  });
});

describe("scanTestFiles with scoping", () => {
  test("scopes test files to contextFiles when scopeToStory=true", async () => {
    const tempDir = makeTempDir("nax-test-scanner-");

    try {
      // Create test directory structure
      const testDir = path.join(tempDir, "test");
      await fs.mkdir(testDir);

      // Create test files
      await fs.writeFile(
        path.join(testDir, "health.service.test.ts"),
        'describe("Health Service", () => { test("works", () => {}); });',
      );
      await fs.writeFile(
        path.join(testDir, "db.connection.test.ts"),
        'describe("DB Connection", () => { test("connects", () => {}); });',
      );
      await fs.writeFile(
        path.join(testDir, "auth.service.test.ts"),
        'describe("Auth Service", () => { test("authenticates", () => {}); });',
      );

      // Scan with contextFiles (only health.service.ts)
      const result = await scanTestFiles({
        workdir: tempDir,
        testDir: "test",
        contextFiles: ["src/health.service.ts"],
        scopeToStory: true,
      });

      // Should only include health.service.test.ts
      expect(result.length).toBe(1);
      expect(result[0].relativePath).toBe("test/health.service.test.ts");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("scans all test files when scopeToStory=false", async () => {
    const tempDir = makeTempDir("nax-test-scanner-");

    try {
      const testDir = path.join(tempDir, "test");
      await fs.mkdir(testDir);

      await fs.writeFile(
        path.join(testDir, "health.service.test.ts"),
        'describe("Health", () => { test("works", () => {}); });',
      );
      await fs.writeFile(
        path.join(testDir, "auth.service.test.ts"),
        'describe("Auth", () => { test("works", () => {}); });',
      );

      // Scan with scopeToStory=false (should scan all)
      const result = await scanTestFiles({
        workdir: tempDir,
        testDir: "test",
        contextFiles: ["src/health.service.ts"],
        scopeToStory: false,
      });

      expect(result.length).toBe(2);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("falls back to full scan when no contextFiles provided", async () => {
    const tempDir = makeTempDir("nax-test-scanner-");

    try {
      const testDir = path.join(tempDir, "test");
      await fs.mkdir(testDir);

      await fs.writeFile(path.join(testDir, "test1.test.ts"), 'describe("Test1", () => { test("works", () => {}); });');
      await fs.writeFile(path.join(testDir, "test2.test.ts"), 'describe("Test2", () => { test("works", () => {}); });');

      // No contextFiles, should scan all
      const result = await scanTestFiles({
        workdir: tempDir,
        testDir: "test",
        scopeToStory: true,
      });

      expect(result.length).toBe(2);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("generateTestCoverageSummary with scoping", () => {
  test("generates scoped summary when contextFiles provided", async () => {
    const tempDir = makeTempDir("nax-test-scanner-");

    try {
      const testDir = path.join(tempDir, "test");
      await fs.mkdir(testDir);

      await fs.writeFile(
        path.join(testDir, "health.service.test.ts"),
        'describe("Health", () => { test("check", () => {}); });',
      );
      await fs.writeFile(
        path.join(testDir, "auth.service.test.ts"),
        'describe("Auth", () => { test("login", () => {}); });',
      );

      const result = await generateTestCoverageSummary({
        workdir: tempDir,
        testDir: "test",
        contextFiles: ["src/health.service.ts"],
        scopeToStory: true,
        maxTokens: 500,
        detail: "names-and-counts",
      });

      // Should only include health.service.test.ts
      expect(result.files.length).toBe(1);
      expect(result.totalTests).toBe(1);
      expect(result.summary).toContain("health.service.test.ts");
      expect(result.summary).not.toContain("auth.service.test.ts");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("falls back to full scan when scopeToStory=true but no contextFiles", async () => {
    const tempDir = makeTempDir("nax-test-scanner-");

    try {
      const testDir = path.join(tempDir, "test");
      await fs.mkdir(testDir);

      await fs.writeFile(path.join(testDir, "test.test.ts"), 'describe("Test", () => { test("works", () => {}); });');

      // scopeToStory=true but no contextFiles → should fall back to full scan
      // (warning logged via structured logger, not console.warn)
      const result = await generateTestCoverageSummary({
        workdir: tempDir,
        testDir: "test",
        scopeToStory: true, // true but no contextFiles
        maxTokens: 500,
      });

      // Should still scan all files (fallback behavior)
      expect(result.totalTests).toBeGreaterThan(0);
      expect(result.files.length).toBe(1);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("returns empty result when no test files found", async () => {
    const tempDir = makeTempDir("nax-test-scanner-");

    try {
      const testDir = path.join(tempDir, "test");
      await fs.mkdir(testDir);

      const result = await generateTestCoverageSummary({
        workdir: tempDir,
        testDir: "test",
        contextFiles: ["src/health.service.ts"],
        scopeToStory: true,
      });

      expect(result.files).toEqual([]);
      expect(result.totalTests).toBe(0);
      expect(result.summary).toBe("");
      expect(result.tokens).toBe(0);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

// PERF-2: an oversized test file (e.g. a 50MB generated fixture) must not be
// fully read into memory just to discover there are no `describe`/`test`
// blocks. Mirrors MAX_NEIGHBOR_FILE_SIZE_BYTES (1MB) in code-neighbor-cache.
describe("scanTestFiles — per-file size cap (PERF-2)", () => {
  test("skips files larger than MAX_TEST_FILE_SIZE_BYTES", async () => {
    const tempDir = makeTempDir("nax-test-scanner-oversize-");
    try {
      const testDir = path.join(tempDir, "test");
      await fs.mkdir(testDir);

      // One small file (should be picked up) and one oversized file (should
      // be skipped without buffering).
      await fs.writeFile(path.join(testDir, "small.test.ts"), 'describe("S", () => { test("ok", () => {}); });');

      // 2MB of whitespace + valid test syntax at the end. The scanner must
      // stat-then-skip without reading the full buffer.
      const big = `${" ".repeat(2 * 1024 * 1024)}describe("Big", () => { test("ok", () => {}); });`;
      await fs.writeFile(path.join(testDir, "huge.test.ts"), big);

      const result = await scanTestFiles({
        workdir: tempDir,
        testDir: "test",
        scopeToStory: false,
      });

      const rels = result.map((f) => f.relativePath).sort();
      expect(rels.some((p) => p.endsWith("small.test.ts"))).toBe(true);
      expect(rels.some((p) => p.endsWith("huge.test.ts"))).toBe(false);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
