import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatReport,
  scanForDeepRelatives,
} from "../../../scripts/check-deep-relatives";
import { cleanupTempDir, makeTempDir } from "../../helpers/temp";

function write(root: string, rel: string, content: string) {
  mkdirSync(join(root, rel.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(join(root, rel), content);
}

describe("scanForDeepRelatives", () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir("nax-deep-rel-");
  });
  afterEach(() => cleanupTempDir(root));

  test("flags 2-level deep relative imports in src/", () => {
    write(root, "src/a/b/c.ts", 'import { X } from "../../utils";\n');
    const violations = scanForDeepRelatives(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      file: "src/a/b/c.ts",
      line: 1,
      importPath: "../../utils",
    });
  });

  test("flags 3-level deep relative imports in test/", () => {
    write(root, "test/unit/a/b.test.ts", 'import { X } from "../../../src/config";\n');
    const violations = scanForDeepRelatives(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.importPath).toBe("../../../src/config");
  });

  test("does not flag 1-level relative imports", () => {
    write(root, "src/a/b.ts", 'import { X } from "../utils";\n');
    expect(scanForDeepRelatives(root)).toHaveLength(0);
  });

  test("flags dynamic imports too", () => {
    write(root, "src/a/b/c.ts", 'const m = await import("../../utils");\n');
    const violations = scanForDeepRelatives(root);
    expect(violations).toHaveLength(1);
  });

  test("suggests @/ alias for src-rooted imports", () => {
    write(root, "src/pipeline/stages/foo.ts", 'import { X } from "../../config";\n');
    const [v] = scanForDeepRelatives(root);
    expect(v?.suggestion).toBe("@/config");
  });

  test("suggests @test/ alias for test-rooted imports", () => {
    write(root, "test/unit/pipeline/foo.test.ts", 'import { X } from "../../helpers";\n');
    const [v] = scanForDeepRelatives(root);
    expect(v?.suggestion).toBe("@test/helpers");
  });

  test("suggests correct alias with sub-path", () => {
    write(root, "src/pipeline/stages/foo.ts", 'import { X } from "../../config/selectors";\n');
    const [v] = scanForDeepRelatives(root);
    expect(v?.suggestion).toBe("@/config/selectors");
  });

  test("skips node_modules and dist directories", () => {
    write(root, "src/node_modules/bad.ts", 'import { X } from "../../utils";\n');
    write(root, "src/dist/bad.ts", 'import { X } from "../../utils";\n');
    expect(scanForDeepRelatives(root)).toHaveLength(0);
  });

  test("skips the exempt check script itself", () => {
    write(root, "scripts/check-deep-relatives.ts", 'import { X } from "../../utils";\n');
    expect(scanForDeepRelatives(root)).toHaveLength(0);
  });
});

describe("formatReport", () => {
  const violation = {
    file: "src/a/b/c.ts",
    line: 1,
    importPath: "../../utils",
    suggestion: "@/utils",
  };

  test("returns OK when count equals baseline", () => {
    const { ok, message } = formatReport([violation], { count: 1, updatedAt: "" });
    expect(ok).toBe(true);
    expect(message).toContain("[OK]");
    expect(message).toContain("baseline: 1");
  });

  test("returns OK with migration note when count dropped below baseline", () => {
    const { ok, message } = formatReport([], { count: 5, updatedAt: "" });
    expect(ok).toBe(true);
    expect(message).toContain("↓ 5 migrated");
  });

  test("returns FAIL when count exceeds baseline", () => {
    const { ok, message } = formatReport([violation, violation], { count: 1, updatedAt: "" });
    expect(ok).toBe(false);
    expect(message).toContain("[FAIL]");
    expect(message).toContain("1 new deep-relative");
  });

  test("returns FAIL with instructions when no baseline file", () => {
    const { ok, message } = formatReport([violation], null);
    expect(ok).toBe(false);
    expect(message).toContain("--update-baseline");
  });

  test("truncates long violation lists to 20 entries", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ ...violation, line: i + 1 }));
    const { message } = formatReport(many, { count: 0, updatedAt: "" });
    expect(message).toContain("... and 5 more");
  });
});
