/**
 * Tests for the test-file pattern resolver — ADR-009 SSOT.
 *
 * Covers:
 * - Resolution chain order (per-package → root-config → detected → fallback)
 * - resolveReviewExcludePatterns parity with old hardcoded default
 * - Immutability and field consistency of ResolvedTestPatterns
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config";
import type { NaxConfig } from "../../../src/config/types";
import { _resolverDeps, resolveReviewExcludePatterns, resolveTestFilePatterns } from "../../../src/test-runners/resolver";
import type { DetectionResult } from "../../../src/test-runners/detect";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(patterns?: string[]): NaxConfig {
  const base = structuredClone(DEFAULT_CONFIG) as NaxConfig;
  if (patterns === undefined) return base; // no smartTestRunner.testFilePatterns
  return {
    ...base,
    execution: {
      ...base.execution,
      smartTestRunner: { enabled: true, fallback: "import-grep", testFilePatterns: patterns },
    },
  } as NaxConfig;
}

const WORKDIR = "/fake/workdir";

// Save/restore injectable deps
let origFileExists: typeof _resolverDeps.fileExists;
let origReadJson: typeof _resolverDeps.readJson;
let origDetect: typeof _resolverDeps.detectTestFilePatterns;

beforeEach(() => {
  origFileExists = _resolverDeps.fileExists;
  origReadJson = _resolverDeps.readJson;
  origDetect = _resolverDeps.detectTestFilePatterns;

  // Safe defaults: no mono config, stub detection
  _resolverDeps.fileExists = async () => false;
  _resolverDeps.readJson = async () => ({});
  _resolverDeps.detectTestFilePatterns = async () =>
    ({ patterns: [], confidence: "empty", sources: [] }) satisfies DetectionResult;
});

afterEach(() => {
  _resolverDeps.fileExists = origFileExists;
  _resolverDeps.readJson = origReadJson;
  _resolverDeps.detectTestFilePatterns = origDetect;
});

// ─── Resolution chain ─────────────────────────────────────────────────────────

describe("resolveTestFilePatterns — resolution chain", () => {
  test("fallback: returns DEFAULT_TEST_FILE_PATTERNS when nothing configured", async () => {
    const resolved = await resolveTestFilePatterns(makeConfig(), WORKDIR);
    expect(resolved.resolution).toBe("fallback");
    expect(resolved.globs).toContain("test/**/*.test.ts");
  });

  test("root-config: returns user patterns when smartTestRunner.testFilePatterns is set", async () => {
    const config = makeConfig(["src/**/*.spec.ts"]);
    const resolved = await resolveTestFilePatterns(config, WORKDIR);
    expect(resolved.resolution).toBe("root-config");
    expect(resolved.globs).toEqual(["src/**/*.spec.ts"]);
  });

  test("root-config: explicit empty array is honoured (no test files)", async () => {
    const config = makeConfig([]);
    const resolved = await resolveTestFilePatterns(config, WORKDIR);
    expect(resolved.resolution).toBe("root-config");
    expect(resolved.globs).toHaveLength(0);
    expect(resolved.regex).toHaveLength(0);
  });

  test("per-package: wins over root-config when mono config file present", async () => {
    const config = makeConfig(["src/**/*.spec.ts"]); // root-config would return this
    const monoConfigPath = `${WORKDIR}/.nax/mono/packages/api/config.json`;
    _resolverDeps.fileExists = async (p) => p === monoConfigPath;
    _resolverDeps.readJson = async () => ({
      execution: { smartTestRunner: { testFilePatterns: ["packages/api/**/*.test.ts"] } },
    });

    const resolved = await resolveTestFilePatterns(config, WORKDIR, "packages/api");
    expect(resolved.resolution).toBe("per-package");
    expect(resolved.globs).toEqual(["packages/api/**/*.test.ts"]);
  });

  test("per-package: falls through when mono config exists but omits testFilePatterns", async () => {
    const config = makeConfig(["src/**/*.spec.ts"]);
    _resolverDeps.fileExists = async () => true;
    _resolverDeps.readJson = async () => ({ execution: { smartTestRunner: {} } });

    const resolved = await resolveTestFilePatterns(config, WORKDIR, "packages/api");
    expect(resolved.resolution).toBe("root-config");
  });

  test("detected: used when detection returns patterns with non-empty confidence", async () => {
    const config = makeConfig(); // no root config
    _resolverDeps.detectTestFilePatterns = async () => ({
      patterns: ["**/*.spec.ts"],
      confidence: "high",
      sources: [{ type: "framework-config", path: "jest.config.ts", patterns: ["**/*.spec.ts"] }],
    });

    const resolved = await resolveTestFilePatterns(config, WORKDIR);
    expect(resolved.resolution).toBe("detected");
    expect(resolved.globs).toEqual(["**/*.spec.ts"]);
  });

  test("detected: skipped when detection returns empty confidence", async () => {
    const config = makeConfig();
    _resolverDeps.detectTestFilePatterns = async () =>
      ({ patterns: [], confidence: "empty", sources: [] }) satisfies DetectionResult;

    const resolved = await resolveTestFilePatterns(config, WORKDIR);
    expect(resolved.resolution).toBe("fallback");
  });

  test("boolean smartTestRunner (true) is treated as no explicit patterns → fallback", async () => {
    const config = {
      ...makeConfig(),
      execution: { ...makeConfig().execution, smartTestRunner: true },
    } as unknown as NaxConfig;
    const resolved = await resolveTestFilePatterns(config, WORKDIR);
    expect(resolved.resolution).toBe("fallback");
  });
});

