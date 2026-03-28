/**
 * Tests for scripts/check-test-overlap.ts
 *
 * Covers test overlap detection and reporting
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../../helpers/temp";
import { analyzeOverlap, generateReport, parseTestFile } from "../../../scripts/check-test-overlap";

describe("check-test-overlap", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = makeTempDir("nax-test-overlap-");
    mkdirSync(join(testDir, "test", "unit"), { recursive: true });
    mkdirSync(join(testDir, "test", "integration"), { recursive: true });
  });

  afterEach(() => {
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe("parseTestFile", () => {
    test("extracts describe blocks from test file", () => {
      const content = `
import { describe, test, expect } from "bun:test";

describe("myFunction", () => {
  test("returns correct value", () => {
    expect(true).toBe(true);
  });
});
`;
      const result = parseTestFile(content, "test.ts");
      expect(result.describes).toContain("myFunction");
    });

    test("extracts test block names", () => {
      const content = `
import { describe, test } from "bun:test";

describe("module", () => {
  test("test 1", () => {});
  test("test 2", () => {});
});
`;
      const result = parseTestFile(content, "test.ts");
      expect(result.tests.length).toBeGreaterThan(0);
    });

    test("extracts imported source modules", () => {
      const content = `
import { myFunc } from "../../../src/mymodule";
import { otherFunc } from "../../../src/other";

describe("test", () => {
  test("works", () => {});
});
`;
      const result = parseTestFile(content, "test.ts");
      expect(result.imports).toContain("src/mymodule");
      expect(result.imports).toContain("src/other");
    });

    test("handles files with no imports", () => {
      const content = `
describe("test", () => {
  test("works", () => {});
});
`;
      const result = parseTestFile(content, "test.ts");
      expect(result.imports.length).toBe(0);
    });

    test("normalizes import paths correctly", () => {
      const content = `
import { func } from "../../../../src/config/loader";
`;
      const result = parseTestFile(content, "test.ts");
      expect(result.imports).toContain("src/config/loader");
    });
  });

  describe("analyzeOverlap", () => {
    test("identifies fully covered integration tests", () => {
      const unitTests = [
        {
          path: "test/unit/config/loader.test.ts",
          describes: ["loadConfig"],
          tests: [],
          imports: ["src/config/loader"],
        },
      ];

      const integrationTests = [
        {
          path: "test/integration/config/loader.test.ts",
          describes: ["loadConfig"],
          tests: [],
          imports: ["src/config/loader"],
        },
      ];

      const result = analyzeOverlap(unitTests, integrationTests);
      expect(result.redundant.length).toBeGreaterThan(0);
    });

    test("identifies unique integration tests", () => {
      const unitTests = [
        {
          path: "test/unit/config/loader.test.ts",
          describes: ["loadConfig"],
          tests: [],
          imports: ["src/config/loader"],
        },
      ];

      const integrationTests = [
        {
          path: "test/integration/execution/runner.test.ts",
          describes: ["runStory"],
          tests: [],
          imports: ["src/execution/runner"],
        },
      ];

      const result = analyzeOverlap(unitTests, integrationTests);
      expect(result.unique.length).toBeGreaterThan(0);
    });

    test("identifies partial overlap", () => {
      const unitTests = [
        {
          path: "test/unit/config/loader.test.ts",
          describes: ["loadConfig"],
          tests: [],
          imports: ["src/config/loader"],
        },
      ];

      const integrationTests = [
        {
          path: "test/integration/config/loader.test.ts",
          describes: ["loadConfig", "saveConfig"],
          tests: [],
          imports: ["src/config/loader"],
        },
      ];

      const result = analyzeOverlap(unitTests, integrationTests);
      expect(result.partial.length).toBeGreaterThan(0);
    });
  });

  describe("generateReport", () => {
    test("generates markdown report with all sections", () => {
      const overlap = {
        redundant: [
          {
            path: "test/integration/config/loader.test.ts",
            coverage: 100,
            unitMatch: "test/unit/config/loader.test.ts",
          },
        ],
        partial: [
          {
            path: "test/integration/execution/runner.test.ts",
            coverage: 50,
            missingTests: ["saveRunner"],
          },
        ],
        unique: [
          {
            path: "test/integration/pipeline/pipeline.test.ts",
          },
        ],
      };

      const report = generateReport(overlap);
      expect(report).toContain("## REDUNDANT");
      expect(report).toContain("## PARTIAL");
      expect(report).toContain("## UNIQUE");
    });

    test("report contains integration test paths", () => {
      const overlap = {
        redundant: [
          {
            path: "test/integration/config/loader.test.ts",
            coverage: 100,
            unitMatch: "test/unit/config/loader.test.ts",
          },
        ],
        partial: [],
        unique: [],
      };

      const report = generateReport(overlap);
      expect(report).toContain("test/integration/config/loader.test.ts");
    });

    test("report is valid markdown", () => {
      const overlap = {
        redundant: [],
        partial: [],
        unique: [
          {
            path: "test/integration/execution/runner.test.ts",
          },
        ],
      };

      const report = generateReport(overlap);
      expect(report).toContain("# Test Overlap Report");
      expect(report.includes("##")).toBe(true);
    });
  });
});
