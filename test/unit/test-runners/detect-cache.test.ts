/**
 * Unit tests for the detect module — cache behaviour, plus extglob/brace
 * expansion of framework-emitted glob patterns.
 *
 * The cache suite was extracted from detect.test.ts to keep both files under
 * the 400-line limit. The extglob suite pins down the expansion of common Jest
 * and Vitest defaults into simple globs: the downstream `globsToTestRegex`
 * extractor only handles the static suffix after the last `*`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeSpawn } from "@test/helpers";
import { globsToTestRegex } from "@/test-runners/conventions";
import type { DetectionResult } from "@/test-runners/detect";
import { _cacheDeps } from "@/test-runners/detect/cache";
import { _directoryScanDeps } from "@/test-runners/detect/directory-scan";
import { expandExtglob, expandExtglobAll } from "@/test-runners/detect/extglob";
import { _fileScanDeps } from "@/test-runners/detect/file-scan";
import { _frameworkConfigDeps } from "@/test-runners/detect/framework-configs";
import { _frameworkDefaultsDeps } from "@/test-runners/detect/framework-defaults";
import { detectTestFilePatterns } from "@/test-runners/detect/index";
import { byCodePoint } from "@/utils/sort";

type Orig = {
  readText: typeof _frameworkConfigDeps.readText;
  parseToml: typeof _frameworkConfigDeps.parseToml;
  parseYaml: typeof _frameworkConfigDeps.parseYaml;
  defaultsReadText: typeof _frameworkDefaultsDeps.readText;
  defaultsFileExists: typeof _frameworkDefaultsDeps.fileExists;
  fileScanSpawn: typeof _fileScanDeps.spawn;
  cacheReadJson: typeof _cacheDeps.readJson;
  cacheWriteJson: typeof _cacheDeps.writeJson;
  cacheFileMtime: typeof _cacheDeps.fileMtime;
  dirExists: typeof _directoryScanDeps.dirExists;
  dirSpawn: typeof _directoryScanDeps.spawn;
};

let orig: Orig;

beforeEach(() => {
  orig = {
    readText: _frameworkConfigDeps.readText,
    parseToml: _frameworkConfigDeps.parseToml,
    parseYaml: _frameworkConfigDeps.parseYaml,
    defaultsReadText: _frameworkDefaultsDeps.readText,
    defaultsFileExists: _frameworkDefaultsDeps.fileExists,
    fileScanSpawn: _fileScanDeps.spawn,
    cacheReadJson: _cacheDeps.readJson,
    cacheWriteJson: _cacheDeps.writeJson,
    cacheFileMtime: _cacheDeps.fileMtime,
    dirExists: _directoryScanDeps.dirExists,
    dirSpawn: _directoryScanDeps.spawn,
  };
  _cacheDeps.readJson = mock(async () => {
    throw new Error("not found");
  });
  _cacheDeps.writeJson = mock(async () => {});
  _cacheDeps.fileMtime = mock(async () => null);
  _directoryScanDeps.dirExists = mock(async () => false);
  _directoryScanDeps.spawn = makeSpawn(() => ({ exitCode: 1 })).spawn;
  _frameworkDefaultsDeps.fileExists = mock(async () => false);
});

afterEach(() => {
  _frameworkConfigDeps.readText = orig.readText;
  _frameworkConfigDeps.parseToml = orig.parseToml;
  _frameworkConfigDeps.parseYaml = orig.parseYaml;
  _frameworkDefaultsDeps.readText = orig.defaultsReadText;
  _frameworkDefaultsDeps.fileExists = orig.defaultsFileExists;
  _fileScanDeps.spawn = orig.fileScanSpawn;
  _cacheDeps.readJson = orig.cacheReadJson;
  _cacheDeps.writeJson = orig.cacheWriteJson;
  _cacheDeps.fileMtime = orig.cacheFileMtime;
  _directoryScanDeps.dirExists = orig.dirExists;
  _directoryScanDeps.spawn = orig.dirSpawn;
});

describe("cache", () => {
  test("returns cached result on hit", async () => {
    const cached: DetectionResult = {
      patterns: ["**/*.cached.ts"],
      confidence: "high",
      sources: [{ type: "framework-config", path: "/fake/workdir/vitest.config.ts", patterns: ["**/*.cached.ts"] }],
    };

    _cacheDeps.readJson = mock(async () => ({
      workdir: "/fake/workdir",
      mtimes: {},
      result: cached,
    }));
    _cacheDeps.fileMtime = mock(async () => null);

    const readTextSpy = mock(async () => null);
    _frameworkConfigDeps.readText = readTextSpy;
    _frameworkDefaultsDeps.readText = readTextSpy;

    const result = await detectTestFilePatterns("/fake/workdir");
    expect(result.patterns).toEqual(["**/*.cached.ts"]);
    expect(readTextSpy).not.toHaveBeenCalled();
  });

  test("writes result to cache after detection", async () => {
    _cacheDeps.readJson = mock(async () => {
      throw new Error("miss");
    });
    _cacheDeps.fileMtime = mock(async () => null);

    const written: Array<[string, unknown]> = [];
    _cacheDeps.writeJson = mock(async (path: string, data: unknown) => {
      written.push([path, data]);
    });

    _frameworkConfigDeps.readText = mock(async () => null);
    _frameworkDefaultsDeps.readText = mock(async (path: string) => {
      if (path.endsWith("package.json")) {
        return JSON.stringify({ devDependencies: { vitest: "^1.0.0" } });
      }
      return null;
    });
    _fileScanDeps.spawn = makeSpawn(() => "").spawn;

    await detectTestFilePatterns("/fake/workdir");
    expect(written.length).toBe(1);
    expect(written[0]?.[0]).toContain("test-patterns.json");
  });

  test("treats corrupt cache as miss, rebuilds without throwing", async () => {
    _cacheDeps.readJson = mock(async () => {
      throw new SyntaxError("bad json");
    });
    _cacheDeps.fileMtime = mock(async () => null);
    _cacheDeps.writeJson = mock(async () => {});

    _frameworkConfigDeps.readText = mock(async () => null);
    _frameworkDefaultsDeps.readText = mock(async () => null);
    _fileScanDeps.spawn = makeSpawn(() => "").spawn;
    _directoryScanDeps.dirExists = mock(async () => false);

    const result = await detectTestFilePatterns("/fake/workdir");
    expect(result.confidence).toBe("empty");
  });

  test("invalidates cache when mtime changes", async () => {
    const cached: DetectionResult = {
      patterns: ["**/*.stale.ts"],
      confidence: "high",
      sources: [],
    };

    _cacheDeps.readJson = mock(async () => ({
      workdir: "/fake/workdir",
      mtimes: { "package.json": 100 },
      result: cached,
    }));
    _cacheDeps.fileMtime = mock(async (path: string) => {
      if (path.endsWith("package.json")) return 200; // changed
      return null;
    });
    _cacheDeps.writeJson = mock(async () => {});

    _frameworkConfigDeps.readText = mock(async () => null);
    _frameworkDefaultsDeps.readText = mock(async (path: string) => {
      if (path.endsWith("package.json")) return JSON.stringify({ devDependencies: { vitest: "^1.0.0" } });
      return null;
    });
    _fileScanDeps.spawn = makeSpawn(() => "").spawn;

    const result = await detectTestFilePatterns("/fake/workdir");
    expect(result.patterns).not.toContain("**/*.stale.ts");
    expect(result.confidence).toBe("medium");
  });
});