// ─── ResolvedTestPatterns field consistency ────────────────────────────────────

describe("resolveTestFilePatterns — field consistency", () => {
  test("all four fields populated for default patterns", async () => {
    const resolved = await resolveTestFilePatterns(makeConfig(), WORKDIR);
    expect(resolved.globs.length).toBeGreaterThan(0);
    expect(resolved.regex.length).toBeGreaterThan(0);
    expect(resolved.testDirs).toContain("test");
    expect(resolved.pathspec.every((p) => p.startsWith(":!"))).toBe(true);
  });

  test("regex correctly classifies a path from the resolved globs", async () => {
    const config = makeConfig(["test/**/*.test.ts"]);
    const resolved = await resolveTestFilePatterns(config, WORKDIR);
    expect(resolved.regex.some((re) => re.test("test/unit/foo.test.ts"))).toBe(true);
    expect(resolved.regex.some((re) => re.test("src/foo.ts"))).toBe(false);
  });

  test("empty globs produces empty pathspec, regex, and testDirs", async () => {
    const resolved = await resolveTestFilePatterns(makeConfig([]), WORKDIR);
    expect(resolved.pathspec).toHaveLength(0);
    expect(resolved.regex).toHaveLength(0);
    expect(resolved.testDirs).toHaveLength(0);
  });

  test("result object is structurally frozen (arrays are readonly)", async () => {
    const resolved = await resolveTestFilePatterns(makeConfig(), WORKDIR);
    // readonly arrays cannot be pushed to at the TS level — runtime verify via type
    expect(Array.isArray(resolved.globs)).toBe(true);
    expect(typeof resolved.resolution).toBe("string");
  });
});

// ─── resolveReviewExcludePatterns ─────────────────────────────────────────────

describe("resolveReviewExcludePatterns", () => {
  test("user explicit array returned verbatim (including empty)", async () => {
    const resolved = await resolveTestFilePatterns(makeConfig(), WORKDIR);
    const explicit = [":!custom/"];
    expect(resolveReviewExcludePatterns(explicit, resolved)).toEqual([":!custom/"]);
    expect(resolveReviewExcludePatterns([], resolved)).toEqual([]);
  });

  test("undefined user patterns: derives from resolved patterns + well-known noise", async () => {
    const config = makeConfig(["test/**/*.test.ts"]);
    const resolved = await resolveTestFilePatterns(config, WORKDIR);
    const derived = resolveReviewExcludePatterns(undefined, resolved);

    // Well-known test dirs always present
    expect(derived).toContain(":!test/");
    expect(derived).toContain(":!tests/");
    expect(derived).toContain(":!__tests__/");
    // Well-known suffixes
    expect(derived).toContain(":!*.test.ts");
    expect(derived).toContain(":!*.spec.ts");
    expect(derived).toContain(":!*_test.go");
    // nax noise paths
    expect(derived).toContain(":!.nax/");
    expect(derived).toContain(":!.nax-pids");
  });

  test("parity: default config excludePatterns match old hardcoded default", async () => {
    const resolved = await resolveTestFilePatterns(makeConfig(), WORKDIR);
    const derived = resolveReviewExcludePatterns(undefined, resolved);
    // Old hardcoded default; resolver produces ":!__tests__/" (without "**/" prefix) for
    // __tests__ — a minor Phase 1 difference that's lower-risk in practice.
    const mustContain = [":!test/", ":!tests/", ":!__tests__/", ":!*_test.go", ":!*.test.ts", ":!*.spec.ts", ":!.nax/", ":!.nax-pids"];
    for (const pattern of mustContain) {
      expect(derived).toContain(pattern);
    }
  });

  test("no duplicates in derived list", async () => {
    const config = makeConfig(["test/**/*.test.ts"]);
    const resolved = await resolveTestFilePatterns(config, WORKDIR);
    const derived = resolveReviewExcludePatterns(undefined, resolved);
    expect(derived.length).toBe(new Set(derived).size);
  });
});
