/**
 * CodeNeighborProvider — path-frame regression suite (nax#2074).
 *
 * Lives beside code-neighbor.test.ts rather than inside it: that file is at
 * 794/800 lines under scripts/check-file-sizes.ts and may not grow.
 *
 * All filesystem I/O is intercepted via _codeNeighborDeps injection.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

const TEST_PATTERNS = makePatterns(["test/unit/**/*.test.ts"]);

/** Story in packages/app of a monorepo rooted at /repo. */
function makeRequest(overrides: Partial<ContextRequest> = {}): ContextRequest {
  return {
    storyId: "US-001",
    repoRoot: "/repo",
    packageDir: "/repo/packages/app",
    storyWorkdir: "packages/app",
    stage: "execution",
    role: "implementer",
    budgetTokens: 8_000,
    resolvedTestPatterns: TEST_PATTERNS,
    ...overrides,
  };
}

/**
 * `files` is keyed by ABSOLUTE path, because the whole point of this suite is
 * that two packages have identically-spelled relative paths.
 * `globByCwd` maps a scan root to the repo-relative-to-that-root file list the
 * glob returns, exactly as Bun.Glob would with `absolute: false`.
 */
function setupDeps(files: Record<string, string>, globByCwd: Record<string, string[]>) {
  _codeNeighborDeps.fileExists = async (path: string) => path in files;
  _codeNeighborDeps.readFile = async (path: string) => files[path] ?? "";
  _codeNeighborDeps.glob = (_pattern: string, cwd: string) => ({ files: globByCwd[cwd] ?? [], truncated: false });
  _codeNeighborDeps.detectLanguage = async () => undefined;
}

let orig: {
  fileExists: typeof _codeNeighborDeps.fileExists;
  readFile: typeof _codeNeighborDeps.readFile;
  glob: typeof _codeNeighborDeps.glob;
  detectLanguage: typeof _codeNeighborDeps.detectLanguage;
};

beforeEach(() => {
  orig = {
    fileExists: _codeNeighborDeps.fileExists,
    readFile: _codeNeighborDeps.readFile,
    glob: _codeNeighborDeps.glob,
    detectLanguage: _codeNeighborDeps.detectLanguage,
  };
});

afterEach(() => {
  _codeNeighborDeps.fileExists = orig.fileExists;
  _codeNeighborDeps.readFile = orig.readFile;
  _codeNeighborDeps.glob = orig.glob;
  _codeNeighborDeps.detectLanguage = orig.detectLanguage;
});

function neighborLines(content: string): string[] {
  return content.split("\n").filter((line) => line.startsWith("- "));
}

