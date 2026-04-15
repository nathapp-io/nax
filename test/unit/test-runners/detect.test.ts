/**
 * Unit tests for the detect module (Phase 2 — four-tier detection)
 *
 * Tests are fixture-based: each test creates a minimal in-memory workdir by
 * injecting mocks via the exported _deps objects. This avoids disk I/O and
 * keeps tests fast and deterministic.
 *
 * Cache behaviour is tested in detect-cache.test.ts.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _directoryScanDeps } from "../../../src/test-runners/detect/directory-scan";
import { _fileScanDeps } from "../../../src/test-runners/detect/file-scan";
import { _frameworkConfigDeps } from "../../../src/test-runners/detect/framework-configs";
import { _frameworkDefaultsDeps } from "../../../src/test-runners/detect/framework-defaults";
import { detectTestFilePatterns, detectTestFilePatternsForWorkspace } from "../../../src/test-runners/detect/index";
import { _cacheDeps } from "../../../src/test-runners/detect/cache";

// ─── Save/restore helpers ─────────────────────────────────────────────────────

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

/** Make a subprocess mock that returns the given stdout text */
function spawnWithOutput(output: string): ReturnType<typeof Bun.spawn> {
  const enc = new TextEncoder();
  const bytes = enc.encode(output);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return { exited: Promise.resolve(0), stdout: stream } as unknown as ReturnType<typeof Bun.spawn>;
}

/** Make a subprocess mock that exits with non-zero (failure) */
function spawnFailed(): ReturnType<typeof Bun.spawn> {
  return { exited: Promise.resolve(1), stdout: null } as unknown as ReturnType<typeof Bun.spawn>;
}

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
  // Default: cache miss, write is no-op
  _cacheDeps.readJson = mock(async () => { throw new Error("not found"); });
  _cacheDeps.writeJson = mock(async () => {});
  _cacheDeps.fileMtime = mock(async () => null);
  // Default: no directories exist, no go.mod/Cargo.toml
  _directoryScanDeps.dirExists = mock(async () => false);
  _directoryScanDeps.spawn = mock((..._args: unknown[]) => spawnFailed()) as unknown as typeof Bun.spawn;
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

// ─── Tier 1: vitest config ────────────────────────────────────────────────────

describe("Tier 1 — vitest config", () => {
  test("detects test.include patterns from vitest.config.ts", async () => {
    _frameworkConfigDeps.readText = mock(async (path: string) => {
      if (path.endsWith("vitest.config.ts")) {
        return `export default defineConfig({ test: { include: ["src/**/*.test.ts", "src/**/*.spec.ts"] } })`;
      }
      return null;
    });
    _frameworkDefaultsDeps.readText = mock(async () => null);
    _fileScanDeps.spawn = mock((..._args: unknown[]) => spawnWithOutput("")) as unknown as typeof Bun.spawn;

    const result = await detectTestFilePatterns("/fake/workdir");
    expect(result.confidence).toBe("high");
    expect(result.patterns).toContain("src/**/*.test.ts");
    expect(result.patterns).toContain("src/**/*.spec.ts");
    expect(result.sources[0]?.type).toBe("framework-config");
  });

  test("falls through to Tier 2 when vitest config has no extractable include", async () => {
    _frameworkConfigDeps.readText = mock(async (path: string) => {
      if (path.endsWith("vitest.config.ts")) return `export default defineConfig({})`;
      return null;
    });
    _frameworkDefaultsDeps.readText = mock(async (path: string) => {
      if (path.endsWith("package.json")) {
        return JSON.stringify({ devDependencies: { vitest: "^1.0.0" } });
      }
      return null;
    });
    _fileScanDeps.spawn = mock((..._args: unknown[]) => spawnWithOutput("")) as unknown as typeof Bun.spawn;

    const result = await detectTestFilePatterns("/fake/workdir");
    expect(result.confidence).toBe("medium");
    // Vitest default is expanded from extglob into simple globs.
    expect(result.patterns).toEqual(
      expect.arrayContaining(["**/*.test.ts", "**/*.spec.ts", "**/*.test.tsx", "**/*.spec.cjs"]),
    );
  });
});

// ─── Tier 1: jest config ──────────────────────────────────────────────────────

