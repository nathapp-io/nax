/**
 * Tier 1 — Framework Config Parsers
 *
 * Extracts test-file glob patterns from framework configuration files.
 * Each parser returns null when the file is absent or yields no usable patterns.
 * The orchestrator (detect/index.ts) tries each parser in turn and unions results.
 *
 * Excluded dirs always filtered: node_modules/, dist/, build/, .nax/, coverage/, .git/
 */

import { expandExtglobAll } from "./extglob";
import type { DetectionSource } from "./types";

/** Directories always excluded from produced globs */
const EXCLUDE_DIRS = ["node_modules", "dist", "build", ".nax", "coverage", ".git"];

/** Injectable deps for testability */
export const _frameworkConfigDeps = {
  readText: async (path: string): Promise<string | null> => {
    const f = Bun.file(path);
    if (!(await f.exists())) return null;
    return f.text();
  },
  parseToml: (text: string): unknown => Bun.TOML.parse(text),
  parseYaml: (text: string): unknown => Bun.YAML.parse(text),
};

/** Filter out patterns referencing excluded dirs */
function filterExcluded(patterns: string[]): string[] {
  return patterns.filter((p) => !EXCLUDE_DIRS.some((d) => p.includes(`/${d}/`) || p.startsWith(`${d}/`)));
}

/**
 * Normalize framework-emitted patterns by expanding extglob/brace syntax
 * into simple globs the suffix-based regex extractor can handle.
 * Filters excluded dirs after expansion since expansion may surface
 * previously-hidden references.
 */
function normalize(patterns: string[]): string[] {
  return filterExcluded(expandExtglobAll(patterns));
}

/**
 * Try reading a vitest config file (vitest.config.ts/js/mts).
 * Extracts `test.include` array when present.
 *
 * Note: vitest configs are TypeScript/JS — we extract include by regex
 * rather than executing the file. Handles the common literal array form.
 */
async function parseVitestConfig(workdir: string): Promise<DetectionSource | null> {
  const candidates = ["vitest.config.ts", "vitest.config.mts", "vitest.config.js", "vitest.config.mjs"];
  for (const name of candidates) {
    const path = `${workdir}/${name}`;
    const text = await _frameworkConfigDeps.readText(path);
    if (!text) continue;

    // Extract test.include: ["pattern1", "pattern2"]  (common literal form)
    const includeMatch = text.match(/include\s*:\s*\[([^\]]+)\]/s);
    if (includeMatch) {
      const patterns = extractStringLiterals(includeMatch[1]);
      if (patterns.length > 0) {
        return { type: "framework-config", path, patterns: normalize(patterns) };
      }
    }
    // Found config file but no extractable include → return empty source to signal Tier 1 found
    return { type: "framework-config", path, patterns: [] };
  }
  return null;
}

/**
 * Try reading a jest config file (jest.config.ts/js/cjs/mjs or package.json#jest).
 * Extracts `testMatch` patterns (prefer) or converts `testRegex` when present.
 */
async function parseJestConfig(workdir: string): Promise<DetectionSource | null> {
  const candidates = ["jest.config.ts", "jest.config.js", "jest.config.cjs", "jest.config.mjs", "jest.config.json"];
  for (const name of candidates) {
    const path = `${workdir}/${name}`;
    const text = await _frameworkConfigDeps.readText(path);
    if (!text) continue;

    const patterns = extractJestPatterns(text);
    return { type: "framework-config", path, patterns: normalize(patterns) };
  }

  // Check package.json#jest
  const pkgPath = `${workdir}/package.json`;
  const pkgText = await _frameworkConfigDeps.readText(pkgPath);
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText) as Record<string, unknown>;
      const jestConfig = pkg.jest as Record<string, unknown> | undefined;
      if (jestConfig) {
        const patterns = extractJestPatternsFromObject(jestConfig);
        if (patterns.length > 0) {
          return { type: "framework-config", path: `${pkgPath}#jest`, patterns: normalize(patterns) };
        }
      }
    } catch {
      // Corrupt package.json — ignore
    }
  }

  return null;
}

