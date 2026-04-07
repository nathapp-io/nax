/**
 * Prompt Audit — fire-and-forget file writer for ACP-bound prompts.
 *
 * When `agent.promptAudit.enabled` is true, every prompt dispatched to ACP
 * is written to a flat file in the audit directory so operators can trace
 * the full prompt sequence that reached the agent.
 *
 * File layout (flat — no subdirs):
 *   <auditDir>/<epochMs>-<sessionName>-<stage>-t<turn>.txt   (run() turns)
 *   <auditDir>/<epochMs>-<sessionName>-<stage>.txt            (complete())
 *
 * `ls <auditDir> | sort` yields the chronological prompt trace across all
 * sessions and call types for a given feature run.
 *
 * All operations are best-effort: errors are warned but never thrown so that
 * an audit write failure can never interrupt an active run.
 */

import { mkdirSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { getSafeLogger } from "../../logger";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface PromptAuditEntry {
  /** Raw prompt text sent to the agent. */
  prompt: string;
  /** ACP session name (e.g. nax-abc12345-my-feature-us-001). */
  sessionName: string;
  /** Working directory — used to resolve the default audit dir. */
  workdir: string;
  /** Override for the audit directory. Absolute or relative to workdir. */
  auditDir?: string;
  /** Story ID for the metadata header. */
  storyId?: string;
  /** Feature name for the metadata header. */
  featureName?: string;
  /** Pipeline stage (e.g. "run", "complete", "decompose"). */
  pipelineStage?: string;
  /** Whether this entry comes from run() or complete(). */
  callType: "run" | "complete";
  /** 1-indexed turn number — only set for run() multi-turn entries. */
  turn?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps (for unit testing)
// ─────────────────────────────────────────────────────────────────────────────

export const _promptAuditDeps = {
  mkdirSync(path: string): void {
    mkdirSync(path, { recursive: true });
  },
  async writeFile(path: string, content: string): Promise<void> {
    await Bun.write(path, content);
  },
  now(): number {
    return Date.now();
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Filename builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the audit filename for a given entry.
 * Format:
 *   run  → <epochMs>-<sessionName>-<stage>-t<pad2(turn)>.txt
 *   complete → <epochMs>-<sessionName>-<stage>.txt
 */
export function buildAuditFilename(entry: PromptAuditEntry, epochMs: number): string {
  const stage = entry.pipelineStage ?? entry.callType;
  if (entry.callType === "run" && entry.turn !== undefined) {
    const pad = String(entry.turn).padStart(2, "0");
    return `${epochMs}-${entry.sessionName}-${stage}-t${pad}.txt`;
  }
  return `${epochMs}-${entry.sessionName}-${stage}.txt`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Content builder
// ─────────────────────────────────────────────────────────────────────────────

function buildAuditContent(entry: PromptAuditEntry, epochMs: number): string {
  const ts = new Date(epochMs).toISOString();
  const typeLabel = entry.callType === "run" && entry.turn !== undefined ? `run / turn ${entry.turn}` : entry.callType;

  const lines = [
    `Timestamp: ${ts}`,
    `Session:   ${entry.sessionName}`,
    `Type:      ${typeLabel}`,
    `StoryId:   ${entry.storyId ?? "(none)"}`,
    `Feature:   ${entry.featureName ?? "(none)"}`,
    `Stage:     ${entry.pipelineStage ?? entry.callType}`,
    "---",
    entry.prompt,
  ];
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write a prompt audit entry to disk. Best-effort — errors warn but never throw.
 * Call with `void writePromptAudit(...)` (fire-and-forget) from adapters.
 */
export async function writePromptAudit(entry: PromptAuditEntry): Promise<void> {
  try {
    // Resolve audit base directory.
    // When running in a parallel worktree (path contains /.nax-wt/), always write to
    // the main project root so audit files are consolidated in one place rather than
    // scattered across worktree directories.
    // Worktrees are always at <projectRoot>/.nax-wt/<storyId>/ (WorktreeManager convention).
    let baseDir: string;
    if (entry.auditDir) {
      baseDir = isAbsolute(entry.auditDir) ? entry.auditDir : join(entry.workdir, entry.auditDir);
    } else {
      const wtMarker = `${sep}.nax-wt${sep}`;
      const wtIdx = entry.workdir.indexOf(wtMarker);
      const projectRoot = wtIdx !== -1 ? entry.workdir.substring(0, wtIdx) : entry.workdir;
      baseDir = join(projectRoot, ".nax", "prompt-audit");
    }

    // Organise by feature name so each feature has its own subfolder.
    // Falls back to "_unknown" when no featureName is available.
    const resolvedDir = join(baseDir, entry.featureName ?? "_unknown");

    _promptAuditDeps.mkdirSync(resolvedDir);

    const epochMs = _promptAuditDeps.now();
    const filename = buildAuditFilename(entry, epochMs);
    const content = buildAuditContent(entry, epochMs);

    await _promptAuditDeps.writeFile(join(resolvedDir, filename), content);
  } catch (err) {
    getSafeLogger()?.warn("acp-adapter", "Failed to write prompt audit file", {
      error: String(err),
      sessionName: entry.sessionName,
    });
  }
}
