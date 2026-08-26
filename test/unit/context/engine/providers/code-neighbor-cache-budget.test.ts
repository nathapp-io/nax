/**
 * CodeNeighborProvider — aggregate content-cache budget (GROWTH-2 follow-up)
 *
 * The per-file size cap (MAX_NEIGHBOR_FILE_SIZE_BYTES) only bounds a SINGLE
 * file's contribution to the shared content cache. With maxGlobFiles
 * defaulting to 500 per scanned dir (and multiple workspace-package dirs
 * scanned per fetch()), many just-under-the-cap files can still accumulate
 * into hundreds of MB retained for one fetch() call.
 *
 * This suite verifies the new aggregate budget (MAX_NEIGHBOR_CACHE_TOTAL_BYTES):
 * once the running total of retained bytes would exceed the budget, further
 * content is still read-and-returned for the current call, but is no longer
 * retained in the shared cache — proven here by seeding two touched files
 * that scan the same candidate list, and observing that candidates beyond
 * the budget are re-read from disk on the second pass (a cache eviction
 * signal) rather than served from an unboundedly-growing cache.
 *
 * All I/O is intercepted via _codeNeighborDeps injection; no real filesystem access.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeLogger } from "@test/helpers";
import type { ContextRequest } from "@/context/engine";
import { _codeNeighborDeps, CodeNeighborProvider } from "@/context/engine";

let origGlob: typeof _codeNeighborDeps.glob;
let origReadFile: typeof _codeNeighborDeps.readFile;
let origFileExists: typeof _codeNeighborDeps.fileExists;
let origFileSize: typeof _codeNeighborDeps.fileSize;
let origDetectLanguage: typeof _codeNeighborDeps.detectLanguage;
let origDiscoverWorkspacePackages: typeof _codeNeighborDeps.discoverWorkspacePackages;
let origGetLogger: typeof _codeNeighborDeps.getLogger;

beforeEach(() => {
  origGlob = _codeNeighborDeps.glob;
  origReadFile = _codeNeighborDeps.readFile;
  origFileExists = _codeNeighborDeps.fileExists;
  origFileSize = _codeNeighborDeps.fileSize;
  origDetectLanguage = _codeNeighborDeps.detectLanguage;
  origDiscoverWorkspacePackages = _codeNeighborDeps.discoverWorkspacePackages;
  origGetLogger = _codeNeighborDeps.getLogger;
  _codeNeighborDeps.getLogger = () => makeLogger();
});

afterEach(() => {
  _codeNeighborDeps.glob = origGlob;
  _codeNeighborDeps.readFile = origReadFile;
  _codeNeighborDeps.fileExists = origFileExists;
  _codeNeighborDeps.fileSize = origFileSize;
  _codeNeighborDeps.detectLanguage = origDetectLanguage;
  _codeNeighborDeps.discoverWorkspacePackages = origDiscoverWorkspacePackages;
  _codeNeighborDeps.getLogger = origGetLogger;
});

function makeRequest(overrides: Partial<ContextRequest> = {}): ContextRequest {
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

// 6MB per candidate — reported via fileSize as a small stat (under the 1MB
// per-file cap) so the per-file cap doesn't interfere; the actual content
// returned by readFile is what exercises the aggregate byte budget.
const CANDIDATE_CONTENT_BYTES = 6 * 1024 * 1024;
const CANDIDATE_CONTENT = "x".repeat(CANDIDATE_CONTENT_BYTES);
const CANDIDATE_COUNT = 10;
const CANDIDATES = Array.from({ length: CANDIDATE_COUNT }, (_, i) => `src/cand${i}.ts`);
const TOUCHED_FILES = ["src/t0.ts", "src/t1.ts"];

describe("CodeNeighborProvider — aggregate content-cache budget (GROWTH-2)", () => {
  test("stops retaining new entries once the aggregate budget is exceeded, so later scans re-read from disk", async () => {
    const readFileCallsByPath: string[] = [];

    _codeNeighborDeps.detectLanguage = async () => "typescript";
    _codeNeighborDeps.discoverWorkspacePackages = async () => [];
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

    const provider = new CodeNeighborProvider({ crossPackageDepth: 0 });
    await provider.fetch(makeRequest({ touchedFiles: TOUCHED_FILES }));

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
