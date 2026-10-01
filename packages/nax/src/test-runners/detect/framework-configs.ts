/**
 * Tier 1 — Framework Config Parsers (JS/TS frameworks)
 *
 * Extracts test-file glob patterns from framework configuration files.
 * Each parser returns null when the file is absent or yields no usable patterns.
 * The orchestrator (detect/index.ts) tries each parser in turn and unions results.
 *
 * Python parsers live in framework-configs-python.ts.
 * Excluded dirs always filtered: node_modules/, dist/, build/, .nax/, coverage/, .git/
 */

import { expandExtglobAll } from "./extglob";
import { _frameworkConfigDeps } from "./framework-configs-deps";
import { parsePyprojectToml, parsePytestIni } from "./framework-configs-python";
import type { DetectionSource } from "./types";

// Re-export so tests continue to import _frameworkConfigDeps from this module.
export { _frameworkConfigDeps } from "./framework-configs-deps";

/** Directories always excluded from produced globs */
const EXCLUDE_DIRS = ["node_modules", "dist", "build", ".nax", "coverage", ".git"];

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
        return { type: "framework-config", framework: "vitest", path, patterns: normalize(patterns) };
      }
    }
    // Found config file but no extractable include → still claim framework to suppress Tier 2 defaults.
    return { type: "framework-config", framework: "vitest", path, patterns: [] };
  }
  return null;
}

/**
 * Try reading a jest config file (jest.config.ts/js/cjs/mjs/json or package.json#jest).
 * Extracts `testMatch` patterns when present.
 *
 * When `testRegex` is detected instead of `testMatch`, we return an empty-pattern
 * source that still carries framework:"jest" so the orchestrator suppresses Tier 2
 * jest defaults (the developer's explicit testRegex scope must be honoured).
 *
 * `jest.config.json` is parsed as JSON (exact schema match). JS/TS/CJS/MJS
 * variants are parsed with a permissive regex since we can't execute them.
 *
 * Fallthrough to package.json#jest only happens when NO jest.config.* file
 * exists — matching Jest's own config-resolution precedence.
 */
async function parseJestConfig(workdir: string): Promise<DetectionSource | null> {
  const candidates = ["jest.config.ts", "jest.config.js", "jest.config.cjs", "jest.config.mjs", "jest.config.json"];
  for (const name of candidates) {
    const path = `${workdir}/${name}`;
    const text = await _frameworkConfigDeps.readText(path);
    if (!text) continue;

    // jest.config.json: parse as JSON for reliable extraction
    if (name.endsWith(".json")) {
      try {
        const config = JSON.parse(text) as Record<string, unknown>;
        const patterns = extractJestPatternsFromObject(config);
        return { type: "framework-config", framework: "jest", path, patterns: normalize(patterns) };
      } catch {
        // Malformed JSON — fall through to regex extraction as a best-effort
      }
    }

    const patterns = extractJestPatterns(text);
    // Even if patterns is empty (e.g. testRegex used), claim the framework so
    // Tier 2 jest defaults are not added on top of an explicit jest config.
    return { type: "framework-config", framework: "jest", path, patterns: normalize(patterns) };
  }

  // Check package.json#jest — only reached when NO jest.config.* file was found.
  const pkgPath = `${workdir}/package.json`;
  const pkgText = await _frameworkConfigDeps.readText(pkgPath);
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText) as Record<string, unknown>;
      const jestConfig = pkg.jest as Record<string, unknown> | undefined;
      if (jestConfig) {
        const patterns = extractJestPatternsFromObject(jestConfig);
        if (patterns.length > 0) {
          return {
            type: "framework-config",
            framework: "jest",
            path: `${pkgPath}#jest`,
            patterns: normalize(patterns),
          };
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
  // testRegex present — dev configured jest explicitly but with a regex we can't
  // convert to globs. Return empty so framework tag suppresses Tier 2 defaults.
  return [];
}

function extractJestPatternsFromObject(config: Record<string, unknown>): string[] {
  const testMatch = config.testMatch;
  if (Array.isArray(testMatch)) return testMatch.filter((p): p is string => typeof p === "string");
  return [];
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
          return { type: "framework-config", framework: "mocha", path, patterns: normalize([specMatch[1]]) };
        }
        // JS/CJS found but spec is dynamic/unextractable — claim framework with empty
        // patterns so downstream callers know mocha is configured even if we can't
        // read the exact spec. Tier 2 mocha defaults fill in as an honest fallback.
        return { type: "framework-config", framework: "mocha", path, patterns: [] };
      }

      const spec = config.spec;
      const patterns = Array.isArray(spec)
        ? spec.filter((p): p is string => typeof p === "string")
        : typeof spec === "string"
          ? [spec]
          : [];

      if (patterns.length > 0) {
        return { type: "framework-config", framework: "mocha", path, patterns: normalize(patterns) };
      }
      // Parseable JSON/YAML config found but no spec field — claim framework; Tier 2 fills in.
      return { type: "framework-config", framework: "mocha", path, patterns: [] };
    } catch {
      // Parse error — skip this config file and try next candidate.
      // Do not emit a sentinel for malformed configs.
    }
  }
  return null;
}

