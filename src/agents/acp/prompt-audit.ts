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

import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
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
  /**
   * Repository root where `.nax/` lives. When provided, skips the
   * parent-directory walk in findNaxProjectRoot(). Carries PipelineContext.projectDir.
   */
  projectDir?: string;
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
  /** Session ID returned by the ACP provider (e.g. acpx UUID). Undefined when not available. */
  sessionId?: string;
  /** Whether the ACP session was resumed from a prior run (true) or freshly created (false/undefined). */
  resumed?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Injectable deps (for unit testing)
// ─────────────────────────────────────────────────────────────────────────────

export const _promptAuditDeps = {
  async mkdir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  },
  async exists(path: string): Promise<boolean> {
    return Bun.file(path).exists();
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
    ...(entry.sessionId ? [`SessionId: ${entry.sessionId}`] : []),
    `Type:      ${typeLabel}`,
    `StoryId:   ${entry.storyId ?? "(none)"}`,
    `Feature:   ${entry.featureName ?? "(none)"}`,
    `Stage:     ${entry.pipelineStage ?? entry.callType}`,
    `Resumed:   ${entry.resumed === true ? "yes" : "no"}`,
    "---",
    entry.prompt,
  ];
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const MAX_NAX_WALK_DEPTH = 10;

/**
 * Walk up from startDir to find the nearest ancestor that contains `.nax/config.json`.
 * Returns that ancestor (the nax project root). Falls back to startDir if not found.
 *
 * This consolidates monorepo audit files at the project root even when individual
 * stories run with a package subdir as their workdir (e.g. apps/api/).
 */
export async function findNaxProjectRoot(startDir: string): Promise<string> {
  let dir = resolve(startDir);
  for (let depth = 0; depth < MAX_NAX_WALK_DEPTH; depth++) {
    if (await _promptAuditDeps.exists(join(dir, ".nax", "config.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root reached
    dir = parent;
  }
  return startDir; // fallback: use workdir as-is
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
    // Two normalisations are applied when auditDir is absent:
    //   1. Worktree strip: paths containing /.nax-wt/<storyId>/ are trimmed to the
    //      project root so parallel-worktree audit files are not written to the
    //      ephemeral worktree directory (WorktreeManager convention).
    //   2. Monorepo walk-up: after stripping, walk up from the effective workdir to
    //      the nearest ancestor containing .nax/config.json. This ensures monorepo
    //      per-package stories (e.g. workdir=apps/api/) write to the project root
    //      instead of the package subdirectory.
    let baseDir: string;
    if (entry.auditDir) {
      baseDir = isAbsolute(entry.auditDir) ? entry.auditDir : join(entry.workdir, entry.auditDir);
    } else if (entry.projectDir) {
      // Fast path: PipelineContext.projectDir is the stable repo root — no walk needed.
      baseDir = join(entry.projectDir, ".nax", "prompt-audit");
    } else {
      // Fallback: strip worktree path then walk up to find .nax/config.json.
      const wtMarker = `${sep}.nax-wt${sep}`;
      const wtIdx = entry.workdir.indexOf(wtMarker);
      const strippedWorkdir = wtIdx !== -1 ? entry.workdir.substring(0, wtIdx) : entry.workdir;
      const projectRoot = await findNaxProjectRoot(strippedWorkdir);
      baseDir = join(projectRoot, ".nax", "prompt-audit");
    }

    // Organise by feature name so each feature has its own subfolder.
    // Falls back to "_unknown" when no featureName is available.
    const resolvedDir = join(baseDir, entry.featureName ?? "_unknown");

    await _promptAuditDeps.mkdir(resolvedDir);

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