describe("Tier 1 — jest config", () => {
  test("extracts testMatch from jest.config.js", async () => {
    _frameworkConfigDeps.readText = mock(async (path: string) => {
      if (path.endsWith("jest.config.js")) {
        return `module.exports = { testMatch: ["**/__tests__/**/*.ts", "**/*.test.ts"] }`;
      }
      return null;
    });
    _frameworkDefaultsDeps.readText = mock(async () => null);
    _fileScanDeps.spawn = mock((..._args: unknown[]) => spawnWithOutput("")) as unknown as typeof Bun.spawn;

    const result = await detectTestFilePatterns("/fake/workdir");
    expect(result.confidence).toBe("high");
    expect(result.patterns).toContain("**/__tests__/**/*.ts");
    expect(result.patterns).toContain("**/*.test.ts");
  });

  test("extracts jest config from package.json#jest", async () => {
    _frameworkConfigDeps.readText = mock(async (path: string) => {
      if (path.endsWith("package.json")) {
        return JSON.stringify({ jest: { testMatch: ["**/*.spec.js"] } });
      }
      return null;
    });
    _frameworkDefaultsDeps.readText = mock(async () => null);
    _fileScanDeps.spawn = mock((..._args: unknown[]) => spawnWithOutput("")) as unknown as typeof Bun.spawn;

    const result = await detectTestFilePatterns("/fake/workdir");
    expect(result.confidence).toBe("high");
    expect(result.patterns).toContain("**/*.spec.js");
  });

  test("parses jest.config.json as JSON (not regex)", async () => {
    _frameworkConfigDeps.readText = mock(async (path: string) => {
      if (path.endsWith("jest.config.json")) {
        return JSON.stringify({ testMatch: ["**/__tests__/**/*.ts", "**/*.test.ts"] });
      }
      return null;
    });
    _frameworkDefaultsDeps.readText = mock(async () => null);
    _fileScanDeps.spawn = mock((..._args: unknown[]) => spawnWithOutput("")) as unknown as typeof Bun.spawn;

    const result = await detectTestFilePatterns("/fake/workdir");
    expect(result.confidence).toBe("high");
    expect(result.patterns).toContain("**/__tests__/**/*.ts");
    expect(result.patterns).toContain("**/*.test.ts");
  });

  test("expands extglob from jest.config.json into simple globs", async () => {
    _frameworkConfigDeps.readText = mock(async (path: string) => {
      if (path.endsWith("jest.config.json")) {
        return JSON.stringify({ testMatch: ["**/?(*.)+(spec|test).[jt]s?(x)"] });
      }
      return null;
    });
    _frameworkDefaultsDeps.readText = mock(async () => null);
    _fileScanDeps.spawn = mock((..._args: unknown[]) => spawnWithOutput("")) as unknown as typeof Bun.spawn;

    const result = await detectTestFilePatterns("/fake/workdir");
    expect(result.patterns).toContain("**/*.spec.ts");
    expect(result.patterns).toContain("**/*.test.tsx");
    expect(result.patterns).not.toContain("**/?(*.)+(spec|test).[jt]s?(x)");
  });
});

// ─── Tier 1: vite config (Vitest) ────────────────────────────────────────────

describe("Tier 1 — vite config (Vitest)", () => {
  test("extracts test.include from vite.config.ts", async () => {
    _frameworkConfigDeps.readText = mock(async (path: string) => {
      if (path.endsWith("vite.config.ts")) {
        return `export default defineConfig({
          plugins: [react()],
          test: {
            globals: true,
            include: ["src/**/*.test.ts", "src/**/*.spec.ts"],
          },
        });`;
      }
      return null;
    });
    _frameworkDefaultsDeps.readText = mock(async () => null);
    _fileScanDeps.spawn = mock((..._args: unknown[]) => spawnWithOutput("")) as unknown as typeof Bun.spawn;

    const result = await detectTestFilePatterns("/fake/workdir");
    expect(result.confidence).toBe("high");
    expect(result.patterns).toContain("src/**/*.test.ts");
    expect(result.patterns).toContain("src/**/*.spec.ts");
  });

  test("does not match unrelated `include` arrays outside test: block", async () => {
    _frameworkConfigDeps.readText = mock(async (path: string) => {
      if (path.endsWith("vite.config.ts")) {
        // A vite config without a test: section — must NOT pick up
        // build.rollupOptions.input or other unrelated arrays.
        return `export default defineConfig({
          build: { rollupOptions: { input: ["src/main.ts"] } },
        });`;
      }
      return null;
    });
    _frameworkDefaultsDeps.readText = mock(async () => null);
    _fileScanDeps.spawn = mock((..._args: unknown[]) => spawnWithOutput("")) as unknown as typeof Bun.spawn;

    const result = await detectTestFilePatterns("/fake/workdir");
    // No test: block → parseViteConfig returns null → no Tier 1 hit
    expect(result.patterns).not.toContain("src/main.ts");
  });
});

