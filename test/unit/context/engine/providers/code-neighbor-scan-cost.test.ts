/**
 * CodeNeighborProvider — scan-cost test
 *
 * Verifies that the reverse-dep glob scan is performed once per fetch() call
 * (not once per touched file) and that each candidate file is read at most once
 * across the entire fetch(), regardless of how many touched files are processed.
 *
 * All I/O is intercepted via _codeNeighborDeps injection; no real filesystem access.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { CodeNeighborProvider, _codeNeighborDeps } from "../../../../../src/context/engine/providers/code-neighbor";
import type { ContextRequest } from "../../../../../src/context/engine/types";

// ─────────────────────────────────────────────────────────────────────────────
// Saved originals
// ─────────────────────────────────────────────────────────────────────────────

let origGlob: typeof _codeNeighborDeps.glob;
let origReadFile: typeof _codeNeighborDeps.readFile;
let origFileExists: typeof _codeNeighborDeps.fileExists;
let origDetectLanguage: typeof _codeNeighborDeps.detectLanguage;
let origDiscoverWorkspacePackages: typeof _codeNeighborDeps.discoverWorkspacePackages;

beforeEach(() => {
  origGlob = _codeNeighborDeps.glob;
  origReadFile = _codeNeighborDeps.readFile;
  origFileExists = _codeNeighborDeps.fileExists;
  origDetectLanguage = _codeNeighborDeps.detectLanguage;
  origDiscoverWorkspacePackages = _codeNeighborDeps.discoverWorkspacePackages;
});

afterEach(() => {
  _codeNeighborDeps.glob = origGlob;
  _codeNeighborDeps.readFile = origReadFile;
  _codeNeighborDeps.fileExists = origFileExists;
  _codeNeighborDeps.detectLanguage = origDetectLanguage;
  _codeNeighborDeps.discoverWorkspacePackages = origDiscoverWorkspacePackages;
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
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("CodeNeighborProvider — scan cost", () => {
  test("reads each candidate source file at most once per fetch across multiple touched files", async () => {
    // Three touched source files in the same package.
    const touchedFiles = ["src/a.ts", "src/b.ts", "src/c.ts"];

    // Two candidate files returned by the glob.
    const candidateFiles = ["src/x.ts", "src/y.ts"];

    // Track how many times each absolute path is read.
    const reads = new Map<string, number>();

    _codeNeighborDeps.detectLanguage = async () => "typescript";
    _codeNeighborDeps.discoverWorkspacePackages = async () => [];

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

    const provider = new CodeNeighborProvider({ crossPackageDepth: 0 });
    await provider.fetch(makeRequest({ touchedFiles }));

    // Core assertion: each candidate file should be read at most once.
    for (const [path, count] of reads) {
      expect(count).toBeLessThanOrEqual(1);
      void path; // suppress unused variable warning
    }

    // Bonus: the glob should have been called exactly once (hoisted outside loop).
    expect(globCallCount).toBe(1);
  });

  test("glob count equals number of unique scan dirs (1 primary + N extra), not number of touched files", async () => {
    const touchedFiles = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"];

    let globCallCount = 0;
    _codeNeighborDeps.detectLanguage = async () => "typescript";
    _codeNeighborDeps.discoverWorkspacePackages = async () => [];
    _codeNeighborDeps.glob = () => {
      globCallCount++;
      return { files: [], truncated: false };
    };
    _codeNeighborDeps.fileExists = async () => false;
    _codeNeighborDeps.readFile = async () => "";

    const provider = new CodeNeighborProvider({ crossPackageDepth: 0 });
    await provider.fetch(makeRequest({ touchedFiles }));

    // With 5 touched files but crossPackageDepth=0, the glob must be called
    // exactly once (one primary workdir scan), not 5 times.
    expect(globCallCount).toBe(1);
  });
});
