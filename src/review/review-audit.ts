/**
 * Review Audit — fire-and-forget writer for LLM reviewer JSON output.
 *
 * Saves the parsed result from semantic and adversarial reviewers to disk so
 * operators can audit exactly what each reviewer decided, regardless of
 * whether the JSON was valid or not.
 *
 * Directory layout (mirrors prompt-audit):
 *   .nax/review-audit/<featureName>/<epochMs>-<sessionName>.json
 *
 * All operations are best-effort: errors are warned but never thrown so that
 * an audit write failure can never interrupt an active run.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getSafeLogger } from "../logger";
import { findNaxProjectRoot } from "../utils/nax-project-root";

export interface ReviewAuditEntry {
  /** Reviewer type. */
  reviewer: "semantic" | "adversarial";
  /** ACP session name — used as part of the filename for correlation with prompt-audit. */
  sessionName: string;
  /** Working directory — used to resolve the audit dir when projectDir is absent. */
  workdir: string;
  /** Story ID for metadata. */
  storyId?: string;
  /** Feature name — determines the subfolder under review-audit/. */
  featureName?: string;
  /**
   * Whether the LLM response parsed successfully into a valid review JSON.
   * false = parse failed; looksLikeFail indicates the heuristic result.
   */
  parsed: boolean;
  /** When parsed is false, whether the raw response contained "passed":false. */
  looksLikeFail?: boolean;
  /** The structured reviewer result. null when parsed is false. */
  result: { passed: boolean; findings: unknown[] } | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps (for unit testing)
// ─────────────────────────────────────────────────────────────────────────────

export const _reviewAuditDeps = {
  async mkdir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  },
  async writeFile(path: string, content: string): Promise<void> {
    await Bun.write(path, content);
  },
  now(): number {
    return Date.now();
  },
  findNaxProjectRoot,
};

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write a review audit entry to disk. Best-effort — errors warn but never throw.
 * Call with `void writeReviewAudit(...)` (fire-and-forget) from reviewer functions.
 */
export async function writeReviewAudit(entry: ReviewAuditEntry): Promise<void> {
  try {
    const projectRoot = await _reviewAuditDeps.findNaxProjectRoot(entry.workdir);
    const resolvedDir = join(projectRoot, ".nax", "review-audit", entry.featureName ?? "_unknown");

    await _reviewAuditDeps.mkdir(resolvedDir);

    const epochMs = _reviewAuditDeps.now();
    const filename = `${epochMs}-${entry.sessionName}.json`;

    const content = JSON.stringify(
      {
        timestamp: new Date(epochMs).toISOString(),
        storyId: entry.storyId ?? null,
        featureName: entry.featureName ?? null,
        reviewer: entry.reviewer,
        sessionName: entry.sessionName,
        parsed: entry.parsed,
        ...(entry.parsed ? {} : { looksLikeFail: entry.looksLikeFail ?? false }),
        result: entry.result,
      },
      null,
      2,
    );

    await _reviewAuditDeps.writeFile(join(resolvedDir, filename), content);
  } catch (err) {
    getSafeLogger()?.warn("review-audit", "Failed to write review audit file", {
      error: String(err),
      sessionName: entry.sessionName,
    });
  }
}
