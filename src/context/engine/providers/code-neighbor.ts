/**
 * Context Engine v2 — CodeNeighborProvider (Phase 3)
 *
 * Surfaces forward deps, reverse deps (language-aware glob, configurable cap),
 * and sibling tests for files touched by the story.
 *
 * See: docs/specs/SPEC-context-engine-v2.md §CodeNeighborProvider
 */

import { join, relative } from "node:path";
import { getLogger } from "@/logger";
import { detectLanguage } from "@/project";
import type { NaxIgnoreMatcher } from "@/utils/path-filters";
import { isRelativeAndSafe } from "@/utils/path-security";
import type { ContextProviderResult, ContextRequest, IContextProvider } from "../types";
import { type ContentCacheState, createContentCacheState } from "./code-neighbor-cache";
import { assembleCodeNeighborChunk, type NeighborSection } from "./code-neighbor-chunk";
import {
  collectForwardNeighbors,
  collectReverseNeighbors,
  MAX_NEIGHBORS_PER_FILE,
  mergeNeighborSlots,
  packageScopeRelative,
  resolveSiblingTestHint,
  type ScannedDir,
} from "./code-neighbor-phases";

export type { ContentCacheState } from "./code-neighbor-cache";
export { createContentCacheState } from "./code-neighbor-cache";

// ─────────────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────────────

