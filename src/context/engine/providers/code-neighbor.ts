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
 * Decompose a test-file glob into `{ prefix, suffix }` where:
 *   - `prefix` is the literal path segment(s) before the first `**` or `*`
 *   - `suffix` is whatever follows the last `*` wildcard
 *
 * Language-agnostic, works for:
 *   "test/unit/*\/*.test.ts" → { prefix: "test/unit/", suffix: ".test.ts" }
 *   "*\/*.test.ts"           → { prefix: "",           suffix: ".test.ts" }
 *   "*\/*_test.go"           → { prefix: "",           suffix: "_test.go" }
 *   "src/*\/*.spec.ts"       → { prefix: "src/",       suffix: ".spec.ts" }
 *
 * Returns null when no usable suffix can be extracted (pattern has no `*`
 * or the `*` is at the end with nothing after it).
 */
function decomposeTestGlob(pattern: string): { prefix: string; suffix: string } | null {
  const lastStar = pattern.lastIndexOf("*");
  if (lastStar === -1) return null;
  const suffix = pattern.slice(lastStar + 1);
  if (suffix.length === 0) return null;

  // First wildcard position — defines the literal prefix.
  const firstStar = pattern.indexOf("*");
  // Trim the trailing `/` of the prefix if present, so composition is clean.
  let prefix = pattern.slice(0, firstStar);
  if (prefix.endsWith("/")) prefix = prefix.slice(0, -1);
  return { prefix, suffix };
}

/**
 * Derive candidate sibling-test paths for a source file, in order of preference.
 *
 * ADR-009 compliant: no hardcoded extensions or directory names. Each glob in
 * `patterns` contributes up to two candidate shapes:
 *   1. Colocated — `<sourceStem><suffix>` (same directory as the source file)
 *   2. Mirrored  — `<globPrefix>/<innerStem><suffix>` (only when the source
 *      lives under `src/`, so we can substitute `src/` → `globPrefix/`)
 *
 * The caller:
 *   - Guards against test-file inputs via `resolved.regex` (prevents the
 *     `.test.test.ts` hallucination — #526 Bug 1).
 *   - Prefers candidates that exist on disk (#526 Bug 2).
 *
 * Returns an empty list when no candidate can be built — caller should then
 * skip the sibling-test hint entirely rather than fall back to hardcoding.
 */
function deriveSiblingTestCandidates(filePath: string, patterns: readonly string[]): string[] {
  // Source extension (preserved when building candidates so `.tsx` stays `.tsx`
  // even when the configured glob only lists `.ts`).
  const srcExtMatch = filePath.match(/\.[^.]+$/);
  if (!srcExtMatch) return [];
  const srcExt = srcExtMatch[0];
  const stemWithPath = filePath.slice(0, -srcExt.length);

  // Bug 1 guard (#526): if the source already ends with any pattern's suffix,
  // it is itself a test file — skip derivation to prevent `.test.test.ts` /
  // `.spec.spec.ts` / `_test_test.go` hallucination. This is a universal check
  // independent of full-path regex classification, because a user's configured
  // `testFilePatterns` may scope to a directory (e.g. `test/unit/`) that does
  // not match a touched-file path like `src/foo.test.ts`.
  for (const pattern of patterns) {
    const decomposed = decomposeTestGlob(pattern);
    if (decomposed && filePath.endsWith(decomposed.suffix)) return [];
    // Also handle the case where the source's stem ends with a marker that,
    // combined with the source extension, would produce a duplicate-marker
    // candidate. e.g. source=src/foo.spec.jsx under pattern `**/*.test.ts`
    // shouldn't yield `src/foo.spec.test.jsx`.
    if (decomposed) {
      const markerFromSuffix = stripExt(decomposed.suffix);
      if (markerFromSuffix.length > 0 && stemWithPath.endsWith(markerFromSuffix)) return [];
    }
  }
  // Extra safety: guard against stems ending with common test markers even when
  // the specific pattern doesn't use the same separator — tests frequently come
  // into providers via PRD contextFiles as `src/foo.test.ts` or `src/foo.spec.ts`.
  if (stemWithPath.endsWith(".test") || stemWithPath.endsWith(".spec")) return [];

  // Mirrored-layout rewrite: substitute `src/` segment with the glob's literal
  // prefix (e.g. `test/unit/`). Skipped when the source path has no `src/`
  // anchor — we cannot infer the mapping without one.
  const srcPrefixed = stemWithPath.startsWith("src/");
  const srcInMiddleIdx = stemWithPath.indexOf("/src/");
  let innerStem: string | null = null;
  let pkgPrefix = "";
  if (srcPrefixed) {
    innerStem = stemWithPath.slice("src/".length);
  } else if (srcInMiddleIdx >= 0) {
    pkgPrefix = `${stemWithPath.slice(0, srcInMiddleIdx)}/`;
    innerStem = stemWithPath.slice(srcInMiddleIdx + "/src/".length);
  }

  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (path: string) => {
    if (path === filePath) return; // never return the source itself
    if (!seen.has(path)) {
      seen.add(path);
      candidates.push(path);
    }
  };

  for (const pattern of patterns) {
    const decomposed = decomposeTestGlob(pattern);
    if (!decomposed) continue;
    const { prefix, suffix } = decomposed;

    // Split suffix into marker + its own extension. When the source extension
    // differs from the suffix's extension, preserve the source extension.
    // e.g. suffix=".test.ts", source=".tsx" → effective=".test.tsx"
    //      suffix="_test.go", source=".go"  → effective="_test.go"
    const suffixExt = (suffix.match(/\.[^.]+$/) ?? [""])[0];
    const marker = suffixExt ? suffix.slice(0, -suffixExt.length) : suffix;
    if (marker.length === 0) continue; // no marker → candidate would equal source
    const effectiveSuffix = `${marker}${srcExt}`;

    // Colocated — beside the source file.
    push(`${stemWithPath}${effectiveSuffix}`);
    // Mirrored — when we have a `src/` anchor and the glob has a literal prefix.
    if (innerStem !== null && prefix.length > 0) {
      push(`${pkgPrefix}${prefix}/${innerStem}${effectiveSuffix}`);
    }
  }
  return candidates;
}