describe("expandExtglob — passthrough cases", () => {
  test("returns plain pattern unchanged when no extglob/brace syntax is present", () => {
    expect(expandExtglob("**/*.test.ts")).toEqual(["**/*.test.ts"]);
    expect(expandExtglob("test/**/*.spec.js")).toEqual(["test/**/*.spec.js"]);
    expect(expandExtglob("**/*_test.go")).toEqual(["**/*_test.go"]);
  });

  test("returns negation patterns unchanged (unsupported)", () => {
    expect(expandExtglob("**/!(test).ts")).toEqual(["**/!(test).ts"]);
  });

  test("returns character-range patterns unchanged (unsupported)", () => {
    expect(expandExtglob("**/test_[a-z].py")).toEqual(["**/test_[a-z].py"]);
  });
});

describe("expandExtglob — single constructs", () => {
  test("brace alternation", () => {
    expect(expandExtglob("**/*.{ts,js}").sort(byCodePoint)).toEqual(["**/*.js", "**/*.ts"]);
  });

  test("character class", () => {
    expect(expandExtglob("**/*.[jt]s").sort(byCodePoint)).toEqual(["**/*.js", "**/*.ts"]);
  });

  test("optional group ?(x) emits empty + content", () => {
    expect(expandExtglob("**/*.ts?(x)").sort(byCodePoint)).toEqual(["**/*.ts", "**/*.tsx"]);
  });

  test("zero-or-more *(x|y) emits empty + each alternative", () => {
    expect(expandExtglob("**/spec*(.unit|.int).ts").sort(byCodePoint)).toEqual([
      "**/spec.int.ts",
      "**/spec.ts",
      "**/spec.unit.ts",
    ]);
  });

  test("one-or-more +(x|y) emits each alternative", () => {
    expect(expandExtglob("**/+(spec|test).ts").sort(byCodePoint)).toEqual(["**/spec.ts", "**/test.ts"]);
  });

  test("exactly-one @(x|y) emits each alternative", () => {
    expect(expandExtglob("**/@(spec|test).ts").sort(byCodePoint)).toEqual(["**/spec.ts", "**/test.ts"]);
  });
});

