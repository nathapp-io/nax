/**
 * Tests for src/acceptance/import-resolution.ts — polyglot import resolution.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { clearLanguageCache } from "../../../src/project";
import {
  languageFromExtension,
  MAX_FILE_LINES,
  parsePythonImports,
  parseRustUses,
  parseTsImports,
  readCapped,
  resolveLanguage,
  resolveSourceFiles,
} from "../../../src/acceptance/import-resolution";
import { withTempDir } from "../../helpers";

afterEach(() => clearLanguageCache());

describe("languageFromExtension", () => {
  test("maps known extensions", () => {
    expect(languageFromExtension("foo.test.ts")).toBe("typescript");
    expect(languageFromExtension("foo_test.go")).toBe("go");
    expect(languageFromExtension("test_foo.py")).toBe("python");
    expect(languageFromExtension("foo_test.rs")).toBe("rust");
    expect(languageFromExtension("foo.spec.jsx")).toBe("javascript");
  });

  test("returns undefined for no/unknown extension", () => {
    expect(languageFromExtension(undefined)).toBeUndefined();
    expect(languageFromExtension("Makefile")).toBeUndefined();
    expect(languageFromExtension("foo.txt")).toBeUndefined();
  });
});

describe("resolveLanguage", () => {
  test("explicit language wins", async () => {
    const lang = await resolveLanguage({ packageDir: "/tmp", language: "rust", testFilePath: "x.py" });
    expect(lang).toBe("rust");
  });

  test("falls back to test-file extension", async () => {
    const lang = await resolveLanguage({ packageDir: "/tmp", testFilePath: "x_test.go" });
    expect(lang).toBe("go");
  });

  test("defaults to typescript when nothing detectable", async () => {
    await withTempDir(async (dir) => {
      const lang = await resolveLanguage({ packageDir: dir });
      expect(lang).toBe("typescript");
    });
  });
});

describe("readCapped", () => {
  test("reads a real file relative to packageDir", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(`${dir}/src/a.ts`, "export const a = 1;");
      const result = await readCapped("src/a.ts", dir);
      expect(result).toEqual({ path: "src/a.ts", content: "export const a = 1;" });
    });
  });

  test("truncates to MAX_FILE_LINES", async () => {
    await withTempDir(async (dir) => {
      const body = Array.from({ length: MAX_FILE_LINES + 50 }, (_, i) => `line${i}`).join("\n");
      await Bun.write(`${dir}/big.ts`, body);
      const result = await readCapped("big.ts", dir);
      expect(result?.content.split("\n").length).toBe(MAX_FILE_LINES);
    });
  });

  test("returns null for a missing file", async () => {
    await withTempDir(async (dir) => {
      expect(await readCapped("nope.ts", dir)).toBeNull();
    });
  });
});

describe("parseTsImports", () => {
  test("keeps relative imports, drops bare specifiers", () => {
    const content = `
import { add } from "./math";
import { z } from "zod";
import { b } from "../lib/b.ts";
`;
    expect(parseTsImports(content)).toEqual(["./math", "../lib/b.ts"]);
  });
});

describe("resolveSourceFiles — typescript", () => {
  test("resolves an extensionless relative import", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(`${dir}/math.ts`, "export const add = (a: number, b: number) => a + b;");
      const files = await resolveSourceFiles({
        testFileContent: `import { add } from "./math";`,
        packageDir: dir,
        language: "typescript",
      });
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe("./math.ts");
    });
  });

  test("caps at 5 files even when 6 resolve", async () => {
    await withTempDir(async (dir) => {
      let content = "";
      for (let i = 1; i <= 6; i++) {
        await Bun.write(`${dir}/f${i}.ts`, `export const v${i} = ${i};`);
        content += `import { v${i} } from "./f${i}.ts";\n`;
      }
      const files = await resolveSourceFiles({ testFileContent: content, packageDir: dir, language: "typescript" });
      expect(files).toHaveLength(5);
    });
  });

  test("degrades to [] when nothing resolves", async () => {
    await withTempDir(async (dir) => {
      const files = await resolveSourceFiles({
        testFileContent: `import { x } from "./missing";`,
        packageDir: dir,
        language: "typescript",
      });
      expect(files).toEqual([]);
    });
  });
});

describe("parsePythonImports", () => {
  test("captures from/import/as/relative forms", () => {
    const content = `
from foo.bar import baz
import pkg.mod
import other as o
from .local import thing
`;
    expect(parsePythonImports(content)).toEqual(["foo.bar", "pkg.mod", "other", "local"]);
  });
});

describe("resolveSourceFiles — python", () => {
  test("resolves dotted module to a .py file", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(`${dir}/foo/bar.py`, "def baz():\n    return 1\n");
      const files = await resolveSourceFiles({
        testFileContent: `from foo.bar import baz`,
        packageDir: dir,
        language: "python",
      });
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe("foo/bar.py");
    });
  });

  test("resolves a package __init__.py", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(`${dir}/pkg/__init__.py`, "VALUE = 1\n");
      const files = await resolveSourceFiles({
        testFileContent: `import pkg`,
        packageDir: dir,
        language: "python",
      });
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe("pkg/__init__.py");
    });
  });
});

describe("parseRustUses", () => {
  test("captures crate/super/self paths, skips external crates", () => {
    const content = `
use crate::math::add;
use crate::util::{a, b};
use super::helpers::x;
use std::collections::HashMap;
`;
    expect(parseRustUses(content)).toEqual(["crate::math::add", "crate::util", "super::helpers"]);
  });
});

describe("resolveSourceFiles — rust", () => {
  test("resolves crate path to src/<path>.rs", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(`${dir}/src/math.rs`, "pub fn add(a: i32, b: i32) -> i32 { a + b }");
      const files = await resolveSourceFiles({
        testFileContent: `use crate::math::add;`,
        packageDir: dir,
        language: "rust",
      });
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe("src/math.rs");
    });
  });

  test("resolves a module directory to mod.rs", async () => {
    await withTempDir(async (dir) => {
      await Bun.write(`${dir}/src/util/mod.rs`, "pub fn a() {}");
      const files = await resolveSourceFiles({
        testFileContent: `use crate::util::{a, b};`,
        packageDir: dir,
        language: "rust",
      });
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe("src/util/mod.rs");
    });
  });
});
