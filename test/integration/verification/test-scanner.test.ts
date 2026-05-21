import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeTempDir } from "../../helpers/temp";
import {
  type TestFileInfo,
  deriveTestPatterns,
  extractTestStructure,
  formatTestSummary,
  generateTestCoverageSummary,
  scanTestFiles,
  truncateToTokenBudget,
} from "../../../src/context/test-scanner";

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

  test("returns empty for file with no tests", () => {
    const source = "export function helper() { return 42; }";
    const result = extractTestStructure(source);
    expect(result.testCount).toBe(0);
    expect(result.describes).toHaveLength(0);
  });

  test("handles mixed describe and top-level tests", () => {
    const source = `
describe("Suite", () => {
  test("in suite", () => {});
});
`;
    const result = extractTestStructure(source);
    expect(result.testCount).toBe(1);
    expect(result.describes).toHaveLength(1);
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

  test("names-only shows file and count", () => {
    const result = formatTestSummary(files, "names-only");
    expect(result).toContain("test/store.test.ts");
    expect(result).toContain("(5 tests)");
    expect(result).toContain("test/validation.test.ts");
    expect(result).toContain("(3 tests)");
    expect(result).not.toContain("CRUD");
  });

  test("names-and-counts shows describe blocks", () => {
    const result = formatTestSummary(files, "names-and-counts");
    expect(result).toContain("CRUD (5 tests)");
    expect(result).toContain("Input validation (3 tests)");
    expect(result).not.toContain("create");
  });

  test("describe-blocks shows individual test names", () => {
    const result = formatTestSummary(files, "describe-blocks");
    expect(result).toContain("create");
    expect(result).toContain("read");
    expect(result).toContain("required name");
  });

  test("header shows total count, includes dedup instruction, empty input → empty string", () => {
    const result = formatTestSummary(files, "names-only");
    expect(result).toContain("8 tests across 2 files");
    expect(result).toContain("DO NOT duplicate");
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

  test("uses preferred detail if within budget", () => {
    const result = truncateToTokenBudget(files, 5000, "describe-blocks");
    expect(result.detail).toBe("describe-blocks");
    expect(result.truncated).toBe(false);
  });

  test("falls back and truncates when budget is too tight", () => {
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
    ["tsx/jsx extensions", ["src/component.tsx", "src/script.jsx"], ["component.test.tsx", "component.spec.tsx", "script.test.jsx", "script.spec.jsx"]],
  ] as const)("generates patterns for %s", (_label, contextFiles, expected) => {
    const patterns = deriveTestPatterns([...contextFiles]);
    for (const p of expected) expect(patterns).toContain(p);
  });

  test("strips common suffixes like .service, .controller, .module", () => {
    const contextFiles = ["src/user.service.ts", "src/api.controller.ts", "src/app.module.ts"];
    const patterns = deriveTestPatterns(contextFiles);

    // Should include both full and simplified patterns
    expect(patterns).toContain("user.service.test.ts");
    expect(patterns).toContain("user.test.ts"); // Simplified
    expect(patterns).toContain("api.controller.test.ts");
    expect(patterns).toContain("api.test.ts"); // Simplified
  });

  test("returns empty array for empty input and deduplicates patterns", () => {
    expect(deriveTestPatterns([])).toEqual([]);

    const patterns = deriveTestPatterns(["src/foo.ts", "src/foo.service.ts"]);
    expect(patterns.filter((p) => p === "foo.test.ts")).toHaveLength(1);
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