/**
 * Parse playwright.config.* for testDir/testMatch.
 *
 * When testMatch is a RegExp literal (unextractable) or no pattern config is
 * present, returns an empty-pattern source. Tier 2 playwright defaults
 * ("**\/*.spec.*") then fill in as an honest fallback — those are exactly
 * what the playwright runtime uses when no testDir/testMatch is set.
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

    // testMatch: ['**/*.spec.ts'] — string array form only; RegExp literals are not extracted
    const testMatchMatch = text.match(/testMatch\s*:\s*\[([^\]]+)\]/s);
    if (testMatchMatch) {
      const extracted = extractStringLiterals(testMatchMatch[1]);
      patterns.push(...extracted);
    }

    if (patterns.length > 0) {
      return { type: "framework-config", framework: "playwright", path, patterns: normalize(patterns) };
    }
    // Config found but no extractable patterns (e.g. only RegExp testMatch).
    // Return empty-pattern source — Tier 2 playwright defaults (`**/*.spec.*`) will
    // fill in as an honest fallback, matching what the playwright runtime uses by default.
    return { type: "framework-config", framework: "playwright", path, patterns: [] };
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
      return { type: "framework-config", framework: "cypress", path, patterns: normalize([specMatch[1]]) };
    }

    return {
      type: "framework-config",
      framework: "cypress",
      path,
      patterns: normalize(["cypress/e2e/**/*.cy.{js,ts}"]),
    };
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
 * Parse vite.config.* for a `test: { include: [...] }` block.
 *
 * Vitest reuses Vite's config file, nesting its test config under `test`.
 * We extract the `test: {...}` block first, then pull `include` from inside
 * to avoid matching unrelated `include` keys elsewhere in the file
 * (e.g. `build.rollupOptions.include`).
 */
async function parseViteConfig(workdir: string): Promise<DetectionSource | null> {
  const candidates = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"];
  for (const name of candidates) {
    const path = `${workdir}/${name}`;
    const text = await _frameworkConfigDeps.readText(path);
    if (!text) continue;

    // Vite configs without a `test:` section aren't Vitest configs — skip.
    if (!/\btest\s*:\s*\{/.test(text)) continue;

    const testBlock = extractBalancedBlock(text, /\btest\s*:\s*\{/);
    if (testBlock) {
      const includeMatch = testBlock.match(/include\s*:\s*\[([^\]]+)\]/s);
      if (includeMatch) {
        const patterns = extractStringLiterals(includeMatch[1]);
        if (patterns.length > 0) {
          return { type: "framework-config", framework: "vitest", path, patterns: normalize(patterns) };
        }
      }
    }
    // Vite config with test: block but no extractable include — claim vitest to suppress Tier 2.
    return { type: "framework-config", framework: "vitest", path, patterns: [] };
  }
  return null;
}

/**
 * Parse bunfig.toml for `[test]` section — signals Bun test use.
 *
 * Bun test doesn't accept custom test-file patterns (the matchers are
 * hardcoded in the runtime), so we emit Bun's well-known defaults when a
 * `[test]` section is present.
 */
async function parseBunfig(workdir: string): Promise<DetectionSource | null> {
  const path = `${workdir}/bunfig.toml`;
  const text = await _frameworkConfigDeps.readText(path);
  if (!text) return null;

  try {
    const parsed = _frameworkConfigDeps.parseToml(text) as Record<string, unknown>;
    if (!parsed?.test || typeof parsed.test !== "object") return null;
  } catch {
    return null;
  }

  return {
    type: "framework-config",
    framework: "bun",
    path,
    patterns: normalize([
      "**/*.test.{ts,tsx,js,jsx,mjs,cjs}",
      "**/*_test.{ts,tsx,js,jsx,mjs,cjs}",
      "**/*.spec.{ts,tsx,js,jsx,mjs,cjs}",
      "**/*_spec.{ts,tsx,js,jsx,mjs,cjs}",
    ]),
  };
}

/**
 * Extract the first `{ ... }` block following a matching anchor regex,
 * balancing braces so nested objects don't truncate the block.
 * Returns null when no matching anchor or when braces don't balance.
 */
function extractBalancedBlock(text: string, anchor: RegExp): string | null {
  const m = text.match(anchor);
  if (!m || m.index === undefined) return null;
  // Advance to the opening `{` of the matched anchor
  const openIdx = text.indexOf("{", m.index);
  if (openIdx === -1) return null;

  let depth = 0;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(openIdx + 1, i);
    }
  }
  return null;
}

/**
 * Run all Tier 1 framework config parsers for a workdir.
 * Returns an array of DetectionSources (one per found config file).
 */
export async function detectFromFrameworkConfigs(workdir: string): Promise<DetectionSource[]> {
  const results = await Promise.all([
    parseVitestConfig(workdir),
    parseViteConfig(workdir),
    parseJestConfig(workdir),
    parseBunfig(workdir),
    parsePyprojectToml(workdir),
    parsePytestIni(workdir),
    parseMochaConfig(workdir),
    parsePlaywrightConfig(workdir),
    parseCypressConfig(workdir),
  ]);

  return results.filter((r): r is DetectionSource => r !== null);
}