function extractJestPatterns(text: string): string[] {
  // testMatch: ["pattern1", "pattern2"]
  const matchMatch = text.match(/testMatch\s*:\s*\[([^\]]+)\]/s);
  if (matchMatch) {
    const patterns = extractStringLiterals(matchMatch[1]);
    if (patterns.length > 0) return patterns;
  }
  return [];
}

function extractJestPatternsFromObject(config: Record<string, unknown>): string[] {
  const testMatch = config.testMatch;
  if (Array.isArray(testMatch)) return testMatch.filter((p): p is string => typeof p === "string");
  return [];
}

/**
 * Parse pyproject.toml for pytest test configuration.
 * Extracts testpaths and python_files from [tool.pytest.ini_options].
 */
async function parsePyprojectToml(workdir: string): Promise<DetectionSource | null> {
  const path = `${workdir}/pyproject.toml`;
  const text = await _frameworkConfigDeps.readText(path);
  if (!text) return null;

  try {
    const parsed = _frameworkConfigDeps.parseToml(text) as Record<string, unknown>;
    const tool = parsed?.tool as Record<string, unknown> | undefined;
    const pytest = tool?.pytest as Record<string, unknown> | undefined;
    const iniOptions = (pytest?.ini_options ?? tool?.["pytest.ini_options"]) as Record<string, unknown> | undefined;

    if (!iniOptions) {
      // pyproject.toml exists but no pytest config
      return null;
    }

    const patterns: string[] = [];

    // testpaths: ["tests", "src"] → "tests/**/*.py"
    const testpaths = iniOptions.testpaths;
    if (Array.isArray(testpaths)) {
      for (const p of testpaths) {
        if (typeof p === "string") patterns.push(`${p}/**/*.py`);
      }
    }

    // python_files: ["test_*.py", "*_test.py"]
    const pythonFiles = iniOptions.python_files;
    if (Array.isArray(pythonFiles)) {
      for (const p of pythonFiles) {
        if (typeof p === "string") patterns.push(p);
      }
    } else if (typeof pythonFiles === "string") {
      patterns.push(pythonFiles);
    }

    // Default pytest patterns when config exists but no explicit patterns
    if (patterns.length === 0) {
      patterns.push("test_*.py", "*_test.py");
    }

    return { type: "framework-config", path, patterns: normalize(patterns) };
  } catch {
    return null;
  }
}

/**
 * Parse pytest.ini for test configuration.
 */
async function parsePytestIni(workdir: string): Promise<DetectionSource | null> {
  const candidates = ["pytest.ini", "setup.cfg"];
  for (const name of candidates) {
    const path = `${workdir}/${name}`;
    const text = await _frameworkConfigDeps.readText(path);
    if (!text) continue;

    if (!text.includes("[pytest]") && !text.includes("[tool:pytest]")) continue;

    const patterns: string[] = [];

    // testpaths = tests src
    const testpathsMatch = text.match(/testpaths\s*=\s*([^\n]+)/);
    if (testpathsMatch) {
      for (const p of testpathsMatch[1].trim().split(/\s+/)) {
        if (p) patterns.push(`${p}/**/*.py`);
      }
    }

    // python_files = test_*.py *_test.py
    const pyFilesMatch = text.match(/python_files\s*=\s*([^\n]+)/);
    if (pyFilesMatch) {
      for (const p of pyFilesMatch[1].trim().split(/\s+/)) {
        if (p) patterns.push(p);
      }
    }

    if (patterns.length === 0) patterns.push("test_*.py", "*_test.py");
    return { type: "framework-config", path, patterns: normalize(patterns) };
  }
  return null;
}

/**
 * Parse .mocharc.* for spec patterns.
 */
