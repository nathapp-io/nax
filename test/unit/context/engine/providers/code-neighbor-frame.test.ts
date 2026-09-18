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

describe("CodeNeighborProvider — worktree isolation residual (PARKED, nax path-frame follow-up #1, nax#2093 class)", () => {
  // REAL production shape under storyIsolation: "worktree": `request.repoRoot`
  // is the MAIN CHECKOUT (`/repo`) while `packageDir` is the worktree package
  // (`/repo/.nax-wt/US-001/packages/app`). code-neighbor resolves disk paths
  // against `repoRoot` (Task 3 / PR4), so it reads the main checkout, not the
  // worktree the story actually executes in. This test CHARACTERIZES that
  // parked residual rather than hiding it.
  //
  // PARKED by controller ruling: the fix is out of PR4's subtractive scope.
  //
  // FOLLOW-UP (nax path-frame follow-up #1): thread a worktree-aware exec root
  // (`storyExecRoot`) onto `ContextRequest` — the same field git-history.ts's
  // RESIDUAL asks for — and resolve disk paths against it. Spec §6's live run
  // covers EXEC/WRITE containment, NOT context resolution, so it will not catch
  // this. When the field lands, resolution reads the worktree and this test
  // must flip to assert `- packages/app/src/worktree-dep.ts` and the absence of
  // `- packages/app/src/main-dep.ts`.
  test("resolution reads the main checkout, not the worktree (parked residual)", async () => {
    setupDeps(
      {
        // Main checkout copy — what `request.repoRoot` points at.
        "/repo/packages/app/src/index.ts": 'import "./main-dep";',
        "/repo/packages/app/src/main-dep.ts": "export const mainDep = 1;",
        // Worktree copy — where the story actually executes.
        "/repo/.nax-wt/US-001/packages/app/src/index.ts": 'import "./worktree-dep";',
        "/repo/.nax-wt/US-001/packages/app/src/worktree-dep.ts": "export const worktreeDep = 1;",
      },
      { "/repo/.nax-wt/US-001/packages/app": ["src/index.ts", "src/worktree-dep.ts"] },
    );
    const provider = new CodeNeighborProvider();

    const result = await provider.fetch(
      makeRequest({
        repoRoot: "/repo",
        packageDir: "/repo/.nax-wt/US-001/packages/app",
        storyWorkdir: "packages/app",
        touchedFiles: ["packages/app/src/index.ts"],
      }),
    );

    const lines = neighborLines(result.chunks[0]?.content ?? "");
    // Documented residual: the main checkout's neighbour is surfaced...
    expect(lines).toContain("- packages/app/src/main-dep.ts");
    // ...and the worktree-only neighbour the story actually depends on is not.
    expect(lines.some((line) => line.includes("worktree-dep"))).toBe(false);
  });
});

describe("CodeNeighborProvider — cross-package scan removal (nax#2074)", () => {
  // parseImportSpecifiers keeps only "."-prefixed specifiers, so a real
  // cross-package import is never collected and the sibling scan could only
  // ever produce false matches. It must not run, and must not be paid for.
  test("package scope globs only the story's own package, never a sibling", async () => {
    const globbedRoots: string[] = [];
    const globByCwd: Record<string, string[]> = {
      "/repo/packages/app": ["src/index.ts"],
      "/repo/packages/lib": ["src/helper.ts"],
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

    expect(globbedRoots).toEqual(["/repo/packages/app"]);
  });
});
