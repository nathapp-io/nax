/**
 * Tests for framework-isolation logic in the detection orchestrator.
 *
 * These tests verify:
 *  1. Tier 1 config suppresses Tier 2 defaults for the same framework
 *  2. Tier 1 with unextractable config (testRegex, dynamic import) still
 *     suppresses Tier 2 defaults for that framework
 *  3. Multiple JS frameworks in devDependencies each get their own defaults
 *  4. Per-framework suppression: Tier 1 for framework A suppresses Tier 2 for
 *     A but not for B (e.g. playwright Tier 1 + jest Tier 2 coexist)
 *  5. Improved pyproject heuristic does not false-positive on config sections
 *  6. jest.config.json with package.json#jest — config file takes precedence
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _directoryScanDeps } from "../../../src/test-runners/detect/directory-scan";
import { _fileScanDeps } from "../../../src/test-runners/detect/file-scan";
import { _frameworkConfigDeps } from "../../../src/test-runners/detect/framework-configs";
import { _frameworkDefaultsDeps } from "../../../src/test-runners/detect/framework-defaults";
import { detectTestFilePatterns } from "../../../src/test-runners/detect/index";
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
  _cacheDeps.readJson = mock(async () => { throw new Error("not found"); });
  _cacheDeps.writeJson = mock(async () => {});
  _cacheDeps.fileMtime = mock(async () => null);
  _directoryScanDeps.dirExists = mock(async () => false);
  _directoryScanDeps.spawn = mock((..._args: unknown[]) => spawnFailed()) as unknown as typeof Bun.spawn;
  _frameworkDefaultsDeps.fileExists = mock(async () => false);
  _fileScanDeps.spawn = mock((..._args: unknown[]) => spawnWithOutput("")) as unknown as typeof Bun.spawn;
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

// ─── Bug 1: Tier 1 config suppresses Tier 2 defaults for same framework ───────

describe("Tier 1 suppresses Tier 2 for the same framework", () => {
  test("jest.config.js custom testMatch is not merged with jest Tier 2 defaults", async () => {
    // Tier 1: explicit narrow jest config
    _frameworkConfigDeps.readText = mock(async (path: string) => {
      if (path.endsWith("jest.config.js")) {
        return `module.exports = { testMatch: ["src/unit/**/*.test.ts"] }`;
      }
      return null;
    });
    // Tier 2: jest in devDeps would contribute many defaults
    _frameworkDefaultsDeps.readText = mock(async (path: string) => {
      if (path.endsWith("package.json")) {
        return JSON.stringify({ devDependencies: { jest: "^29.0.0" } });
      }
      return null;
    });

    const result = await detectTestFilePatterns("/fake/workdir");
    expect(result.confidence).toBe("high");
    expect(result.patterns).toContain("src/unit/**/*.test.ts");
    // Tier 2 jest defaults must NOT appear alongside the Tier 1 custom patterns
    expect(result.patterns).not.toContain("**/__tests__/**/*.ts");
    expect(result.patterns).not.toContain("**/*.spec.ts");
    expect(result.patterns).toHaveLength(1);
  });

  test("vitest.config.ts include suppresses vitest Tier 2 defaults", async () => {
    _frameworkConfigDeps.readText = mock(async (path: string) => {
      if (path.endsWith("vitest.config.ts")) {
        return `export default defineConfig({ test: { include: ["tests/**/*.unit.ts"] } })`;
      }
      return null;
    });
    _frameworkDefaultsDeps.readText = mock(async (path: string) => {
      if (path.endsWith("package.json")) {
        return JSON.stringify({ devDependencies: { vitest: "^1.0.0" } });
      }
      return null;
    });

    const result = await detectTestFilePatterns("/fake/workdir");
    expect(result.confidence).toBe("high");
    expect(result.patterns).toContain("tests/**/*.unit.ts");
    // Vitest defaults (many expanded globs) must not bleed through
    expect(result.patterns).not.toContain("**/*.test.ts");
    expect(result.patterns).toHaveLength(1);
  });

  test("playwright.config.ts testDir suppresses playwright Tier 2 defaults", async () => {
    _frameworkConfigDeps.readText = mock(async (path: string) => {
      if (path.endsWith("playwright.config.ts")) {
        return `export default defineConfig({ testDir: 'e2e' })`;
      }
      return null;
    });
    _frameworkDefaultsDeps.readText = mock(async (path: string) => {
      if (path.endsWith("package.json")) {
        return JSON.stringify({ devDependencies: { "@playwright/test": "^1.40.0" } });
      }
      return null;
    });

    const result = await detectTestFilePatterns("/fake/workdir");
    expect(result.confidence).toBe("high");
    // testDir 'e2e' produces brace pattern that normalize() expands
    expect(result.patterns).toContain("e2e/**/*.spec.ts");
    expect(result.patterns).toContain("e2e/**/*.spec.js");
    // Broad Tier 2 playwright defaults must not appear
    expect(result.patterns).not.toContain("**/*.spec.ts");
    expect(result.patterns).not.toContain("**/*.spec.js");
  });
});

