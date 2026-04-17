/**
 * CodeNeighborProvider — unit tests
 *
 * All filesystem I/O is intercepted via _codeNeighborDeps injection.
 * No real files are read.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { CodeNeighborProvider, _codeNeighborDeps } from "../../../../../src/context/engine/providers/code-neighbor";
import type { CodeNeighborProviderOptions } from "../../../../../src/context/engine/providers/code-neighbor";
import type { ContextRequest } from "../../../../../src/context/engine/types";

// ─────────────────────────────────────────────────────────────────────────────
// Saved originals
// ─────────────────────────────────────────────────────────────────────────────

let origFileExists: typeof _codeNeighborDeps.fileExists;
let origReadFile: typeof _codeNeighborDeps.readFile;
let origGlob: typeof _codeNeighborDeps.glob;
let origDiscoverWorkspacePackages: typeof _codeNeighborDeps.discoverWorkspacePackages;

beforeEach(() => {
  origFileExists = _codeNeighborDeps.fileExists;
  origReadFile = _codeNeighborDeps.readFile;
  origGlob = _codeNeighborDeps.glob;
  origDiscoverWorkspacePackages = _codeNeighborDeps.discoverWorkspacePackages;
  // Default: no workspace packages (non-monorepo fallback)
  _codeNeighborDeps.discoverWorkspacePackages = async () => [];
});

afterEach(() => {
  _codeNeighborDeps.fileExists = origFileExists;
  _codeNeighborDeps.readFile = origReadFile;
  _codeNeighborDeps.glob = origGlob;
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
  _codeNeighborDeps.glob = (_pattern: string, _cwd: string) => globFiles;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("CodeNeighborProvider", () => {
  const provider = new CodeNeighborProvider();

  test("returns empty when touchedFiles is absent", async () => {
    setupDeps({});
    const result = await provider.fetch(makeRequest());
    expect(result.chunks).toHaveLength(0);
  });

  test("returns empty when touchedFiles is empty array", async () => {
    setupDeps({});
    const result = await provider.fetch(makeRequest({ touchedFiles: [] }));
    expect(result.chunks).toHaveLength(0);
  });

  test("returns empty when file is not in src/ and has no reverse deps", async () => {
    // Files outside src/ (e.g. config files) have no sibling test path or forward deps
    setupDeps({ globFiles: [] });
    const result = await provider.fetch(makeRequest({ touchedFiles: ["scripts/build.ts"] }));
    expect(result.chunks).toHaveLength(0);
  });

  test("includes sibling test even when src file does not exist on disk", async () => {
    // src/ files always get a sibling test neighbor derived from their path
    setupDeps({ globFiles: [] });
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/missing.ts"] }));
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.content).toContain("test/unit/missing.test.ts");
  });

  test("includes sibling test file in neighbors", async () => {
    setupDeps({
      files: { "src/foo/bar.ts": 'import "./dep"' },
      globFiles: [],
    });
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/foo/bar.ts"] }));
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.content).toContain("test/unit/foo/bar.test.ts");
  });

  test("chunk has kind 'neighbor'", async () => {
    setupDeps({ files: { "src/a.ts": "" }, globFiles: [] });
    // Only the sibling test is added; a.ts exists so we get at least one neighbor
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/a.ts"] }));
    expect(result.chunks[0]?.kind).toBe("neighbor");
  });

  test("chunk has scope 'story'", async () => {
    setupDeps({ files: { "src/a.ts": "" }, globFiles: [] });
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/a.ts"] }));
    expect(result.chunks[0]?.scope).toBe("story");
  });

  test("chunk role includes implementer and tdd", async () => {
    setupDeps({ files: { "src/a.ts": "" }, globFiles: [] });
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/a.ts"] }));
    expect(result.chunks[0]?.role).toContain("implementer");
    expect(result.chunks[0]?.role).toContain("tdd");
  });

  test("chunk rawScore is 0.65", async () => {
    setupDeps({ files: { "src/a.ts": "" }, globFiles: [] });
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/a.ts"] }));
    expect(result.chunks[0]?.rawScore).toBe(0.65);
  });

  test("forward dep is included when file has import statements", async () => {
    setupDeps({
      files: {
        "src/service.ts": 'import { helper } from "./utils/helper"',
        "src/utils/helper.ts": "export const helper = () => {}",
      },
      globFiles: [],
    });
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/service.ts"] }));
    const content = result.chunks[0]?.content ?? "";
    expect(content).toContain("src/utils/helper");
  });

  test("reverse dep is included when another file imports the touched file", async () => {
    setupDeps({
      files: {
        "src/utils/helper.ts": "",
        "src/service.ts": 'import { helper } from "./utils/helper"',
      },
      globFiles: ["src/service.ts"],
    });
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/utils/helper.ts"] }));
    const content = result.chunks[0]?.content ?? "";
    expect(content).toContain("src/service.ts");
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

  test("chunk tokens equals ceil(content.length / 4)", async () => {
    setupDeps({ files: { "src/a.ts": "" }, globFiles: [] });
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/a.ts"] }));
    const chunk = result.chunks[0]!;
    expect(chunk.tokens).toBe(Math.ceil(chunk.content.length / 4));
  });

  test("chunk content is capped at MAX_CHUNK_TOKENS * 4 characters", async () => {
    // Generate many files to create a long section list
    const manyFiles = Array.from({ length: 10 }, (_, i) => `src/file${i}.ts`);
    const fileMap: Record<string, string> = {};
    for (const f of manyFiles) fileMap[f] = "";
    setupDeps({ files: fileMap, globFiles: [] });

    const result = await provider.fetch(makeRequest({ touchedFiles: manyFiles }));
    const chunk = result.chunks[0];
    if (chunk) {
      expect(chunk.content.length).toBeLessThanOrEqual(500 * 4);
      expect(chunk.tokens).toBe(Math.ceil(chunk.content.length / 4));
    }
  });

  test("sibling test path: non-src files produce no sibling", async () => {
    // test/ files themselves have no sibling
    setupDeps({ files: { "test/unit/foo.test.ts": "" }, globFiles: [] });
    const result = await provider.fetch(makeRequest({ touchedFiles: ["test/unit/foo.test.ts"] }));
    // No forward deps, no sibling test — chunk only if reverse deps exist
    // With empty glob, result should be empty
    expect(result.chunks).toHaveLength(0);
  });

  test(".tsx file sibling maps to .test.tsx not .test.ts", async () => {
    setupDeps({ files: { "src/components/Button.tsx": "" }, globFiles: [] });
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/components/Button.tsx"] }));
    const content = result.chunks[0]?.content ?? "";
    expect(content).toContain("test/unit/components/Button.test.tsx");
    expect(content).not.toContain("Button.test.ts\n");
  });

  test("reverse-dep scan continues past self-reference (continue, not break)", async () => {
    // When the touched file appears in the glob results, the scan must continue
    // past it to find other reverse deps — a break would terminate early.
    setupDeps({
      files: {
        "src/utils/target.ts": "",
        "src/service.ts": 'import { x } from "./utils/target"',
      },
      // Put the touched file first in glob order to trigger the continue path
      globFiles: ["src/utils/target.ts", "src/service.ts"],
    });
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/utils/target.ts"] }));
    const content = result.chunks[0]?.content ?? "";
    expect(content).toContain("src/service.ts");
  });

  test("does not include the touched file itself as a neighbor", async () => {
    setupDeps({
      files: { "src/a.ts": 'import "./a"' }, // import of itself — should not appear
      globFiles: [],
    });
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/a.ts"] }));
    const content = result.chunks[0]?.content ?? "";
    // The file header "src/a.ts" appears once (as the section title), but should
    // not appear in the neighbor list beneath it
    const lines = content.split("\n");
    const neighborLines = lines.filter((l) => l.startsWith("- "));
    for (const line of neighborLines) {
      expect(line).not.toBe("- src/a.ts");
    }
  });

  test("pullTools is always empty", async () => {
    setupDeps({ files: { "src/a.ts": "" }, globFiles: [] });
    const result = await provider.fetch(makeRequest({ touchedFiles: ["src/a.ts"] }));
    expect(result.pullTools).toEqual([]);
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
      return [];
    };
    _codeNeighborDeps.fileExists = async () => false;
    _codeNeighborDeps.readFile = async () => "";
    return captured;
  }

  test("default neighborScope is 'package' — glob runs in packageDir (and repoRoot via crossPackageDepth=1)", async () => {
    const cwds = captureGlobCwds();
    const p = new CodeNeighborProvider();
    await p.fetch(MONOREPO_REQUEST);
    expect(cwds).toContain("/repo/packages/api");
    expect(cwds).toContain("/repo"); // crossPackageDepth defaults to 1
  });

  test("neighborScope 'repo' — glob runs in repoRoot", async () => {
    const cwds = captureGlobCwds();
    const p = new CodeNeighborProvider({ neighborScope: "repo" } as CodeNeighborProviderOptions);
    await p.fetch(MONOREPO_REQUEST);
    expect(cwds).toContain("/repo");
    expect(cwds).not.toContain("/repo/packages/api");
  });

  test("neighborScope 'package' crossPackageDepth 0 — glob only in packageDir", async () => {
    const cwds = captureGlobCwds();
    const p = new CodeNeighborProvider({ neighborScope: "package", crossPackageDepth: 0 } as CodeNeighborProviderOptions);
    await p.fetch(MONOREPO_REQUEST);
    expect(cwds).toContain("/repo/packages/api");
    expect(cwds).not.toContain("/repo");
  });

  test("non-monorepo: neighborScope 'package' uses repoRoot when packageDir === repoRoot", async () => {
    const cwds = captureGlobCwds();
    const p = new CodeNeighborProvider({ neighborScope: "package" } as CodeNeighborProviderOptions);
    await p.fetch(makeRequest({ touchedFiles: ["src/a.ts"] })); // packageDir === repoRoot
    expect(cwds).toContain("/repo");
  });

  test("crossPackageDepth 0 with neighborScope 'package' — glob only in packageDir", async () => {
    const cwds = captureGlobCwds();
    const p = new CodeNeighborProvider({ neighborScope: "package", crossPackageDepth: 0 } as CodeNeighborProviderOptions);
    await p.fetch(MONOREPO_REQUEST);
    expect(cwds.filter((c) => c === "/repo/packages/api")).toHaveLength(1);
    expect(cwds).not.toContain("/repo");
  });

  test("crossPackageDepth 1 with neighborScope 'package' — falls back to repoRoot when no workspace detected", async () => {
    const cwds = captureGlobCwds();
    // discoverWorkspacePackages already returns [] from beforeEach → fallback to repoRoot
    const p = new CodeNeighborProvider({ neighborScope: "package", crossPackageDepth: 1 } as CodeNeighborProviderOptions);
    await p.fetch(MONOREPO_REQUEST);
    expect(cwds).toContain("/repo/packages/api");
    expect(cwds).toContain("/repo");
  });

  test("crossPackageDepth 1 — workspace detection scans detected package dirs (excludes current packageDir)", async () => {
    const cwds = captureGlobCwds();
    // Simulate workspace detection finding packages/api and packages/web
    _codeNeighborDeps.discoverWorkspacePackages = async () => ["packages/api", "packages/web"];
    const p = new CodeNeighborProvider({ neighborScope: "package", crossPackageDepth: 1 } as CodeNeighborProviderOptions);
    await p.fetch(MONOREPO_REQUEST);
    // packages/api is the current packageDir — excluded
    expect(cwds).toContain("/repo/packages/api"); // primary workdir scan
    expect(cwds).toContain("/repo/packages/web"); // cross-package scan
    expect(cwds).not.toContain("/repo"); // not fallback — workspace was detected
  });

  test("crossPackageDepth 1 — non-monorepo (packageDir === repoRoot) skips cross-package scan", async () => {
    const cwds = captureGlobCwds();
    const p = new CodeNeighborProvider({ neighborScope: "package", crossPackageDepth: 1 } as CodeNeighborProviderOptions);
    await p.fetch(makeRequest({ touchedFiles: ["src/a.ts"] })); // packageDir === repoRoot
    // Only one glob call (primary workdir), no cross-package
    expect(cwds.filter((c) => c === "/repo")).toHaveLength(1);
  });
});
