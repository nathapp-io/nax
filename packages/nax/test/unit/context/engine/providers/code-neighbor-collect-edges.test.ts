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
 *      content behind the mock (the fileExists guard is real) and no importer
 *      of that absent target becomes a reverse dep, while the mirrored
 *      sibling hint still lands;
 *   3. an oversized own file collects no forward deps (readCached -> null),
 *      while the sibling hint still lands;
 *   4. a directory import ("." / "./lib") IS a reverse dep even when the
 *      importer never mentions the index file's base name — US-005 removed
 *      the includes() quick-check false negative;
 *   5. the AC5 package-scope exact-match arm: a scanned file spelled exactly
 *      as the package's relative path is kept, while a genuinely outside
 *      candidate is dropped;
 *   6. US-005 (review finding 8): on REAL temporary source files, forward and
 *      reverse resolution agree on the files that exist — `./Button` ->
 *      Button.tsx, `./x.js` -> x.js, `./lib` -> lib/index.ts — and no edge is
 *      emitted to an absent target or to a file outside the workdir.
 *
 * Injection goes through _codeNeighborDeps (the module seam the mirrors use);
 * the in-memory mocks are rooted at /repo like setupDeps in
 * code-neighbor.test.ts. Item 6 deliberately stubs nothing but language
 * detection: it must fail if resolution ever stops looking at disk.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
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

// Snapshot of every dep taken ONCE, at module load — not in beforeEach. A
// per-test snapshot records whatever the live object holds at that moment as
// the "original", so a stub left behind by an earlier test in this file (or set
// in a describe-level beforeAll) would be restored as if it were real (the
// 14edda8d lesson). Every test here stubs the deps it uses via setupDeps(), so
// none depends on the snapshot holding the real implementations; restoring to
// it is what keeps this file from leaking its stubs into later files.
const REAL_CODE_NEIGHBOR_DEPS = { ..._codeNeighborDeps };

beforeEach(() => {
  Object.assign(_codeNeighborDeps, REAL_CODE_NEIGHBOR_DEPS);
});

