/**
 * CodeNeighborProvider — unit tests
 *
 * All filesystem I/O is intercepted via _codeNeighborDeps injection.
 * No real files are read.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { CodeNeighborProvider, _codeNeighborDeps } from "../../../../../src/context/engine/providers/code-neighbor";
import type { CodeNeighborProviderOptions } from "../../../../../src/context/engine/providers/code-neighbor";
import type { ContextRequest } from "../../../../../src/context/engine/types";
import type { NaxIgnoreMatcher, NaxIgnoreIndex } from "../../../../../src/utils/path-filters";
import type { ResolvedTestPatterns } from "../../../../../src/test-runners/resolver";
import { extractTestDirs, globsToPathspec, globsToTestRegex } from "../../../../../src/test-runners/conventions";
import { cleanupTempDir, makeTempDir } from "../../../../helpers/temp";

/**
 * Build a ResolvedTestPatterns value from test-file globs.
 * Mirrors what resolveTestFilePatterns() produces via buildResolved() — keeps
 * the test setup honest and consistent with the production SSOT path (ADR-009).
 */
function makePatterns(globs: readonly string[]): ResolvedTestPatterns {
  return {
    globs,
    pathspec: globsToPathspec(globs),
    regex: globsToTestRegex(globs),
    testDirs: extractTestDirs(globs),
    resolution: "root-config",
  };
}

/** Default pattern used by most tests: `test/unit/<name>.test.ts` mirrored layout. */
const DEFAULT_TEST_PATTERNS = makePatterns(["test/unit/**/*.test.ts"]);

// ─────────────────────────────────────────────────────────────────────────────
// Saved originals
// ─────────────────────────────────────────────────────────────────────────────

let origFileExists: typeof _codeNeighborDeps.fileExists;
let origReadFile: typeof _codeNeighborDeps.readFile;
let origGlob: typeof _codeNeighborDeps.glob;
let origDiscoverWorkspacePackages: typeof _codeNeighborDeps.discoverWorkspacePackages;
let origDetectLanguage: typeof _codeNeighborDeps.detectLanguage;

beforeEach(() => {
  origFileExists = _codeNeighborDeps.fileExists;
  origReadFile = _codeNeighborDeps.readFile;
  origGlob = _codeNeighborDeps.glob;
  origDiscoverWorkspacePackages = _codeNeighborDeps.discoverWorkspacePackages;
  origDetectLanguage = _codeNeighborDeps.detectLanguage;
  // Default: no workspace packages (non-monorepo fallback)
  _codeNeighborDeps.discoverWorkspacePackages = async () => [];
});