export interface CodeNeighborProviderOptions {
  /**
   * Scope of the working directory for neighbor discovery (AC-56).
   * Since nax#2134 this is a POST-FILTER over the execRoot scan, not a scan
   * partition: the reverse-dep glob always runs at the story execution root
   * (`request.execRoot ?? request.repoRoot`), and this option only decides
   * whether candidates outside the package are dropped from the result.
   *   "repo" — every candidate the execRoot scan found is kept.
   *   "package" — candidates outside `packageDir` are dropped (default).
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

/** Derive the source-file glob for reverse-dep scanning (#895, L1). */
async function resolveSourceGlob(override: string | undefined, packageDir: string): Promise<string> {
  if (override) return override;
  const language = await _codeNeighborDeps.detectLanguage(packageDir);
  return (language && SOURCE_GLOB_BY_LANGUAGE[language]) ?? FALLBACK_SOURCE_GLOB;
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
 * (language-aware glob, configurable cap), and sibling tests (ADR-009 SSOT).
 *
 * Single-frame (nax#2125): every path is repo-rooted. `filePath` is
 * repo-rooted (types.ts), `scannedDirs` files are relative to the glob root
 * (`scanRoot` — since nax#2134 unconditionally the story execution root), and
 * `execRoot` is that same root, the directory the story's agent actually
 * executes in (`request.execRoot ?? request.repoRoot` at the call site). Every
 * comparison is made on absolute paths, and the result is spelled relative to
 * `execRoot`, exactly once on return — the agent's file tools are rooted at the
 * story execution root, so no package frame or unreadable marker is needed.
 *
 * `packageDir` and `neighborScope` are threaded through to keep AC5's
 * "same neighbours as today" behaviour under the default package scope:
 * when `neighborScope === "package"`, candidate files outside `packageDir`
 * (relative to execRoot) are dropped — the scan glob still runs at
 * execRoot so worktree-only neighbours stay in scope (AC3), but cross-
 * package importers do not leak into the chunk (AC5). The relative package
 * path is derived by `packageScopeRelative` (code-neighbor-phases.ts), which
 * yields "" (filter skipped) rather than a path that cannot match, so a
 * packageDir in a different frame cannot silently empty the neighbour set.
 *
 * Accepts pre-scanned directory results and a shared content cache so that the
 * glob and file reads are not repeated across touched files in one fetch().
 *
 * The body is a sequencer over the four phases in
 * `code-neighbor-phases.ts` (forward deps → reverse deps → slot merge →
 * sibling-test hint), run in the original execution order. Two observable
 * quirks are deliberate and pinned (code-neighbor-collect-edges.test.ts):
 * the sibling hint is added AFTER the MAX_NEIGHBORS_PER_FILE-capped merge,
 * so a full neighbor set pushes the hint off at the final slice; and the
 * reverse quick-check (`includes(fileBaseName)`) misses directory imports
 * whose content never spells the base name.
 */
interface CollectNeighborsInput {
  filePath: string;
  execRoot: string;
  packageDir: string;
  neighborScope: "repo" | "package";
  scannedDirs: ScannedDir[];
  contentCacheState: ContentCacheState;
  siblingTestContext?: { globs: readonly string[]; regex: readonly RegExp[] };
}

async function collectNeighbors(input: CollectNeighborsInput): Promise<{ neighbors: string[]; truncated: boolean }> {
  const { filePath, execRoot, packageDir, neighborScope, scannedDirs, contentCacheState, siblingTestContext } = input;
  // AC5: package-scope filter applies the legacy "scan only this package"
  // partition as a post-filter on the execRoot-rooted scan, NOT as a
  // partition of the scan root itself. The relative packageDir is computed
  // here so the same `srcFile` strings the glob returns can be matched
  // without a second join.
  const relPackageDir = neighborScope === "package" ? packageScopeRelative(execRoot, packageDir) : "";
  const packagePrefix = relPackageDir.endsWith("/") ? relPackageDir : `${relPackageDir}/`;

  const ownAbsPath = join(execRoot, filePath);
  // Quick check uses the base name (without extension) — broad but avoids parsing every file.
  const fileBaseName = (filePath.split("/").pop() ?? filePath).replace(/\.[^.]+$/, "");
  const ownAbsNoExt = ownAbsPath.replace(/\.[^./]+$/, "");

  // Forward/reverse deps use independent budgets so import-heavy files can't
  // starve the reverse-dep scan (#1611).
  const forwardNeighbors = await collectForwardNeighbors({
    filePath,
    execRoot,
    ownAbsPath,
    contentCacheState,
    deps: _codeNeighborDeps,
  });
  const reverse = await collectReverseNeighbors({
    ownAbsPath,
    ownAbsNoExt,
    fileBaseName,
    relPackageDir,
    packagePrefix,
    scannedDirs,
    contentCacheState,
    deps: _codeNeighborDeps,
  });
  const neighbors = mergeNeighborSlots(forwardNeighbors, reverse.neighbors);

  const siblingHint = await resolveSiblingTestHint({
    filePath,
    execRoot,
    siblingTestContext,
    deps: _codeNeighborDeps,
  });
  if (siblingHint !== null) neighbors.add(join(execRoot, siblingHint));

  return {
    neighbors: [...neighbors].slice(0, MAX_NEIGHBORS_PER_FILE).map((abs) => relative(execRoot, abs)),
    truncated: reverse.anyTruncated,
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
    // nax#2134 (US-001): the story execution root drives every disk
    // resolution. Under `execution.storyIsolation: "worktree"` this is the
    // worktree root, not the main checkout. Producers that do not have a
    // story (pull-tool handlers) omit execRoot and fall back to repoRoot —
    // today's behaviour. The scanRoot for the reverse-dep glob derives from
    // the SAME root (the spec's literal "scanRoot is derived from the same
    // root"), so a worktree-only neighbour is always in scope regardless of
    // the neighbour-scope option.
    const execRoot = request.execRoot ?? request.repoRoot;
    // The scan root: where the reverse-dep glob runs. Per spec US-001 the
    // scanRoot derives from execRoot; the neighborScope option becomes a
    // filter applied after the scan rather than a partition of the scan root.
    const scanRoot = execRoot;
    if (!touchedFiles || touchedFiles.length === 0) {
      return { chunks: [], pullTools: [] };
    }

    // Single-frame (nax#2125): touchedFiles is REPO-ROOTED (types.ts) and the
    // agent's file tools can address any repo-rooted path, so every touched
    // file is reachable. No package-frame partition or unreadable-marker
    // bookkeeping is needed — the paths pass through as stored.
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
      // nax#2134 (US-001): resolve against the story execution root so a
      // worktree-isolated story reads the worktree, not the main checkout.
      const { neighbors, truncated } = await collectNeighbors({
        filePath: file,
        execRoot,
        packageDir: request.packageDir,
        neighborScope: this.neighborScope,
        scannedDirs,
        contentCacheState,
        siblingTestContext,
      });
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
