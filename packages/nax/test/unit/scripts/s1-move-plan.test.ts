import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseMoveManifest } from "@scripts/lib/agent-move-manifest";
import {
  barrelMap,
  buildMovePlan,
  classifyTest,
  exportedNames,
  importedNames,
  MOVE_DESPITE_DISK,
  makeHelperCheck,
  STAY_IN_NAX,
  type TestRuling,
  testDestination,
} from "@scripts/lib/s1-move/plan";
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

/** A member of STAY_IN_NAX: ruled to stay. Taken from the set so this asserts the rule, not its data. */
const STAY_IN_NAX_PATH = [...STAY_IN_NAX][0] ?? "";
/** A member of MOVE_DESPITE_DISK: ruled to move despite mentioning the disk. */
const MOVE_DESPITE_DISK_PATH = [...MOVE_DESPITE_DISK][0] ?? "";

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

describe("classifyTest", () => {
  /** Ruling for a path built the way buildMovePlan builds one. */
  function ruleFor(rel: string): TestRuling {
    return classifyTest(root, MANIFEST, rel, barrelMap(root), makeHelperCheck(root, MANIFEST, barrelMap(root)));
  }

  test("short-circuits a STAY_IN_NAX path to stay, ahead of the disk check", () => {
    fixture();
    // Ruled to stay on disk alone, and unreachable from this fixture's tree. Both
    // holds would fall through to "move" if the short-circuit lost its precedence,
    // so this asserts where the decision is made and not merely what it returns.
    write("test/unit/moving/pinned.test.ts", 'import { a } from "@/moving/a";\nconst here = process.cwd();\n');
    expect(ruleFor(STAY_IN_NAX_PATH)).toBe("stay");
    // No ruling: the same shape classifies as needs-ruling, so the short-circuit is what decided.
    expect(ruleFor("test/unit/moving/pinned.test.ts")).toBe("needs-ruling");
  });

  test("lets a MOVE_DESPITE_DISK path move, and leaves a marked test unlisted needing a ruling", () => {
    fixture();
    const marked = 'import { one } from "@/utils/one";\nconst here = import.meta.dir;\n';
    write(MOVE_DESPITE_DISK_PATH, marked);
    write("test/unit/utils/unruled.test.ts", marked);
    expect(ruleFor(MOVE_DESPITE_DISK_PATH)).toBe("move");
    expect(ruleFor("test/unit/utils/unruled.test.ts")).toBe("needs-ruling");
  });
});

describe("makeHelperCheck", () => {
  test("does not settle a helper from a cycle it was only provisionally inside", () => {
    root = makeTempDir("s1-move-cycle-");
    write("src/stays/c.ts", "export const c = 1;\n");
    // a -> b -> a is a cycle, and a is nax-bound through `holder`, reached AFTER b
    // in a's import list. b's only route to staying code runs back through the cycle,
    // so nothing inside b's own subtree can settle it.
    write("test/helpers/index.ts", 'export { b } from "./b";\n');
    write(
      "test/helpers/a.ts",
      'import { b } from "./b";\nimport { holder } from "./holder";\nexport const a = b + holder;\n',
    );
    write("test/helpers/b.ts", 'import { a } from "./a";\nexport const b = a;\n');
    write("test/helpers/holder.ts", 'import { c } from "@/stays/c";\nexport const holder = c;\n');
    const check = makeHelperCheck(root, MANIFEST, barrelMap(root));
    expect(check("test/helpers/a.ts")).toBe(false);
    // The defect this pins: answering b from a provisional "a is fine" and caching it,
    // which sends a test to nax-agent with a helper that reaches staying code.
    expect(check("test/helpers/b.ts")).toBe(false);
    expect(check("test/helpers/b.ts")).toBe(false);
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

  test("a moving test that reads the disk without a marker is advised, not fatal", () => {
    fixture();
    // The failure this guards against is CWD-relative and carries none of DISK_MARKER's
    // self-locating spellings, so the ruling gate cannot see it. The sibling test above
    // already pins that a marker still gets a hard stop; this pins that the blind spot
    // is reported rather than silently waved through.
    write(
      "test/unit/moving/markerless.test.ts",
      'import { a } from "@/moving/a";\nconst source = await Bun.file("src/moving/a.ts").text();\n',
    );
    const plan = buildMovePlan(root, MANIFEST);
    expect(plan.tests.map((t) => t.from)).toContain("test/unit/moving/markerless.test.ts");
    expect(plan.unmarkedDiskReaders).toEqual(["test/unit/moving/markerless.test.ts"]);
  });

  test("the helper closure walks transitively, not one level", () => {
    fixture();
    // deep.ts is reached only through fs.ts. A closure that stopped at the seeds
    // would move fs.ts and leave a moved test importing a helper nax-agent lacks.
    write("test/helpers/fs.ts", 'import { deep } from "./deep";\nexport const readDir = () => deep;\n');
    write("test/helpers/deep.ts", "export const deep = 1;\n");
    write("test/helpers/index.ts", 'export { makeTemp } from "./temp";\nexport { readDir } from "./fs";\n');
    write(
      "test/unit/moving/deep.test.ts",
      'import { a } from "@/moving/a";\nimport { readDir } from "@test/helpers";\n',
    );
    const plan = buildMovePlan(root, MANIFEST);
    expect(plan.helpers.map((h) => h.from)).toEqual([
      "test/helpers/deep.ts",
      "test/helpers/fs.ts",
      "test/helpers/temp.ts",
    ]);
  });

  test("a test whose helper reaches staying code stays", () => {
    fixture();
    rmSync(join(root, "test/unit/moving/a.test.ts"));
    const plan = buildMovePlan(root, MANIFEST);
    expect(plan.tests.map((t) => t.from)).toEqual(["test/unit/utils/one.test.ts"]);
    expect(plan.helpers).toEqual([]);
  });
});