describe("CodeNeighborProvider — path frame (nax#2074)", () => {
  // The other sign of the same defect. Pre-fix, a repo-rooted scan compares a
  // repo-framed srcFile against a package-framed filePath, so a genuine
  // cross-package dependent matches NOTHING and is silently dropped; the
  // `srcFile === filePath` self-skip would have discarded it anyway had the
  // frames agreed. Single-frame: the neighbour renders repo-rooted, unmarked —
  // the agent can open any repo path.
  test("a genuine cross-package dependent is found and rendered repo-rooted", async () => {
    setupDeps(
      {
        "/repo/packages/app/src/index.ts": "export const app = 1;",
        "/repo/packages/lib/src/index.ts": 'import "../../app/src/index";',
      },
      { "/repo": ["packages/app/src/index.ts", "packages/lib/src/index.ts"] },
    );
    const provider = new CodeNeighborProvider({ neighborScope: "repo" });

    const result = await provider.fetch(makeRequest({ touchedFiles: ["packages/app/src/index.ts"] }));

    const lines = neighborLines(result.chunks[0]?.content ?? "");
    expect(lines).toContain("- packages/lib/src/index.ts");
  });

  // The spec's #2074 worked example (design.md:386-389), restored here as an
  // ADDITIONAL case alongside the mechanism case below ("package scope globs
  // only the story's own package"), which pins the glob roots rather than the
  // rendered result. The plan's Task 2 Step 4 retired the original version of
  // this case; the spec is the binding authority, so the observable outcome is
  // pinned here too.
  //
  // Pre-fix, at the default package scope the sibling scan globbed
  // packages/lib and compared relative spellings: helper.ts's `./index`
  // resolved to the sibling's "src/index.ts", which string-equalled the
  // consumer's package-framed "src/index.ts", rendering a false
  // `- src/helper.ts`. The sibling's own "src/index.ts" was skipped outright as
  // if it were the consumer's file (the self-skip half of the same defect).
  test("the issue's worked example: no sibling reverse-dep and no self-skip", async () => {
    setupDeps(
      {
        "/repo/packages/app/src/index.ts": "export const app = 1;",
        "/repo/packages/lib/src/helper.ts": 'import "./index";',
        "/repo/packages/lib/src/index.ts": "export const lib = 1;",
      },
      {
        "/repo/packages/app": ["src/index.ts"],
        // The pre-fix sibling scan's inputs; unreachable at package scope now.
        "/repo/packages/lib": ["src/helper.ts", "src/index.ts"],
        "/repo": ["packages/app/src/index.ts", "packages/lib/src/helper.ts", "packages/lib/src/index.ts"],
      },
    );

    // Default scope: the issue's exact configuration. helper.ts must not be
    // recorded as a reverse dependency of the consumer's src/index.ts.
    const pkgScoped = await new CodeNeighborProvider().fetch(
      makeRequest({ touchedFiles: ["packages/app/src/index.ts"] }),
    );
    const pkgLines = neighborLines(pkgScoped.chunks[0]?.content ?? "");
    expect(pkgLines.some((line) => line.includes("helper.ts"))).toBe(false);
    expect(pkgLines).not.toContain("- src/index.ts");

    // Repo scope: the sibling files are scanned, so the absolute comparison and
    // the absolute self-skip must still reject both the sibling helper.ts and
    // the sibling's identically-spelled src/index.ts.
    const repoScoped = await new CodeNeighborProvider({ neighborScope: "repo" }).fetch(
      makeRequest({ touchedFiles: ["packages/app/src/index.ts"] }),
    );
    const repoLines = neighborLines(repoScoped.chunks[0]?.content ?? "");
    expect(repoLines.some((line) => line.includes("helper.ts"))).toBe(false);
    expect(repoLines.some((line) => line.includes("lib/src/index.ts"))).toBe(false);
    expect(repoLines).not.toContain("- src/index.ts");
  });

  // Single-frame: a dependent inside the consumer's package is rendered
  // repo-rooted, the spelling the agent's file tools resolve.
  test("a dependent inside the consumer's package renders repo-rooted", async () => {
    setupDeps(
      {
        "/repo/packages/app/src/index.ts": "export const app = 1;",
        "/repo/packages/app/src/user.ts": 'import "./index";',
      },
      { "/repo": ["packages/app/src/index.ts", "packages/app/src/user.ts"] },
    );
    const provider = new CodeNeighborProvider({ neighborScope: "repo" });

    const result = await provider.fetch(makeRequest({ touchedFiles: ["packages/app/src/index.ts"] }));

    const lines = neighborLines(result.chunks[0]?.content ?? "");
    expect(lines).toContain("- packages/app/src/user.ts");
  });

  // scopePaths is an attribution key sharing the rendered spelling — no
  // separate frame and no marker.
  test("scopePaths records the same repo-rooted string the content renders", async () => {
    setupDeps(
      {
        "/repo/packages/app/src/index.ts": "export const app = 1;",
        "/repo/packages/lib/src/index.ts": 'import "../../app/src/index";',
      },
      { "/repo": ["packages/app/src/index.ts", "packages/lib/src/index.ts"] },
    );
    const provider = new CodeNeighborProvider({ neighborScope: "repo" });

    const result = await provider.fetch(makeRequest({ touchedFiles: ["packages/app/src/index.ts"] }));

    expect(result.chunks[0]?.scopePaths).toContain("packages/lib/src/index.ts");
    // The touched file is attributed repo-rooted too.
    expect(result.chunks[0]?.scopePaths).toContain("packages/app/src/index.ts");
    expect(result.chunks[0]?.scopePaths?.some((p) => p.startsWith("src/"))).toBe(false);
  });

  // The touched file is repo-rooted by contract (types.ts); fetch() resolves it
  // against repoRoot with no package-frame re-spelling. Under neighborScope
  // "repo" the OLD code resolved a package-framed path against repoRoot (the
  // sibling frame) and read nothing, so forward deps silently vanished.
  test("forward deps are resolved repo-rooted even when the scan root is the repo", async () => {
    setupDeps(
      {
        "/repo/packages/app/src/index.ts": 'import "./dep";',
        "/repo/packages/app/src/dep.ts": "export const dep = 1;",
      },
      { "/repo": ["packages/app/src/index.ts", "packages/app/src/dep.ts"] },
    );
    const provider = new CodeNeighborProvider({ neighborScope: "repo" });

    const result = await provider.fetch(makeRequest({ touchedFiles: ["packages/app/src/index.ts"] }));

    expect(neighborLines(result.chunks[0]?.content ?? "")).toContain("- packages/app/src/dep.ts");
  });
});