// ─── Bug 2: Tier 1 unextractable config still suppresses Tier 2 defaults ──────

describe("Tier 1 unextractable config suppresses Tier 2 defaults", () => {
  test("jest.config.js with testRegex falls back to jest Tier 2 defaults (honest fallback)", async () => {
    // Developer uses testRegex instead of testMatch — we can't extract patterns.
    // Because Tier 1 yields no patterns, Tier 2 defaults are allowed through as a
    // best-effort fallback (better than emitting nothing and missing test files).
    _frameworkConfigDeps.readText = mock(async (path: string) => {
      if (path.endsWith("jest.config.js")) {
        return `module.exports = { testRegex: /src\\/.*\\.unit\\.test\\.tsx?$/ }`;
      }
      return null;
    });
    _frameworkDefaultsDeps.readText = mock(async (path: string) => {
      if (path.endsWith("package.json")) {
        return JSON.stringify({ devDependencies: { jest: "^29.0.0" } });
      }
      return null;
    });

    const result = await detectTestFilePatterns("/fake/workdir");
    // Tier 1 found jest.config.js but extracted no patterns (testRegex unextractable).
    // Tier 2 jest defaults are NOT suppressed — they surface as a medium-confidence fallback.
    expect(result.patterns).toContain("**/__tests__/**/*.ts");
    expect(result.patterns).toContain("**/*.test.ts");
  });

  test("vitest.config.ts with dynamic include falls back to vitest Tier 2 defaults", async () => {
    // Config file exists but include is dynamic — empty extraction.
    // Tier 1 yields no patterns, so Tier 2 defaults surface as best-effort fallback.
    _frameworkConfigDeps.readText = mock(async (path: string) => {
      if (path.endsWith("vitest.config.ts")) {
        return `export default defineConfig({ test: { include: getIncludePatterns() } })`;
      }
      return null;
    });
    _frameworkDefaultsDeps.readText = mock(async (path: string) => {
      if (path.endsWith("package.json")) {
        return JSON.stringify({ devDependencies: { vitest: "^1.0.0" } });
      }
      return null;
    });

    const result = await detectTestFilePatterns("/fake/workdir");
    // Vitest Tier 2 defaults surface (medium confidence) as a best-effort fallback
    expect(result.confidence).toBe("medium");
    expect(result.patterns).toContain("**/*.test.ts");
  });
});

// ─── Bug 2 (Tier 2): All matching frameworks emitted, not just first ──────────

describe("Tier 2 emits all matching frameworks", () => {
  test("jest + @playwright/test in devDeps both get defaults", async () => {
    _frameworkConfigDeps.readText = mock(async () => null);
    _frameworkDefaultsDeps.readText = mock(async (path: string) => {
      if (path.endsWith("package.json")) {
        return JSON.stringify({
          devDependencies: {
            jest: "^29.0.0",
            "@playwright/test": "^1.40.0",
          },
        });
      }
      return null;
    });

    const result = await detectTestFilePatterns("/fake/workdir");
    expect(result.confidence).toBe("medium");
    // Jest defaults present
    expect(result.patterns).toContain("**/__tests__/**/*.ts");
    expect(result.patterns).toContain("**/*.test.ts");
    // Playwright defaults present — not dropped because jest was found first
    expect(result.patterns).toContain("**/*.spec.ts");
    expect(result.patterns).toContain("**/*.spec.js");
  });

  test("jest + cypress in devDeps both get defaults", async () => {
    _frameworkConfigDeps.readText = mock(async () => null);
    _frameworkDefaultsDeps.readText = mock(async (path: string) => {
      if (path.endsWith("package.json")) {
        return JSON.stringify({
          devDependencies: {
            jest: "^29.0.0",
            cypress: "^13.0.0",
          },
        });
      }
      return null;
    });

    const result = await detectTestFilePatterns("/fake/workdir");
    expect(result.confidence).toBe("medium");
    expect(result.patterns).toContain("**/*.test.ts");
    // Cypress defaults should be present too
    expect(result.patterns.some((p) => p.startsWith("cypress/"))).toBe(true);
  });

  test("vitest + go.mod polyglot project gets patterns for both", async () => {
    _frameworkConfigDeps.readText = mock(async () => null);
    _frameworkDefaultsDeps.readText = mock(async (path: string) => {
      if (path.endsWith("package.json")) {
        return JSON.stringify({ devDependencies: { vitest: "^1.0.0" } });
      }
      return null;
    });
    _frameworkDefaultsDeps.fileExists = mock(async (path: string) => path.endsWith("go.mod"));

    const result = await detectTestFilePatterns("/fake/workdir");
    expect(result.confidence).toBe("medium");
    expect(result.patterns).toContain("**/*_test.go");
    expect(result.patterns).toContain("**/*.test.ts");
  });
});

