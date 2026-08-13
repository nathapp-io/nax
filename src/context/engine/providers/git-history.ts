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
import { gitWithTimeout } from "../../../utils/git";
import { isRelativeAndSafe } from "../../../utils/path-security";
import type { ContextProviderResult, ContextRequest, IContextProvider, RawChunk } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────────────

export interface GitHistoryProviderOptions {
  /**
   * Scope of the git working directory for history queries (AC-55).
   * "repo" — runs git log in repoRoot (full repo history).
   * "package" — runs git log in packageDir (monorepo package boundary).
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
async function fetchFileHistory(filePath: string, workdir: string): Promise<string | null> {
  const { stdout, exitCode } = await _gitHistoryDeps.gitWithTimeout(
    ["log", "--oneline", "--follow", "-n", String(MAX_COMMITS), "--", filePath],
    workdir,
  );

  if (exitCode !== 0) return null;
  const trimmed = stdout.trim();
  if (!trimmed) return null;

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

  async fetch(request: ContextRequest): Promise<ContextProviderResult> {
    const { touchedFiles } = request;
    const workdir = this.historyScope === "package" ? request.packageDir : request.repoRoot;
    if (!touchedFiles || touchedFiles.length === 0) {
      return { chunks: [], pullTools: [] };
    }

    const filesToProcess = touchedFiles.filter(isRelativeAndSafe).slice(0, MAX_FILES);

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
          section: await fetchFileHistory(file, workdir),
        })),
      )
    ).filter((entry): entry is { file: string; section: string } => entry.section !== null);

    if (fileSections.length === 0) {
      return { chunks: [], pullTools: [] };
    }

    // Preserve the declared touchedFiles order for both sections and
    // scopePaths — concurrent fetchFileHistory completion order is not
    // guaranteed to match input order, but AC2 requires the chunk's
    // scopePaths list to mirror the order files were declared in
    // touchedFiles. fileSections was built via map() over filesToProcess
    // so its order already matches the declaration order.
    const sections = fileSections.map((entry) => entry.section);
    const scopePaths = fileSections.map((entry) => entry.file);

    const header = "## Recent Git History\n\nCommits touching story files:";
    const rawContent = `${header}\n\n${sections.join("\n\n")}`;

    // Cap content to avoid overrunning token budget
    const maxChars = MAX_CHUNK_TOKENS * 4;
    const content = rawContent.length > maxChars ? rawContent.slice(0, maxChars) : rawContent;
    const tokens = Math.ceil(content.length / 4);

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
