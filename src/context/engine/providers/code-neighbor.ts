/**
 * Context Engine v2 — CodeNeighborProvider
 *
 * Surfaces import-graph neighbors for files this story touches:
 *   - Forward deps:  files imported by the touched file (import/require parse)
 *   - Reverse deps:  files that import the touched file (Bun.Glob scan, capped at 200 files)
 *   - Sibling test:  mirrored test file (src/foo/bar.ts → test/unit/foo/bar.test.ts)
 *
 * Language scope:
 *   Forward dep parsing is JavaScript/TypeScript-only (import/require syntax).
 *   For other languages (Python, Go, Rust, etc.), forward deps return empty;
 *   reverse deps and sibling tests are still attempted where applicable.
 *   The reverse-dep glob covers common source extensions across languages.
 *
 * The combined result is collapsed into a single "neighbor" kind chunk.
 * Files are capped at MAX_FILES; neighbors per file capped at MAX_NEIGHBORS_PER_FILE.
 * Chunk is capped at MAX_CHUNK_TOKENS to avoid budget overrun.
 *
 * Phase 3.
 *
 * See: docs/specs/SPEC-context-engine-v2.md §CodeNeighborProvider
 */

import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { getLogger } from "../../../logger";
import { discoverWorkspacePackages } from "../../../test-runners/detect/workspace";
import { isRelativeAndSafe } from "../../../utils/path-security";
import type { ContextProviderResult, ContextRequest, IContextProvider, RawChunk } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────────────

