import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "../../helpers/temp";
import {
  parseTestFile,
  findDeadImports,
  findDeadTestReferences,
  generateDeadTestsReport,
  scanTestDirectory,
} from "../../../scripts/check-dead-tests";

describe("parseTestFile", () => {
  test("extracts import paths from test file", () => {
    const content = `
      import { foo } from "src/config/loader";
      import { bar } from "../../../../src/pipeline/stages/verify";
      import { baz } from "@/helpers";
    `;
    const result = parseTestFile(content, "test/unit/example.test.ts");

    expect(result.imports).toContain("src/config/loader");
    expect(result.imports).toContain("src/pipeline/stages/verify");
    expect(result.imports).not.toContain("@/helpers"); // External import
  });

  test("extracts test names from test file", () => {
    const content = `
      describe("feature", () => {
        test("does something", () => {});
        test("handles edge cases", () => {});
      });
    `;
    const result = parseTestFile(content, "test/unit/example.test.ts");

    expect(result.testNames).toContain("does something");
    expect(result.testNames).toContain("handles edge cases");
  });

  test("extracts describe blocks from test file", () => {
    const content = `
      describe("routing", () => {});
      describe("verification", () => {});
    `;
    const result = parseTestFile(content, "test/unit/example.test.ts");

    expect(result.describes).toContain("routing");
    expect(result.describes).toContain("verification");
  });

  test("returns normalized import paths", () => {
    const content = `
      import { x } from "../../../../src/execution/runner";
      import { y } from "../../../src/config/schema";
    `;
    const result = parseTestFile(content, "test/unit/example.test.ts");

    expect(result.imports).toContain("src/execution/runner");
    expect(result.imports).toContain("src/config/schema");
  });
});

describe("findDeadImports", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-");
    // Create src structure
    mkdirSync(join(tempDir, "src", "config"), { recursive: true });
    mkdirSync(join(tempDir, "src", "pipeline", "stages"), { recursive: true });
    writeFileSync(join(tempDir, "src", "config", "loader.ts"), "export const loader = {};");
    writeFileSync(join(tempDir, "src", "pipeline", "stages", "verify.ts"), "export const verify = {};");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns empty array when all imports exist", () => {
    const testInfo = {
      path: "test/unit/example.test.ts",
      imports: ["src/config/loader", "src/pipeline/stages/verify"],
      testNames: [],
      describes: [],
    };

    const deadImports = findDeadImports(testInfo, tempDir);
    expect(deadImports).toEqual([]);
  });

  test("flags imports that don't exist on disk", () => {
    const testInfo = {
      path: "test/unit/example.test.ts",
      imports: ["src/config/loader", "src/config/missing", "src/pipeline/stages/verify"],
      testNames: [],
      describes: [],
    };

    const deadImports = findDeadImports(testInfo, tempDir);
    expect(deadImports).toContain("src/config/missing");
    expect(deadImports).not.toContain("src/config/loader");
  });

  test("checks both .ts and .ts extensions", () => {
    const testInfo = {
      path: "test/unit/example.test.ts",
      imports: ["src/config/loader"],
      testNames: [],
      describes: [],
    };

    // loader.ts exists, so should be fine
    const deadImports = findDeadImports(testInfo, tempDir);
    expect(deadImports).toEqual([]);
  });
});

describe("findDeadTestReferences", () => {
  test("flags test names referencing removed features", () => {
    const testInfo = {
      path: "test/unit/example.test.ts",
      imports: [],
      testNames: ["dispatcher integration", "worktree cleanup", "normal test"],
      describes: [],
    };

    const deadRefs = findDeadTestReferences(testInfo);
    expect(deadRefs).toContain("dispatcher");
    expect(deadRefs).toContain("worktree");
    expect(deadRefs).not.toContain("normal test");
  });

  test("flags describe blocks referencing removed features", () => {
    const testInfo = {
      path: "test/unit/example.test.ts",
      imports: [],
      testNames: [],
      describes: ["tdd-orchestrator-prompts", "verification v0.21", "valid module"],
    };

    const deadRefs = findDeadTestReferences(testInfo);
    expect(deadRefs).toContain("tdd-orchestrator-prompts");
    expect(deadRefs).toContain("verification v0.21");
    expect(deadRefs).not.toContain("valid module");
  });

  test("matches removed features case-insensitively", () => {
    const testInfo = {
      path: "test/unit/example.test.ts",
      imports: [],
      testNames: ["Dispatcher handling", "WORKTREE setup"],
      describes: [],
    };

    const deadRefs = findDeadTestReferences(testInfo);
    expect(deadRefs.length).toBeGreaterThan(0);
  });
});

