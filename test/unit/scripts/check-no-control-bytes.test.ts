import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findControlByteViolations, formatControlByteReport } from "@scripts/check-no-control-bytes";
import { makeTempDir } from "@test/helpers";

describe("findControlByteViolations", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-control-byte-check-");
    mkdirSync(join(tempDir, "src"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("returns empty array for a file with only escaped control sequences", () => {
    writeFileSync(join(tempDir, "src", "safe.ts"), `const key = \`\${a}\\u0000\${b}\`;\nconst nl = "line1\\nline2";\n`);

    expect(findControlByteViolations(tempDir)).toEqual([]);
  });

  test("allows normal whitespace (tab, newline, CRLF)", () => {
    writeFileSync(tempFile(tempDir, "whitespace.ts"), "const x = 1;\r\n\tconst y = 2;\n");

    expect(findControlByteViolations(tempDir)).toEqual([]);
  });

  test("flags a raw embedded NUL byte used as a key separator", () => {
    writeFileSync(join(tempDir, "src", "unsafe.ts"), Buffer.from(`const key = \`\${a}\x00\${b}\`;\n`, "utf8"));

    const violations = findControlByteViolations(tempDir);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe("src/unsafe.ts");
    expect(violations[0]?.line).toBe(1);
    expect(violations[0]?.code).toBe(0);
  });

  test("flags a raw Ctrl+C byte in a string literal", () => {
    writeFileSync(join(tempDir, "src", "ctrlc.ts"), Buffer.from('if (char === "\x03") {\n', "utf8"));

    const violations = findControlByteViolations(tempDir);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.code).toBe(3);
  });

  test("reports the correct line number for a violation past the first line", () => {
    writeFileSync(
      join(tempDir, "src", "multiline.ts"),
      Buffer.from('const a = 1;\nconst b = 2;\nconst bad = "\x01";\n', "utf8"),
    );

    const violations = findControlByteViolations(tempDir);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(3);
  });
});

function tempFile(tempDir: string, name: string): string {
  return join(tempDir, "src", name);
}

describe("formatControlByteReport", () => {
  test("returns ok message when there are no violations", () => {
    expect(formatControlByteReport([])).toContain("[OK]");
  });

  test("includes file, line, column, and guidance when violations exist", () => {
    const report = formatControlByteReport([{ file: "src/unsafe.ts", line: 3, column: 18, code: 0 }]);

    expect(report).toContain("[FAIL]");
    expect(report).toContain("src/unsafe.ts:3:18");
    expect(report).toContain("escape sequence");
  });
});
