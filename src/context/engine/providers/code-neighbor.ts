/**
 * Context Engine v2 — CodeNeighborProvider (Phase 3)
 *
 * Surfaces forward deps, reverse deps (language-aware glob, configurable cap),
 * and sibling tests for files touched by the story.
 *
 * See: docs/specs/SPEC-context-engine-v2.md §CodeNeighborProvider
 */

import { join, relative, resolve } from "node:path";
import { discoverWorkspacePackages } from "@/test-runners/detect";
import type { NaxIgnoreMatcher } from "@/utils/path-filters";
import { getLogger } from "../../../logger";
import { detectLanguage } from "../../../project";
import { isRelativeAndSafe } from "../../../utils/path-security";
import type { ContextProviderResult, ContextRequest, IContextProvider } from "../types";
import { type ContentCacheState, createContentCacheState, readCached } from "./code-neighbor-cache";
import { type NeighborSection, assembleCodeNeighborChunk } from "./code-neighbor-chunk";

export type { ContentCacheState } from "./code-neighbor-cache";
export { createContentCacheState } from "./code-neighbor-cache";

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
  /**
   * Override the source-file glob for reverse-dep scanning (#895).
   * When omitted, derived from detectLanguage(packageDir) via SOURCE_GLOB_BY_LANGUAGE.
   */
  sourceGlob?: string;
  /**
   * Maximum files scanned per directory during reverse-dep glob (#895).
   * Default: 500 (raised from 200; language-aware glob reduces noise).
   * Applied per-directory: with crossPackageDepth > 0, each workspace package
   * dir counts separately, so effective total can be N × maxGlobFiles.
   */
  maxGlobFiles?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum number of files to process */
const MAX_FILES = 10;

/** Maximum number of neighbors (forward + reverse combined) per file */
const MAX_NEIGHBORS_PER_FILE = 8;

/** Default maximum files scanned during reverse-dep glob (#895) */
const MAX_GLOB_FILES_DEFAULT = 500;

// Per-language globs for reverse-dep scanning (#895, L1). Polyglot/unknown falls back to FALLBACK_SOURCE_GLOB.
const SOURCE_GLOB_BY_LANGUAGE: Record<string, string> = {
  typescript: "**/*.{ts,tsx,js,jsx,mjs,cjs}",
  javascript: "**/*.{js,jsx,mjs,cjs}",
  go: "**/*.go",
  python: "**/*.py",
  rust: "**/*.rs",
};

const FALLBACK_SOURCE_GLOB = "**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,rb,php,cs,cpp,c,h}";

/** Directory prefixes excluded from reverse-dep glob; checked as startsWith or interior segment. */
const EXCLUDED_DIR_PREFIXES = [
  "node_modules/",
  ".git/",
  ".nax/",
  "vendor/",
  "dist/",
  "build/",
  "out/",
  ".cache/",
] as const;

function isExcludedPath(file: string, ignoreMatchers: readonly NaxIgnoreMatcher[]): boolean {
  for (const prefix of EXCLUDED_DIR_PREFIXES) {
    if (file.startsWith(prefix) || file.includes(`/${prefix}`)) return true;
  }
  return ignoreMatchers.some((m) => m.test(file));
}

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps
// ─────────────────────────────────────────────────────────────────────────────

