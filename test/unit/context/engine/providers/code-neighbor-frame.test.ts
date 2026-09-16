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
import { UNREADABLE_MARKER } from "@/utils/path-frame";

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
  _codeNeighborDeps.discoverWorkspacePackages = async () => [];
}

let orig: {
  fileExists: typeof _codeNeighborDeps.fileExists;
  readFile: typeof _codeNeighborDeps.readFile;
  glob: typeof _codeNeighborDeps.glob;
  detectLanguage: typeof _codeNeighborDeps.detectLanguage;
  discoverWorkspacePackages: typeof _codeNeighborDeps.discoverWorkspacePackages;
};

beforeEach(() => {
  orig = {
    fileExists: _codeNeighborDeps.fileExists,
    readFile: _codeNeighborDeps.readFile,
    glob: _codeNeighborDeps.glob,
    detectLanguage: _codeNeighborDeps.detectLanguage,
    discoverWorkspacePackages: _codeNeighborDeps.discoverWorkspacePackages,
  };
});

afterEach(() => {
  _codeNeighborDeps.fileExists = orig.fileExists;
  _codeNeighborDeps.readFile = orig.readFile;
  _codeNeighborDeps.glob = orig.glob;
  _codeNeighborDeps.detectLanguage = orig.detectLanguage;
  _codeNeighborDeps.discoverWorkspacePackages = orig.discoverWorkspacePackages;
});

function neighborLines(content: string): string[] {
  return content.split("\n").filter((line) => line.startsWith("- "));
}

describe("CodeNeighborProvider — path frame (nax#2074)", () => {
  // THE ISSUE'S WORKED EXAMPLE, and the only setup that reproduces the false
  // reverse-dep: it needs the SIBLING scan, where srcFile is relative to
  // packages/lib while filePath is relative to packages/app. Measured against
  // the pre-fix code this returns `- src/helper.ts`.
  //
  // This test is RETIRED in Task 2 Step 4: it pins the behaviour of the scan
  // being deleted. Its durable successor is the "globs only the story's own
  // package" case added there.
  test("a sibling package's same-named import is not a reverse dependency", async () => {
    setupDeps(
      {
        "/repo/packages/app/src/index.ts": "export const app = 1;",
        "/repo/packages/lib/src/helper.ts": 'import "./index";',
        "/repo/packages/lib/src/index.ts": "export const lib = 1;",
      },
      { "/repo/packages/app": ["src/index.ts"], "/repo/packages/lib": ["src/helper.ts", "src/index.ts"] },
    );
    _codeNeighborDeps.discoverWorkspacePackages = async () => ["packages/app", "packages/lib"];
    const provider = new CodeNeighborProvider();

    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/index.ts"] }));

    const lines = neighborLines(result.chunks[0]?.content ?? "");
    expect(lines).not.toContain("- src/helper.ts");
    expect(lines.some((line) => line.includes("helper.ts"))).toBe(false);
  });

  // The other sign of the same defect. Pre-fix, a repo-rooted scan compares a
  // repo-framed srcFile against a package-framed filePath, so a genuine
  // cross-package dependent matches NOTHING and is silently dropped; the
  // `srcFile === filePath` self-skip would have discarded it anyway had the
  // frames agreed. Measured against the pre-fix code this returns no neighbour
  // at all beyond the sibling-test hint.
  test("a genuine cross-package dependent is found and marked unreadable", async () => {
    setupDeps(
      {
        "/repo/packages/app/src/index.ts": "export const app = 1;",
        "/repo/packages/lib/src/index.ts": 'import "../../app/src/index";',
      },
      { "/repo": ["packages/app/src/index.ts", "packages/lib/src/index.ts"] },
    );
    const provider = new CodeNeighborProvider({ neighborScope: "repo" });

    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/index.ts"] }));

    const lines = neighborLines(result.chunks[0]?.content ?? "");
    expect(lines).toContain(`- packages/lib/src/index.ts${UNREADABLE_MARKER}`);
  });

  // A genuine same-package dependent found via a repo-rooted scan must come
  // back package-relative, because the agent's file tools are rooted there.
  test("a dependent inside the consumer's package renders package-relative", async () => {
    setupDeps(
      {
        "/repo/packages/app/src/index.ts": "export const app = 1;",
        "/repo/packages/app/src/user.ts": 'import "./index";',
      },
      { "/repo": ["packages/app/src/index.ts", "packages/app/src/user.ts"] },
    );
    const provider = new CodeNeighborProvider({ neighborScope: "repo" });

    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/index.ts"] }));

    const lines = neighborLines(result.chunks[0]?.content ?? "");
    expect(lines).toContain("- src/user.ts");
    expect(lines.some((line) => line.includes(UNREADABLE_MARKER))).toBe(false);
  });

  // scopePaths is an attribution key, not prompt text: the marker must not leak
  // into it, or the same file is attributed under two different strings.
  test("scopePaths records the marked neighbour without the marker", async () => {
    setupDeps(
      {
        "/repo/packages/app/src/index.ts": "export const app = 1;",
        "/repo/packages/lib/src/index.ts": 'import "../../app/src/index";',
      },
      { "/repo": ["packages/app/src/index.ts", "packages/lib/src/index.ts"] },
    );
    const provider = new CodeNeighborProvider({ neighborScope: "repo" });

    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/index.ts"] }));

    expect(result.chunks[0]?.scopePaths).toContain("packages/lib/src/index.ts");
    expect(result.chunks[0]?.scopePaths?.some((p) => p.includes(UNREADABLE_MARKER))).toBe(false);
  });

  // The touched file is package-framed by contract (types.ts:329). Under
  // neighborScope "repo" the OLD code resolved it against repoRoot and read
  // nothing, so forward deps silently vanished.
  test("forward deps are resolved against packageDir even when the scan root is the repo", async () => {
    setupDeps(
      {
        "/repo/packages/app/src/index.ts": 'import "./dep";',
        "/repo/packages/app/src/dep.ts": "export const dep = 1;",
      },
      { "/repo": ["packages/app/src/index.ts", "packages/app/src/dep.ts"] },
    );
    const provider = new CodeNeighborProvider({ neighborScope: "repo" });

    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/index.ts"] }));

    expect(neighborLines(result.chunks[0]?.content ?? "")).toContain("- src/dep.ts");
  });
});
