/**
 * Characterisation tests for `collectNeighbors` branches nothing else pins
 * (A12 cognitive-complexity drain — docs/plans/STATUS-complexity-drain.md).
 *
 * The three code-neighbor* mirror suites exercise the provider end-to-end and
 * pin the forward/reverse flows, the #1611 slot guarantees, the package
 * scope, the nax#2074/#2125/#2134 frames, sibling-test selection, and the
 * glob cap. These tests pin the remaining guard arms whose mirrors cannot
 * discriminate them, each green against the UNREFACTORED function:
 *
 *   1. a forward import resolving outside the workdir contributes nothing
 *      (resolveImport -> null -> continue), while a normal sibling import
 *      still lands;
 *   2. a missing own file collects no forward deps even when readFile has
 *      content behind the mock (the fileExists guard is real), while reverse
 *      deps and the mirrored sibling hint still land;
 *   3. an oversized own file collects no forward deps (readCached -> null),
 *      while the sibling hint still lands;
 *   4. the includes() quick-check quirk: a directory import (".") whose
 *      content never mentions the touched file's base name is NOT discovered
 *      as a reverse dep — pinned as-is per §2.1 (record, don't fix); changing
 *      it needs its own issue;
 *   5. the AC5 package-scope exact-match arm: a scanned file spelled exactly
 *      as the package's relative path is kept, while a genuinely outside
 *      candidate is dropped.
 *
 * All injection goes through _codeNeighborDeps (the module seam the mirrors
 * use); every mock is in-memory and rooted at /repo like setupDeps in
 * code-neighbor.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _codeNeighborDeps, CodeNeighborProvider } from "@/context/engine/providers/code-neighbor";
import { MAX_NEIGHBOR_FILE_SIZE_BYTES } from "@/context/engine/providers/code-neighbor-cache";
import type { ContextRequest } from "@/context/engine/types";
import { extractTestDirs, globsToPathspec, globsToTestRegex } from "@/test-runners/conventions";
import type { ResolvedTestPatterns } from "@/test-runners/resolver";

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

interface DepsOverrides {
  files?: Record<string, string>;
  globFiles?: string[];
  fileExists?: (path: string) => boolean;
  fileSize?: (path: string) => number;
}

/** Install in-memory dep mocks rooted at /repo; per-field overrides win. */
function setupDeps(overrides: DepsOverrides = {}) {
  const { files = {}, globFiles = [], fileExists, fileSize } = overrides;
  _codeNeighborDeps.fileExists = async (path: string) =>
    fileExists ? fileExists(path) : path.replace("/repo/", "") in files;
  _codeNeighborDeps.readFile = async (path: string) => files[path.replace("/repo/", "")] ?? "";
  _codeNeighborDeps.fileSize = async (path: string) => (fileSize ? fileSize(path) : 1024);
  _codeNeighborDeps.glob = () => ({ files: globFiles, truncated: false });
  _codeNeighborDeps.detectLanguage = async () => undefined;
}

let origFileExists: typeof _codeNeighborDeps.fileExists;
let origReadFile: typeof _codeNeighborDeps.readFile;
let origFileSize: typeof _codeNeighborDeps.fileSize;
let origGlob: typeof _codeNeighborDeps.glob;
let origDetectLanguage: typeof _codeNeighborDeps.detectLanguage;

beforeEach(() => {
  origFileExists = _codeNeighborDeps.fileExists;
  origReadFile = _codeNeighborDeps.readFile;
  origFileSize = _codeNeighborDeps.fileSize;
  origGlob = _codeNeighborDeps.glob;
  origDetectLanguage = _codeNeighborDeps.detectLanguage;
});

afterEach(() => {
  _codeNeighborDeps.fileExists = origFileExists;
  _codeNeighborDeps.readFile = origReadFile;
  _codeNeighborDeps.fileSize = origFileSize;
  _codeNeighborDeps.glob = origGlob;
  _codeNeighborDeps.detectLanguage = origDetectLanguage;
});

/** Neighbor lines ("- <path>") rendered in the chunk body — the paths that matter. */
function neighborLines(content: string): string[] {
  return content.split("\n").filter((l) => l.startsWith("- "));
}