describe("scanTestDirectory", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-");
    // Create test structure with a good test
    mkdirSync(join(tempDir, "test", "unit"), { recursive: true });
    mkdirSync(join(tempDir, "src", "config"), { recursive: true });
    writeFileSync(
      join(tempDir, "src", "config", "loader.ts"),
      "export const loader = {};"
    );
    writeFileSync(
      join(tempDir, "test", "unit", "good.test.ts"),
      `
      import { loader } from "src/config/loader";
      describe("loader", () => {
        test("loads config", () => {});
      });
    `
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("scans test directory and returns test info", () => {
    // Add a test file with dead import
    writeFileSync(
      join(tempDir, "test", "unit", "bad.test.ts"),
      `
      import { missing } from "src/config/missing";
      test("test", () => {});
    `
    );

    const result = scanTestDirectory(join(tempDir, "test"), tempDir);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].path).toContain("bad.test.ts");
  });

  test("identifies files with dead imports", () => {
    // Add a test file with dead import
    writeFileSync(
      join(tempDir, "test", "unit", "bad.test.ts"),
      `
      import { missing } from "src/config/missing";
      test("test", () => {});
    `
    );

    const result = scanTestDirectory(join(tempDir, "test"), tempDir);
    const badFile = result.find((t) => t.path.includes("bad.test.ts"));
    expect(badFile).toBeDefined();
    expect(badFile?.deadImports).toContain("src/config/missing");
  });

  test("identifies files with dead references", () => {
    writeFileSync(
      join(tempDir, "test", "unit", "old.test.ts"),
      `
      describe("dispatcher integration", () => {
        test("test", () => {});
      });
    `
    );

    const result = scanTestDirectory(join(tempDir, "test"), tempDir);
    const oldFile = result.find((t) => t.path.includes("old.test.ts"));
    expect(oldFile).toBeDefined();
    if (oldFile) {
      expect(oldFile.deadReferences?.length).toBeGreaterThan(0);
    }
  });
});

describe("generateDeadTestsReport", () => {
  test("generates markdown report from dead test findings", () => {
    const findings = [
      {
        path: "test/unit/old.test.ts",
        imports: ["src/config/loader"],
        testNames: ["dispatcher test"],
        describes: [],
        deadImports: [],
        deadReferences: ["dispatcher"],
      },
      {
        path: "test/integration/missing.test.ts",
        imports: ["src/missing/module"],
        testNames: [],
        describes: [],
        deadImports: ["src/missing/module"],
        deadReferences: [],
      },
    ];

    const report = generateDeadTestsReport(findings);

    expect(report).toContain("Dead Tests Report");
    expect(report).toContain("test/unit/old.test.ts");
    expect(report).toContain("test/integration/missing.test.ts");
    expect(report).toContain("dispatcher");
    expect(report).toContain("src/missing/module");
  });

  test("includes recommendations in report", () => {
    const findings = [
      {
        path: "test/unit/example.test.ts",
        imports: ["src/missing"],
        testNames: [],
        describes: [],
        deadImports: ["src/missing"],
        deadReferences: [],
      },
    ];

    const report = generateDeadTestsReport(findings);
    expect(report).toContain("Recommendation");
  });

  test("shows empty section when no dead tests found", () => {
    const findings: any[] = [];
    const report = generateDeadTestsReport(findings);
    expect(report).toContain("No dead tests detected");
  });
});