// ─── Tier 1: bunfig.toml (Bun test) ──────────────────────────────────────────

describe("Tier 1 — bunfig.toml (Bun test)", () => {
  test("emits Bun defaults when [test] section is present", async () => {
    _frameworkConfigDeps.readText = mock(async (path: string) => {
      if (path.endsWith("bunfig.toml")) {
        return `[test]\npreload = ["./happydom.ts"]`;
      }
      return null;
    });
    _frameworkConfigDeps.parseToml = mock((_text: string) => ({
      test: { preload: ["./happydom.ts"] },
    }));
    _frameworkDefaultsDeps.readText = mock(async () => null);
    _fileScanDeps.spawn = mock((..._args: unknown[]) => spawnWithOutput("")) as unknown as typeof Bun.spawn;

    const result = await detectTestFilePatterns("/fake/workdir");
    expect(result.confidence).toBe("high");
    expect(result.patterns).toContain("**/*.test.ts");
    expect(result.patterns).toContain("**/*.spec.ts");
    expect(result.patterns).toContain("**/*_test.ts");
    expect(result.patterns).toContain("**/*_spec.ts");
  });

  test("returns nothing when bunfig.toml has no [test] section", async () => {
    _frameworkConfigDeps.readText = mock(async (path: string) => {
      if (path.endsWith("bunfig.toml")) {
        return `[install]\nregistry = "https://npm.example.com/"`;
      }
      return null;
    });
    _frameworkConfigDeps.parseToml = mock((_text: string) => ({
      install: { registry: "https://npm.example.com/" },
    }));
    _frameworkDefaultsDeps.readText = mock(async () => null);
    _fileScanDeps.spawn = mock((..._args: unknown[]) => spawnWithOutput("")) as unknown as typeof Bun.spawn;

    const result = await detectTestFilePatterns("/fake/workdir");
    // No [test] in bunfig → falls through to lower tiers; Tier 4 may emit
    // something via directory scan but we mocked that to fail above.
    expect(result.confidence).not.toBe("high");
  });
});

// ─── Tier 1: Python ───────────────────────────────────────────────────────────

describe("Tier 1 — pytest config", () => {
  test("detects testpaths from pyproject.toml", async () => {
    _frameworkConfigDeps.readText = mock(async (path: string) => {
      if (path.endsWith("pyproject.toml")) {
        return `[tool.pytest.ini_options]\ntestpaths = ["tests", "integration"]`;
      }
      return null;
    });
    _frameworkConfigDeps.parseToml = mock((_text: string) => ({
      tool: { pytest: { ini_options: { testpaths: ["tests", "integration"] } } },
    }));
    _frameworkDefaultsDeps.readText = mock(async () => null);
    _fileScanDeps.spawn = mock((..._args: unknown[]) => spawnWithOutput("")) as unknown as typeof Bun.spawn;

    const result = await detectTestFilePatterns("/fake/workdir");
    expect(result.confidence).toBe("high");
    expect(result.patterns).toContain("tests/**/*.py");
    expect(result.patterns).toContain("integration/**/*.py");
  });
});

// ─── Tier 2: framework defaults ──────────────────────────────────────────────