export interface CodeNeighborProviderOptions {
  /**
   * Scope of the working directory for neighbor discovery (AC-56).
   * "repo" — scans from repoRoot (full repo).
   * "package" — scans from packageDir (monorepo package boundary, default).
   */
  neighborScope?: "repo" | "package";
  /**
   * Maximum neighbor traversal depth across the package boundary (AC-62).
   * Only applies when neighborScope is "package".
   * 0 — no cross-package scanning.
   * 1 (default) — additionally scans repoRoot for cross-package reverse deps.
   */
  crossPackageDepth?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum number of files to process */
const MAX_FILES = 10;

/** Maximum number of neighbors (forward + reverse combined) per file */
const MAX_NEIGHBORS_PER_FILE = 8;

/** Maximum files scanned during reverse-dep glob */
const MAX_GLOB_FILES = 200;

/** Token ceiling for the combined neighbor chunk */
const MAX_CHUNK_TOKENS = 500;

/**
 * Source file extensions to scan for reverse deps.
 * Covers common languages nax may be run against.
 */
const SOURCE_GLOB = "src/**/*.{ts,tsx,js,jsx,py,go,rs,java,rb,php,cs,cpp,c,h}";

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps
// ─────────────────────────────────────────────────────────────────────────────

export const _codeNeighborDeps = {
  fileExists: (path: string): Promise<boolean> => Bun.file(path).exists(),
  readFile: (path: string): Promise<string> => Bun.file(path).text(),
  discoverWorkspacePackages: (repoRoot: string): Promise<string[]> => discoverWorkspacePackages(repoRoot),
  getLogger,
  glob: (pattern: string, cwd: string): string[] => {
    const g = new Bun.Glob(pattern);
    const results: string[] = [];
    let count = 0;
    let truncated = false;
    for (const file of g.scanSync({ cwd, absolute: false })) {
      if (count >= MAX_GLOB_FILES) {
        truncated = true;
        break;
      }
      results.push(file);
      count++;
    }
    if (truncated) {
      _codeNeighborDeps.getLogger().debug("context-v2", "Glob cap reached — results truncated", {
        pattern,
        cwd,
        cap: MAX_GLOB_FILES,
      });
    }
    return results;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function contentHash8(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

/** Patterns that match JS/TS import/require statements — used with matchAll() */
const FROM_PATTERN = /from\s+['"]([^'"]+)['"]/g;
const REQUIRE_PATTERN = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const IMPORT_SIDE_EFFECT_PATTERN = /import\s+['"]([^'"]+)['"]/g;

/**
 * Parse JS/TS import specifiers from file content.
 * Returns only relative paths (starts with ".") — ignores node_modules.
 * Returns empty for non-JS/TS files (no import syntax match).
 */
function parseImportSpecifiers(content: string): string[] {
  const specifiers = new Set<string>();
  for (const match of content.matchAll(FROM_PATTERN)) {
    if (match[1]?.startsWith(".")) specifiers.add(match[1]);
  }
  for (const match of content.matchAll(REQUIRE_PATTERN)) {
    if (match[1]?.startsWith(".")) specifiers.add(match[1]);
  }
  for (const match of content.matchAll(IMPORT_SIDE_EFFECT_PATTERN)) {
    if (match[1]?.startsWith(".")) specifiers.add(match[1]);
  }
  return [...specifiers];
}

/**
 * Resolve a relative import specifier to a workdir-relative path.
 * Extension candidates are checked in order — with-extension first so the
 * returned path always carries the extension (avoids bare "src/utils/helper").
 * Returns null if all candidates fall outside workdir.
 */
function resolveImport(specifier: string, fromFile: string, workdir: string): string | null {
  const base = resolve(workdir, fromFile, "..", specifier);
  // Extension-first ordering ensures the returned path includes the extension.
  const candidates = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`, base];
  for (const candidate of candidates) {
    const rel = relative(workdir, candidate);
    if (!rel.startsWith("..")) return rel;
  }
  return null;
}

/**
 * Derive the colocated sibling test path for a source file.
 * Returns the test file in the same directory as the source.
 *   src/foo/bar.ts   → src/foo/bar.test.ts
 *   src/foo/bar.tsx  → src/foo/bar.test.tsx
 *   src/foo/bar.test.ts → null  (already a test file)
 *
 * Used by collectNeighbors to prefer colocated tests when they exist on disk,
 * before falling back to the mirrored test/unit/ path. See #526 Bug 2.
 */
function colocalTestPath(filePath: string): string | null {
  const match = filePath.match(/^(.+)\.(ts|tsx|js|jsx)$/);
  if (!match) return null;
  const base = match[1] ?? "";
  if (base.endsWith(".test") || base.endsWith(".spec")) return null;
  const ext = match[2] ?? "ts";
  return `${base}.test.${ext}`;
}

/**
 * Derive the mirrored sibling test file path for a source file.
 * Maps src/ → test/unit/, preserving the source extension.
 *   src/foo/bar.ts       → test/unit/foo/bar.test.ts
 *   src/foo/bar.tsx      → test/unit/foo/bar.test.tsx
 *   src/foo/bar.test.ts  → null  (already a test file)
 *   src/foo/bar.spec.ts  → null  (already a test file)
 *
 * Returning null for test-file inputs prevents the `.test.test.ts` /
 * `.spec.spec.ts` hallucination that appeared when the provider was fed
 * a test file as a touched file (e.g. via PRD `contextFiles`). See #526.
 */
function mirroredTestPath(filePath: string): string | null {
  const srcMatch = filePath.match(/^src\/(.+)\.(ts|tsx|js|jsx)$/);
  if (!srcMatch) return null;
  const base = srcMatch[1] ?? "";
  if (base.endsWith(".test") || base.endsWith(".spec")) return null;
  const ext = srcMatch[2] ?? "ts";
  return `test/unit/${base}.test.${ext}`;
}

/**
 * Collect neighbors for a single file:
 * - forward deps (JS/TS import parse only — empty for other languages)
 * - reverse deps (all common source extensions)
 * - sibling test file (JS/TS/JSX/TSX only)
 *
 * extraGlobWorkdirs: when provided (AC-62 crossPackageDepth > 0), also scans
 * each directory for cross-package reverse deps (workspace package dirs or repoRoot).
 */
async function collectNeighbors(filePath: string, workdir: string, extraGlobWorkdirs?: string[]): Promise<string[]> {
  const neighbors = new Set<string>();

  // Forward deps (JS/TS only)
  if (await _codeNeighborDeps.fileExists(join(workdir, filePath))) {
    const content = await _codeNeighborDeps.readFile(join(workdir, filePath));
    for (const spec of parseImportSpecifiers(content)) {
      const resolved = resolveImport(spec, filePath, workdir);
      if (resolved && resolved !== filePath) neighbors.add(resolved);
    }
  }

  // Reverse deps — scan for files that import this file.
  // Quick check uses the base name (without extension) — broad but avoids parsing every file.
  const fileBaseName = (filePath.split("/").pop() ?? filePath).replace(/\.[^.]+$/, "");
  const fileNoExt = filePath.replace(/\.[^.]+$/, "");

  const scanForReverseDeps = async (scanWorkdir: string) => {
    const srcFiles = _codeNeighborDeps.glob(SOURCE_GLOB, scanWorkdir);
    for (const srcFile of srcFiles) {
      if (neighbors.size >= MAX_NEIGHBORS_PER_FILE) break;
      if (srcFile === filePath) continue;
      try {
        const content = await _codeNeighborDeps.readFile(join(scanWorkdir, srcFile));
        if (content.includes(fileBaseName)) {
          for (const spec of parseImportSpecifiers(content)) {
            const resolved = resolveImport(spec, srcFile, scanWorkdir);
            if (resolved === filePath || resolved === fileNoExt) {
              neighbors.add(srcFile);
              break;
            }
          }
        }
      } catch {
        // Skip unreadable files
      }
    }
  };

  await scanForReverseDeps(workdir);

  // AC-62: cross-package reverse deps — scan each extra workdir (workspace packages)
  if (extraGlobWorkdirs) {
    for (const extraDir of extraGlobWorkdirs) {
      if (neighbors.size >= MAX_NEIGHBORS_PER_FILE) break;
      await scanForReverseDeps(extraDir);
    }
  }

  // Sibling test (JS/TS/JSX/TSX only).
  // Prefer colocated test (src/foo.test.ts) when it exists on disk (#526 Bug 2);
  // fall back to the test/unit/ mirror hint for projects that use a separate test dir.
  const colocal = colocalTestPath(filePath);
  const mirrored = mirroredTestPath(filePath);
  if (colocal && (await _codeNeighborDeps.fileExists(join(workdir, colocal)))) {
    neighbors.add(colocal);
  } else if (mirrored) {
    neighbors.add(mirrored);
  }

  return [...neighbors].slice(0, MAX_NEIGHBORS_PER_FILE);
}

// ─────────────────────────────────────────────────────────────────────────────
// AC-62 workspace detection helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the extra glob workdirs for cross-package scanning (AC-62).
 *
 * When neighborScope is "package" and crossPackageDepth > 0 in a monorepo,
 * detects workspace packages (pnpm-workspace.yaml, package.json#workspaces, etc.)
 * and returns their absolute paths as scan roots (excluding the current packageDir).
 * Falls back to [repoRoot] when workspace detection finds nothing — this scans
 * the whole repo as a safe fallback for non-standard monorepo layouts.
 *
 * Returns undefined when cross-package scanning is not needed.
 */
async function resolveExtraGlobWorkdirs(
  neighborScope: "repo" | "package",
  crossPackageDepth: number,
  repoRoot: string,
  packageDir: string,
): Promise<string[] | undefined> {
  if (neighborScope !== "package" || crossPackageDepth <= 0 || packageDir === repoRoot) {
    return undefined;
  }
  try {
    const relPkgDirs = await _codeNeighborDeps.discoverWorkspacePackages(repoRoot);
    if (relPkgDirs.length === 0) return [repoRoot];
    // Convert relative workspace dirs to absolute, excluding the current package
    return relPkgDirs.map((rel) => join(repoRoot, rel)).filter((abs) => abs !== packageDir);
  } catch {
    return [repoRoot];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Surfaces import-graph neighbors for files touched by the story.
 * Returns a single combined chunk with kind "neighbor".
 */
export class CodeNeighborProvider implements IContextProvider {
  readonly id = "code-neighbor";
  readonly kind = "neighbor" as const;

  private readonly neighborScope: "repo" | "package";
  private readonly crossPackageDepth: number;

  constructor(options: CodeNeighborProviderOptions = {}) {
    this.neighborScope = options.neighborScope ?? "package";
    this.crossPackageDepth = options.crossPackageDepth ?? 1;
  }

  async fetch(request: ContextRequest): Promise<ContextProviderResult> {
    const { touchedFiles } = request;
    const workdir = this.neighborScope === "package" ? request.packageDir : request.repoRoot;
    // AC-62: cross-package scanning — detect shared workspace dirs instead of scanning full repoRoot.
    // Only active when neighborScope "package", crossPackageDepth > 0, and this is a monorepo
    // (packageDir !== repoRoot). Falls back to [repoRoot] when no workspace packages are found.
    const extraGlobWorkdirs = await resolveExtraGlobWorkdirs(
      this.neighborScope,
      this.crossPackageDepth,
      request.repoRoot,
      request.packageDir,
    );
    if (!touchedFiles || touchedFiles.length === 0) {
      return { chunks: [], pullTools: [] };
    }

    const filesToProcess = touchedFiles.filter(isRelativeAndSafe).slice(0, MAX_FILES);

    const sections: string[] = [];
    for (const file of filesToProcess) {
      const neighbors = await collectNeighbors(file, workdir, extraGlobWorkdirs);
      if (neighbors.length > 0) {
        sections.push(`### ${file}\n${neighbors.map((n) => `- ${n}`).join("\n")}`);
      }
    }

    if (sections.length === 0) {
      return { chunks: [], pullTools: [] };
    }

    const header = "## Code Neighbors\n\nRelated files (imports, reverse-deps, tests):";
    const rawContent = `${header}\n\n${sections.join("\n\n")}`;

    // Cap content to avoid overrunning token budget
    const maxChars = MAX_CHUNK_TOKENS * 4;
    const content = rawContent.length > maxChars ? rawContent.slice(0, maxChars) : rawContent;
    const tokens = Math.ceil(content.length / 4);

    const chunk: RawChunk = {
      id: `code-neighbor:${contentHash8(content)}`,
      kind: "neighbor",
      scope: "story",
      role: ["implementer", "tdd"],
      content,
      tokens,
      rawScore: 0.65,
    };

    return { chunks: [chunk], pullTools: [] };
  }
}