async function parseMochaConfig(workdir: string): Promise<DetectionSource | null> {
  const candidates = [".mocharc.js", ".mocharc.cjs", ".mocharc.yaml", ".mocharc.yml", ".mocharc.json"];
  for (const name of candidates) {
    const path = `${workdir}/${name}`;
    const text = await _frameworkConfigDeps.readText(path);
    if (!text) continue;

    try {
      let config: Record<string, unknown>;
      if (name.endsWith(".json")) {
        config = JSON.parse(text) as Record<string, unknown>;
      } else if (name.endsWith(".yaml") || name.endsWith(".yml")) {
        config = _frameworkConfigDeps.parseYaml(text) as Record<string, unknown>;
      } else {
        // JS/CJS — extract spec: property with regex
        const specMatch = text.match(/spec\s*:\s*['"]([^'"]+)['"]/);
        if (specMatch) {
          return { type: "framework-config", path, patterns: normalize([specMatch[1]]) };
        }
        continue;
      }

      const spec = config.spec;
      const patterns = Array.isArray(spec)
        ? spec.filter((p): p is string => typeof p === "string")
        : typeof spec === "string"
          ? [spec]
          : [];

      if (patterns.length > 0) {
        return { type: "framework-config", path, patterns: normalize(patterns) };
      }
    } catch {
      // parse error — skip this config file, try next candidate
    }
  }
  return null;
}

/**
 * Parse playwright.config.* for testDir/testMatch.
 */
async function parsePlaywrightConfig(workdir: string): Promise<DetectionSource | null> {
  const candidates = ["playwright.config.ts", "playwright.config.js"];
  for (const name of candidates) {
    const path = `${workdir}/${name}`;
    const text = await _frameworkConfigDeps.readText(path);
    if (!text) continue;

    const patterns: string[] = [];

    // testDir: 'e2e' or testDir: "e2e"
    const testDirMatch = text.match(/testDir\s*:\s*['"]([^'"]+)['"]/);
    if (testDirMatch) patterns.push(`${testDirMatch[1]}/**/*.spec.{ts,js}`);

    // testMatch: ['**/*.spec.ts']
    const testMatchMatch = text.match(/testMatch\s*:\s*\[([^\]]+)\]/s);
    if (testMatchMatch) {
      const extracted = extractStringLiterals(testMatchMatch[1]);
      patterns.push(...extracted);
    }

    if (patterns.length > 0) {
      return { type: "framework-config", path, patterns: normalize(patterns) };
    }
    // Config file found but no extractable pattern
    return { type: "framework-config", path, patterns: ["**/*.spec.ts", "**/*.spec.js"] };
  }
  return null;
}

/**
 * Parse cypress.config.* for specPattern.
 */
async function parseCypressConfig(workdir: string): Promise<DetectionSource | null> {
  const candidates = ["cypress.config.ts", "cypress.config.js"];
  for (const name of candidates) {
    const path = `${workdir}/${name}`;
    const text = await _frameworkConfigDeps.readText(path);
    if (!text) continue;

    // specPattern: 'cypress/e2e/**/*.cy.{js,jsx,ts,tsx}'
    const specMatch = text.match(/specPattern\s*:\s*['"]([^'"]+)['"]/);
    if (specMatch) {
      return { type: "framework-config", path, patterns: normalize([specMatch[1]]) };
    }

    return { type: "framework-config", path, patterns: normalize(["cypress/e2e/**/*.cy.{js,ts}"]) };
  }
  return null;
}

/** Extract string literals from a JS array body (e.g. `"foo", 'bar'`) */
function extractStringLiterals(body: string): string[] {
  const patterns: string[] = [];
  const re = /['"]([^'"]+)['"]/g;
  let m = re.exec(body);
  while (m !== null) {
    if (m[1]) patterns.push(m[1]);
    m = re.exec(body);
  }
  return patterns;
}

/**
 * Run all Tier 1 framework config parsers for a workdir.
 * Returns an array of DetectionSources (one per found config file).
 */
export async function detectFromFrameworkConfigs(workdir: string): Promise<DetectionSource[]> {
  const results = await Promise.all([
    parseVitestConfig(workdir),
    parseJestConfig(workdir),
    parsePyprojectToml(workdir),
    parsePytestIni(workdir),
    parseMochaConfig(workdir),
    parsePlaywrightConfig(workdir),
    parseCypressConfig(workdir),
  ]);

  return results.filter((r): r is DetectionSource => r !== null);
}
