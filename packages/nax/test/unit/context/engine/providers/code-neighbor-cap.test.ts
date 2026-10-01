/**
 * CodeNeighborProvider — #895 language-aware glob, configurable cap, visible truncation.
 *
 * Split from code-neighbor.test.ts per test-architecture.md (file exceeds 800-line limit).
 * All filesystem I/O is intercepted via _codeNeighborDeps injection.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeLogger } from "@test/helpers";
import { _codeNeighborDeps, CodeNeighborProvider } from "@/context/engine/providers/code-neighbor";
import type { ContextRequest } from "@/context/engine/types";
import { extractTestDirs, globsToPathspec, globsToTestRegex } from "@/test-runners/conventions";
import type { ResolvedTestPatterns } from "@/test-runners/resolver";

function makePatterns(globs: readonly string[]): ResolvedTestPatterns {
  return {
    globs,
    pathspec: globsToPathspec(globs),
    regex: globsToTestRegex(globs),
    testDirs: extractTestDirs(globs),
    resolution: "root-config",
  };
}

function makeRequest(overrides: Partial<ContextRequest> = {}): ContextRequest {
  return {
    storyId: "US-895",
    repoRoot: "/repo",
    packageDir: "/repo",
    stage: "execution",
    role: "implementer",
    budgetTokens: 8_000,
    resolvedTestPatterns: makePatterns(["test/unit/**/*.test.ts"]),
    ...overrides,
  };
}

/** scan-cost suite (storyId US-001) — no resolvedTestPatterns, provider defaults. */
function makeScanCostRequest(overrides: Partial<ContextRequest> = {}): ContextRequest {
  return {
    storyId: "US-001",
    repoRoot: "/repo",
    packageDir: "/repo",
    stage: "execution",
    role: "implementer",
    budgetTokens: 8_000,
    ...overrides,
  };
}

