/**
 * Context Engine v2 — GitHistoryProvider
 *
 * Surfaces recent git commit history for files this story touches.
 * For each file in request.touchedFiles, runs `git log --oneline --follow -n N`
 * and concatenates the results into a single "history" kind chunk.
 *
 * The combined chunk is capped at MAX_CHUNK_TOKENS to prevent overrun.
 * Returns empty when touchedFiles is absent or git fails.
 *
 * Scope: repo-scoped (anchor `repoRoot`). touchedFiles is REPO-ROOTED and git
 * ALWAYS runs at repoRoot against a repo-rooted pathspec; `historyScope` is a
 * post-filter over those entries, not a workdir switch. Chunk headings are
 * rendered repo-rooted verbatim and `scopePaths` share that same spelling.
 *
 * Phase 3.
 *
 * See: docs/specs/SPEC-context-engine-v2.md §GitHistoryProvider
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { getLogger } from "@/logger";
import { gitWithTimeout } from "@/utils/git";
import { isWithinPackage } from "@/utils/path-frame";
import { isRelativeAndSafe } from "@/utils/path-security";
import type { ContextProviderResult, ContextRequest, IContextProvider, RawChunk } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────────────

export interface GitHistoryProviderOptions {
  /**
   * Scope of the git history query (AC-55, nax#2088).
   * git ALWAYS runs in repoRoot against repo-rooted pathspecs; this option is
   * a post-filter, not a workdir switch:
   *   "repo" — every touched file is queried (full repo history).
   *   "package" — only files beneath packageDir are queried (monorepo package
   *     boundary).
   * Default: "package" (monorepo-safe; scopes history to the story's package).
   */
  historyScope?: "repo" | "package";
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Maximum number of commits to fetch per file */
const MAX_COMMITS = 5;

/** Maximum number of files to process (avoids very long prompts for large stories) */
const MAX_FILES = 10;

/** Token ceiling for the combined history chunk */
const MAX_CHUNK_TOKENS = 600;

/** Max number of dropped-file paths sampled into a single warn log (L-5). */
const LOG_SAMPLE_MAX_FILES = 5;

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps
// ─────────────────────────────────────────────────────────────────────────────

export const _gitHistoryDeps = {
  gitWithTimeout,
  getLogger,
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function contentHash8(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 8);
}

/** True when `path` has at least one commit in `repoRoot`'s history. */
async function hasHistoryAt(path: string, repoRoot: string): Promise<boolean> {
  const { stdout, exitCode } = await _gitHistoryDeps.gitWithTimeout(["log", "--oneline", "-1", "--", path], repoRoot);
  return exitCode === 0 && stdout.trim().length > 0;
}

/**
 * True when `file` (already outside the package per `isWithinPackage`) is
 * ambiguous: a pre-#2067 package-relative legacy spelling for a file that ALSO
 * reads as a repo-root path. The string "src/client.ts" cannot distinguish
 * "the root file" from "the package's file spelled package-relative", so
 * querying it at repoRoot would surface the root file's history under this
 * story's label — the #2088 sharper variant that `"package"` scope drops
 * (M13). The caller drops it.
 *
 * Ambiguity is decided from HISTORY, not from the working tree. What this gates
 * is `git log --follow`, and the two disagree in both directions: a root file
 * deleted last month is absent from disk yet still reports a full history, and
 * the package's counterpart may be a file this story is about to CREATE. An
 * existsSync probe sees neither, reports no collision, and attributes the root
 * file's history to this story — the defect it was meant to prevent.
 *
 * Only consulted for a non-canonical set: `contextFilesCanonical` asserts the
 * plan-time write seam already re-spelled every existing path, so an
 * out-of-package file there is genuinely repo-rooted and a repo-rooted query is
 * correct. Unreachable for a root story: `isWithinPackage(file, ".")` always
 * returns true, so the caller's filter excludes every file before this is
 * consulted.
 */
async function collidesWithPackageFile(file: string, packageWorkdir: string, repoRoot: string): Promise<boolean> {
  const [underPackage, atRoot] = await Promise.all([
    hasHistoryAt(join(packageWorkdir, file), repoRoot),
    hasHistoryAt(file, repoRoot),
  ]);
  return underPackage && atRoot;
}

/**
 * Split `"repo"`-scope files into what to query and what to drop as ambiguous.
 *
 * A canonical set is repo-rooted by construction, so every file is kept. Else,
 * an out-of-package file that also resolves beneath the package is a collision
 * (see `collidesWithPackageFile`) and is dropped.
 */
async function repoScopeFiles(
  files: string[],
  packageWorkdir: string,
  repoRoot: string,
  canonical: boolean,
): Promise<{ kept: string[]; dropped: string[] }> {
  if (canonical) return { kept: files, dropped: [] };
  const misses = files.filter((file) => !isWithinPackage(file, packageWorkdir));
  const collisions = await Promise.all(misses.map((file) => collidesWithPackageFile(file, packageWorkdir, repoRoot)));
  const dropped = misses.filter((_file, i) => collisions[i]);
  if (dropped.length === 0) return { kept: files, dropped: [] };
  const droppedSet = new Set(dropped);
  return { kept: files.filter((file) => !droppedSet.has(file)), dropped };
}

