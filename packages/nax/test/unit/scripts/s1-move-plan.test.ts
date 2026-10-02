import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseMoveManifest } from "@scripts/lib/agent-move-manifest";
import { barrelMap, buildMovePlan, exportedNames, importedNames, testDestination } from "@scripts/lib/s1-move/plan";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

let root = "";
afterEach(() => {
  if (root) cleanupTempDir(root);
  root = "";
});

function write(rel: string, content: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
}

const MANIFEST = parseMoveManifest({
  entries: [
    { from: "src/moving/", to: "lib/" },
    { from: "src/utils/one.ts", to: "internal/one.ts" },
  ],
});

/** A package where a.test.ts can move, b.test.ts needs a nax-bound helper, c.test.ts tests staying code. */
function fixture(): void {
  root = makeTempDir("s1-move-plan-");
  write("src/moving/a.ts", 'import { one } from "@/utils/one";\nexport const a = one;\n');
  write("src/moving/b.ts", 'import { a } from "./a";\nexport const b = a;\n');
  write("src/utils/one.ts", "export const one = 1;\n");
  write("src/stays/c.ts", 'import { a } from "@/moving/a";\nexport const c = a;\n');
  write(
    "test/helpers/index.ts",
    'export { makeTemp } from "./temp";\nexport { type Cfg, makeConfig } from "./config";\n',
  );
  write("test/helpers/temp.ts", 'import { one } from "@/utils/one";\nexport const makeTemp = () => one;\n');
  write(
    "test/helpers/config.ts",
    'import { c } from "@/stays/c";\nexport type Cfg = 1;\nexport const makeConfig = () => c;\n',
  );
  write("test/unit/moving/a.test.ts", 'import { a } from "@/moving/a";\nimport { makeTemp } from "@test/helpers";\n');
  write("test/unit/moving/b.test.ts", 'import { b } from "@/moving/b";\nimport { makeConfig } from "@test/helpers";\n');
  write("test/unit/stays/c.test.ts", 'import { c } from "@/stays/c";\n');
  write("test/unit/utils/one.test.ts", 'import { one } from "../../../src/utils/one";\n');
}

describe("clause parsing", () => {
  test("exportedNames takes the alias, importedNames the original", () => {
    expect(exportedNames(" a, type B, c as d ")).toEqual(["a", "B", "d"]);
    expect(importedNames(" a, type B, c as d ")).toEqual(["a", "B", "c"]);
  });
});

describe("barrelMap", () => {
  test("maps every barrel name to its helper module", () => {
    fixture();
    expect([...barrelMap(root)]).toEqual([
      ["makeTemp", "test/helpers/temp.ts"],
      ["Cfg", "test/helpers/config.ts"],
      ["makeConfig", "test/helpers/config.ts"],
    ]);
  });

  test("refuses a barrel that uses export *", () => {
    fixture();
    write("test/helpers/index.ts", 'export * from "./temp";\n');
    expect(() => barrelMap(root)).toThrow("export *");
  });
});

describe("testDestination", () => {
  test("mirrors the manifest move of the tested source, file or directory", () => {
    expect(testDestination(MANIFEST, "test/unit/moving/a.test.ts")).toBe("test/unit/lib/a.test.ts");
    expect(testDestination(MANIFEST, "test/unit/moving/acs.test.ts")).toBe("test/unit/lib/acs.test.ts");
    expect(testDestination(MANIFEST, "test/unit/utils/one.test.ts")).toBe("test/unit/internal/one.test.ts");
    expect(testDestination(MANIFEST, "test/unit/other/x.test.ts")).toBe("test/unit/other/x.test.ts");
  });
});

describe("buildMovePlan", () => {
  test("moves the manifest sources, the clean tests and the helpers they reach", () => {
    fixture();
    const plan = buildMovePlan(root, MANIFEST);
    expect(plan.sources).toEqual([
      { from: "src/moving/a.ts", to: "src/lib/a.ts" },
      { from: "src/moving/b.ts", to: "src/lib/b.ts" },
      { from: "src/utils/one.ts", to: "src/internal/one.ts" },
    ]);
    expect(plan.tests).toEqual([
      { from: "test/unit/moving/a.test.ts", to: "test/unit/lib/a.test.ts" },
      { from: "test/unit/utils/one.test.ts", to: "test/unit/internal/one.test.ts" },
    ]);
    expect(plan.helpers).toEqual([{ from: "test/helpers/temp.ts", to: "test/helpers/temp.ts" }]);
  });

  test("a moving test that reads the disk needs an explicit ruling", () => {
    fixture();
    write("test/unit/moving/disk.test.ts", 'import { a } from "@/moving/a";\nconst here = import.meta.dir;\n');
    expect(() => buildMovePlan(root, MANIFEST)).toThrow("test/unit/moving/disk.test.ts");
  });

  test("a test whose helper reaches staying code stays", () => {
    fixture();
    rmSync(join(root, "test/unit/moving/a.test.ts"));
    const plan = buildMovePlan(root, MANIFEST);
    expect(plan.tests.map((t) => t.from)).toEqual(["test/unit/utils/one.test.ts"]);
    expect(plan.helpers).toEqual([]);
  });
});
