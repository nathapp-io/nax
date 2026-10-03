import { describe, expect, test } from "bun:test";
import { explicitTsSpecifier, rewriteTsExtensions } from "@scripts/lib/ts-extensions";

// A fake tree: /p/src/{index.ts, a.ts, both.ts, both/index.ts, dir/index.ts, sub.ts, sub/index.ts, sub/leaf.ts}.
const FILES = new Set([
  "/p/src/a.ts",
  "/p/src/both.ts",
  "/p/src/both/index.ts",
  "/p/src/dir/index.ts",
  "/p/src/sub/leaf.ts",
  "/p/src/sub/index.ts",
  "/p/src/sub.ts",
  "/p/src/index.ts",
]);
const isFile = (abs: string) => FILES.has(abs);
const FROM = "/p/src/main.ts";

describe("explicitTsSpecifier", () => {
  test("a file gets .ts; a directory gets /index.ts", () => {
    expect(explicitTsSpecifier("./a", FROM, isFile)).toBe("./a.ts");
    expect(explicitTsSpecifier("./dir", FROM, isFile)).toBe("./dir/index.ts");
    expect(explicitTsSpecifier("../a", "/p/src/sub/leaf.ts", isFile)).toBe("../a.ts");
  });

  test("when x.ts and x/index.ts both exist, the file wins (bundler resolution order)", () => {
    expect(explicitTsSpecifier("./both", FROM, isFile)).toBe("./both.ts");
  });

  test(". and .. and a trailing slash are directory-only; a same-named sibling file is never picked", () => {
    // resolve("/p/src/sub", ".") + ".ts" is /p/src/sub.ts, which exists: a naive rewrite writes "..ts".
    expect(explicitTsSpecifier(".", "/p/src/sub/leaf.ts", isFile)).toBe("./index.ts");
    expect(explicitTsSpecifier("..", "/p/src/sub/leaf.ts", isFile)).toBe("../index.ts");
    expect(explicitTsSpecifier("./sub/", FROM, isFile)).toBe("./sub/index.ts");
  });

  test("already explicit, #src/ and bare specifiers are left alone", () => {
    expect(explicitTsSpecifier("./a.ts", FROM, isFile)).toBeNull();
    expect(explicitTsSpecifier("./dir/index.ts", FROM, isFile)).toBeNull();
    expect(explicitTsSpecifier("#src/a", FROM, isFile)).toBeNull();
    expect(explicitTsSpecifier("zod", FROM, isFile)).toBeNull();
    expect(explicitTsSpecifier("node:fs", FROM, isFile)).toBeNull();
  });

  test("an unresolvable relative specifier throws naming the file and the specifier", () => {
    expect(() => explicitTsSpecifier("./nope", FROM, isFile)).toThrow('/p/src/main.ts: cannot resolve "./nope"');
  });
});

describe("rewriteTsExtensions", () => {
  test("rewrites static, export-from, multi-line, side-effect and import() type sites; counts them", () => {
    const src = [
      'import { a } from "./a";',
      'export * from "./dir";',
      "import {",
      "  x,",
      '} from "./both";',
      'import "./sub";',
      'type T = import("./a").T;',
      'import { s } from "#src/a";',
      "",
    ].join("\n");
    const out = rewriteTsExtensions(src, FROM, isFile);
    expect(out.rewritten).toBe(5);
    expect(out.source).toBe(
      [
        'import { a } from "./a.ts";',
        'export * from "./dir/index.ts";',
        "import {",
        "  x,",
        '} from "./both.ts";',
        'import "./sub.ts";',
        'type T = import("./a.ts").T;',
        'import { s } from "#src/a";',
        "",
      ].join("\n"),
    );
  });

  test("import-shaped text in comments, strings and templates is not rewritten", () => {
    const src = [
      '// import { a } from "./a";',
      '/* export * from "./dir"; */',
      "const s = 'import { a } from \"./a\";';",
      'const t = `await import("./a")`;',
      "",
    ].join("\n");
    expect(rewriteTsExtensions(src, FROM, isFile)).toEqual({ source: src, rewritten: 0 });
  });

  test("is idempotent", () => {
    const once = rewriteTsExtensions('import { a } from "./a";\nexport * from "./dir";\n', FROM, isFile);
    expect(rewriteTsExtensions(once.source, FROM, isFile)).toEqual({ source: once.source, rewritten: 0 });
  });
});