describe("CodeNeighborProvider — heading == scopePath (single frame)", () => {
  test("every scopePath is rendered verbatim in the chunk content", async () => {
    setupDeps(
      {
        "/repo/packages/app/src/index.ts": 'import "./dep";',
        "/repo/packages/app/src/dep.ts": "export const dep = 1;",
      },
      { "/repo": ["packages/app/src/index.ts", "packages/app/src/dep.ts"] },
    );
    const provider = new CodeNeighborProvider({ neighborScope: "repo" });

    const result = await provider.fetch(makeRequest({ touchedFiles: ["packages/app/src/index.ts"] }));

    const chunk = result.chunks[0];
    expect(chunk).toBeDefined();
    const scope = chunk?.scopePaths ?? [];
    expect(scope.length).toBeGreaterThan(0);
    for (const path of scope) {
      expect(chunk?.content).toContain(path);
    }
  });
});

describe("CodeNeighborProvider — execRoot thread-through (nax#2134)", () => {
  // US-001 / AC1-AC5: when `ContextRequest.execRoot` is set to a worktree root
  // and `repoRoot` is the main checkout, fetch() must read disk from the
  // worktree, render neighbours relative to it, and surface the worktree-only
  // neighbour as the resolution target. AC5: with execRoot UNSET, behaviour is
  // unchanged (fallback to repoRoot).

  /** Files keyed by absolute path; glob cwd → repo-relative-to-cwd list. */
  function setupWorktreeDeps(): void {
    setupDeps(
      {
        // Main checkout: a SAME-NAMED neighbour with the same import shape.
        // If fetch() reads the main checkout instead of the worktree, this is
        // the file that would appear.
        "/repo/packages/app/src/index.ts": 'import "./main-dep";',
        "/repo/packages/app/src/main-dep.ts": "export const mainDep = 1;",
        // Worktree-only: the touched file and its forward dep + a sibling
        // test, plus a reverse-dep consumer.
        "/repo/.nax-wt/US-001/packages/app/src/index.ts": 'import "./worktree-dep";',
        "/repo/.nax-wt/US-001/packages/app/src/worktree-dep.ts": "export const worktreeDep = 1;",
        "/repo/.nax-wt/US-001/packages/app/src/user.ts": 'import "./index";',
        "/repo/.nax-wt/US-001/packages/app/src/index.test.ts": "",
      },
      {
        // US-001: scanRoot derives from execRoot. The glob mock returns the
        // worktree's package dir contents regardless of whether the worktree
        // root or the package dir is the scan cwd (both resolve to the same
        // file set for the reverse-dep probe). The sibling-test probe also
        // runs fileExists against execRoot.
        "/repo/.nax-wt/US-001": [
          "packages/app/src/index.ts",
          "packages/app/src/worktree-dep.ts",
          "packages/app/src/user.ts",
          "packages/app/src/index.test.ts",
        ],
        "/repo/.nax-wt/US-001/packages/app": [
          "src/index.ts",
          "src/worktree-dep.ts",
          "src/user.ts",
          "src/index.test.ts",
        ],
      },
    );
  }

  test("AC1: forward dep that exists only under execRoot is returned", async () => {
    setupWorktreeDeps();
    const provider = new CodeNeighborProvider();

    const result = await provider.fetch(
      makeRequest({
        repoRoot: "/repo",
        execRoot: "/repo/.nax-wt/US-001",
        packageDir: "/repo/.nax-wt/US-001/packages/app",
        storyWorkdir: "packages/app",
        touchedFiles: ["packages/app/src/index.ts"],
      }),
    );

    const lines = neighborLines(result.chunks[0]?.content ?? "");
    // AC1: forward dep neighbour is listed.
    expect(lines).toContain("- packages/app/src/worktree-dep.ts");
    // The main checkout's copy of the touched file imports ./main-dep — a
    // same-shaped decoy that exists there and nowhere else. It must never
    // appear: its presence would mean disk resolution ran against repoRoot.
    expect(lines).not.toContain("- packages/app/src/main-dep.ts");
  });

  test("AC2: returned neighbour paths are relative to execRoot and never begin with .nax-wt/", async () => {
    setupWorktreeDeps();
    const provider = new CodeNeighborProvider();

    const result = await provider.fetch(
      makeRequest({
        repoRoot: "/repo",
        execRoot: "/repo/.nax-wt/US-001",
        packageDir: "/repo/.nax-wt/US-001/packages/app",
        storyWorkdir: "packages/app",
        touchedFiles: ["packages/app/src/index.ts"],
      }),
    );

    const lines = neighborLines(result.chunks[0]?.content ?? "");
    // AC2: the worktree-only forward dep is present, spelled relative to
    // execRoot — not as `.nax-wt/US-001/packages/app/src/worktree-dep.ts` and
    // not with any leaked prefix.
    expect(lines).toContain("- packages/app/src/worktree-dep.ts");
    // AC2: nothing in the chunk — section headings (`### <path>`) and neighbour
    // bullets (`- <path>`) alike — carries a `.nax-wt/` segment. A leak here
    // means a path was spelled relative to something other than execRoot
    // (absolute, repoRoot-relative, or worktree-prefixed).
    const content = result.chunks[0]?.content ?? "";
    expect(content).not.toContain(".nax-wt/");
    // scopePaths is the chunk's attribution key and must share that spelling.
    const scopePaths = result.chunks[0]?.scopePaths ?? [];
    expect(scopePaths.length).toBeGreaterThan(0);
    for (const path of scopePaths) {
      expect(path).not.toContain(".nax-wt/");
    }
  });

  test("AC3: a worktree-only reverse-dep (importer) is returned as a neighbour", async () => {
    setupWorktreeDeps();
    const provider = new CodeNeighborProvider();

    const result = await provider.fetch(
      makeRequest({
        repoRoot: "/repo",
        execRoot: "/repo/.nax-wt/US-001",
        packageDir: "/repo/.nax-wt/US-001/packages/app",
        storyWorkdir: "packages/app",
        touchedFiles: ["packages/app/src/index.ts"],
      }),
    );

    const lines = neighborLines(result.chunks[0]?.content ?? "");
    // AC3: src/user.ts imports the touched file and exists only in the
    // worktree. It must appear as a reverse-dep neighbour.
    expect(lines).toContain("- packages/app/src/user.ts");
  });

  test("AC4: a sibling test that exists only under execRoot is returned", async () => {
    setupWorktreeDeps();
    const provider = new CodeNeighborProvider();

    const result = await provider.fetch(
      makeRequest({
        repoRoot: "/repo",
        execRoot: "/repo/.nax-wt/US-001",
        packageDir: "/repo/.nax-wt/US-001/packages/app",
        storyWorkdir: "packages/app",
        touchedFiles: ["packages/app/src/index.ts"],
      }),
    );

    const lines = neighborLines(result.chunks[0]?.content ?? "");
    // AC4: src/index.test.ts is a colocated sibling test (not the mirrored
    // layout), and it exists only in the worktree. ADR-009 picks the
    // colocated candidate when it exists on disk.
    expect(lines).toContain("- packages/app/src/index.test.ts");
  });

  // US-001 (review finding): `packageDir` and `execRoot` need not be in the
  // same frame. `packageDir` is documented as the package dir — under worktree
  // isolation a producer may stamp the MAIN checkout's package dir while
  // `execRoot` carries the worktree root. Deriving the package-scope filter as
  // `relative(execRoot, packageDir)` then yields an escaping path
  // ("../../packages/app"), which matches no scanned file and silently drops
  // EVERY reverse-dep candidate. The package's identity must be derived in the
  // frame that `packageDir` and the scanned files actually share.
  test("AC3: reverse deps survive a main-checkout packageDir with a worktree execRoot", async () => {
    setupWorktreeDeps();
    const provider = new CodeNeighborProvider();

    const result = await provider.fetch(
      makeRequest({
        repoRoot: "/repo",
        execRoot: "/repo/.nax-wt/US-001",
        // The frame mismatch under test: main-checkout package dir.
        packageDir: "/repo/packages/app",
        storyWorkdir: "packages/app",
        touchedFiles: ["packages/app/src/index.ts"],
      }),
    );

    const lines = neighborLines(result.chunks[0]?.content ?? "");
    expect(lines).toContain("- packages/app/src/user.ts");
    // The worktree-only forward dep must survive too — the same filter guards
    // the reverse scan, but the forward path must not regress alongside it.
    expect(lines).toContain("- packages/app/src/worktree-dep.ts");
  });

  test("AC5: with execRoot unset, fetch resolves against repoRoot (unchanged behaviour)", async () => {
    setupDeps(
      {
        "/repo/packages/app/src/index.ts": 'import "./dep";',
        "/repo/packages/app/src/dep.ts": "export const dep = 1;",
      },
      { "/repo": ["packages/app/src/index.ts", "packages/app/src/dep.ts"] },
    );
    const provider = new CodeNeighborProvider();

    const result = await provider.fetch(
      makeRequest({
        repoRoot: "/repo",
        // execRoot intentionally omitted — AC5's fallback.
        packageDir: "/repo/packages/app",
        storyWorkdir: "packages/app",
        touchedFiles: ["packages/app/src/index.ts"],
      }),
    );

    // AC5: identical neighbour set as today's repoRoot-resolved behaviour.
    const lines = neighborLines(result.chunks[0]?.content ?? "");
    expect(lines).toContain("- packages/app/src/dep.ts");
  });
});

