import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  findAliasInternalViolations,
  formatAliasViolationReport,
  formatShadowedBarrelReport,
  loadBarrels,
  scanFileForAliasInternals,
} from "../../../scripts/check-alias-internals";
import { cleanupTempDir, makeTempDir } from "../../helpers/temp";

function setupRepo(root: string) {
  mkdirSync(join(root, "src", "routing"), { recursive: true });
  writeFileSync(join(root, "src", "routing", "index.ts"), "export {};\n");
  writeFileSync(join(root, "src", "routing", "router.ts"), "export class Router {}\n");

  mkdirSync(join(root, "src", "config"), { recursive: true });
  writeFileSync(join(root, "src", "config", "index.ts"), "export {};\n");
  writeFileSync(join(root, "src", "config", "selectors.ts"), "export type X = number;\n");

  mkdirSync(join(root, "src", "utils"), { recursive: true });
  writeFileSync(join(root, "src", "utils", "leaf.ts"), "export const x = 1;\n");

  mkdirSync(join(root, "test", "helpers"), { recursive: true });
  writeFileSync(join(root, "test", "helpers", "index.ts"), "export {};\n");

  mkdirSync(join(root, "test", "unit"), { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
}

describe("loadBarrels", () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir("nax-alias-check-");
    setupRepo(root);
  });
  afterEach(() => cleanupTempDir(root));

  test("discovers src/* and test/* directories that have an index.ts", () => {
    const { barrels } = loadBarrels(root);
    expect(barrels).toContain("@/routing");
    expect(barrels).toContain("@/config");
    expect(barrels).toContain("@test/helpers");
  });

  test("excludes directories without an index.ts barrel", () => {
    const { barrels } = loadBarrels(root);
    expect(barrels).not.toContain("@/utils");
  });
});

describe("scanFileForAliasInternals", () => {
  let root: string;
  let barrels: Set<string>;

  beforeEach(() => {
    root = makeTempDir("nax-alias-scan-");
    setupRepo(root);
    barrels = loadBarrels(root).barrels;
  });
  afterEach(() => cleanupTempDir(root));

  test("flags value imports that bypass a barrel", () => {
    const file = join(root, "src", "consumer.ts");
    const content = 'import { Router } from "@/routing/router";\n';
    const violations = scanFileForAliasInternals(file, content, barrels, root);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      importPath: "@/routing/router",
      suggestion: "@/routing",
      line: 1,
    });
  });

  test("allows barrel-only imports", () => {
    const file = join(root, "src", "consumer.ts");
    const content = 'import { Router } from "@/routing";\n';
    expect(scanFileForAliasInternals(file, content, barrels, root)).toEqual([]);
  });

  test("allows type-only imports into internal paths (singleton-safe)", () => {
    const file = join(root, "src", "consumer.ts");
    const content = 'import type { X } from "@/config/selectors";\nexport type { X } from "@/config/selectors";\n';
    expect(scanFileForAliasInternals(file, content, barrels, root)).toEqual([]);
  });

  test("flags value imports from selectors-style internal paths", () => {
    const file = join(root, "src", "consumer.ts");
    const content = 'import { selectors } from "@/config/selectors";\n';
    const violations = scanFileForAliasInternals(file, content, barrels, root);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.suggestion).toBe("@/config");
  });

  test("flags dynamic imports into internal paths", () => {
    const file = join(root, "src", "consumer.ts");
    const content = 'const m = await import("@/routing/router");\n';
    const violations = scanFileForAliasInternals(file, content, barrels, root);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.importPath).toBe("@/routing/router");
  });

  test("ignores plain relative imports — out of scope for this check", () => {
    const file = join(root, "src", "consumer.ts");
    const content = 'import { Router } from "../routing/router";\n';
    expect(scanFileForAliasInternals(file, content, barrels, root)).toEqual([]);
  });

  test("ignores aliases pointing into directories without barrels", () => {
    const file = join(root, "src", "consumer.ts");
    const content = 'import { x } from "@/utils/leaf";\n';
    expect(scanFileForAliasInternals(file, content, barrels, root)).toEqual([]);
  });
});

describe("findAliasInternalViolations", () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir("nax-alias-find-");
    setupRepo(root);
  });
  afterEach(() => cleanupTempDir(root));

  test("walks src/, test/, and bin/ recursively", () => {
    writeFileSync(join(root, "src", "a.ts"), 'import { Router } from "@/routing/router";\n');
    writeFileSync(join(root, "test", "unit", "b.test.ts"), 'import { x } from "@test/helpers/inner";\n');
    writeFileSync(join(root, "bin", "c.ts"), 'import { Router } from "@/routing";\n');

    const violations = findAliasInternalViolations(root);
    const paths = violations.map((v) => v.file).sort();
    expect(paths).toEqual(["src/a.ts", "test/unit/b.test.ts"]);
  });
});

describe("formatAliasViolationReport", () => {
  test("returns OK message when clean", () => {
    expect(formatAliasViolationReport([], 35)).toContain("[OK]");
    expect(formatAliasViolationReport([], 35)).toContain("35 barrels");
  });

  test("includes file, line, and suggestion when violations exist", () => {
    const report = formatAliasViolationReport(
      [
        {
          file: "src/consumer.ts",
          line: 1,
          importPath: "@/routing/router",
          suggestion: "@/routing",
        },
      ],
      35,
    );
    expect(report).toContain("[FAIL]");
    expect(report).toContain("src/consumer.ts:1");
    expect(report).toContain("@/routing/router");
    expect(report).toContain("@/routing");
  });
});

