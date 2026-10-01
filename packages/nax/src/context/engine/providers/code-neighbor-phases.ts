/**
 * Context Engine v2 — collectNeighbors phases (split from code-neighbor.ts,
 * cognitive-complexity drain A12 — docs/plans/STATUS-complexity-drain.md §9).
 *
 * `collectNeighbors` (code-neighbor.ts) is the sequencer: it derives the
 * package-scope frame and path bookkeeping, then runs the four phases below
 * in the original execution order — forward deps, reverse deps, the
 * slot-merge, and the sibling-test hint. Each phase owns one stage of the
 * original body; every comment moved with its code.
 *
 * This module imports NOTHING from code-neighbor.ts. The injectable deps
 * arrive BY REFERENCE on each phase's input (`_codeNeighborDeps` — tests
 * reassign its properties, so every phase must read `deps.X` at call time),
 * typed by the structural `PhaseDeps` below. That keeps the import graph
 * acyclic: code-neighbor.ts is the only importer of this module.
 */

import { isAbsolute, join, relative, resolve } from "node:path";
import { type ContentCacheState, type ReadCachedDeps, readCached } from "./code-neighbor-cache";
import { deriveSiblingTestCandidates, isTestFile } from "./test-path-derivation";

/** Maximum number of neighbors (forward + reverse combined) per file */
export const MAX_NEIGHBORS_PER_FILE = 8;

/** Deps the phases need — a structural subset of `_codeNeighborDeps`, read at call time. */
export interface PhaseDeps extends ReadCachedDeps {
  fileExists: (path: string) => Promise<boolean>;
}