describe("expandExtglob — Jest defaults", () => {
  test("**/__tests__/**/*.[jt]s?(x) → 4 simple globs", () => {
    const result = expandExtglob("**/__tests__/**/*.[jt]s?(x)").sort(byCodePoint);
    expect(result).toEqual([
      "**/__tests__/**/*.js",
      "**/__tests__/**/*.jsx",
      "**/__tests__/**/*.ts",
      "**/__tests__/**/*.tsx",
    ]);
  });

  test("**/?(*.)+(spec|test).[jt]s?(x) → 16 simple globs covering all shapes", () => {
    const result = expandExtglob("**/?(*.)+(spec|test).[jt]s?(x)").sort(byCodePoint);
    expect(result).toContain("**/*.spec.ts");
    expect(result).toContain("**/*.spec.tsx");
    expect(result).toContain("**/*.test.js");
    expect(result).toContain("**/spec.ts"); // bare form from ?(*.)
    expect(result).toContain("**/test.jsx");
    expect(result.length).toBe(16);
  });
});

describe("expandExtglob — Vitest defaults", () => {
  test("**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx} expands to 16 globs", () => {
    const result = expandExtglob("**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}");
    expect(result).toContain("**/*.test.ts");
    expect(result).toContain("**/*.spec.tsx");
    expect(result).toContain("**/*.spec.mjs");
    expect(result.length).toBe(16); // 2 × 8
  });
});

describe("expandExtglobAll — multi-pattern de-duplication", () => {
  test("merges and de-dupes overlapping expansions", () => {
    const result = expandExtglobAll(["**/*.{ts,js}", "**/*.[jt]s"]);
    expect(result.sort(byCodePoint)).toEqual(["**/*.js", "**/*.ts"]);
  });

  test("preserves passthrough patterns alongside expanded ones", () => {
    const result = expandExtglobAll(["**/*.test.ts", "**/*.{spec,test}.js"]);
    expect(result.sort(byCodePoint)).toEqual(["**/*.spec.js", "**/*.test.js", "**/*.test.ts"]);
  });
});

describe("regression — expanded globs work with globsToTestRegex", () => {
  test("Jest defaults expanded → globsToTestRegex matches real test paths", () => {
    const expanded = expandExtglobAll(["**/__tests__/**/*.[jt]s?(x)", "**/?(*.)+(spec|test).[jt]s?(x)"]);
    const regexes = globsToTestRegex(expanded);

    // The whole point of FEAT-015 fix: real Jest test files must classify as test files.
    const isTest = (p: string) => regexes.some((re) => re.test(p));
    expect(isTest("apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts")).toBe(true);
    expect(isTest("apps/api/test/integration/foo/foo.integration.spec.ts")).toBe(true);
    expect(isTest("src/components/__tests__/button.tsx")).toBe(true);
    expect(isTest("src/foo.test.js")).toBe(true);
    expect(isTest("src/foo.ts")).toBe(false); // source file — must NOT match
  });

  test("non-expanded extglob produces a regex that matches nothing real (the bug)", () => {
    const regexes = globsToTestRegex(["**/?(*.)+(spec|test).[jt]s?(x)"]);
    const isTest = (p: string) => regexes.some((re) => re.test(p));
    // This is the original failure mode: real test files don't match the broken regex.
    expect(isTest("apps/api/test/e2e/api-endpoint/endpoint.e2e.spec.ts")).toBe(false);
  });
});