describe("test-importer exemption (GitHub #1647)", () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir("nax-alias-check-");
    setupRepo(root);
  });
  afterEach(() => cleanupTempDir(root));

  test("allows a test file to value-import a src internal via @/", () => {
    const file = join(root, "test", "unit", "router.test.ts");
    const content = 'import { Router } from "@/routing/router";\n';
    writeFileSync(file, content);

    const { barrels } = loadBarrels(root);
    expect(scanFileForAliasInternals(file, content, barrels, root)).toEqual([]);
  });

  test("allows a test file to dynamically import a src internal via @/", () => {
    const file = join(root, "test", "unit", "router.test.ts");
    const content = 'const m = await import("@/routing/router");\n';
    writeFileSync(file, content);

    const { barrels } = loadBarrels(root);
    expect(scanFileForAliasInternals(file, content, barrels, root)).toEqual([]);
  });

  test("still flags the same import from a src file", () => {
    const file = join(root, "src", "routing", "consumer.ts");
    const content = 'import { Router } from "@/routing/router";\n';
    writeFileSync(file, content);

    const { barrels } = loadBarrels(root);
    const violations = scanFileForAliasInternals(file, content, barrels, root);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.importPath).toBe("@/routing/router");
  });

  test("still flags the same import from a bin file", () => {
    const file = join(root, "bin", "cli.ts");
    const content = 'import { Router } from "@/routing/router";\n';
    writeFileSync(file, content);

    const { barrels } = loadBarrels(root);
    expect(scanFileForAliasInternals(file, content, barrels, root)).toHaveLength(1);
  });

  test("does NOT exempt @test/ internals for test files — fixtures stay barrelled", () => {
    mkdirSync(join(root, "test", "helpers"), { recursive: true });
    writeFileSync(join(root, "test", "helpers", "config.ts"), "export const makeConfig = () => ({});\n");

    const file = join(root, "test", "unit", "thing.test.ts");
    const content = 'import { makeConfig } from "@test/helpers/config";\n';
    writeFileSync(file, content);

    const { barrels } = loadBarrels(root);
    const violations = scanFileForAliasInternals(file, content, barrels, root);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.importPath).toBe("@test/helpers/config");
  });

  test("a directory merely named test-* is not treated as a test importer", () => {
    mkdirSync(join(root, "src", "test-runners"), { recursive: true });
    const file = join(root, "src", "test-runners", "runner.ts");
    const content = 'import { Router } from "@/routing/router";\n';
    writeFileSync(file, content);

    const { barrels } = loadBarrels(root);
    expect(scanFileForAliasInternals(file, content, barrels, root)).toHaveLength(1);
  });
});

describe("shadowed directory barrels (GitHub #1648)", () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir("nax-alias-check-");
    setupRepo(root);
  });
  afterEach(() => cleanupTempDir(root));

  test("reports nothing when no sibling file shadows a barrel", () => {
    expect(loadBarrels(root).shadowed).toEqual([]);
  });

  test("detects a directory barrel shadowed by a same-named sibling file", () => {
    writeFileSync(join(root, "src", "routing.ts"), 'export * from "./routing/index";\n');

    const { shadowed } = loadBarrels(root);
    expect(shadowed).toHaveLength(1);
    expect(shadowed[0]).toEqual({
      alias: "@/routing",
      shadowedBy: "src/routing.ts",
      barrel: "src/routing/index.ts",
    });
  });

  test("drops the shadowed barrel from the reachable set, so it is never suggested", () => {
    writeFileSync(join(root, "src", "routing.ts"), "export const x = 1;\n");

    const { barrels } = loadBarrels(root);
    expect(barrels.has("@/routing")).toBe(false);
    expect(barrels.has("@/config")).toBe(true);
  });

  test("a shadowed barrel's internals are not reported as alias violations", () => {
    writeFileSync(join(root, "src", "routing.ts"), "export const x = 1;\n");

    const file = join(root, "src", "consumer.ts");
    const content = 'import { Router } from "@/routing/router";\n';
    writeFileSync(file, content);

    const { barrels } = loadBarrels(root);
    expect(scanFileForAliasInternals(file, content, barrels, root)).toEqual([]);
  });

  test("detects a shadowed @test/ barrel too", () => {
    writeFileSync(join(root, "test", "helpers.ts"), "export const h = 1;\n");

    const { shadowed } = loadBarrels(root);
    expect(shadowed.map((s) => s.alias)).toContain("@test/helpers");
  });

  test("report names the file, the barrel and the remedy", () => {
    const message = formatShadowedBarrelReport([
      { alias: "@/routing", shadowedBy: "src/routing.ts", barrel: "src/routing/index.ts" },
    ]);
    expect(message).toContain("[FAIL] 1 directory barrel(s) shadowed");
    expect(message).toContain("src/routing.ts");
    expect(message).toContain("src/routing/index.ts");
    expect(message).toContain("fold it into the barrel");
  });
});
