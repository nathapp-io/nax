import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../../helpers/temp";
import {
  countFileLines,
  findOversizedTestFiles,
  generateTestSizesReport,
  shouldFailOnHardLimit,
} from "../../../scripts/check-test-sizes";

describe("countFileLines", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("counts lines correctly in a file", () => {
    const filePath = join(tempDir, "test.ts");
    writeFileSync(filePath, "line1\nline2\nline3\n");
    const count = countFileLines(filePath);
    expect(count).toBe(3);
  });

  test("handles empty files", () => {
    const filePath = join(tempDir, "empty.ts");
    writeFileSync(filePath, "");
    const count = countFileLines(filePath);
    expect(count).toBe(0);
  });

  test("counts single line file correctly", () => {
    const filePath = join(tempDir, "single.ts");
    writeFileSync(filePath, "only line");
    const count = countFileLines(filePath);
    expect(count).toBe(1);
  });
});

describe("findOversizedTestFiles", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-");
    mkdirSync(join(tempDir, "test", "unit"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns empty array when all test files are under 500 lines", () => {
    const smallFile = join(tempDir, "test", "unit", "small.test.ts");
    writeFileSync(smallFile, "line\n".repeat(100));

    const oversized = findOversizedTestFiles(join(tempDir, "test"), 500);
    expect(oversized).toEqual([]);
  });

  test("flags files exceeding soft limit (500 lines)", () => {
    const largeFile = join(tempDir, "test", "unit", "large.test.ts");
    writeFileSync(largeFile, "line\n".repeat(510));

    const oversized = findOversizedTestFiles(join(tempDir, "test"), 500);
    expect(oversized.length).toBe(1);
    expect(oversized[0].path).toContain("large.test.ts");
    expect(oversized[0].lineCount).toBe(510);
  });

  test("includes multiple oversized files", () => {
    const file1 = join(tempDir, "test", "unit", "file1.test.ts");
    const file2 = join(tempDir, "test", "unit", "file2.test.ts");
    writeFileSync(file1, "line\n".repeat(510));
    writeFileSync(file2, "line\n".repeat(520));

    const oversized = findOversizedTestFiles(join(tempDir, "test"), 500);
    expect(oversized.length).toBe(2);
  });

  test("sorts results by line count descending", () => {
    const file1 = join(tempDir, "test", "unit", "file1.test.ts");
    const file2 = join(tempDir, "test", "unit", "file2.test.ts");
    writeFileSync(file1, "line\n".repeat(510));
    writeFileSync(file2, "line\n".repeat(600));

    const oversized = findOversizedTestFiles(join(tempDir, "test"), 500);
    expect(oversized[0].lineCount).toBe(600);
    expect(oversized[1].lineCount).toBe(510);
  });

  test("ignores non-.test.ts files", () => {
    const testFile = join(tempDir, "test", "unit", "helper.ts");
    writeFileSync(testFile, "line\n".repeat(600));

    const oversized = findOversizedTestFiles(join(tempDir, "test"), 500);
    expect(oversized.length).toBe(0);
  });

  test("recursively finds test files in subdirectories", () => {
    mkdirSync(join(tempDir, "test", "integration"), { recursive: true });
    const file1 = join(tempDir, "test", "unit", "unit.test.ts");
    const file2 = join(tempDir, "test", "integration", "integration.test.ts");
    writeFileSync(file1, "line\n".repeat(510));
    writeFileSync(file2, "line\n".repeat(520));

    const oversized = findOversizedTestFiles(join(tempDir, "test"), 500);
    expect(oversized.length).toBe(2);
  });
});

describe("shouldFailOnHardLimit", () => {
  test("returns true when skipPrecheck is false and hardLimit is exceeded", () => {
    const oversized = [{ path: "test/file.test.ts", lineCount: 850 }];
    const result = shouldFailOnHardLimit(oversized, 800, false);
    expect(result).toBe(true);
  });

  test("returns false when skipPrecheck is true even if hardLimit is exceeded", () => {
    const oversized = [{ path: "test/file.test.ts", lineCount: 850 }];
    const result = shouldFailOnHardLimit(oversized, 800, true);
    expect(result).toBe(false);
  });

  test("returns false when all files are under hardLimit", () => {
    const oversized = [{ path: "test/file.test.ts", lineCount: 750 }];
    const result = shouldFailOnHardLimit(oversized, 800, false);
    expect(result).toBe(false);
  });

  test("returns true when any file exceeds hardLimit", () => {
    const oversized = [
      { path: "test/file1.test.ts", lineCount: 750 },
      { path: "test/file2.test.ts", lineCount: 850 },
    ];
    const result = shouldFailOnHardLimit(oversized, 800, false);
    expect(result).toBe(true);
  });
});

describe("generateTestSizesReport", () => {
  test("generates report with no oversized files", () => {
    const report = generateTestSizesReport([], 500, 800);
    expect(report).toContain("All test files are within acceptable size limits");
  });

  test("generates report with oversized files", () => {
    const oversized = [
      { path: "test/unit/file1.test.ts", lineCount: 550 },
      { path: "test/unit/file2.test.ts", lineCount: 820 },
    ];
    const report = generateTestSizesReport(oversized, 500, 800);
    expect(report).toContain("file1.test.ts");
    expect(report).toContain("550");
    expect(report).toContain("file2.test.ts");
    expect(report).toContain("820");
  });

  test("includes warning indicator for soft limit violations", () => {
    const oversized = [{ path: "test/unit/file1.test.ts", lineCount: 550 }];
    const report = generateTestSizesReport(oversized, 500, 800);
    expect(report).toContain("⚠");
  });

  test("includes failure indicator for hard limit violations", () => {
    const oversized = [{ path: "test/unit/file2.test.ts", lineCount: 820 }];
    const report = generateTestSizesReport(oversized, 500, 800);
    expect(report).toContain("✗");
  });

  test("includes summary statistics", () => {
    const oversized = [
      { path: "test/unit/file1.test.ts", lineCount: 550 },
      { path: "test/unit/file2.test.ts", lineCount: 820 },
    ];
    const report = generateTestSizesReport(oversized, 500, 800);
    expect(report).toContain("2 test file(s) exceed the soft limit");
    expect(report).toContain("1 test file(s) exceed the hard limit");
  });
});