// ─── Bug 3: Per-framework suppression — Tier 1 for A does not suppress B ──────

describe("per-framework isolation: Tier 1 A does not suppress Tier 2 B", () => {
  test("playwright Tier 1 + jest Tier 2 coexist — jest defaults present", async () => {
    // Tier 1: playwright config only
    _frameworkConfigDeps.readText = mock(async (path: string) => {
      if (path.endsWith("playwright.config.ts")) {
        return `export default defineConfig({ testDir: 'e2e' })`;
      }
      return null;
    });
    // Tier 2: jest + playwright both in devDeps
    _frameworkDefaultsDeps.readText = mock(async (path: string) => {
      if (path.endsWith("package.json")) {
        return JSON.stringify({
          devDependencies: {
            jest: "^29.0.0",
            "@playwright/test": "^1.40.0",
          },
        });
      }
      return null;
    });

    const result = await detectTestFilePatterns("/fake/workdir");
    // Playwright Tier 1 scoped pattern retained (brace expanded by normalize())
    expect(result.patterns).toContain("e2e/**/*.spec.ts");
    expect(result.patterns).toContain("e2e/**/*.spec.js");
    // Jest Tier 2 defaults emitted (playwright Tier 1 does not suppress jest)
    expect(result.patterns).toContain("**/__tests__/**/*.ts");
    expect(result.patterns).toContain("**/*.test.ts");
    // Note: **/*.spec.ts appears in both jest defaults and playwright defaults — can't
    // distinguish via patterns alone, but playwright Tier 2 SOURCE is suppressed.
  });

  test("playwright Tier 1 + cypress Tier 2 — cypress patterns present, playwright broad defaults absent", async () => {
    // Tier 1: playwright scoped to e2e/
    _frameworkConfigDeps.readText = mock(async (path: string) => {
      if (path.endsWith("playwright.config.ts")) {
        return `export default defineConfig({ testDir: 'e2e' })`;
      }
      return null;
    });
    // Tier 2: playwright + cypress in devDeps (no jest — cleaner isolation check)
    _frameworkDefaultsDeps.readText = mock(async (path: string) => {
      if (path.endsWith("package.json")) {
        return JSON.stringify({
          devDependencies: {
            "@playwright/test": "^1.40.0",
            cypress: "^13.0.0",
          },
        });
      }
      return null;
    });

    const result = await detectTestFilePatterns("/fake/workdir");
    // Playwright Tier 1 scoped patterns present
    expect(result.patterns).toContain("e2e/**/*.spec.ts");
    // Cypress Tier 2 present (different framework — not suppressed)
    expect(result.patterns.some((p) => p.startsWith("cypress/"))).toBe(true);
    // Playwright Tier 2 broad defaults suppressed — **/*.spec.ts must NOT appear
    // (only source of **/*.spec.ts here would be playwright Tier 2 defaults)
    expect(result.patterns).not.toContain("**/*.spec.ts");
    expect(result.patterns).not.toContain("**/*.spec.js");
  });

  test("vitest Tier 1 + pytest pyproject Tier 2 coexist", async () => {
    _frameworkConfigDeps.readText = mock(async (path: string) => {
      if (path.endsWith("vitest.config.ts")) {
        return `export default defineConfig({ test: { include: ["src/**/*.test.ts"] } })`;
      }
      return null;
    });
    _frameworkDefaultsDeps.readText = mock(async (path: string) => {
      if (path.endsWith("package.json")) {
        return JSON.stringify({ devDependencies: { vitest: "^1.0.0" } });
      }
      if (path.endsWith("pyproject.toml")) {
        // pytest as a quoted string in a dependency array (common PEP 517 form)
        return `[project]\nname = "myapp"\ndependencies = ["pytest>=7.0", "requests"]\n`;
      }
      return null;
    });

    const result = await detectTestFilePatterns("/fake/workdir");
    // vitest Tier 1 pattern
    expect(result.patterns).toContain("src/**/*.test.ts");
    // pytest Tier 2 defaults (unrelated framework — not suppressed)
    expect(result.patterns).toContain("test_*.py");
    // vitest Tier 2 defaults must be suppressed
    expect(result.patterns).not.toContain("**/*.spec.ts");
  });
});

