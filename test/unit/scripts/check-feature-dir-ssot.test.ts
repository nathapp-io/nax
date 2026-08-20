import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "@test/helpers";
import { findFeatureDirViolations, formatFeatureDirViolationReport } from "@scripts/check-feature-dir-ssot";

describe("findFeatureDirViolations", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-feature-dir-check-");
    mkdirSync(join(tempDir, "src", "config"), { recursive: true });
    mkdirSync(join(tempDir, "src", "prompts", "builders"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns empty array when the shared helper is used", () => {
    writeFileSync(
      join(tempDir, "src", "safe.ts"),
      'import { featureDir } from "@/config";\nconst dir = join(featureDir(root, id), "prd.json");\n',
    );

    expect(findFeatureDirViolations(tempDir)).toEqual([]);
  });

  test('flags the argv form: join(root, ".nax", "features", …)', () => {
    writeFileSync(
      join(tempDir, "src", "argv.ts"),
      'import { join } from "node:path";\nconst dir = join(projectDir, ".nax", "features", featureId);\n',
    );

    const violations = findFeatureDirViolations(tempDir);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe("src/argv.ts");
    expect(violations[0]?.line).toBe(2);
  });

  test("flags the template form: `${root}/.nax/features/…`", () => {
    writeFileSync(
      join(tempDir, "src", "template.ts"),
      "const prd = `${workdir}/.nax/features/${featureId}/prd.json`;\n",
    );

    expect(findFeatureDirViolations(tempDir)).toHaveLength(1);
  });

  test("flags a bare pattern literal used as a glob", () => {
    writeFileSync(join(tempDir, "src", "glob.ts"), 'const pattern = ".nax/features/*/prd.json";\n');

    expect(findFeatureDirViolations(tempDir)).toHaveLength(1);
  });

  test("does not flag prose in comments", () => {
    writeFileSync(
      join(tempDir, "src", "commented.ts"),
      "// Walks .nax/features/<id>/prd.json to resolve the feature.\nconst x = 1;\n",
    );

    expect(findFeatureDirViolations(tempDir)).toEqual([]);
  });

  test("does not flag prose in a trailing comment after real code", () => {
    writeFileSync(
      join(tempDir, "src", "trailing.ts"),
      'const featureId = parts[2]; // ".nax/features/<featureId>/prd.json"\n',
    );

    expect(findFeatureDirViolations(tempDir)).toEqual([]);
  });

  test("honours an explicit allow marker on a prose string", () => {
    writeFileSync(
      join(tempDir, "src", "message.ts"),
      'const msg = "no features found in .nax/features/"; // nax-feature-dir-allow: user-facing message\n',
    );

    expect(findFeatureDirViolations(tempDir)).toEqual([]);
  });

  test("exempts src/config/paths.ts, which defines the helpers", () => {
    writeFileSync(join(tempDir, "src", "config", "paths.ts"), 'export const PROJECT_FEATURES_DIR = ".nax/features";\n');

    expect(findFeatureDirViolations(tempDir)).toEqual([]);
  });

  test("exempts src/prompts/, whose literals are LLM instruction text", () => {
    writeFileSync(
      join(tempDir, "src", "prompts", "builders", "acceptance-builder.ts"),
      "const p = `Write the test under <repo-root>/.nax/features/${name}/`;\n",
    );

    expect(findFeatureDirViolations(tempDir)).toEqual([]);
  });
});

describe("formatFeatureDirViolationReport", () => {
  test("returns ok message when there are no violations", () => {
    expect(formatFeatureDirViolationReport([])).toContain("[OK]");
  });

  test("includes file, line, and guidance when violations exist", () => {
    const report = formatFeatureDirViolationReport([
      {
        file: "src/unsafe.ts",
        line: 7,
        snippet: 'const dir = join(projectDir, ".nax", "features", featureId);',
      },
    ]);

    expect(report).toContain("[FAIL]");
    expect(report).toContain("src/unsafe.ts:7");
    expect(report).toContain("featureDir(");
    expect(report).toContain("nax-feature-dir-allow");
  });
});