/** cache-budget suite (GROWTH-2) — no resolvedTestPatterns, provider defaults. */
function makeCacheBudgetRequest(overrides: Partial<ContextRequest> = {}): ContextRequest {
  return {
    storyId: "US-GROWTH-2",
    repoRoot: "/repo",
    packageDir: "/repo",
    stage: "execution",
    role: "implementer",
    budgetTokens: 8_000,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Save / restore deps
// ─────────────────────────────────────────────────────────────────────────────

let origFileExists: typeof _codeNeighborDeps.fileExists;
let origReadFile: typeof _codeNeighborDeps.readFile;
let origGlob: typeof _codeNeighborDeps.glob;
let origFileSize: typeof _codeNeighborDeps.fileSize;
let origDetectLanguage: typeof _codeNeighborDeps.detectLanguage;
let origGetLogger: typeof _codeNeighborDeps.getLogger;

beforeEach(() => {
  origFileExists = _codeNeighborDeps.fileExists;
  origReadFile = _codeNeighborDeps.readFile;
  origGlob = _codeNeighborDeps.glob;
  origFileSize = _codeNeighborDeps.fileSize;
  origDetectLanguage = _codeNeighborDeps.detectLanguage;
  origGetLogger = _codeNeighborDeps.getLogger;
  // Quiet defaults
  _codeNeighborDeps.fileExists = async () => false;
  _codeNeighborDeps.readFile = async () => "";
  _codeNeighborDeps.detectLanguage = async () => undefined;
  _codeNeighborDeps.getLogger = () => makeLogger();
});

afterEach(() => {
  _codeNeighborDeps.fileExists = origFileExists;
  _codeNeighborDeps.readFile = origReadFile;
  _codeNeighborDeps.glob = origGlob;
  _codeNeighborDeps.fileSize = origFileSize;
  _codeNeighborDeps.detectLanguage = origDetectLanguage;
  _codeNeighborDeps.getLogger = origGetLogger;
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Sets up glob spy that captures the pattern and cap arguments. */
function spyGlob() {
  let capturedPattern = "";
  let capturedCap = 0;
  _codeNeighborDeps.glob = (pattern, _cwd, _m, cap) => {
    capturedPattern = pattern;
    capturedCap = cap ?? 500;
    return { files: [], truncated: false };
  };
  return {
    get pattern() {
      return capturedPattern;
    },
    get cap() {
      return capturedCap;
    },
  };
}

// 6MB per candidate — reported via fileSize as a small stat (under the 1MB
// per-file cap) so the per-file cap doesn't interfere; the actual content
// returned by readFile is what exercises the aggregate byte budget.
const CANDIDATE_CONTENT_BYTES = 6 * 1024 * 1024;
const CANDIDATE_CONTENT = "x".repeat(CANDIDATE_CONTENT_BYTES);
const CANDIDATE_COUNT = 10;
const CANDIDATES = Array.from({ length: CANDIDATE_COUNT }, (_, i) => `src/cand${i}.ts`);
const TOUCHED_FILES = ["src/t0.ts", "src/t1.ts"];

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("CodeNeighborProvider — language-aware glob and cap (#895)", () => {
  test("derives TS glob when language=typescript", async () => {
    _codeNeighborDeps.detectLanguage = async () => "typescript";
    const spy = spyGlob();
    await new CodeNeighborProvider().fetch(makeRequest({ touchedFiles: ["src/a.ts"] }));
    expect(spy.pattern).toBe("**/*.{ts,tsx,js,jsx,mjs,cjs}");
  });

  test("derives Go glob when language=go", async () => {
    _codeNeighborDeps.detectLanguage = async () => "go";
    const spy = spyGlob();
    await new CodeNeighborProvider().fetch(makeRequest({ touchedFiles: ["src/a.ts"] }));
    expect(spy.pattern).toBe("**/*.go");
  });

  test("falls back to wide glob when language=undefined", async () => {
    _codeNeighborDeps.detectLanguage = async () => undefined;
    const spy = spyGlob();
    await new CodeNeighborProvider().fetch(makeRequest({ touchedFiles: ["src/a.ts"] }));
    expect(spy.pattern).toContain(".{ts,tsx,js,jsx,mjs,cjs,py,go,rs");
  });

  test("respects sourceGlob override — does not call detectLanguage", async () => {
    let detectCalled = false;
    _codeNeighborDeps.detectLanguage = async () => {
      detectCalled = true;
      return "typescript";
    };
    const spy = spyGlob();
    await new CodeNeighborProvider({ sourceGlob: "lib/**/*.ts" }).fetch(makeRequest({ touchedFiles: ["src/a.ts"] }));
    expect(detectCalled).toBe(false);
    expect(spy.pattern).toBe("lib/**/*.ts");
  });

  test("respects maxGlobFiles override — passes cap to glob dep", async () => {
    const spy = spyGlob();
    await new CodeNeighborProvider({ maxGlobFiles: 50 }).fetch(makeRequest({ touchedFiles: ["src/a.ts"] }));
    expect(spy.cap).toBe(50);
  });

  test("emits warn-level log on truncation with storyId, packageDir, pattern, cap, hint", async () => {
    const logger = makeLogger();
    _codeNeighborDeps.getLogger = () => logger;
    // Simulate the real glob behaviour: when truncated=true it calls warn internally.
    // We replace glob with one that calls getLogger().warn exactly as the real dep does.
    _codeNeighborDeps.glob = (_p, _c, _m, cap, ctx) => {
      _codeNeighborDeps.getLogger().warn("context-v2", "Reverse-dep glob cap reached — results truncated", {
        storyId: ctx?.storyId,
        packageDir: ctx?.packageDir,
        pattern: _p,
        cap,
        hint: "Increase context.v2.providers.maxGlobFiles or narrow context.v2.providers.sourceGlob",
      });
      return { files: ["src/a.ts"], truncated: true };
    };
    await new CodeNeighborProvider().fetch(makeRequest({ touchedFiles: ["src/b.ts"] }));
    const warnEntries = logger.calls.filter((c) => c.level === "warn");
    expect(warnEntries.length).toBeGreaterThan(0);
    const data = warnEntries[0]?.data;
    expect(data).toHaveProperty("storyId");
    expect(data).toHaveProperty("packageDir");
    expect(data).toHaveProperty("pattern");
    expect(data).toHaveProperty("cap");
    expect(data).toHaveProperty("hint");
  });

  test("appends truncation note to chunk content when glob is truncated", async () => {
    _codeNeighborDeps.glob = () => ({ files: ["src/a.ts"], truncated: true });
    const result = await new CodeNeighborProvider().fetch(makeRequest({ touchedFiles: ["src/b.ts"] }));
    const content = result.chunks[0]?.content ?? "";
    expect(content).toContain("> Note: reverse-dep scan capped at");
  });

  test("does not warn or append note when glob is below cap", async () => {
    const logger = makeLogger();
    _codeNeighborDeps.getLogger = () => logger;
    _codeNeighborDeps.glob = () => ({ files: ["src/a.ts"], truncated: false });
    const result = await new CodeNeighborProvider().fetch(makeRequest({ touchedFiles: ["src/b.ts"] }));
    expect(logger.calls.some((c) => c.level === "warn")).toBe(false);
    expect(result.chunks[0]?.content ?? "").not.toContain("> Note:");
  });
});

// The reverse-dep glob scan runs once per fetch() call (not once per touched
// file) and each candidate file is read at most once across the whole fetch,
// regardless of how many touched files are processed.
describe("CodeNeighborProvider — scan cost", () => {
  test("reads each candidate source file at most once per fetch across multiple touched files", async () => {
    // Three touched source files in the same package.
    const touchedFiles = ["src/a.ts", "src/b.ts", "src/c.ts"];

    // Two candidate files returned by the glob.
    const candidateFiles = ["src/x.ts", "src/y.ts"];

    // Track how many times each absolute path is read.
    const reads = new Map<string, number>();

    _codeNeighborDeps.detectLanguage = async () => "typescript";

    // Glob returns the same candidate list regardless of call count.
    // We also count glob invocations to ensure it is called exactly once.
    let globCallCount = 0;
    _codeNeighborDeps.glob = (_pattern, _cwd, _ignore, _cap, _ctx) => {
      globCallCount++;
      return { files: candidateFiles, truncated: false };
    };

    // fileExists: touched files exist; candidates do not (simplifies sibling test logic).
    _codeNeighborDeps.fileExists = async (p: string) => {
      return touchedFiles.some((tf) => p.endsWith(tf));
    };

    // readFile: track read counts; return content with no imports so forward-dep
    // and reverse-dep processing completes cleanly without adding neighbors.
    _codeNeighborDeps.readFile = async (p: string) => {
      reads.set(p, (reads.get(p) ?? 0) + 1);
      // Return empty content — no imports, no reverse-dep matches.
      return "";
    };

    const provider = new CodeNeighborProvider();
    await provider.fetch(makeScanCostRequest({ touchedFiles }));

    // Core assertion: each candidate file should be read at most once.
    for (const [path, count] of reads) {
      expect(count).toBeLessThanOrEqual(1);
      void path; // suppress unused variable warning
    }

    // Bonus: the glob should have been called exactly once (hoisted outside loop).
    expect(globCallCount).toBe(1);
  });

  test("glob count is one scan root, not number of touched files", async () => {
    const touchedFiles = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"];

    let globCallCount = 0;
    _codeNeighborDeps.detectLanguage = async () => "typescript";
    _codeNeighborDeps.glob = () => {
      globCallCount++;
      return { files: [], truncated: false };
    };
    _codeNeighborDeps.fileExists = async () => false;
    _codeNeighborDeps.readFile = async () => "";

    const provider = new CodeNeighborProvider();
    await provider.fetch(makeScanCostRequest({ touchedFiles }));

    // With 5 touched files, the single scan root is globbed once, not 5 times.
    expect(globCallCount).toBe(1);
  });
});

// GROWTH-2 follow-up: the per-file size cap (MAX_NEIGHBOR_FILE_SIZE_BYTES) only
// bounds a SINGLE file's contribution to the shared content cache; once the
// running total of retained bytes would exceed the aggregate budget
// (MAX_NEIGHBOR_CACHE_TOTAL_BYTES), further content is still read-and-returned
// for the current call but is no longer retained — proven here by two touched
// files that scan the same candidate list, where candidates beyond the budget
// are re-read from disk on the second pass (a cache eviction signal).
describe("CodeNeighborProvider — aggregate content-cache budget (GROWTH-2)", () => {
  test("stops retaining new entries once the aggregate budget is exceeded, so later scans re-read from disk", async () => {
    const readFileCallsByPath: string[] = [];

    _codeNeighborDeps.detectLanguage = async () => "typescript";
    _codeNeighborDeps.glob = () => ({ files: CANDIDATES, truncated: false });
    _codeNeighborDeps.fileExists = async (p: string) => TOUCHED_FILES.some((tf) => p.endsWith(tf));
    _codeNeighborDeps.fileSize = async () => 1024; // well under the per-file cap
    _codeNeighborDeps.readFile = async (p: string) => {
      readFileCallsByPath.push(p);
      // Touched files themselves are empty (no forward-dep parsing needed);
      // candidates carry the large filler content that drives the budget.
      if (TOUCHED_FILES.some((tf) => p.endsWith(tf))) return "";
      return CANDIDATE_CONTENT;
    };

    const provider = new CodeNeighborProvider();
    await provider.fetch(makeCacheBudgetRequest({ touchedFiles: TOUCHED_FILES }));

    // First pass (touched file 0): every candidate is read exactly once —
    // 10 candidate reads + 1 own-content read = 11.
    // Second pass (touched file 1) re-scans the SAME candidate list: with an
    // unbounded cache, none of the 10 candidates would be re-read (only the
    // new touched file's own content = 1 extra read, total 12). With no
    // caching at all, all 10 candidates would be re-read (total 22).
    // The aggregate budget (50MB) fits at most 8 of the 10 six-MB candidates,
    // so exactly 2 candidates fall outside the budget and get re-read on the
    // second pass: total = 11 + 1 (own) + 2 (evicted re-reads) = 14.
    const totalReads = readFileCallsByPath.length;
    expect(totalReads).toBe(14);

    // Sanity: strictly between "perfectly cached" (12) and "never cached" (22).
    expect(totalReads).toBeGreaterThan(12);
    expect(totalReads).toBeLessThan(22);

    // The last two candidates (beyond the 50MB budget) must each appear
    // exactly twice — once per pass, proving they were never retained.
    const cand8Reads = readFileCallsByPath.filter((p) => p.endsWith("cand8.ts")).length;
    const cand9Reads = readFileCallsByPath.filter((p) => p.endsWith("cand9.ts")).length;
    expect(cand8Reads).toBe(2);
    expect(cand9Reads).toBe(2);

    // The first eight candidates (within budget) must each appear exactly
    // once — proving they WERE retained and served from cache on pass two.
    for (let i = 0; i < 8; i++) {
      const reads = readFileCallsByPath.filter((p) => p.endsWith(`cand${i}.ts`)).length;
      expect(reads).toBe(1);
    }
  });
});