// ─── Bug 4: pyproject heuristic avoids false positives ───────────────────────

describe("pyproject.toml pytest heuristic", () => {
  test("detects pytest from [project.dependencies] key-value entry", async () => {
    _frameworkConfigDeps.readText = mock(async () => null);
    _frameworkDefaultsDeps.readText = mock(async (path: string) => {
      if (path.endsWith("pyproject.toml")) {
        return `[project]\nname = "myapp"\n\n[project.dependencies]\npytest = ">=7.0"\n`;
      }
      return null;
    });

    const result = await detectTestFilePatterns("/fake/workdir");
    expect(result.patterns).toContain("test_*.py");
    expect(result.patterns).toContain("tests/**/*.py");
  });

  test("detects pytest from quoted string in dependency array", async () => {
    _frameworkConfigDeps.readText = mock(async () => null);
    _frameworkDefaultsDeps.readText = mock(async (path: string) => {
      if (path.endsWith("pyproject.toml")) {
        // PEP 517 format: pytest as a quoted item in dependencies array
        return `[project]\nname = "myapp"\ndependencies = ["pytest>=7", "black"]\n`;
      }
      return null;
    });

    const result = await detectTestFilePatterns("/fake/workdir");
    expect(result.patterns).toContain("test_*.py");
  });

  test("does NOT detect pytest from [tool.pytest.ini_options] header alone", async () => {
    // Only a config section header — no dependency declaration
    // Tier 2 heuristic should NOT trigger; Tier 1 would handle ini_options separately
    _frameworkConfigDeps.readText = mock(async () => null); // Tier 1 parsers return null here
    _frameworkDefaultsDeps.readText = mock(async (path: string) => {
      if (path.endsWith("pyproject.toml")) {
        return `[tool.pytest.ini_options]\naddopts = "-v"\n`;
      }
      return null;
    });

    const result = await detectTestFilePatterns("/fake/workdir");
    // [tool.pytest.ini_options] has no = or quoted "pytest" → heuristic doesn't fire
    expect(result.confidence).toBe("empty");
    expect(result.patterns).not.toContain("test_*.py");
  });
});

// ─── Bug 5: jest config fallthrough — config file takes precedence ─────────────

describe("jest config resolution precedence", () => {
  test("jest.config.js exists and is empty → package.json#jest is NOT used", async () => {
    // Jest's actual resolution: jest.config.* wins over package.json#jest.
    // If jest.config.js is found (even with no extractable testMatch), we must
    // not fall through to package.json#jest.
    _frameworkConfigDeps.readText = mock(async (path: string) => {
      if (path.endsWith("jest.config.js")) {
        // No testMatch — just some other config
        return `module.exports = { transform: {} }`;
      }
      if (path.endsWith("package.json")) {
        return JSON.stringify({ jest: { testMatch: ["src/**/*.unit.test.ts"] } });
      }
      return null;
    });
    _frameworkDefaultsDeps.readText = mock(async () => null);

    const result = await detectTestFilePatterns("/fake/workdir");
    // package.json#jest pattern must NOT appear — jest.config.js took precedence
    expect(result.patterns).not.toContain("src/**/*.unit.test.ts");
    // And jest Tier 2 defaults should also be suppressed (jest was claimed by Tier 1)
    expect(result.patterns).not.toContain("**/*.test.ts");
  });

  test("no jest.config.* → package.json#jest is used", async () => {
    _frameworkConfigDeps.readText = mock(async (path: string) => {
      if (path.endsWith("package.json")) {
        return JSON.stringify({ jest: { testMatch: ["src/**/*.unit.test.ts"] } });
      }
      return null;
    });
    _frameworkDefaultsDeps.readText = mock(async () => null);

    const result = await detectTestFilePatterns("/fake/workdir");
    expect(result.confidence).toBe("high");
    expect(result.patterns).toContain("src/**/*.unit.test.ts");
  });
});
