import { describe, test, expect } from "bun:test";
import {
  extractTestStructure,
  formatTestSummary,
  truncateToTokenBudget,
  type TestFileInfo,
} from "../src/context/test-scanner";

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

  test("handles single-quoted strings", () => {
    const source = `describe('Auth', () => { it('logs in', () => {}); });`;
    const result = extractTestStructure(source);
    expect(result.describes[0].name).toBe("Auth");
    expect(result.describes[0].tests).toEqual(["logs in"]);
  });

  test("handles backtick strings", () => {
    const source = "describe(`Math utils`, () => { test(`adds numbers`, () => {}); });";
    const result = extractTestStructure(source);
    expect(result.describes[0].name).toBe("Math utils");
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
    const source = `export function helper() { return 42; }`;
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
      describes: [
        { name: "CRUD", tests: ["create", "read", "update", "delete", "upsert"] },
      ],
    },
    {
      relativePath: "test/validation.test.ts",
      testCount: 3,
      describes: [
        { name: "Input validation", tests: ["required name", "max length", "type check"] },
      ],
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

  test("includes dedup instruction", () => {
    const result = formatTestSummary(files, "names-only");
    expect(result).toContain("DO NOT duplicate");
  });

  test("shows total count in header", () => {
    const result = formatTestSummary(files, "names-only");
    expect(result).toContain("8 tests across 2 files");
  });

  test("returns empty string for no files", () => {
    expect(formatTestSummary([], "names-only")).toBe("");
  });
});

describe("truncateToTokenBudget", () => {
  const files: TestFileInfo[] = [
    {
      relativePath: "test/store.test.ts",
      testCount: 10,
      describes: [
        { name: "CRUD", tests: Array.from({ length: 10 }, (_, i) => `test ${i}`) },
      ],
    },
    {
      relativePath: "test/auth.test.ts",
      testCount: 8,
      describes: [
        { name: "Auth", tests: Array.from({ length: 8 }, (_, i) => `auth test ${i}`) },
      ],
    },
  ];

  test("uses preferred detail if within budget", () => {
    const result = truncateToTokenBudget(files, 5000, "describe-blocks");
    expect(result.detail).toBe("describe-blocks");
    expect(result.truncated).toBe(false);
  });

  test("falls back to simpler detail if over budget", () => {
    // Very tight budget — force fallback
    const result = truncateToTokenBudget(files, 50, "describe-blocks");
    expect(result.truncated).toBe(true);
  });

  test("handles tiny budget with fallback message", () => {
    const result = truncateToTokenBudget(files, 10, "describe-blocks");
    expect(result.truncated).toBe(true);
    expect(result.summary).toContain("test files");
  });
});