/** Result of a pre-scanned directory for reverse-dep matching. */
export interface ScannedDir {
  workdir: string;
  files: string[];
  truncated: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Import parsing (moved verbatim from code-neighbor.ts)
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
 * The package's path RELATIVE TO THE SCAN ROOT, or "" when the two are not
 * comparable.
 *
 * `relative(execRoot, packageDir)` is only meaningful when both name the same
 * tree. `packageDir` may be stamped from the MAIN checkout while `execRoot`
 * names the worktree (US-001), and the naive `relative()` then returns an
 * escaping path ("../../packages/app") that matches no scanned file — silently
 * dropping EVERY reverse-dep candidate rather than merely widening the scan.
 *
 * An escaping result therefore means "no usable package frame", and the
 * caller skips the filter. Failing open is deliberate: a wider neighbour set
 * is a recall cost the consumer can absorb, while a silently empty one is the
 * stale-or-absent-context defect this provider exists to prevent.
 */
export function packageScopeRelative(execRoot: string, packageDir: string): string {
  if (!packageDir) return "";
  // A relative packageDir is already in the scan frame (it is a repo-relative
  // key); relative() against it would resolve the second argument against the
  // process cwd instead, so pass it through untouched.
  const rel = isAbsolute(packageDir) ? relative(execRoot, packageDir) : packageDir;
  const normalized = rel.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalized === "" || normalized === "." || normalized.startsWith("..")) return "";
  return normalized;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — forward deps
// ─────────────────────────────────────────────────────────────────────────────

export interface ForwardPhaseInput {
  filePath: string;
  execRoot: string;
  /** Absolute path of the touched file itself — also the forward self-import skip. */
  ownAbsPath: string;
  contentCacheState: ContentCacheState;
  deps: PhaseDeps;
}

/**
 * Forward deps: the touched file's own imports (JS/TS only — non-JS/TS files
 * match none of the import patterns).
 */
export async function collectForwardNeighbors(input: ForwardPhaseInput): Promise<Set<string>> {
  const { filePath, execRoot, ownAbsPath, contentCacheState, deps } = input;
  const forwardNeighbors = new Set<string>();
  if (await deps.fileExists(ownAbsPath)) {
    const ownContent = await readCached(ownAbsPath, contentCacheState, deps);
    if (ownContent !== null && ownContent.length > 0) {
      for (const spec of parseImportSpecifiers(ownContent)) {
        const resolved = resolveImport(spec, filePath, execRoot);
        if (resolved === null) continue;
        const resolvedAbs = join(execRoot, resolved);
        if (resolvedAbs !== ownAbsPath) forwardNeighbors.add(resolvedAbs);
      }
    }
  }
  return forwardNeighbors;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — reverse deps
// ─────────────────────────────────────────────────────────────────────────────

export interface ReversePhaseInput {
  /** Absolute path of the touched file itself. */
  ownAbsPath: string;
  /** Same path with the extension stripped — matches bare-directory resolutions. */
  ownAbsNoExt: string;
  /** The touched file's base name without extension — the includes() quick check. */
  fileBaseName: string;
  /** Package path relative to the scan root, or "" when the filter is skipped (AC5). */
  relPackageDir: string;
  /** `relPackageDir` with a trailing slash — the startsWith prefix form. */
  packagePrefix: string;
  scannedDirs: readonly ScannedDir[];
  contentCacheState: ContentCacheState;
  deps: PhaseDeps;
}

export interface ReverseOutcome {
  neighbors: Set<string>;
  /** True when any VISITED scanned dir hit its glob cap (nax#2074/#895). */
  anyTruncated: boolean;
}

/** AC5 package-scope filter: drop candidates outside the package's relative path. */
function isOutsidePackageScope(srcFile: string, input: ReversePhaseInput): boolean {
  // relPackageDir "" means "no usable package frame" — the filter is skipped
  // (failing open, see packageScopeRelative).
  if (!input.relPackageDir) return false;
  return !srcFile.startsWith(input.packagePrefix) && srcFile !== input.relPackageDir;
}

/** Does this candidate's content resolve to the touched file (or its bare-dir form)? */
async function importsOwnPath(
  srcFile: string,
  scanWorkdir: string,
  content: string,
  input: ReversePhaseInput,
): Promise<boolean> {
  for (const spec of parseImportSpecifiers(content)) {
    const resolved = resolveImport(spec, srcFile, scanWorkdir);
    if (resolved === null) continue;
    const resolvedAbs = join(scanWorkdir, resolved);
    if (resolvedAbs === input.ownAbsPath || resolvedAbs === input.ownAbsNoExt) return true;
  }
  return false;
}

/**
 * Reverse deps: files that import the touched file, found by scanning the
 * pre-scanned directories. The includes() quick check on the base name keeps
 * most candidates from being parsed at all.
 */
export async function collectReverseNeighbors(input: ReversePhaseInput): Promise<ReverseOutcome> {
  const { ownAbsPath, fileBaseName, scannedDirs, contentCacheState, deps } = input;
  const reverseNeighbors = new Set<string>();
  let anyTruncated = false;
  outer: for (const { workdir: scanWorkdir, files: srcFiles, truncated } of scannedDirs) {
    if (truncated) anyTruncated = true;
    for (const srcFile of srcFiles) {
      if (reverseNeighbors.size >= MAX_NEIGHBORS_PER_FILE) break outer;
      // AC5 package-scope filter: under the default package scope, drop any
      // candidate file whose `srcFile` (relative to execRoot) lies outside
      // the package's relative path. The scan runs at execRoot so worktree-
      // only files in the package stay in scope (AC3), but cross-package
      // importers do not (AC5).
      if (isOutsidePackageScope(srcFile, input)) continue;
      const srcAbs = join(scanWorkdir, srcFile);
      // Absolute self-skip. Comparing `srcFile === filePath` skipped a SIBLING's
      // identically-spelled file and let a sibling's `./index` count as a
      // dependent of ours — nax#2074, both signs of the same defect.
      if (srcAbs === ownAbsPath) continue;
      const content = await readCached(srcAbs, contentCacheState, deps);
      // Short-circuit order matters for cost only: candidates whose content
      // lacks the base name are never parsed (the original's nested if).
      if (content?.includes(fileBaseName) && (await importsOwnPath(srcFile, scanWorkdir, content, input))) {
        reverseNeighbors.add(srcAbs);
      }
    }
  }
  return { neighbors: reverseNeighbors, anyTruncated };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 — slot merge
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merge forward and reverse deps into the final neighbor slots.
 *
 * Guarantee reverse deps a minimum share of slots — otherwise forward deps
 * (inserted first) would crowd them out at the final slice() in the
 * sequencer. The reverse loop still backfills past this minimum into unused
 * forward slots (#1611).
 */
export function mergeNeighborSlots(
  forwardNeighbors: ReadonlySet<string>,
  reverseNeighbors: ReadonlySet<string>,
): Set<string> {
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
  return neighbors;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4 — sibling test hint
// ─────────────────────────────────────────────────────────────────────────────

export interface SiblingHintInput {
  filePath: string;
  execRoot: string;
  siblingTestContext?: { globs: readonly string[]; regex: readonly RegExp[] };
  deps: PhaseDeps;
}

/**
 * Sibling test hint — resolver-driven (ADR-009), or null when the phase is
 * skipped (no context threaded, the touched file is itself a test file, or
 * nothing usable was derived).
 *
 * Selection order:
 *   1. First candidate that exists on disk wins — colocated is preferred over
 *      mirrored because it appears first in the candidate list. This is the
 *      #526 Bug 2 fix: projects using colocated tests get the real path back.
 *   2. If no candidate exists but a mirrored candidate was generated, use it
 *      as a TDD hint ("write the test here"). Preserves the pre-existing
 *      behaviour for src/-anchored sources with no test yet.
 *   3. Otherwise skip — do not hallucinate a path for non-src/ files or when
 *      no mirrored anchor exists.
 */
export async function resolveSiblingTestHint(input: SiblingHintInput): Promise<string | null> {
  const { filePath, execRoot, siblingTestContext, deps } = input;
  // Skipped entirely when no context is threaded (callers must pass
  // resolvedTestPatterns via ContextRequest).
  if (!siblingTestContext) return null;
  if (isTestFile(filePath, siblingTestContext.regex)) return null;
  const candidates = deriveSiblingTestCandidates(filePath, siblingTestContext.globs);
  let chosen: string | null = null;
  for (const candidate of candidates) {
    if (await deps.fileExists(join(execRoot, candidate))) {
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
  if (chosen !== null && chosen !== filePath) return chosen;
  return null;
}