afterEach(() => {
  Object.assign(_codeNeighborDeps, REAL_CODE_NEIGHBOR_DEPS);
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

  test("a missing own file yields no reverse dep from an importer of that name; the sibling hint is retained", async () => {
    // `ghost.ts` is absent on disk while readFile still serves import content
    // for it. Two consequences are pinned here: the fileExists guard keeps
    // that content out of the forward deps, and `src/other.ts`'s `./ghost`
    // import resolves to nothing because the target does not exist — so no
    // reverse edge is emitted for it (US-005 AC-6). The mirrored sibling hint
    // is a synthesized TDD pointer rather than a resolved neighbour, so it
    // still lands even though no such file is on disk (US-005 AC-4).
    const files: Record<string, string> = {
      "src/ghost.ts": 'import { u } from "./util"',
      "src/util.ts": "",
      "src/other.ts": 'import { g } from "./ghost"',
    };
    setupDeps({
      files,
      globFiles: ["src/other.ts"],
      // Everything in `files` exists EXCEPT the touched file itself. Both the
      // touched file AND its colocated test candidate are absent, so selection
      // falls through to the mirrored hint (which is not existence-checked —
      // the "TDD hint" arm the mirror at code-neighbor.test.ts pins).
      fileExists: (path: string) => path.replace("/repo/", "") in files && path !== "/repo/src/ghost.ts",
    });
    const provider = new CodeNeighborProvider();
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/ghost.ts"] }));
    const lines = neighborLines(result.chunks[0]?.content ?? "");
    expect(lines).toContain("- test/unit/ghost.test.ts");
    expect(lines).not.toContain("- src/other.ts");
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

  test("a directory import is a reverse dep even when the importer never spells the index base name", async () => {
    // US-005 AC-2: `import "."` (or `import "./lib"`) resolves to the
    // directory's index file. The includes() quick check looked only for the
    // touched file's base name ("index"), so an importer that never writes
    // that word was skipped before parsing — a false negative that made a
    // directory import invisible in the reverse direction. Index files now
    // skip the quick check and the existence-checked resolver decides.
    setupDeps({
      files: {
        "index.ts": "",
        "consumer.ts": 'import { x } from "."',
      },
      globFiles: ["consumer.ts"],
    });
    const provider = new CodeNeighborProvider();
    const result = await provider.fetch(makeRequest({ touchedFiles: ["index.ts"], resolvedTestPatterns: undefined }));
    const lines = neighborLines(result.chunks[0]?.content ?? "");
    expect(lines).toContain("- consumer.ts");
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

// ─────────────────────────────────────────────────────────────────────────────
// US-005 (review finding 8) — resolution against real files
//
// `resolveImport` used to return the FIRST in-repo candidate without asking
// whether it exists, so `./Button` produced `Button.ts` beside a real
// `Button.tsx`, `./x.js` produced `x.js.ts`, and `./lib` produced `lib.ts`
// beside `lib/index.ts`. The same defect emptied the reverse direction,
// because an importer also resolved to the wrong path.
//
// These tests run the provider over REAL temporary source files with nothing
// stubbed except language detection, so forward and reverse have to agree on
// what is on disk. The fixture deliberately has no shadowing candidates
// (no src/Button.ts, no src/lib.ts, no src/x.js.ts).
// ─────────────────────────────────────────────────────────────────────────────

describe("CodeNeighborProvider — US-005 resolution against real files", () => {
  let root: string;
  let work: string;

  /**
   * Fixture layout:
   *   work/src/App.ts        imports ./Button ./x.js ./lib ./util ./ghost
   *   work/src/Button.tsx    the file ./Button must resolve to
   *   work/src/x.js          the file ./x.js must resolve to
   *   work/src/lib/index.ts  the file ./lib must resolve to
   *   work/src/util.ts       ordinary `.ts` control import
   *   work/src/Control.ts    imports ./util.ts — the explicit-extension control
   *   work/src/Back.ts       imports ../outside/x — a REAL file outside work
   *   outside/x.ts
   */
  const FIXTURE: Record<string, string> = {
    // NOTE: this source must never spell the word "index" — AC-2 requires the
    // directory import to be found without it.
    "work/src/App.ts": [
      'import { Button } from "./Button";',
      'import { x } from "./x.js";',
      'import { lib } from "./lib";',
      'import { util } from "./util";',
      'import { ghost } from "./ghost";',
    ].join("\n"),
    "work/src/Button.tsx": "export const Button = 1;",
    "work/src/x.js": "export const x = 1;",
    "work/src/lib/index.ts": "export const lib = 1;",
    "work/src/util.ts": "export const util = 1;",
    // Explicit-extension control import (`./util.ts`, not `./util`).
    "work/src/Control.ts": 'import { util } from "./util.ts";',
    "work/src/Back.ts": 'import { o } from "../outside/x";',
    "outside/x.ts": "export const o = 1;",
  };

  beforeAll(() => {
    root = makeTempDir("nax-test-");
    work = join(root, "work");
    for (const [rel, content] of Object.entries(FIXTURE)) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
  });

  afterAll(() => {
    cleanupTempDir(root);
  });

  beforeEach(() => {
    // Every other dep stays the real one: these tests are worthless if
    // resolution stops consulting the filesystem. Only language detection is
    // stubbed (the temp fixture has no manifest to detect from).
    _codeNeighborDeps.detectLanguage = async () => "typescript";
  });

  /** A request rooted at the real fixture workdir. */
  function fixtureRequest(overrides: Partial<ContextRequest> = {}): ContextRequest {
    return makeRequest({ repoRoot: work, packageDir: work, ...overrides });
  }

  test("[AC-1] forward deps name the files that exist: ./Button → Button.tsx, ./x.js → x.js, ./lib → lib/index.ts", async () => {
    const provider = new CodeNeighborProvider();
    const result = await provider.fetch(fixtureRequest({ touchedFiles: ["src/App.ts"] }));
    const lines = neighborLines(result.chunks[0]?.content ?? "");
    expect(lines).toContain("- src/Button.tsx");
    expect(lines).toContain("- src/x.js");
    expect(lines).toContain("- src/lib/index.ts");
    // Guessed spellings that do not exist must not appear.
    expect(lines).not.toContain("- src/Button.ts");
    expect(lines).not.toContain("- src/x.js.ts");
    expect(lines).not.toContain("- src/lib.ts");
  });

  test("[AC-5] an ordinary .ts control import still resolves — extensionless and explicit", async () => {
    const provider = new CodeNeighborProvider();
    // `./util.ts` (explicit extension): the old resolver answered `util.ts.ts`
    // because it returned the first candidate inside the repo without looking
    // at disk, so an explicit extension was the one form it could not get right.
    const explicit = await provider.fetch(
      fixtureRequest({ touchedFiles: ["src/Control.ts"], resolvedTestPatterns: undefined }),
    );
    const explicitLines = neighborLines(explicit.chunks[0]?.content ?? "");
    expect(explicitLines).toContain("- src/util.ts");
    expect(explicitLines).not.toContain("- src/util.ts.ts");

    // `./util` (extensionless) — the ordinary control form, both directions.
    const forward = await provider.fetch(
      fixtureRequest({ touchedFiles: ["src/App.ts"], resolvedTestPatterns: undefined }),
    );
    expect(neighborLines(forward.chunks[0]?.content ?? "")).toContain("- src/util.ts");

    const reverse = await provider.fetch(
      fixtureRequest({ touchedFiles: ["src/util.ts"], resolvedTestPatterns: undefined }),
    );
    expect(neighborLines(reverse.chunks[0]?.content ?? "")).toContain("- src/App.ts");
  });

  test("[AC-2] reverse deps name the real importer of Button.tsx, x.js and lib/index.ts", async () => {
    // The premise: App.ts reaches lib/index.ts through the directory form and
    // never writes "index", which the old includes() quick check required.
    expect(FIXTURE["work/src/App.ts"]).not.toContain("index");

    const provider = new CodeNeighborProvider();
    for (const touched of ["src/Button.tsx", "src/x.js", "src/lib/index.ts"]) {
      const result = await provider.fetch(fixtureRequest({ touchedFiles: [touched], resolvedTestPatterns: undefined }));
      expect(neighborLines(result.chunks[0]?.content ?? "")).toContain("- src/App.ts");
    }
  });

  test("[AC-3] no edge to an absent target (./ghost) or to a file outside the workdir (../outside/x)", async () => {
    const provider = new CodeNeighborProvider();
    // src/ghost.ts does not exist — the import must contribute no neighbour.
    const forward = await provider.fetch(
      fixtureRequest({ touchedFiles: ["src/App.ts"], resolvedTestPatterns: undefined }),
    );
    expect(neighborLines(forward.chunks[0]?.content ?? "").some((l) => l.includes("ghost"))).toBe(false);

    // outside/x.ts really does exist, one level above the workdir: it is still
    // not a neighbour.
    const outside = await provider.fetch(
      fixtureRequest({ touchedFiles: ["src/Back.ts"], resolvedTestPatterns: undefined }),
    );
    expect(outside.chunks).toHaveLength(0);
  });

  test("[AC-4] the synthesized sibling test hint needs no file on disk and is still emitted", async () => {
    const provider = new CodeNeighborProvider();
    const result = await provider.fetch(fixtureRequest({ touchedFiles: ["src/util.ts"] }));
    expect(neighborLines(result.chunks[0]?.content ?? "")).toContain("- test/unit/util.test.ts");
    expect(existsSync(join(work, "test/unit/util.test.ts"))).toBe(false);
  });
});
