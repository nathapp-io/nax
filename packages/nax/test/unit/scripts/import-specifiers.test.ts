import { describe, expect, test } from "bun:test";
import { rewriteSpecifiers, specifierSites } from "@scripts/lib/import-specifiers";

describe("specifierSites", () => {
  test("finds static, type-only, multi-line, side-effect, dynamic and inline type sites in source order", () => {
    const src = [
      'import { a } from "./a";',
      'import type { B } from "@/b";',
      "import {",
      "  c,",
      "  d,",
      '} from "../cd";',
      'import "./side";',
      'export * as ns from "./ns";',
      'type E = import("./e").E;',
      'const f = await import("@/f");',
    ].join("\n");
    expect(specifierSites(src).map((s) => [s.spec, s.kind])).toEqual([
      ["./a", "static"],
      ["@/b", "static"],
      ["../cd", "static"],
      ["./side", "side-effect"],
      ["./ns", "static"],
      ["./e", "dynamic"],
      ["@/f", "dynamic"],
    ]);
  });

  test("records the statement prelude of a static site", () => {
    const [site] = specifierSites('  import * as tools from "@/tools";\n');
    expect(site?.prelude).toBe("  import * as tools from ");
  });

  test("ignores specifiers inside comments", () => {
    expect(specifierSites('// import { x } from "./x";\n/* import("./y") */\n')).toEqual([]);
  });
});

describe("rewriteSpecifiers", () => {
  test("replaces only the sites the map changes, leaving the rest of the text alone", () => {
    const src = 'import { a } from "./a";\nimport { b } from "./b";\nconst c = import("./a");\n';
    const out = rewriteSpecifiers(src, (site) => (site.spec === "./a" ? "#src/a" : null));
    expect(out).toBe('import { a } from "#src/a";\nimport { b } from "./b";\nconst c = import("#src/a");\n');
  });

  test("replaces a whole statement and keeps its indentation", () => {
    const src = '  import * as ts from "@/tools/x";\nexport const y = 1;\n';
    const out = rewriteSpecifiers(src, () => ({ statement: 'import { xModule as ts } from "pkg/internal"' }));
    expect(out).toBe('  import { xModule as ts } from "pkg/internal";\nexport const y = 1;\n');
  });

  test("throws rather than mangling the source when a whole-statement replacement hits a non-static site", () => {
    // A dynamic or side-effect site has an empty prelude, so statementStart() would
    // resolve to the opening quote and the splice would splice into `import(`.
    for (const src of ['const c = import("./a");\n', 'import "./side";\n']) {
      expect(() => rewriteSpecifiers(src, () => ({ statement: "X" }))).toThrow(/only valid for a static import/);
    }
  });
});
