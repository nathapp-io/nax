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
 * Phase 3.
 *
 * See: docs/specs/SPEC-context-engine-v2.md §GitHistoryProvider
 */

import { createHash } from "node:crypto";
import { getLogger } from "@/logger";
import { gitWithTimeout } from "@/utils/git";
import { toPackageFrame } from "@/utils/path-frame";
import { isRelativeAndSafe } from "@/utils/path-security";
import { packageDirRelative } from "@/utils/paths";
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

/**
 * Fetch git log for a single file and return a formatted section.
 * Returns null when the file has no history or git fails.
 */
async function fetchFileHistory(
  filePath: string,
  workdir: string,
  storyId: string | undefined,
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
    _gitHistoryDeps.getLogger().warn("context-v2", "git history empty for touched file", {
      storyId,
      filePath,
      pathspec: filePath,
      cwd: workdir,
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
    const workdir = request.repoRoot;
    // "." = repo root: a root story (or worktree case where packageDirRelative
    // is undefined) keeps every entry — toPackageFrame is identity for ".".
    const packageWorkdir = packageDirRelative(request.repoRoot, request.packageDir) ?? ".";
    const filesToProcess = touchedFiles
      .filter(isRelativeAndSafe)
      .filter((file) => this.historyScope !== "package" || toPackageFrame(file, packageWorkdir) !== null)
      .slice(0, MAX_FILES);

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
          section: await fetchFileHistory(file, workdir, request.storyId, signal),
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
