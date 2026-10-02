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
      'const g = require("@/g");',
      'export * as ns from "./ns";',
      'type E = import("./e").E;',
      'const f = await import("@/f");',
    ].join("\n");
    expect(specifierSites(src).map((s) => [s.spec, s.kind])).toEqual([
      ["./a", "static"],
      ["@/b", "static"],
      ["../cd", "static"],
      ["./side", "side-effect"],
      ["@/g", "require"],
      ["./ns", "static"],
      ["./e", "dynamic"],
      ["@/f", "dynamic"],
    ]);
  });

  test("finds CommonJS require sites, tolerating whitespace inside the call", () => {
    const src = 'const a = require("@/a");\nconst b = require ( "../b" );\nconst c = require.resolve("c");\n';
    expect(specifierSites(src).map((s) => [s.spec, s.kind])).toEqual([
      ["@/a", "require"],
      ["../b", "require"],
    ]);
  });

  test("records the statement prelude of a static site", () => {
    const [site] = specifierSites('  import * as tools from "@/tools";\n');
    expect(site?.prelude).toBe("  import * as tools from ");
  });

  test("ignores specifiers inside comments", () => {
    expect(specifierSites('// import { x } from "./x";\n/* import("./y") */\n')).toEqual([]);
  });

  test("ignores import-like text inside a string, but still finds a real dynamic import", () => {
    const src = 'const src = \'await import("@scope/pkg");\';\nconst f = await import("@scope/pkg");\n';
    expect(specifierSites(src).map((s) => [s.spec, s.kind])).toEqual([["@scope/pkg", "dynamic"]]);
  });

  test("finds real imports after regex literals and inside template interpolations", () => {
    const regexLine = 'const re = /"/g; const f = await import("@scope/pkg");';
    const interp = "$" + '{await import("@scope/pkg")}';
    const templateLine = `const s = \`x ${interp} y\`;`;
    expect(specifierSites(regexLine).map((s) => [s.spec, s.kind])).toEqual([["@scope/pkg", "dynamic"]]);
    expect(specifierSites(templateLine).map((s) => [s.spec, s.kind])).toEqual([["@scope/pkg", "dynamic"]]);
    expect(rewriteSpecifiers(templateLine, () => "@scope/replaced")).toBe(
      `const s = \`x ${"$" + '{await import("@scope/replaced")}'} y\`;`,
    );
  });

  test("scans nested template expressions and ignores import-like template text and division", () => {
    const nested =
      "$" +
      '{(() => { if (ready) { const block = true; } const close = "}"; /* } */ return `inner ' +
      "$" +
      '{import("@nested")}' +
      "` tail`; })()}";
    const second = "$" + '{import("@second")}';
    const rawText = `\`raw await import("@fixture") ${nested} middle ${second} trailing import("@fixture")\``;
    const src = `const ratio = value / other; const literal = value / "not code"; const s = ${rawText};`;
    expect(specifierSites(src).map((site) => [site.spec, site.kind])).toEqual([
      ["@nested", "dynamic"],
      ["@second", "dynamic"],
    ]);
  });

  test("does not treat quotes or slash characters in regex classes as source strings", () => {
    const src = String.raw`const re = /["\\/]+/g; const f = import("@after-regex");`;
    expect(specifierSites(src).map((site) => [site.spec, site.kind])).toEqual([["@after-regex", "dynamic"]]);
  });

  test("recognizes regex literals after control-condition parentheses", () => {
    const src = 'if (ready) {} /"/.test(text); const f = import("@after-condition");';
    expect(specifierSites(src).map((site) => [site.spec, site.kind])).toEqual([["@after-condition", "dynamic"]]);
  });

  test("keeps division after object literals as division", () => {
    const src = 'const quotient = ({ value: 10 }) / divisor; const f = import("@after-division");';
    expect(specifierSites(src).map((site) => [site.spec, site.kind])).toEqual([["@after-division", "dynamic"]]);
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

  test("rewrites a require specifier in place, leaving the call around it", () => {
    const src = 'const { NaxError } = require("../errors");\n';
    const out = rewriteSpecifiers(src, (site) => (site.spec === "../errors" ? "#src/errors" : null));
    expect(out).toBe('const { NaxError } = require("#src/errors");\n');
  });

  test("throws rather than mangling the source when a whole-statement replacement hits a non-static site", () => {
    // A dynamic or side-effect site has an empty prelude, so statementStart() would
    // resolve to the opening quote and the splice would splice into `import(`.
    // A require site has a prelude, but it names the call, not a statement head:
    // splicing there would turn `const { a } = require("x")` into a syntax error.
    for (const src of ['const c = import("./a");\n', 'import "./side";\n', 'const a = require("./a");\n']) {
      expect(() => rewriteSpecifiers(src, () => ({ statement: "X" }))).toThrow(/only valid for a static import/);
    }
  });
});
