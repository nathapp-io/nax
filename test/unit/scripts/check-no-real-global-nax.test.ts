import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  findForbiddenGlobalNaxUsages,
  formatGlobalNaxViolationReport,
} from "@scripts/check-no-real-global-nax";
import { makeTempDir } from "@test/helpers";

describe("findForbiddenGlobalNaxUsages", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-global-path-check-");
    mkdirSync(join(tempDir, "src"), { recursive: true });
    mkdirSync(join(tempDir, "test", "integration", "config"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns empty array when no direct ~/.nax path is constructed", () => {
    writeFileSync(
      join(tempDir, "src", "safe.ts"),
      'import { globalConfigDir } from "../config/paths";\nconst pluginsDir = join(globalConfigDir(), "plugins");\n',
    );

    expect(findForbiddenGlobalNaxUsages(tempDir)).toEqual([]);
  });

  test("flags direct homedir-based .nax path construction in src", () => {
    writeFileSync(
      join(tempDir, "src", "unsafe.ts"),
      'import os from "node:os";\nimport path from "node:path";\nconst runsDir = path.join(os.homedir(), ".nax", "runs");\n',
    );

    const violations = findForbiddenGlobalNaxUsages(tempDir);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe("src/unsafe.ts");
    expect(violations[0]?.line).toBe(3);
  });

  test("flags direct homedir-based .nax path construction in tests", () => {
    writeFileSync(
      join(tempDir, "test", "unit.test.ts"),
      'import { homedir } from "node:os";\nimport { join } from "node:path";\nconst dir = join(homedir(), ".nax", "events");\n',
    );

    const violations = findForbiddenGlobalNaxUsages(tempDir);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe("test/unit.test.ts");
  });

  test("allows the explicit globalConfigDir fallback test file", () => {
    writeFileSync(
      join(tempDir, "test", "integration", "config", "paths.test.ts"),
      'import { homedir } from "node:os";\nimport { join } from "node:path";\nconst expected = join(homedir(), ".nax");\n',
    );

    expect(findForbiddenGlobalNaxUsages(tempDir)).toEqual([]);
  });
});

describe("formatGlobalNaxViolationReport", () => {
  test("returns ok message when there are no violations", () => {
    expect(formatGlobalNaxViolationReport([])).toContain("[OK]");
  });

  test("includes file, line, and guidance when violations exist", () => {
    const report = formatGlobalNaxViolationReport([
      {
        file: "src/unsafe.ts",
        line: 3,
        snippet: 'const runsDir = path.join(os.homedir(), ".nax", "runs");',
      },
    ]);

    expect(report).toContain("[FAIL]");
    expect(report).toContain("src/unsafe.ts:3");
    expect(report).toContain("globalConfigDir()");
  });
});