/** Strip the trailing file extension from a path/suffix fragment. */
function stripExt(s: string): string {
  const m = s.match(/\.[^.]+$/);
  return m ? s.slice(0, -m[0].length) : s;
}

/**
 * Decide whether `filePath` is itself a test file under the resolved patterns.
 * Used by collectNeighbors to skip sibling-test derivation for test-file inputs
 * (prevents `.test.test.ts` / `.spec.spec.ts` hallucination — #526 Bug 1).
 */
function isTestFile(filePath: string, regex: readonly RegExp[]): boolean {
  return regex.some((re) => re.test(filePath));
}

/**
 * Collect neighbors for a single file:
 * - forward deps (JS/TS import parse only — empty for other languages)
 * - reverse deps (all common source extensions)
 * - sibling test file (derived from ResolvedTestPatterns, ADR-009 SSOT)
 *
 * extraGlobWorkdirs: when provided (AC-62 crossPackageDepth > 0), also scans
 * each directory for cross-package reverse deps (workspace package dirs or repoRoot).
 *
 * siblingTestContext: when provided, enables sibling-test derivation via the
 * resolver's globs + testDirs. When omitted, sibling-test hinting is skipped
 * (the legacy `test/unit/` hardcoding is gone — callers must thread the
 * resolver per ADR-009).
 */
async function collectNeighbors(
  filePath: string,
  workdir: string,
  extraGlobWorkdirs?: string[],
  siblingTestContext?: { globs: readonly string[]; regex: readonly RegExp[] },
): Promise<string[]> {
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

  // Sibling test — resolver-driven (ADR-009). Skipped entirely when no context
  // is threaded (callers must pass resolvedTestPatterns via ContextRequest).
  //
  // Selection order:
  //   1. First candidate that exists on disk wins — colocated is preferred over
  //      mirrored because it appears first in the candidate list. This is the
  //      #526 Bug 2 fix: projects using colocated tests get the real path back.
  //   2. If no candidate exists but a mirrored candidate was generated, use it
  //      as a TDD hint ("write the test here"). Preserves the pre-existing
  //      behaviour for src/-anchored sources with no test yet.
  //   3. Otherwise skip — do not hallucinate a path for non-src/ files or when
  //      no mirrored anchor exists.
  if (siblingTestContext && !isTestFile(filePath, siblingTestContext.regex)) {
    const candidates = deriveSiblingTestCandidates(filePath, siblingTestContext.globs);
    let chosen: string | null = null;
    for (const candidate of candidates) {
      if (await _codeNeighborDeps.fileExists(join(workdir, candidate))) {
        chosen = candidate;
        break;
      }
    }
    if (chosen === null) {
      // Find the first mirrored candidate (index > 0 after any colocated).
      // A mirrored candidate requires a src/-anchored source AND a non-empty
      // glob prefix; deriveSiblingTestCandidates omits it otherwise.
      const colocated = candidates[0];
      const mirrored = candidates.find((c, i) => i > 0 && c !== colocated);
      if (mirrored) chosen = mirrored;
    }
    if (chosen !== null && chosen !== filePath) neighbors.add(chosen);
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

    // ADR-009: sibling-test derivation requires resolver output on the request.
    // When ContextRequest.resolvedTestPatterns is absent (e.g. legacy callers
    // that pre-date the wiring), we skip sibling-test hinting entirely rather
    // than reintroducing hardcoded `test/unit/`+`.test.ts` assumptions.
    const siblingTestContext = request.resolvedTestPatterns
      ? {
          globs: request.resolvedTestPatterns.globs,
          regex: request.resolvedTestPatterns.regex,
        }
      : undefined;

    const sections: string[] = [];
    for (const file of filesToProcess) {
      const neighbors = await collectNeighbors(file, workdir, extraGlobWorkdirs, siblingTestContext);
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
