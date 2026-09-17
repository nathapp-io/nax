/**
 * Context Engine v2 — CodeNeighborProvider (Phase 3)
 *
 * Surfaces forward deps, reverse deps (language-aware glob, configurable cap),
 * and sibling tests for files touched by the story.
 *
 * See: docs/specs/SPEC-context-engine-v2.md §CodeNeighborProvider
 */

import { join, relative, resolve } from "node:path";
import { getLogger } from "@/logger";
import { detectLanguage } from "@/project";
import type { NaxIgnoreMatcher } from "@/utils/path-filters";
import { partitionPackageFrame, UNREADABLE_MARKER } from "@/utils/path-frame";
import { isRelativeAndSafe } from "@/utils/path-security";
import type { ContextProviderResult, ContextRequest, IContextProvider } from "../types";
import { type ContentCacheState, createContentCacheState, readCached } from "./code-neighbor-cache";
import { assembleCodeNeighborChunk, type NeighborSection } from "./code-neighbor-chunk";
import { deriveSiblingTestCandidates, isTestFile } from "./test-path-derivation";

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
   * Override the source-file glob for reverse-dep scanning (#895).
   * When omitted, derived from detectLanguage(packageDir) via SOURCE_GLOB_BY_LANGUAGE.
   */
  sourceGlob?: string;
  /**
   * Maximum files scanned per directory during reverse-dep glob (#895).
   * Default: 500 (raised from 200; language-aware glob reduces noise).
   * One scan root per fetch since nax#2074, so this is also the per-fetch cap.
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
 * Re-spell an absolute neighbour path for the consuming story (nax#2074).
 *
 * Inside the consumer's root -> package-relative, which is what the agent's
 * file tools can open (codingToolRoot, src/agents/types.ts:182-197).
 * Outside it -> repo-rooted and marked: a package-relative spelling would
 * resolve to a real but WRONG file under the consumer's root, so the path
 * carries the same UNREADABLE_MARKER nax#2072 already ships. A path beneath
 * neither root stays absolute -- rare, honest, and still marked.
 *
 * `relative()` on absolute paths is used rather than a derived string prefix:
 * under storyIsolation "worktree" the consumer root and the repo root are
 * different trees, and any prefix derivation silently matches nothing (nax#2069).
 */
function spellForConsumer(absPath: string, consumerRoot: string, repoRoot: string): string {
  const fromConsumer = relative(consumerRoot, absPath);
  if (fromConsumer !== "" && !fromConsumer.startsWith("..")) return fromConsumer;
  const fromRepo = relative(repoRoot, absPath);
  const spelled = fromRepo !== "" && !fromRepo.startsWith("..") ? fromRepo : absPath;
  return `${spelled}${UNREADABLE_MARKER}`;
}

/**
 * Collect neighbors for a single file: forward deps (JS/TS only), reverse deps
 * (language-aware glob, configurable cap), and sibling tests (ADR-009 SSOT).
 *
 * Two roots, deliberately distinct (nax#2074):
 *   - `consumerRoot` is the absolute dir `filePath` is relative to. It is ALWAYS
 *     `request.packageDir`: `fetch()` partitions the repo-rooted
 *     `request.touchedFiles` into the package frame at the point of resolution
 *     (nax#2088), so every `filePath` that reaches here is package-framed.
 *   - each `ScannedDir.workdir` is the root its `files` are relative to.
 *
 * Under `neighborScope: "repo"` those differ, so no two relative paths here are
 * mutually intelligible. Every comparison is therefore made on absolute paths,
 * and the result is re-spelled for the consumer exactly once, on return.
 *
 * Accepts pre-scanned directory results and a shared content cache so that the
 * glob and file reads are not repeated across touched files in one fetch().
 */
async function collectNeighbors(
  filePath: string,
  consumerRoot: string,
  repoRoot: string,
  scannedDirs: ScannedDir[],
  contentCacheState: ContentCacheState,
  siblingTestContext?: { globs: readonly string[]; regex: readonly RegExp[] },
): Promise<{ neighbors: string[]; truncated: boolean }> {
  // Forward/reverse deps use independent budgets so import-heavy files can't
  // starve the reverse-dep scan (#1611).
  const forwardNeighbors = new Set<string>();
  let anyTruncated = false;

  const ownAbsPath = join(consumerRoot, filePath);
  if (await _codeNeighborDeps.fileExists(ownAbsPath)) {
    const ownContent = await readCached(ownAbsPath, contentCacheState, _codeNeighborDeps);
    if (ownContent !== null && ownContent.length > 0) {
      for (const spec of parseImportSpecifiers(ownContent)) {
        const resolved = resolveImport(spec, filePath, consumerRoot);
        if (resolved === null) continue;
        const resolvedAbs = join(consumerRoot, resolved);
        if (resolvedAbs !== ownAbsPath) forwardNeighbors.add(resolvedAbs);
      }
    }
  }

  // Quick check uses the base name (without extension) — broad but avoids parsing every file.
  const fileBaseName = (filePath.split("/").pop() ?? filePath).replace(/\.[^.]+$/, "");
  const ownAbsNoExt = ownAbsPath.replace(/\.[^./]+$/, "");

  const reverseNeighbors = new Set<string>();
  outer: for (const { workdir: scanWorkdir, files: srcFiles, truncated } of scannedDirs) {
    if (truncated) anyTruncated = true;
    for (const srcFile of srcFiles) {
      if (reverseNeighbors.size >= MAX_NEIGHBORS_PER_FILE) break outer;
      const srcAbs = join(scanWorkdir, srcFile);
      // Absolute self-skip. Comparing `srcFile === filePath` skipped a SIBLING's
      // identically-spelled file and let a sibling's `./index` count as a
      // dependent of ours — nax#2074, both signs of the same defect.
      if (srcAbs === ownAbsPath) continue;
      const content = await readCached(srcAbs, contentCacheState, _codeNeighborDeps);
      if (content?.includes(fileBaseName)) {
        for (const spec of parseImportSpecifiers(content)) {
          const resolved = resolveImport(spec, srcFile, scanWorkdir);
          if (resolved === null) continue;
          const resolvedAbs = join(scanWorkdir, resolved);
          if (resolvedAbs === ownAbsPath || resolvedAbs === ownAbsNoExt) {
            reverseNeighbors.add(srcAbs);
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
      if (await _codeNeighborDeps.fileExists(join(consumerRoot, candidate))) {
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
    if (chosen !== null && chosen !== filePath) neighbors.add(join(consumerRoot, chosen));
  }

  return {
    neighbors: [...neighbors]
      .slice(0, MAX_NEIGHBORS_PER_FILE)
      .map((abs) => spellForConsumer(abs, consumerRoot, repoRoot)),
    truncated: anyTruncated,
  };
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
  private readonly sourceGlobOverride: string | undefined;
  private readonly maxGlobFiles: number;

  constructor(options: CodeNeighborProviderOptions = {}) {
    this.neighborScope = options.neighborScope ?? "package";
    this.sourceGlobOverride = options.sourceGlob;
    this.maxGlobFiles = options.maxGlobFiles ?? MAX_GLOB_FILES_DEFAULT;
  }

  async fetch(request: ContextRequest, signal?: AbortSignal): Promise<ContextProviderResult> {
    const { touchedFiles } = request;
    // The scan root: where the reverse-dep glob runs.
    const scanRoot = this.neighborScope === "package" ? request.packageDir : request.repoRoot;
    if (!touchedFiles || touchedFiles.length === 0) {
      return { chunks: [], pullTools: [] };
    }

    // nax#2088: touchedFiles is REPO-ROOTED (types.ts); re-spell into the
    // package frame here — collectNeighbors joins onto consumerRoot === packageDir.
    //
    // pkgDir MUST come from request.storyWorkdir, not from
    // packageDirRelative(request.repoRoot, request.packageDir): under
    // storyIsolation: "worktree" that derivation yields
    // ".nax-wt/<storyId>/<pkg>", matches nothing, and silently drops every
    // touched file (nax#2069, path-frame follow-up C1). "." (no story, or a
    // caller that already passes the resolved package root as repoRoot, e.g.
    // handlers/query-neighbor.ts) is the safe fallback: toPackageFrame is
    // identity for ".".
    const pkgDir = request.storyWorkdir ?? ".";
    // H7 (path-frame follow-up to #2089): `canonical: true` asserts
    // touchedFiles came through the plan-time write seam
    // (story.workdirSource !== undefined) — this provider cannot see that
    // flag directly, only what the request producer threaded onto it. An
    // unconditional `true` here was unbacked: for a pre-#2067 PRD holding a
    // real, existing package-relative entry, it silently dropped the file as
    // "outside the package" with no diagnostic.
    const canonical = request.contextFilesCanonical ?? false;
    const { readable, unreachable } = partitionPackageFrame(touchedFiles, pkgDir, { canonical });
    if (unreachable.length > 0) {
      _codeNeighborDeps
        .getLogger()
        .warn(
          "context-v2",
          "code-neighbor touchedFiles could not be resolved inside this story's package and were dropped",
          {
            storyId: request.storyId,
            packageDir: pkgDir,
            count: unreachable.length,
            files: unreachable.slice(0, MAX_FILES),
          },
        );
    }
    const filesToProcess = readable.filter(isRelativeAndSafe).slice(0, MAX_FILES);

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

    const ignoreMatchers = request.naxIgnoreIndex?.getMatchers(scanRoot);

    // Resolve source glob once per request (lazy: detectLanguage called only if no override).
    const sourceGlob = await resolveSourceGlob(this.sourceGlobOverride, request.packageDir);
    const globCtx = { storyId: request.storyId, packageDir: request.packageDir };

    // Hoist the reverse-dep glob scan outside the per-file loop (once per
    // touched file) with a shared content cache (each candidate read at most
    // once per fetch). One scan root since nax#2074: bare specifiers are never
    // parsed, so a cross-package dependent was never findable.
    const scannedDirs: ScannedDir[] = [scanDirectory(sourceGlob, scanRoot, ignoreMatchers, this.maxGlobFiles, globCtx)];
    const contentCacheState = createContentCacheState();

    const sections: NeighborSection[] = [];
    let anyTruncated = false;
    for (const file of filesToProcess) {
      // PERF-2: cooperative cancellation — a timed-out fetch must stop doing
      // work instead of scanning/reading files the orchestrator no longer wants.
      if (signal?.aborted) break;
      const { neighbors, truncated } = await collectNeighbors(
        file,
        request.packageDir,
        request.repoRoot,
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
      packageWorkdir: pkgDir,
    });
    if (chunk === null) {
      return { chunks: [], pullTools: [] };
    }

    return { chunks: [chunk], pullTools: [] };
  }
}