describe("CodeNeighborProvider — cross-package scan removal (nax#2074)", () => {
  // US-001: scanRoot derives from execRoot (which falls back to repoRoot when
  // unset). The reverse-dep glob runs once at that single root — a partition
  // by neighbour-scope option was the pre-US-001 shape that left
  // worktree-only neighbours out of scope (nax#2134).
  test("reverse-dep glob runs once at execRoot — single scan root, not partitioned by neighbour-scope", async () => {
    const globbedRoots: string[] = [];
    const globByCwd: Record<string, string[]> = {
      "/repo": ["packages/app/src/index.ts", "packages/lib/src/helper.ts"],
    };
    setupDeps({ "/repo/packages/app/src/index.ts": "export const app = 1;" }, globByCwd);
    // Record the scan roots instead of delegating: setupDeps' stub takes two
    // parameters while the real dep takes five, so a pass-through wrapper only
    // adds a typing problem.
    _codeNeighborDeps.glob = (_pattern: string, cwd: string) => {
      globbedRoots.push(cwd);
      return { files: globByCwd[cwd] ?? [], truncated: false };
    };

    await new CodeNeighborProvider().fetch(makeRequest({ touchedFiles: ["packages/app/src/index.ts"] }));

    expect(globbedRoots).toEqual(["/repo"]);
  });

  // US-001 (AC1-AC4): with execRoot SET, the reverse-dep glob must run at the
  // story's worktree root — not repoRoot, and not the package dir. The AC1-AC4
  // tests do fail if scanRoot regresses (verified by reverting it to both
  // repoRoot and packageDir), but only incidentally: their fixture keys
  // `globByCwd` by cwd, so a wrong cwd yields an empty file list rather than a
  // wrong one. This test pins the cwd itself, which is the behavior US-001 adds
  // and the only spelling that makes the scan root explicit.
  test("reverse-dep glob runs at the worktree root when execRoot is set", async () => {
    const globbedRoots: string[] = [];
    const worktreeRoot = "/repo/.nax-wt/US-001";
    const globByCwd: Record<string, string[]> = {
      [worktreeRoot]: ["packages/app/src/index.ts", "packages/app/src/user.ts"],
    };
    setupDeps(
      {
        [`${worktreeRoot}/packages/app/src/index.ts`]: "export const app = 1;",
        [`${worktreeRoot}/packages/app/src/user.ts`]: 'import "./index";',
      },
      globByCwd,
    );
    _codeNeighborDeps.glob = (_pattern: string, cwd: string) => {
      globbedRoots.push(cwd);
      return { files: globByCwd[cwd] ?? [], truncated: false };
    };

    const result = await new CodeNeighborProvider().fetch(
      makeRequest({
        repoRoot: "/repo",
        execRoot: worktreeRoot,
        packageDir: `${worktreeRoot}/packages/app`,
        storyWorkdir: "packages/app",
        touchedFiles: ["packages/app/src/index.ts"],
      }),
    );

    // The scan ran at the worktree root — not "/repo" (main checkout) and not
    // the package dir.
    expect(globbedRoots).toEqual([worktreeRoot]);
    // ...and the reverse dep that scan found is surfaced.
    expect(neighborLines(result.chunks[0]?.content ?? "")).toContain("- packages/app/src/user.ts");
  });
});