/**
 * Fetch git log for a single file and return a formatted section.
 * Returns null when the file has no history or git fails.
 */
async function fetchFileHistory(
  filePath: string,
  workdir: string,
  storyId: string | undefined,
  packageWorkdir: string,
  packageDirAbs: string,
  signal?: AbortSignal,
): Promise<string | null> {
  // PERF-2: cooperative cancellation — a timed-out fetch must not keep
  // spawning git for files the orchestrator no longer wants.
  if (signal?.aborted) return null;
  const { stdout, exitCode } = await _gitHistoryDeps.gitWithTimeout(
    ["log", "--oneline", "--follow", "-n", String(MAX_COMMITS), "--", filePath],
    workdir,
  );

  if (exitCode !== 0) return null;
  const trimmed = stdout.trim();
  if (!trimmed) {
    // A5 (nax#2088): git returned exit 0 with no commits for this pathspec —
    // a silent miss, not an error. Log once so a frame bug is diagnosable.
    // §9 (.nax/rules/monorepo-awareness.md) vocabulary: `packageDir` is the
    // ABSOLUTE package dir, `workdir` is the RELATIVE story.workdir (M-3 fix
    // — these were previously swapped here).
    _gitHistoryDeps.getLogger().warn("context-v2", "git history empty for touched file", {
      storyId,
      filePath,
      pathspec: filePath,
      packageDir: packageDirAbs,
      workdir: packageWorkdir,
    });
    return null;
  }

  return `### ${filePath}\n${trimmed}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Surfaces recent git commit history for files touched by the story.
 * Returns a single combined chunk with kind "history".
 */
export class GitHistoryProvider implements IContextProvider {
  readonly id = "git-history";
  readonly kind = "history" as const;

  private readonly historyScope: "repo" | "package";

  constructor(options: GitHistoryProviderOptions = {}) {
    this.historyScope = options.historyScope ?? "package";
  }

  async fetch(request: ContextRequest, signal?: AbortSignal): Promise<ContextProviderResult> {
    const { touchedFiles } = request;
    if (!touchedFiles || touchedFiles.length === 0) {
      return { chunks: [], pullTools: [] };
    }

    // nax#2088: touchedFiles is REPO-ROOTED (types.ts) and git ALWAYS runs in
    // repoRoot against the repo-rooted pathspec. Running `git log` in packageDir
    // while the paths stay repo-framed made the pathspec resolve to nothing
    // (exit 0, empty stdout — silently dropping the file) or, worse, to an
    // unrelated root-level file under the story's label.
    //
    // historyScope is a post-filter, not a workdir switch: under "package" only
    // entries beneath request.packageDir are kept.
    //
    // RESIDUAL (nax path-frame follow-up #1): workdir stays request.repoRoot,
    // the MAIN checkout, even under storyIsolation: "worktree". ContextRequest
    // carries no separate "worktree repo root" distinct from packageDir (which
    // already includes the package suffix), so there is nowhere safe to derive
    // it from without guessing. Any history that DOES survive under worktree
    // isolation is therefore read from the main checkout's HEAD, not the
    // worktree's. See the follow-up report for this residual; do not "fix" it
    // by joining packageDir segments without a real worktree-root field.
    const workdir = request.repoRoot;
    // request.storyWorkdir is the PRD-declared story workdir (repo-relative),
    // threaded onto the request by the callers that build it from a story
    // (pipeline/stages/context.ts, stage-assembler.ts). It must NOT be derived
    // as packageDirRelative(repoRoot, packageDir): under storyIsolation:
    // "worktree", packageDir is `<root>/.nax-wt/<storyId>/<pkg>` while repoRoot
    // is the main checkout, so that derivation yields `.nax-wt/<storyId>/<pkg>`,
    // matches nothing in repo-rooted touchedFiles, and silently drops every
    // entry. Same trap as nax#2069; see the ContextRequest.storyWorkdir
    // docblock in src/context/engine/types.ts.
    // "." = repo root: a root story (or a caller with no story, e.g. a
    // pull-tool handler where packageDir already equals repoRoot) keeps every
    // entry — isWithinPackage always matches for ".".
    const packageWorkdir = request.storyWorkdir ?? ".";
    const safeFiles = touchedFiles.filter(isRelativeAndSafe);
    let inHistoryScope: string[];
    if (this.historyScope === "package") {
      inHistoryScope = safeFiles.filter((file) => isWithinPackage(file, packageWorkdir));
      const droppedByScope = safeFiles.filter((file) => !isWithinPackage(file, packageWorkdir));
      if (droppedByScope.length > 0) {
        // Supplements the empty-stdout A5 warn below: that one can only fire
        // on files that reach fetchFileHistory. Files removed by THIS
        // historyScope post-filter never reach it, and were the dominant
        // silent-drop path (nax path-frame follow-up review, C1/H7/M14).
        // §9 (.nax/rules/monorepo-awareness.md) vocabulary: `packageDir` is
        // the ABSOLUTE package dir, `workdir` is the RELATIVE story.workdir
        // (M-3 fix — this previously logged the relative value as `packageDir`).
        _gitHistoryDeps.getLogger().warn("context-v2", "git history dropped touched file(s) outside package scope", {
          storyId: request.storyId,
          packageDir: request.packageDir,
          workdir: packageWorkdir,
          count: droppedByScope.length,
          files: droppedByScope.slice(0, LOG_SAMPLE_MAX_FILES),
        });
      }
    } else {
      // "repo": every safe file is queried — except an ambiguous pre-#2067
      // legacy spelling that ALSO has history beneath the package (M13).
      // Dropping the collision rather than guessing repo-rooted closes the
      // #2088 sharper variant for this scope; a canonical set has no ambiguity
      // and is passed through untouched (see repoScopeFiles). Ambiguity is
      // judged from history, not the working tree — see collidesWithPackageFile
      // for why the two differ in both directions.
      const { kept, dropped } = await repoScopeFiles(
        safeFiles,
        packageWorkdir,
        request.repoRoot,
        request.contextFilesCanonical === true,
      );
      inHistoryScope = kept;
      if (dropped.length > 0) {
        _gitHistoryDeps
          .getLogger()
          .warn("context-v2", "git history dropped ambiguous path(s) colliding with a same-named package file", {
            storyId: request.storyId,
            packageDir: request.packageDir,
            workdir: packageWorkdir,
            count: dropped.length,
            files: dropped.slice(0, LOG_SAMPLE_MAX_FILES),
          });
      }
    }
    const filesToProcess = inHistoryScope.slice(0, MAX_FILES);

    // US-001: scope attribution must follow the file-to-section association,
    // not the input list. fetchFileHistory returns null for files with no
    // history (or git failures); only the files whose history was actually
    // surfaced contribute a section, so only those files are attributed to
    // the chunk via RawChunk.scopePaths. Files declared in touchedFiles but
    // absent from the result are deliberately excluded — the chunk says
    // nothing about them and must not claim scope.
    const fileSections: Array<{ file: string; section: string }> = (
      await Promise.all(
        filesToProcess.map(async (file) => ({
          file,
          section: await fetchFileHistory(file, workdir, request.storyId, packageWorkdir, request.packageDir, signal),
        })),
      )
    ).filter((entry): entry is { file: string; section: string } => entry.section !== null);

    if (fileSections.length === 0) {
      return { chunks: [], pullTools: [] };
    }

    // US-001 (truncation contract): scopePaths must list ONLY the files
    // whose sections actually appear in chunk.content. If the combined
    // history exceeds MAX_CHUNK_TOKENS, later sections are dropped
    // entirely (added atomically — never sliced mid-section) so the chunk
    // never claims scope over a file whose history it has truncated away.
    //
    // Preserve the declared touchedFiles order for both sections and
    // scopePaths — concurrent fetchFileHistory completion order is not
    // guaranteed to match input order, but AC2 requires the chunk's
    // scopePaths list to mirror the order files were declared in
    // touchedFiles. fileSections was built via map() over filesToProcess
    // so its order already matches the declaration order.
    const header = "## Recent Git History\n\nCommits touching story files:";
    const maxChars = MAX_CHUNK_TOKENS * 4;
    const SECTION_SEPARATOR = "\n\n";
    const accumulatedParts: string[] = [`${header}${SECTION_SEPARATOR}`];
    let accumulatedLength = header.length + SECTION_SEPARATOR.length;
    const includedFileSections: Array<{ file: string; section: string }> = [];
    for (const entry of fileSections) {
      // Cost to add this section: a trailing separator (except for the very
      // first section that follows the header — the header already ends in
      // SECTION_SEPARATOR) plus the section text.
      const separatorCost = includedFileSections.length === 0 ? 0 : SECTION_SEPARATOR.length;
      const candidateLength = accumulatedLength + separatorCost + entry.section.length;
      // First section is always included so the chunk emits at least the
      // header + something; subsequent sections must fit within the cap
      // atomically.
      if (includedFileSections.length > 0 && candidateLength > maxChars) break;
      if (separatorCost > 0) accumulatedParts.push(SECTION_SEPARATOR);
      accumulatedParts.push(entry.section);
      accumulatedLength = candidateLength;
      includedFileSections.push(entry);
    }
    const content = accumulatedParts.join("").slice(0, maxChars);
    const tokens = Math.ceil(content.length / 4);
    const scopePaths = includedFileSections.map((entry) => entry.file);

    const chunk: RawChunk = {
      id: `git-history:${contentHash8(content)}`,
      kind: "history",
      scope: "story",
      role: ["implementer", "tdd"],
      content,
      tokens,
      rawScore: 0.7,
      scopePaths,
    };

    return { chunks: [chunk], pullTools: [] };
  }
}