describe("Tier 2 — framework defaults from manifests", () => {
  test("detects jest from devDependencies at medium confidence", async () => {
    _frameworkConfigDeps.readText = mock(async () => null);
    _frameworkDefaultsDeps.readText = mock(async (path: string) => {
      if (path.endsWith("package.json")) {
        return JSON.stringify({ devDependencies: { jest: "^29.0.0" } });
      }
      return null;
    });
    _fileScanDeps.spawn = mock((..._args: unknown[]) => spawnWithOutput("")) as unknown as typeof Bun.spawn;

    const result = await detectTestFilePatterns("/fake/workdir");
    expect(result.confidence).toBe("medium");
    // Jest defaults are expanded from extglob to simple globs so downstream
    // regex classification (globsToTestRegex) works correctly.
    expect(result.patterns).toEqual(
      expect.arrayContaining([
        "**/__tests__/**/*.js",
        "**/__tests__/**/*.ts",
        "**/*.spec.ts",
        "**/*.test.tsx",
      ]),
    );
    // Must not contain unexpanded extglob patterns.
    expect(result.patterns).not.toContain("**/?(*.)+(spec|test).[jt]s?(x)");
  });

  test("detects bun test from package.json scripts.test", async () => {
    _frameworkConfigDeps.readText = mock(async () => null);
    _frameworkDefaultsDeps.readText = mock(async (path: string) => {
      if (path.endsWith("package.json")) {
        return JSON.stringify({ scripts: { test: "bun test" } });
      }
      return null;
    });
    _fileScanDeps.spawn = mock((..._args: unknown[]) => spawnWithOutput("")) as unknown as typeof Bun.spawn;

    const result = await detectTestFilePatterns("/fake/workdir");
    expect(result.confidence).toBe("medium");
    // Bun defaults are expanded from brace alternatives into simple globs
    // and broadened to cover *_test.*, *.spec.*, and *_spec.* (matching Bun's discovery rules).
    expect(result.patterns).toEqual(
      expect.arrayContaining(["**/*.test.ts", "**/*.test.tsx", "**/*_test.ts", "**/*.spec.ts"]),
    );
  });

  test("detects Go project from go.mod and returns **/*_test.go at medium confidence", async () => {
    _frameworkConfigDeps.readText = mock(async () => null);
    _frameworkDefaultsDeps.readText = mock(async () => null);
    _frameworkDefaultsDeps.fileExists = mock(async (path: string) => path.endsWith("go.mod"));
    _fileScanDeps.spawn = mock((..._args: unknown[]) => spawnWithOutput("")) as unknown as typeof Bun.spawn;

    const result = await detectTestFilePatterns("/fake/workdir");
    expect(result.confidence).toBe("medium");
    expect(result.patterns).toContain("**/*_test.go");
    expect(result.sources[0]?.type).toBe("manifest");
  });

  test("polyglot project (TS + Go) merges patterns from both", async () => {
    _frameworkConfigDeps.readText = mock(async () => null);
    _frameworkDefaultsDeps.readText = mock(async (path: string) => {
      if (path.endsWith("package.json")) {
        return JSON.stringify({ devDependencies: { vitest: "^1.0.0" } });
      }
      return null;
    });
    _frameworkDefaultsDeps.fileExists = mock(async (path: string) => path.endsWith("go.mod"));
    _fileScanDeps.spawn = mock((..._args: unknown[]) => spawnWithOutput("")) as unknown as typeof Bun.spawn;

    const result = await detectTestFilePatterns("/fake/workdir");
    expect(result.confidence).toBe("medium");
    expect(result.patterns).toContain("**/*_test.go");
    // Vitest extglob is expanded into simple globs.
    expect(result.patterns).toEqual(expect.arrayContaining(["**/*.test.ts", "**/*.spec.tsx"]));
  });
});

// ─── Tier 3: file scan ────────────────────────────────────────────────────────

