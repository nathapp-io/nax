import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@nathapp/nax-test-kit/bun/temp";
import { findBunApiUses } from "#scripts/check-no-bun-apis";

let root = "";
afterEach(() => {
  if (root) cleanupTempDir(root);
  root = "";
});

function src(name: string, content: string): void {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", name), content, "utf8");
}

describe("findBunApiUses", () => {
  test("flags Bun globals and bun: modules in code, relative to the package", async () => {
    root = makeTempDir("no-bun-apis-");
    src("a.ts", 'const f = Bun.file("x");\nimport { test } from "bun:test";\nconst ok = 1;\n');
    expect(await findBunApiUses(join(root, "src"), root)).toEqual([
      { file: join("src", "a.ts"), line: 1, text: 'const f = Bun.file("x");' },
      { file: join("src", "a.ts"), line: 2, text: 'import { test } from "bun:test";' },
    ]);
  });

  test("ignores comment lines and identifiers that merely end in Bun", async () => {
    root = makeTempDir("no-bun-apis-");
    src("b.ts", "// Bun.spawn is not allowed here\n * Bun.file in a doc comment\nconst myBun = { x: 1 };\nmyBun.x;\n");
    expect(await findBunApiUses(join(root, "src"), root)).toEqual([]);
  });
});

test.each([
  "const runtime = globalThis.Bun;",
  'const f = globalThis.Bun.file("x");',
  "type Runtime = typeof Bun;",
  "const dir = import.meta.dir;",
  'const module = await import("bun:test");',
  'import { Glob } from "bun";',
  'import "bun";',
])("rejects Bun-specific source: %s", async (code) => {
  root = makeTempDir("no-bun-forms-");
  src("bad.ts", `const ok = 1;\n${code}\n`);
  expect(await findBunApiUses(join(root, "src"), root)).toEqual([{ file: join("src", "bad.ts"), line: 2, text: code }]);
});
test("Node imports and commentary about runtime forms remain accepted", async () => {
  root = makeTempDir("no-bun-comments-");
  src(
    "ok.ts",
    'import { readFile } from "node:fs/promises";\n// globalThis.Bun and import.meta.dir\n * typeof Bun\nconst myBun = { file: 1 };\nmyBun.file;\n',
  );
  expect(await findBunApiUses(join(root, "src"), root)).toEqual([]);
});