export const _codeNeighborDeps = {
  fileExists: (path: string): Promise<boolean> => Bun.file(path).exists(),
  readFile: (path: string): Promise<string> => Bun.file(path).text(),
  fileSize: async (path: string): Promise<number> => (await Bun.file(path).stat()).size,
  discoverWorkspacePackages: (repoRoot: string): Promise<string[]> => discoverWorkspacePackages(repoRoot),
  detectLanguage: (packageDir: string) => detectLanguage(packageDir),
  getLogger,
  glob: (
    pattern: string,
    cwd: string,
    ignoreMatchers: readonly NaxIgnoreMatcher[] = [],
    cap: number = MAX_GLOB_FILES_DEFAULT,
    ctx?: { storyId?: string; packageDir?: string },
  ): { files: string[]; truncated: boolean } => {
    const g = new Bun.Glob(pattern);
    const results: string[] = [];
    let count = 0;
    let truncated = false;
    for (const file of g.scanSync({ cwd, absolute: false })) {
      if (isExcludedPath(file, ignoreMatchers)) continue;
      if (count >= cap) {
        truncated = true;
        break;
      }
      results.push(file);
      count++;
    }
    if (truncated) {
      _codeNeighborDeps.getLogger().warn("context-v2", "Reverse-dep glob cap reached — results truncated", {
        storyId: ctx?.storyId,
        packageDir: ctx?.packageDir,
        pattern,
        cwd,
        cap,
        hint: "Increase context.v2.providers.maxGlobFiles or narrow context.v2.providers.sourceGlob",
      });
    }
    return { files: results, truncated };
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

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

/** Derive the source-file glob for reverse-dep scanning (#895, L1). */
async function resolveSourceGlob(override: string | undefined, packageDir: string): Promise<string> {
  if (override) return override;
  const language = await _codeNeighborDeps.detectLanguage(packageDir);
  return (language && SOURCE_GLOB_BY_LANGUAGE[language]) ?? FALLBACK_SOURCE_GLOB;
}

/** Result of a pre-scanned directory for reverse-dep matching. */
interface ScannedDir {
  workdir: string;
  files: string[];
  truncated: boolean;
}

/**
 * Scan a directory once for candidate source files.
 * Results are meant to be shared across all per-file calls in one fetch().
 */
function scanDirectory(
  sourceGlob: string,
  workdir: string,
  ignoreMatchers: readonly NaxIgnoreMatcher[] | undefined,
  maxGlobFiles: number,
  globCtx: { storyId?: string; packageDir?: string } | undefined,
): ScannedDir {
  const { files, truncated } = _codeNeighborDeps.glob(sourceGlob, workdir, ignoreMatchers, maxGlobFiles, globCtx);
  return { workdir, files, truncated };
}

/**
 * Collect neighbors for a single file: forward deps (JS/TS only), reverse deps
 * (language-aware glob, configurable cap), and sibling test (ADR-009 SSOT).
 *
 * Accepts pre-scanned directory results and a shared content cache so that
 * the glob and file reads are not repeated across touched files in one fetch().
 */
async function collectNeighbors(
  filePath: string,
  workdir: string,
  scannedDirs: ScannedDir[],
  contentCacheState: ContentCacheState,
  siblingTestContext?: { globs: readonly string[]; regex: readonly RegExp[] },
): Promise<{ neighbors: string[]; truncated: boolean }> {
  // Forward/reverse deps use independent budgets so import-heavy files can't
  // starve the reverse-dep scan (#1611).
  const forwardNeighbors = new Set<string>();
  let anyTruncated = false;

  const ownAbsPath = join(workdir, filePath);
  if (await _codeNeighborDeps.fileExists(ownAbsPath)) {
    const ownContent = await readCached(ownAbsPath, contentCacheState, _codeNeighborDeps);
    if (ownContent !== null && ownContent.length > 0) {
      for (const spec of parseImportSpecifiers(ownContent)) {
        const resolved = resolveImport(spec, filePath, workdir);
        if (resolved && resolved !== filePath) forwardNeighbors.add(resolved);
      }
    }
  }

  // Quick check uses the base name (without extension) — broad but avoids parsing every file.
  const fileBaseName = (filePath.split("/").pop() ?? filePath).replace(/\.[^.]+$/, "");
  const fileNoExt = filePath.replace(/\.[^.]+$/, "");

  const reverseNeighbors = new Set<string>();
  outer: for (const { workdir: scanWorkdir, files: srcFiles, truncated } of scannedDirs) {
    if (truncated) anyTruncated = true;
    for (const srcFile of srcFiles) {
      if (reverseNeighbors.size >= MAX_NEIGHBORS_PER_FILE) break outer;
      if (srcFile === filePath) continue;
      const content = await readCached(join(scanWorkdir, srcFile), contentCacheState, _codeNeighborDeps);
      if (content?.includes(fileBaseName)) {
        for (const spec of parseImportSpecifiers(content)) {
          const resolved = resolveImport(spec, srcFile, scanWorkdir);
          if (resolved === filePath || resolved === fileNoExt) {
            reverseNeighbors.add(srcFile);
            break;
          }
        }
      }
    }
  }

  // Guarantee reverse deps a minimum share of slots — otherwise forward deps
  // (inserted first) would crowd them out at the final slice() below. The
  // reverse loop still backfills past this minimum into unused forward slots.
  const minReverseSlots = Math.min(reverseNeighbors.size, Math.ceil(MAX_NEIGHBORS_PER_FILE / 2));
  const forwardSlots = MAX_NEIGHBORS_PER_FILE - minReverseSlots;
  const neighbors = new Set<string>();
  for (const f of forwardNeighbors) {
    if (neighbors.size >= forwardSlots) break;
    neighbors.add(f);
  }
  for (const r of reverseNeighbors) {
    if (neighbors.size >= MAX_NEIGHBORS_PER_FILE) break;
    neighbors.add(r);
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

  return { neighbors: [...neighbors].slice(0, MAX_NEIGHBORS_PER_FILE), truncated: anyTruncated };
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
  private readonly sourceGlobOverride: string | undefined;
  private readonly maxGlobFiles: number;

  constructor(options: CodeNeighborProviderOptions = {}) {
    this.neighborScope = options.neighborScope ?? "package";
    this.crossPackageDepth = options.crossPackageDepth ?? 1;
    this.sourceGlobOverride = options.sourceGlob;
    this.maxGlobFiles = options.maxGlobFiles ?? MAX_GLOB_FILES_DEFAULT;
  }

  async fetch(request: ContextRequest, signal?: AbortSignal): Promise<ContextProviderResult> {
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

    const ignoreMatchers = request.naxIgnoreIndex?.getMatchers(workdir);

    // Resolve source glob once per request (lazy: detectLanguage called only if no override).
    const sourceGlob = await resolveSourceGlob(this.sourceGlobOverride, request.packageDir);
    const globCtx = { storyId: request.storyId, packageDir: request.packageDir };

    // Hoist the reverse-dep glob scan outside the per-file loop so we never
    // re-glob the same directory N times (once per touched file). A shared
    // content cache further ensures each candidate file is read at most once
    // across all touched files in this fetch() call.
    const scannedDirs: ScannedDir[] = [scanDirectory(sourceGlob, workdir, ignoreMatchers, this.maxGlobFiles, globCtx)];
    if (extraGlobWorkdirs) {
      for (const extraDir of extraGlobWorkdirs) {
        scannedDirs.push(scanDirectory(sourceGlob, extraDir, ignoreMatchers, this.maxGlobFiles, globCtx));
      }
    }
    const contentCacheState = createContentCacheState();

    const sections: NeighborSection[] = [];
    let anyTruncated = false;
    for (const file of filesToProcess) {
      // PERF-2: cooperative cancellation — a timed-out fetch must stop doing
      // work instead of scanning/reading files the orchestrator no longer wants.
      if (signal?.aborted) break;
      const { neighbors, truncated } = await collectNeighbors(
        file,
        workdir,
        scannedDirs,
        contentCacheState,
        siblingTestContext,
      );
      if (truncated) anyTruncated = true;
      if (neighbors.length > 0) {
        sections.push({ file, neighbors });
      }
    }
    if (signal?.aborted) {
      return { chunks: [], pullTools: [] };
    }

    // US-002: chunk assembly (and `scopePaths` attribution) lives in
    // `code-neighbor-chunk.ts`. The provider collects sections; the chunk
    // module owns the section→RawChunk pipeline so this file stays flat.
    const chunk = assembleCodeNeighborChunk({
      sections,
      truncated: anyTruncated,
      maxGlobFiles: this.maxGlobFiles,
    });
    if (chunk === null) {
      return { chunks: [], pullTools: [] };
    }

    return { chunks: [chunk], pullTools: [] };
  }
}