describe("Tier 3 — file scan", () => {
  test("detects .test.ts suffix from git ls-files with ≥5 files", async () => {
    _frameworkConfigDeps.readText = mock(async () => null);
    _frameworkDefaultsDeps.readText = mock(async () => null);

    const testFiles = Array.from({ length: 6 }, (_, i) => `src/module${i}.test.ts`).join("\n");
    const allFiles = `${testFiles}\nsrc/app.ts\nsrc/index.ts\n`;
    _fileScanDeps.spawn = mock((..._args: unknown[]) =>
      spawnWithOutput(allFiles),
    ) as unknown as typeof Bun.spawn;

    const result = await detectTestFilePatterns("/fake/workdir");
    expect(result.confidence).toBe("low");
    expect(result.patterns).toContain("**/*.test.ts");
    expect(result.sources[0]?.type).toBe("file-scan");
  });

  test("returns empty when no suffix meets threshold", async () => {
    _frameworkConfigDeps.readText = mock(async () => null);
    _frameworkDefaultsDeps.readText = mock(async () => null);

    const files =
      "src/a.test.ts\nsrc/b.test.ts\n" +
      Array.from({ length: 50 }, (_, i) => `src/f${i}.ts`).join("\n");
    _fileScanDeps.spawn = mock((..._args: unknown[]) => spawnWithOutput(files)) as unknown as typeof Bun.spawn;
    _directoryScanDeps.dirExists = mock(async () => false);

    const result = await detectTestFilePatterns("/fake/workdir");
    expect(result.confidence).toBe("empty");
  });
});

// ─── Tier 4: directory scan ───────────────────────────────────────────────────

describe("Tier 4 — directory convention", () => {
  test("detects test/ directory and emits generic globs", async () => {
    _frameworkConfigDeps.readText = mock(async () => null);
    _frameworkDefaultsDeps.readText = mock(async () => null);
    _fileScanDeps.spawn = mock((..._args: unknown[]) => spawnWithOutput("")) as unknown as typeof Bun.spawn;

    _directoryScanDeps.dirExists = mock(async (path: string) => path.endsWith("/test"));
    _directoryScanDeps.spawn = mock((..._args: unknown[]) =>
      spawnWithOutput("test/foo.test.ts\ntest/bar.test.ts\n"),
    ) as unknown as typeof Bun.spawn;

    const result = await detectTestFilePatterns("/fake/workdir");
    expect(result.confidence).toBe("low");
    expect(result.patterns.some((p) => p.startsWith("test/"))).toBe(true);
  });
});

// ─── Empty project ────────────────────────────────────────────────────────────

describe("empty project", () => {
  test("returns empty confidence when no signals found", async () => {
    _frameworkConfigDeps.readText = mock(async () => null);
    _frameworkDefaultsDeps.readText = mock(async () => null);
    _fileScanDeps.spawn = mock((..._args: unknown[]) => spawnWithOutput("")) as unknown as typeof Bun.spawn;
    _directoryScanDeps.dirExists = mock(async () => false);

    const result = await detectTestFilePatterns("/fake/workdir");
    expect(result.confidence).toBe("empty");
    expect(result.patterns).toHaveLength(0);
    expect(result.sources).toHaveLength(0);
  });
});

// ─── Monorepo workspace ───────────────────────────────────────────────────────

describe("monorepo workspace", () => {
  test("detectTestFilePatternsForWorkspace returns per-package map", async () => {
    // Root: vitest; packages/api: jest; packages/ui: empty
    _frameworkConfigDeps.readText = mock(async () => null);
    _frameworkDefaultsDeps.readText = mock(async (path: string) => {
      if (path === "/fake/root/package.json") {
        return JSON.stringify({ devDependencies: { vitest: "^1.0.0" } });
      }
      if (path === "/fake/root/packages/api/package.json") {
        return JSON.stringify({ devDependencies: { jest: "^29.0.0" } });
      }
      return null;
    });
    _frameworkDefaultsDeps.fileExists = mock(async () => false);
    _fileScanDeps.spawn = mock((..._args: unknown[]) => spawnWithOutput("")) as unknown as typeof Bun.spawn;
    _directoryScanDeps.dirExists = mock(async () => false);

    const result = await detectTestFilePatternsForWorkspace("/fake/root", ["packages/api", "packages/ui"]);

    // Root should detect vitest (extglob expanded into simple globs)
    expect(result[""]?.confidence).toBe("medium");
    expect(result[""]?.patterns).toEqual(expect.arrayContaining(["**/*.test.ts", "**/*.spec.tsx"]));

    // packages/api should detect jest (extglob expanded into simple globs)
    expect(result["packages/api"]?.confidence).toBe("medium");
    expect(result["packages/api"]?.patterns).toEqual(
      expect.arrayContaining(["**/__tests__/**/*.ts", "**/__tests__/**/*.tsx"]),
    );

    // packages/ui has no signals
    expect(result["packages/ui"]?.confidence).toBe("empty");
  });
});