afterEach(() => {
  _codeNeighborDeps.fileExists = origFileExists;
  _codeNeighborDeps.readFile = origReadFile;
  _codeNeighborDeps.glob = origGlob;
  _codeNeighborDeps.discoverWorkspacePackages = origDiscoverWorkspacePackages;
  _codeNeighborDeps.detectLanguage = origDetectLanguage;
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeRequest(overrides: Partial<ContextRequest> = {}): ContextRequest {
  return {
    storyId: "US-001",
    repoRoot: "/repo",
    packageDir: "/repo",
    stage: "execution",
    role: "implementer",
    budgetTokens: 8_000,
    resolvedTestPatterns: DEFAULT_TEST_PATTERNS,
    ...overrides,
  };
}

function setupDeps(options: {
  files?: Record<string, string>;
  globFiles?: string[];
}) {
  const { files = {}, globFiles = [] } = options;
  _codeNeighborDeps.fileExists = async (path: string) => {
    const rel = path.replace("/repo/", "");
    return rel in files;
  };
  _codeNeighborDeps.readFile = async (path: string) => {
    const rel = path.replace("/repo/", "");
    return files[rel] ?? "";
  };
  _codeNeighborDeps.glob = (_pattern: string, _cwd: string) => ({ files: globFiles, truncated: false });
  _codeNeighborDeps.detectLanguage = async () => undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("CodeNeighborProvider", () => {
  const provider = new CodeNeighborProvider();

  test.each([
    ["touchedFiles is absent", () => makeRequest()],
    ["touchedFiles is empty array", () => makeRequest({ touchedFiles: [] })],
  ])("returns empty when %s", async (_label, makeReq) => {
    setupDeps({});
    const result = await provider.fetch(makeReq());
    expect(result.chunks).toHaveLength(0);
  });

  test("returns empty for non-src files (scripts/) and for test files themselves", async () => {
    setupDeps({ globFiles: [] });
    expect((await provider.fetch(makeRequest({ touchedFiles: ["scripts/build.ts"] }))).chunks).toHaveLength(0);
    setupDeps({ files: { "test/unit/foo.test.ts": "" }, globFiles: [] });
    expect((await provider.fetch(makeRequest({ touchedFiles: ["test/unit/foo.test.ts"] }))).chunks).toHaveLength(0);
  });

  test("includes sibling test for src/ files regardless of disk existence", async () => {
    setupDeps({ globFiles: [] });
    const r1 = await provider.fetch(makeRequest({ touchedFiles: ["src/missing.ts"] }));
    expect(r1.chunks).toHaveLength(1);
    expect(r1.chunks[0]?.content).toContain("test/unit/missing.test.ts");

    setupDeps({ files: { "src/foo/bar.ts": 'import "./dep"' }, globFiles: [] });
    const r2 = await provider.fetch(makeRequest({ touchedFiles: ["src/foo/bar.ts"] }));
    expect(r2.chunks).toHaveLength(1);
    expect(r2.chunks[0]?.content).toContain("test/unit/foo/bar.test.ts");
  });

  test("chunk has expected metadata", async () => {
    setupDeps({ files: { "src/a.ts": "" }, globFiles: [] });
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/a.ts"] }));
    expect(result.chunks[0]?.kind).toBe("neighbor");
    expect(result.chunks[0]?.scope).toBe("story");
    expect(result.chunks[0]?.role).toContain("implementer");
    expect(result.chunks[0]?.role).toContain("tdd");
    expect(result.chunks[0]?.rawScore).toBe(0.65);
  });

  test("includes forward deps (imports) and reverse deps (importers of touched file)", async () => {
    setupDeps({
      files: { "src/service.ts": 'import { helper } from "./utils/helper"', "src/utils/helper.ts": "export const helper = () => {}" },
      globFiles: [],
    });
    expect((await provider.fetch(makeRequest({ touchedFiles: ["src/service.ts"] }))).chunks[0]?.content ?? "").toContain("src/utils/helper");

    setupDeps({
      files: { "src/utils/helper.ts": "", "src/service.ts": 'import { helper } from "./utils/helper"' },
      globFiles: ["src/service.ts"],
    });
    expect((await provider.fetch(makeRequest({ touchedFiles: ["src/utils/helper.ts"] }))).chunks[0]?.content ?? "").toContain("src/service.ts");
  });

  test("reverse deps are not starved when forward deps alone reach MAX_NEIGHBORS_PER_FILE (#1611)", async () => {
    // 8 forward deps (own file's imports) — meets MAX_NEIGHBORS_PER_FILE on their own.
    const forwardDeps = Array.from({ length: 8 }, (_, i) => `./dep${i}`);
    const serviceContent = forwardDeps.map((d) => `import "${d}"`).join("\n");
    const files: Record<string, string> = { "src/service.ts": serviceContent };
    for (let i = 0; i < 8; i++) files[`src/dep${i}.ts`] = "";
    files["src/consumer.ts"] = 'import "./service"';

    setupDeps({ files, globFiles: ["src/consumer.ts"] });
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/service.ts"] }));
    const content = result.chunks[0]?.content ?? "";
    expect(content).toContain("src/consumer.ts");
  });

  test("reverse deps backfill unused forward slots past their guaranteed minimum (#1611)", async () => {
    // 1 forward dep leaves 7 slots free; 6 reverse-dep consumers should all
    // appear, not just the 4-slot minimum reserved for reverse deps.
    const consumers = Array.from({ length: 6 }, (_, i) => `src/consumer${i}.ts`);
    const files: Record<string, string> = {
      "src/service.ts": 'import "./dep0"',
      "src/dep0.ts": "",
    };
    for (const c of consumers) files[c] = 'import "./service"';

    setupDeps({ files, globFiles: consumers });
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/service.ts"] }));
    const content = result.chunks[0]?.content ?? "";
    for (const c of consumers) expect(content).toContain(c);
  });

  test("combines neighbors from multiple files into one chunk", async () => {
    setupDeps({
      files: { "src/a.ts": "", "src/b.ts": "" },
      globFiles: [],
    });
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/a.ts", "src/b.ts"] }));
    expect(result.chunks).toHaveLength(1);
    const content = result.chunks[0]?.content ?? "";
    expect(content).toContain("src/a.ts");
    expect(content).toContain("src/b.ts");
  });

  test("chunk tokens = ceil(content.length/4); pullTools empty; content capped at MAX_CHUNK_TOKENS*4", async () => {
    setupDeps({ files: { "src/a.ts": "" }, globFiles: [] });
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/a.ts"] }));
    const chunk = result.chunks[0]!;
    expect(chunk.tokens).toBe(Math.ceil(chunk.content.length / 4));
    expect(result.pullTools).toEqual([]);

    const manyFiles = Array.from({ length: 10 }, (_, i) => `src/file${i}.ts`);
    const fileMap: Record<string, string> = {};
    for (const f of manyFiles) fileMap[f] = "";
    setupDeps({ files: fileMap, globFiles: [] });
    const r2 = await provider.fetch(makeRequest({ touchedFiles: manyFiles }));
    if (r2.chunks[0]) {
      expect(r2.chunks[0].content.length).toBeLessThanOrEqual(500 * 4);
      expect(r2.chunks[0].tokens).toBe(Math.ceil(r2.chunks[0].content.length / 4));
    }
  });

  test.each([
    ["test", "src/greeting.test.ts", "greeting.test.test.ts", ".test.test."],
    ["spec", "src/greeting.spec.ts", "greeting.spec.spec.ts", ".spec.spec."],
  ])("sibling test path: .%s.ts input does not hallucinate doubled suffix (#526)", async (_kind, file, bad1, bad2) => {
    setupDeps({ files: { [file]: "" }, globFiles: [] });
    const result = await provider.fetch(makeRequest({ touchedFiles: [file] }));
    const content = result.chunks[0]?.content ?? "";
    expect(content).not.toContain(bad1);
    expect(content).not.toContain(bad2);
  });

  test("sibling test path: .test.tsx / .spec.tsx also guarded (#526)", async () => {
    setupDeps({
      files: {
        "src/components/Button.test.tsx": "",
        "src/components/Button.spec.jsx": "",
      },
      globFiles: [],
    });
    const r1 = await provider.fetch(makeRequest({ touchedFiles: ["src/components/Button.test.tsx"] }));
    const r2 = await provider.fetch(makeRequest({ touchedFiles: ["src/components/Button.spec.jsx"] }));
    expect(r1.chunks[0]?.content ?? "").not.toContain("Button.test.test.");
    expect(r2.chunks[0]?.content ?? "").not.toContain("Button.spec.spec.");
  });

  test(".tsx file sibling maps to .test.tsx not .test.ts", async () => {
    setupDeps({ files: { "src/components/Button.tsx": "" }, globFiles: [] });
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/components/Button.tsx"] }));
    const content = result.chunks[0]?.content ?? "";
    expect(content).toContain("test/unit/components/Button.test.tsx");
    expect(content).not.toContain("Button.test.ts\n");
  });

  // ───────── ADR-009 compliance — resolver-driven sibling-test derivation ────────

  test("no sibling-test hint when resolvedTestPatterns is absent on request (ADR-009)", async () => {
    // When the caller has not threaded the resolver output, providers must NOT
    // fall back to hardcoded test/unit/ + .test.ts assumptions (#526 ADR-009).
    setupDeps({ globFiles: [] });
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/missing.ts"], resolvedTestPatterns: undefined }));
    expect(result.chunks).toHaveLength(0);
  });

  test("colocated test preferred when on disk; falls back to mirrored hint when absent (#526 Bug 2)", async () => {
    setupDeps({ files: { "src/calc.ts": "", "src/calc.test.ts": "" }, globFiles: [] });
    const colocated = await provider.fetch(makeRequest({ touchedFiles: ["src/calc.ts"], resolvedTestPatterns: makePatterns(["**/*.test.ts"]) }));
    const c1 = colocated.chunks[0]?.content ?? "";
    expect(c1).toContain("src/calc.test.ts");
    expect(c1).not.toContain("test/unit/");

    setupDeps({ files: { "src/calc.ts": "" }, globFiles: [] });
    const mirrored = await provider.fetch(makeRequest({ touchedFiles: ["src/calc.ts"], resolvedTestPatterns: makePatterns(["test/unit/**/*.test.ts"]) }));
    expect(mirrored.chunks[0]?.content ?? "").toContain("test/unit/calc.test.ts");
  });

  test("Go pattern: src/foo.go → src/foo_test.go; src/foo_test.go does not hallucinate _test_test.go (#526 Bug 1)", async () => {
    setupDeps({ files: { "src/foo.go": "", "src/foo_test.go": "" }, globFiles: [] });
    const r1 = await provider.fetch(makeRequest({
      touchedFiles: ["src/foo.go"],
      resolvedTestPatterns: makePatterns(["**/*_test.go"]),
    }));
    expect(r1.chunks[0]?.content ?? "").toContain("src/foo_test.go");
    expect(r1.chunks[0]?.content ?? "").not.toContain(".test.ts");

    setupDeps({ files: { "src/foo_test.go": "" }, globFiles: [] });
    const r2 = await provider.fetch(makeRequest({
      touchedFiles: ["src/foo_test.go"],
      resolvedTestPatterns: makePatterns(["**/*_test.go"]),
    }));
    expect(r2.chunks[0]?.content ?? "").not.toContain("_test_test.go");
  });

  test("monorepo-tiny: colocated test wins; mirrored hint preserves package prefix when absent", async () => {
    setupDeps({ files: { "packages/lib/src/util.ts": "", "packages/lib/src/util.test.ts": "" }, globFiles: [] });
    const colocated = await provider.fetch(makeRequest({ touchedFiles: ["packages/lib/src/util.ts"], resolvedTestPatterns: makePatterns(["**/*.test.ts"]) }));
    const c1 = colocated.chunks[0]?.content ?? "";
    expect(c1).toContain("packages/lib/src/util.test.ts");
    expect(c1).not.toContain("test/unit/");

    setupDeps({ files: { "packages/lib/src/util.ts": "" }, globFiles: [] });
    const mirrored = await provider.fetch(makeRequest({ touchedFiles: ["packages/lib/src/util.ts"], resolvedTestPatterns: makePatterns(["test/unit/**/*.test.ts"]) }));
    expect(mirrored.chunks[0]?.content ?? "").toContain("packages/lib/test/unit/util.test.ts");
  });

  test("self-reference: reverse-dep scan continues past self; self not listed as neighbor", async () => {
    setupDeps({
      files: {
        "src/utils/target.ts": "",
        "src/service.ts": 'import { x } from "./utils/target"',
      },
      globFiles: ["src/utils/target.ts", "src/service.ts"],
    });
    const r1 = await provider.fetch(makeRequest({ touchedFiles: ["src/utils/target.ts"] }));
    expect(r1.chunks[0]?.content ?? "").toContain("src/service.ts");

    setupDeps({ files: { "src/a.ts": 'import "./a"' }, globFiles: [] });
    const r2 = await provider.fetch(makeRequest({ touchedFiles: ["src/a.ts"] }));
    const neighborLines = (r2.chunks[0]?.content ?? "").split("\n").filter((l) => l.startsWith("- "));
    for (const line of neighborLines) {
      expect(line).not.toBe("- src/a.ts");
    }
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// AC-56 + AC-62: neighborScope and crossPackageDepth options
// ─────────────────────────────────────────────────────────────────────────────

describe("CodeNeighborProvider — AC-56/AC-62 neighborScope + crossPackageDepth", () => {
  const MONOREPO_REQUEST: ContextRequest = {
    storyId: "US-002",
    repoRoot: "/repo",
    packageDir: "/repo/packages/api",
    stage: "execution",
    role: "implementer",
    budgetTokens: 8_000,
    touchedFiles: ["src/service.ts"],
  };

  /** Captures which cwds were passed to glob */
  function captureGlobCwds(): string[] {
    const captured: string[] = [];
    _codeNeighborDeps.glob = (_pattern: string, cwd: string) => {
      captured.push(cwd);
      return { files: [], truncated: false };
    };
    _codeNeighborDeps.fileExists = async () => false;
    _codeNeighborDeps.readFile = async () => "";
    return captured;
  }

  test("neighborScope controls which dirs glob runs in (default, repo, package+crossPackageDepth=0)", async () => {
    // default: package scope with crossPackageDepth=1 → runs in packageDir AND repoRoot
    const cwds1 = captureGlobCwds();
    await new CodeNeighborProvider().fetch(MONOREPO_REQUEST);
    expect(cwds1).toContain("/repo/packages/api");
    expect(cwds1).toContain("/repo");

    // repo scope → only repoRoot
    const cwds2 = captureGlobCwds();
    await new CodeNeighborProvider({ neighborScope: "repo" } as CodeNeighborProviderOptions).fetch(MONOREPO_REQUEST);
    expect(cwds2).toContain("/repo");
    expect(cwds2).not.toContain("/repo/packages/api");

    // package scope crossPackageDepth=0 → only packageDir
    const cwds3 = captureGlobCwds();
    await new CodeNeighborProvider({ neighborScope: "package", crossPackageDepth: 0 } as CodeNeighborProviderOptions).fetch(MONOREPO_REQUEST);
    expect(cwds3).toContain("/repo/packages/api");
    expect(cwds3.filter((c) => c === "/repo/packages/api")).toHaveLength(1);
    expect(cwds3).not.toContain("/repo");
  });

  test("non-monorepo (packageDir === repoRoot): default scope uses repoRoot; crossPackageDepth 1 does not duplicate cross-package scan", async () => {
    const cwds1 = captureGlobCwds();
    const p1 = new CodeNeighborProvider({ neighborScope: "package" } as CodeNeighborProviderOptions);
    await p1.fetch(makeRequest({ touchedFiles: ["src/a.ts"] }));
    expect(cwds1).toContain("/repo");

    const cwds2 = captureGlobCwds();
    const p2 = new CodeNeighborProvider({ neighborScope: "package", crossPackageDepth: 1 } as CodeNeighborProviderOptions);
    await p2.fetch(makeRequest({ touchedFiles: ["src/a.ts"] }));
    expect(cwds2.filter((c) => c === "/repo")).toHaveLength(1);
  });

  test("crossPackageDepth 1: falls back to repoRoot when no workspace; scans detected packages otherwise", async () => {
    const cwds1 = captureGlobCwds();
    const p1 = new CodeNeighborProvider({ neighborScope: "package", crossPackageDepth: 1 } as CodeNeighborProviderOptions);
    await p1.fetch(MONOREPO_REQUEST);
    expect(cwds1).toContain("/repo/packages/api");
    expect(cwds1).toContain("/repo");

    const cwds2 = captureGlobCwds();
    _codeNeighborDeps.discoverWorkspacePackages = async () => ["packages/api", "packages/web"];
    const p2 = new CodeNeighborProvider({ neighborScope: "package", crossPackageDepth: 1 } as CodeNeighborProviderOptions);
    await p2.fetch(MONOREPO_REQUEST);
    expect(cwds2).toContain("/repo/packages/api");
    expect(cwds2).toContain("/repo/packages/web");
    expect(cwds2).not.toContain("/repo");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SEC-503: path traversal prevention
// ─────────────────────────────────────────────────────────────────────────────

describe("CodeNeighborProvider — SEC-503 path traversal prevention", () => {
  test.each([
    ["dotdot traversal", "../../../etc/passwd"],
    ["absolute path", "/etc/passwd"],
  ])("drops touchedFiles with %s — never reads them", async (_label, malicious) => {
    const readPaths: string[] = [];
    _codeNeighborDeps.fileExists = async (rp: string) => { readPaths.push(rp); return false; };
    _codeNeighborDeps.glob = () => ({ files: [], truncated: false });

    const p = new CodeNeighborProvider();
    await p.fetch(makeRequest({ touchedFiles: [malicious, "src/valid.ts"] }));

    expect(readPaths.some((rp) => rp.includes("etc/passwd"))).toBe(false);
  });

  test("still processes safe files when unsafe ones are present", async () => {
    const readPaths: string[] = [];
    _codeNeighborDeps.fileExists = async (p: string) => {
      readPaths.push(p);
      return true;
    };
    _codeNeighborDeps.readFile = async () => "";
    _codeNeighborDeps.glob = () => ({ files: [], truncated: false });

    const p = new CodeNeighborProvider();
    await p.fetch(makeRequest({ touchedFiles: ["../evil", "src/valid.ts"] }));

    expect(readPaths.some((rp) => rp.includes("valid.ts"))).toBe(true);
    expect(readPaths.some((rp) => rp.includes("evil"))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #508-M11: debug log when glob cap (MAX_GLOB_FILES=200) is reached
// ─────────────────────────────────────────────────────────────────────────────

describe("CodeNeighborProvider — #508-M11 glob cap debug logging", () => {
  let tmpDir: string;
  let origGetLogger: typeof _codeNeighborDeps.getLogger;

  beforeAll(() => {
    tmpDir = makeTempDir("nax-test-");
    const srcDir = join(tmpDir, "src");
    mkdirSync(srcDir, { recursive: true });
    // Create 201 files to exceed the 200-file cap
    for (let i = 0; i < 201; i++) {
      writeFileSync(join(srcDir, `file${i}.ts`), "");
    }
  });

  afterAll(() => {
    cleanupTempDir(tmpDir);
  });

  beforeEach(() => {
    origGetLogger = _codeNeighborDeps.getLogger;
  });

  afterEach(() => {
    _codeNeighborDeps.getLogger = origGetLogger;
  });

  test("logs warn when glob truncated at cap; no warn when below cap", () => {
    let warnCalls: Array<[string, string, Record<string, unknown>]> = [];
    _codeNeighborDeps.getLogger = () =>
      ({
        debug: () => {},
        warn: (stage: string, msg: string, ctx: Record<string, unknown>) => warnCalls.push([stage, msg, ctx]),
        info: () => {},
        error: () => {},
      }) as unknown as ReturnType<typeof _codeNeighborDeps.getLogger>;

    const { files, truncated } = _codeNeighborDeps.glob("src/**/*.ts", tmpDir, [], 200);
    expect(files).toHaveLength(200);
    expect(truncated).toBe(true);
    expect(warnCalls.length).toBeGreaterThan(0);
    expect(warnCalls[0]?.[0]).toBe("context-v2");
    expect(warnCalls[0]?.[2]).toMatchObject({ cap: 200 });

    warnCalls = [];
    const { files: files2, truncated: truncated2 } = _codeNeighborDeps.glob("src/file0.ts", tmpDir, [], 500);
    expect(files2.length).toBeLessThan(200);
    expect(truncated2).toBe(false);
    expect(warnCalls.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Glob source exclusions: node_modules, .nax, nested .nax, naxIgnoreIndex
// ─────────────────────────────────────────────────────────────────────────────

describe("CodeNeighborProvider — glob source file exclusions", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = makeTempDir("nax-glob-excl-");
    // Excluded dirs
    mkdirSync(join(tmpDir, "node_modules", "lodash"), { recursive: true });
    writeFileSync(join(tmpDir, "node_modules", "lodash", "index.ts"), "");
    mkdirSync(join(tmpDir, ".nax"), { recursive: true });
    writeFileSync(join(tmpDir, ".nax", "setup.ts"), "");
    mkdirSync(join(tmpDir, "packages", "api", ".nax"), { recursive: true });
    writeFileSync(join(tmpDir, "packages", "api", ".nax", "config.ts"), "");
    // Real source files in non-src/ layouts
    mkdirSync(join(tmpDir, "lib"), { recursive: true });
    writeFileSync(join(tmpDir, "lib", "utils.ts"), "");
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "main.ts"), "");
  });

  afterAll(() => {
    cleanupTempDir(tmpDir);
  });

  test("excludes node_modules/.nax/nested-.nax from glob; respects naxIgnoreIndex matchers", () => {
    const { files } = _codeNeighborDeps.glob("**/*.ts", tmpDir);
    expect(files.some((f) => f.startsWith("node_modules/"))).toBe(false);
    expect(files.some((f) => f.startsWith(".nax/"))).toBe(false);
    expect(files.some((f) => f.includes("/.nax/"))).toBe(false);
    expect(files).toContain("lib/utils.ts");
    expect(files).toContain("src/main.ts");

    const nmDir = join(tmpDir, "node_modules", "bigpkg");
    mkdirSync(nmDir, { recursive: true });
    for (let i = 0; i < 205; i++) writeFileSync(join(nmDir, `mod${i}.ts`), "");
    const { files: files2 } = _codeNeighborDeps.glob("**/*.ts", tmpDir);
    expect(files2).toContain("lib/utils.ts");
    expect(files2.some((f) => f.startsWith("node_modules/"))).toBe(false);

    const matcher: NaxIgnoreMatcher = { source: "root", pattern: "lib/**", test: (p: string) => p.startsWith("lib/") };
    const { files: files3 } = _codeNeighborDeps.glob("**/*.ts", tmpDir, [matcher]);
    expect(files3.some((f) => f.startsWith("lib/"))).toBe(false);
    expect(files3).toContain("src/main.ts");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-002 — scope attribution: chunk.scopePaths lists each analysed file plus
// each rendered neighbor path (AC1/AC2/AC3/AC4). The chunk-assembly logic
// lives in `code-neighbor-chunk.ts`; these tests cover the provider
// integration that threads scope attribution through `fetch()`.
// ─────────────────────────────────────────────────────────────────────────────

describe("CodeNeighborProvider — US-002 scope attribution", () => {
  const provider = new CodeNeighborProvider();

  test("[AC1] scopePaths contains the touched file path when one file has neighbors", async () => {
    setupDeps({ files: { "src/foo.ts": "" }, globFiles: [] });
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/foo.ts"] }));
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.scopePaths).toBeDefined();
    expect(result.chunks[0]?.scopePaths).toContain("src/foo.ts");
  });

  test("[AC2] scopePaths contains each neighbor path rendered in the chunk body", async () => {
    // Forward dep to src/foo/dep.ts, plus the mirrored sibling test hint
    // test/unit/foo.test.ts. The sibling-test hint lands in neighbors via
    // the resolver, so both are included.
    setupDeps({
      files: { "src/foo.ts": 'import { dep } from "./foo/dep"' },
      globFiles: [],
    });
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/foo.ts"] }));
    expect(result.chunks).toHaveLength(1);

    const scope = result.chunks[0]?.scopePaths;
    const body = result.chunks[0]?.content ?? "";

    // AC2 contract: scopePaths is populated AND contains every neighbor
    // path rendered in the chunk body.
    expect(scope).toBeDefined();
    expect(scope!.length).toBeGreaterThan(0);
    // Forward dep rendered in the body must be in scopePaths.
    expect(scope!).toContain("src/foo/dep.ts");
    // Sibling test hint rendered in the body must also be in scopePaths.
    expect(scope!).toContain("test/unit/foo.test.ts");
    // Touched file is in scopePaths.
    expect(scope!).toContain("src/foo.ts");
    // Every entry in scopePaths appears in the body (no orphan scopes).
    for (const neighbor of scope!) {
      expect(body).toContain(neighbor);
    }
  });

  test("[AC3] returns empty chunks list when touched files have no neighbors", async () => {
    // Test files are dropped (sibling-test derivation returns [] for them)
    // — and there are no reverse-deps or forward-deps.
    setupDeps({ globFiles: [] });
    const result = await provider.fetch(
      makeRequest({ touchedFiles: ["test/unit/existing.test.ts"] }),
    );
    expect(result.chunks).toHaveLength(0);
  });

  test("[AC4] shared neighbor across two touched files appears exactly once in scopePaths", async () => {
    // src/foo.ts and src/bar.ts both import the same dep — the chunk
    // renders two sections but scopePaths must dedupe the shared neighbor.
    setupDeps({
      files: {
        "src/foo.ts": 'import { shared } from "./shared"',
        "src/bar.ts": 'import { shared } from "./shared"',
      },
      globFiles: [],
    });
    const result = await provider.fetch(
      makeRequest({ touchedFiles: ["src/foo.ts", "src/bar.ts"] }),
    );
    expect(result.chunks).toHaveLength(1);

    const scope = result.chunks[0]?.scopePaths ?? [];
    const sharedOccurrences = scope.filter((p) => p === "src/shared.ts").length;
    expect(sharedOccurrences).toBe(1);

    // Both touched files are still present in scopePaths.
    expect(scope).toContain("src/foo.ts");
    expect(scope).toContain("src/bar.ts");
  });

  test("[AC4] chunk.id remains code-neighbor:<hash> with scopePaths attached", async () => {
    setupDeps({ files: { "src/foo.ts": "" }, globFiles: [] });
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/foo.ts"] }));
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.id).toMatch(/^code-neighbor:[0-9a-f]{8}$/);
    expect(result.chunks[0]?.scopePaths).toBeDefined();
    expect(result.chunks[0]?.scopePaths!.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// naxIgnoreIndex threading: ContextRequest → collectNeighbors → glob dep
// ─────────────────────────────────────────────────────────────────────────────

describe("CodeNeighborProvider — naxIgnoreIndex threaded through fetch", () => {
  test("passes naxIgnoreIndex matchers to glob dep", async () => {
    let capturedMatchers: readonly NaxIgnoreMatcher[] | undefined;
    _codeNeighborDeps.glob = (_pattern, _cwd, ignoreMatchers) => {
      capturedMatchers = ignoreMatchers;
      return { files: [], truncated: false };
    };

    const matcher: NaxIgnoreMatcher = {
      source: "root",
      pattern: "generated/**",
      test: (p: string) => p.startsWith("generated/"),
    };
    const mockIndex: NaxIgnoreIndex = {
      repoRoot: "/repo",
      getMatchers: () => [matcher],
      filter: (paths) => [...paths],
      toPathspecExcludes: () => [],
    };

    const p = new CodeNeighborProvider();
    await p.fetch(
      makeRequest({
        touchedFiles: ["src/foo.ts"],
        naxIgnoreIndex: mockIndex,
      }),
    );

    expect(capturedMatchers).toBeDefined();
    expect(capturedMatchers).toEqual([matcher]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PERF-2: cooperative cancellation — an aborted fetch must stop doing work
// ─────────────────────────────────────────────────────────────────────────────

describe("CodeNeighborProvider — cooperative cancellation (PERF-2)", () => {
  test("an already-aborted signal skips per-file neighbor collection entirely", async () => {
    let readCalls = 0;
    _codeNeighborDeps.fileExists = async () => {
      readCalls++;
      return true;
    };
    _codeNeighborDeps.readFile = async () => {
      readCalls++;
      return 'import "./dep"';
    };
    _codeNeighborDeps.glob = () => ({ files: ["src/a.ts", "src/b.ts"], truncated: false });
    _codeNeighborDeps.detectLanguage = async () => undefined;

    const controller = new AbortController();
    controller.abort();

    const p = new CodeNeighborProvider();
    const result = await p.fetch(
      makeRequest({ touchedFiles: ["src/foo.ts", "src/bar.ts"] }),
      controller.signal,
    );

    // The fetch must bail out before reading any file or scanning neighbors.
    expect(result.chunks).toHaveLength(0);
    expect(readCalls).toBe(0);
  });

  test("an abort mid-fetch stops further per-file processing", async () => {
    const reads: string[] = [];
    let abortAfterFirst = false;
    const controller = new AbortController();

    _codeNeighborDeps.fileExists = async () => true;
    _codeNeighborDeps.readFile = async (path: string) => {
      reads.push(path);
      if (abortAfterFirst) controller.abort();
      abortAfterFirst = true;
      return 'import "./dep"';
    };
    _codeNeighborDeps.glob = () => ({ files: [], truncated: false });
    _codeNeighborDeps.detectLanguage = async () => undefined;

    const p = new CodeNeighborProvider();
    await p.fetch(
      makeRequest({ touchedFiles: ["src/foo.ts", "src/bar.ts", "src/baz.ts"] }),
      controller.signal,
    );

    // After the first file triggers the abort, no further files are processed.
    expect(reads.length).toBeLessThan(3);
  });
});

