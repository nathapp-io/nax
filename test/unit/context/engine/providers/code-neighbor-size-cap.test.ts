/**
 * CodeNeighborProvider — size-cap test (GROWTH-2)
 *
 * Verifies that a candidate reverse-dep file over MAX_NEIGHBOR_FILE_SIZE_BYTES
 * is skipped before its full content is read into the shared cache. The
 * `includes` pre-filter runs on content, so it cannot gate the read itself —
 * the size cap is what bounds per-fetch() memory for large generated/vendor
 * files.
 *
 * All I/O is intercepted via _codeNeighborDeps injection; no real filesystem access.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CodeNeighborProvider, _codeNeighborDeps } from "@/context/engine";
import type { ContextRequest } from "@/context/engine";

// ─────────────────────────────────────────────────────────────────────────────
// Saved originals
// ─────────────────────────────────────────────────────────────────────────────

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

const OVERSIZED_BYTES = 2 * 1024 * 1024; // 2MB — over the 1MB cap

/** Captures logger.warn calls so tests can assert on them without a real logger. */
function spyLogger() {
  const warnCalls: unknown[][] = [];
  _codeNeighborDeps.getLogger = () =>
    ({
      debug: () => {},
      info: () => {},
      error: () => {},
      warn: (...args: unknown[]) => {
        warnCalls.push(args);
      },
    }) as any;
  return warnCalls;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("CodeNeighborProvider — size cap (GROWTH-2)", () => {
  test("skips reading a candidate reverse-dep file over the size cap", async () => {
    const touchedFiles = ["src/a.ts"];
    const candidateFiles = ["src/huge-generated.ts"];

    const readCalls: string[] = [];

    _codeNeighborDeps.detectLanguage = async () => "typescript";
    _codeNeighborDeps.discoverWorkspacePackages = async () => [];
    _codeNeighborDeps.glob = () => ({ files: candidateFiles, truncated: false });
    _codeNeighborDeps.fileExists = async (p: string) => touchedFiles.some((tf) => p.endsWith(tf));
    _codeNeighborDeps.fileSize = async (p: string) => (p.endsWith("huge-generated.ts") ? OVERSIZED_BYTES : 0);
    _codeNeighborDeps.readFile = async (p: string) => {
      readCalls.push(p);
      return "";
    };

    const provider = new CodeNeighborProvider({ crossPackageDepth: 0 });
    await provider.fetch(makeRequest({ touchedFiles }));

    expect(readCalls.some((p) => p.endsWith("huge-generated.ts"))).toBe(false);
  });

  test("still reads a candidate file at or under the size cap", async () => {
    const touchedFiles = ["src/a.ts"];
    const candidateFiles = ["src/normal.ts"];

    const readCalls: string[] = [];

    _codeNeighborDeps.detectLanguage = async () => "typescript";
    _codeNeighborDeps.discoverWorkspacePackages = async () => [];
    _codeNeighborDeps.glob = () => ({ files: candidateFiles, truncated: false });
    _codeNeighborDeps.fileExists = async (p: string) => touchedFiles.some((tf) => p.endsWith(tf));
    _codeNeighborDeps.fileSize = async () => 1024; // 1KB — well under cap
    _codeNeighborDeps.readFile = async (p: string) => {
      readCalls.push(p);
      return "";
    };

    const provider = new CodeNeighborProvider({ crossPackageDepth: 0 });
    await provider.fetch(makeRequest({ touchedFiles }));

    expect(readCalls.some((p) => p.endsWith("normal.ts"))).toBe(true);
  });
});

describe("CodeNeighborProvider — fileSize failure observability", () => {
  test("falls through silently on a benign ENOENT stat race (no warning)", async () => {
    const touchedFiles = ["src/a.ts"];
    const candidateFiles = ["src/deleted-mid-scan.ts"];
    const warnCalls = spyLogger();

    _codeNeighborDeps.detectLanguage = async () => "typescript";
    _codeNeighborDeps.discoverWorkspacePackages = async () => [];
    _codeNeighborDeps.glob = () => ({ files: candidateFiles, truncated: false });
    _codeNeighborDeps.fileExists = async (p: string) => touchedFiles.some((tf) => p.endsWith(tf));
    _codeNeighborDeps.fileSize = async () => {
      const err = new Error("ENOENT: no such file or directory") as Error & { code: string };
      err.code = "ENOENT";
      throw err;
    };
    _codeNeighborDeps.readFile = async () => "";

    const provider = new CodeNeighborProvider({ crossPackageDepth: 0 });
    await provider.fetch(makeRequest({ touchedFiles }));

    expect(warnCalls.length).toBe(0);
  });

  test("logs a warning when fileSize throws an unexpected (non-ENOENT) error", async () => {
    const touchedFiles = ["src/a.ts"];
    const candidateFiles = ["src/candidate.ts"];
    const warnCalls = spyLogger();

    _codeNeighborDeps.detectLanguage = async () => "typescript";
    _codeNeighborDeps.discoverWorkspacePackages = async () => [];
    _codeNeighborDeps.glob = () => ({ files: candidateFiles, truncated: false });
    _codeNeighborDeps.fileExists = async (p: string) => touchedFiles.some((tf) => p.endsWith(tf));
    _codeNeighborDeps.fileSize = async () => {
      throw new TypeError("permission denied");
    };
    _codeNeighborDeps.readFile = async () => "";

    const provider = new CodeNeighborProvider({ crossPackageDepth: 0 });
    await provider.fetch(makeRequest({ touchedFiles }));

    expect(warnCalls.length).toBeGreaterThan(0);
  });

  test("logs a warning when _codeNeighborDeps.fileSize is not a function", async () => {
    const touchedFiles = ["src/a.ts"];
    const candidateFiles = ["src/candidate.ts"];
    const warnCalls = spyLogger();

    _codeNeighborDeps.detectLanguage = async () => "typescript";
    _codeNeighborDeps.discoverWorkspacePackages = async () => [];
    _codeNeighborDeps.glob = () => ({ files: candidateFiles, truncated: false });
    _codeNeighborDeps.fileExists = async (p: string) => touchedFiles.some((tf) => p.endsWith(tf));
    // Simulate a caller passing a partial deps object without fileSize wired up.
    (_codeNeighborDeps as any).fileSize = undefined;
    _codeNeighborDeps.readFile = async () => "";

    const provider = new CodeNeighborProvider({ crossPackageDepth: 0 });
    await provider.fetch(makeRequest({ touchedFiles }));

    expect(warnCalls.length).toBeGreaterThan(0);
  });
});

describe("CodeNeighborProvider — oversized-file skip consistency (item 4)", () => {
  test("returns a consistent 'skipped' outcome across repeated reads of the same oversized file within one fetch()", async () => {
    // "src/shared.ts" is oversized AND appears both as touched file A's own
    // content and as a reverse-dep candidate scanned while processing
    // touched file B — forcing two internal reads of the same path within
    // a single fetch() call.
    const touchedFiles = ["src/shared.ts", "src/b.ts"];
    const candidateFiles = ["src/shared.ts"];

    let sharedFileSizeCalls = 0;
    const readCalls: string[] = [];

    _codeNeighborDeps.detectLanguage = async () => "typescript";
    _codeNeighborDeps.discoverWorkspacePackages = async () => [];
    _codeNeighborDeps.glob = () => ({ files: candidateFiles, truncated: false });
    _codeNeighborDeps.fileExists = async (p: string) => touchedFiles.some((tf) => p.endsWith(tf));
    _codeNeighborDeps.fileSize = async (p: string) => {
      if (p.endsWith("shared.ts")) {
        sharedFileSizeCalls++;
        return OVERSIZED_BYTES;
      }
      return 1024;
    };
    _codeNeighborDeps.readFile = async (p: string) => {
      readCalls.push(p);
      return "";
    };

    const provider = new CodeNeighborProvider({ crossPackageDepth: 0 });
    await provider.fetch(makeRequest({ touchedFiles }));

    // The oversized file must never be read into content — proving the
    // "skipped as oversized" outcome held consistently on both accesses.
    expect(readCalls.some((p) => p.endsWith("shared.ts"))).toBe(false);

    // The skip is remembered after the first stat — the second access (from
    // touched file B's reverse-dep scan) must not re-stat the same path.
    expect(sharedFileSizeCalls).toBe(1);
  });
});