describe("CodeNeighborProvider — collectNeighbors unpinned branches (A12 characterisation)", () => {
  test("a forward import resolving outside the workdir contributes nothing; a sibling import still lands", async () => {
    setupDeps({
      files: {
        "src/a.ts": 'import { x } from "../../outside/x"\nimport { u } from "./util"',
        "src/util.ts": "",
      },
      globFiles: [],
    });
    const provider = new CodeNeighborProvider();
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/a.ts"] }));
    const lines = neighborLines(result.chunks[0]?.content ?? "");
    expect(lines).toContain("- src/util.ts");
    expect(lines.some((l) => l.includes("outside"))).toBe(false);
  });

  test("a missing own file collects no forward deps; reverse deps and the sibling hint still land", async () => {
    // fileExists says the touched file is absent while readFile still serves
    // import content for it — if the fileExists guard were gone, the mocked
    // content would leak in as forward deps and this test would fail.
    setupDeps({
      files: {
        "src/ghost.ts": 'import { u } from "./util"',
        "src/util.ts": "",
        "src/other.ts": 'import { g } from "./ghost"',
      },
      globFiles: ["src/other.ts"],
      // Both the touched file AND its colocated test candidate are absent, so
      // selection falls through to the mirrored hint (which is not existence-
      // checked — the "TDD hint" arm the mirror at code-neighbor.test.ts pins).
      fileExists: (path: string) => path !== "/repo/src/ghost.ts" && path !== "/repo/src/ghost.test.ts",
    });
    const provider = new CodeNeighborProvider();
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/ghost.ts"] }));
    const lines = neighborLines(result.chunks[0]?.content ?? "");
    expect(lines).toContain("- src/other.ts");
    expect(lines).toContain("- test/unit/ghost.test.ts");
    expect(lines.some((l) => l.includes("src/util.ts"))).toBe(false);
  });

  test("an oversized own file collects no forward deps; the sibling hint still lands", async () => {
    setupDeps({
      files: {
        "src/big.ts": 'import { u } from "./util"',
        "src/util.ts": "",
      },
      globFiles: [],
      fileSize: (path: string) => (path === "/repo/src/big.ts" ? MAX_NEIGHBOR_FILE_SIZE_BYTES + 1 : 1024),
    });
    const provider = new CodeNeighborProvider();
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/big.ts"] }));
    const lines = neighborLines(result.chunks[0]?.content ?? "");
    expect(lines).toContain("- test/unit/big.test.ts");
    expect(lines.some((l) => l.includes("src/util.ts"))).toBe(false);
  });

  test("quick-check quirk: a directory import whose content lacks the base name is not a reverse dep", async () => {
    // The candidate imports the touched file via "." (resolving to the
    // repo-root index file) but its content never contains the base name
    // "index", so the includes() quick check skips it before any parsing.
    // Pinned as-is (§2.1): widening this is a behaviour change with its own
    // issue, not a refactor.
    setupDeps({
      files: {
        "index.ts": "",
        "consumer.ts": 'import { x } from "."',
      },
      globFiles: ["consumer.ts"],
    });
    const provider = new CodeNeighborProvider();
    const result = await provider.fetch(makeRequest({ touchedFiles: ["index.ts"], resolvedTestPatterns: undefined }));
    expect(result.chunks).toHaveLength(0);
  });

  test("package scope keeps a file spelled exactly as the package's relative path; drops outside candidates", async () => {
    // AC5 exact-match arm: "pkg" fails startsWith("pkg/") but equals
    // relPackageDir, so it survives the filter; "outside/other.ts" matches
    // neither and is dropped even though it imports the touched file too.
    setupDeps({
      files: {
        "src/a.ts": "",
        pkg: 'import { a } from "./src/a"',
        "outside/other.ts": 'import { a } from "./src/a"',
      },
      globFiles: ["pkg", "outside/other.ts"],
    });
    const provider = new CodeNeighborProvider({ neighborScope: "package" });
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/a.ts"], packageDir: "/repo/pkg" }));
    const lines = neighborLines(result.chunks[0]?.content ?? "");
    expect(lines).toContain("- pkg");
    expect(lines.some((l) => l.includes("outside"))).toBe(false);
  });
});
