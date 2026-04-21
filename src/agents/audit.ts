/**
 * Prompt Audit — fire-and-forget file writer for AgentManager-dispatched prompts.
 *
 * Owned by AgentManager (ADR-012 / ADR-013 §0). Every LLM call — descriptor
 * session or ephemeral — passes through IAgentManager, making it the universal
 * chokepoint for audit writes. The adapter is a pure executor with no audit concern.
 *
 * File layout (flat — no subdirs):
 *   <auditDir>/<featureName>/<epochMs>-<label>-<stage>.txt
 *
 * `ls <auditDir> | sort` yields the chronological prompt trace across all
 * agents and call types for a given feature run.
 *
 * All operations are best-effort: errors are warned but never thrown so that
 * an audit write failure can never interrupt an active run.
 */

import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { getSafeLogger } from "../logger";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface PromptAuditEntry {
  /** Raw prompt text sent to the agent. */
  prompt: string;
  /** Agent name (e.g. "claude", "codex") — used in filename when sessionName is absent. */
  agentName?: string;
  /**
   * Human-readable session label for the filename (e.g. "claude-my-feature-us-001").
   * Falls back to agentName when absent.
   */
  sessionName?: string;
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
  /**
   * Stable nax session ID from SessionManager (descriptor.id).
   * Present only for descriptor sessions routed through SessionManager.runInSession().
   * Absent for ephemeral calls (complete(), plan(), debate turns) — honest absence.
   */
  stableSessionId?: string;
  /** 1-indexed turn number — preserved for backward compat with legacy adapter-written entries. */
  turn?: number;
  /** Volatile session ID (acpxSessionId) — preserved for backward compat. */
  sessionId?: string;
  /** Stable record ID (acpxRecordId) — preserved for backward compat. */
  recordId?: string;
  /** Whether the ACP session was resumed — preserved for backward compat. */
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
 *   run  → <epochMs>-<label>-<stage>-t<pad2(turn)>.txt   (legacy turn entries)
 *   run  → <epochMs>-<label>-<stage>.txt                  (AgentManager entries — no turn)
 *   complete → <epochMs>-<label>-<stage>.txt
 */
export function buildAuditFilename(entry: PromptAuditEntry, epochMs: number): string {
  const label = entry.sessionName ?? entry.agentName ?? "agent";
  const stage = entry.pipelineStage ?? entry.callType;
  if (entry.callType === "run" && entry.turn !== undefined) {
    const pad = String(entry.turn).padStart(2, "0");
    return `${epochMs}-${label}-${stage}-t${pad}.txt`;
  }
  return `${epochMs}-${label}-${stage}.txt`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Content builder
// ─────────────────────────────────────────────────────────────────────────────

function buildAuditContent(entry: PromptAuditEntry, epochMs: number): string {
  const ts = new Date(epochMs).toISOString();
  const typeLabel = entry.callType === "run" && entry.turn !== undefined ? `run / turn ${entry.turn}` : entry.callType;

  const lines = [
    `Timestamp: ${ts}`,
    ...(entry.agentName ? [`Agent:     ${entry.agentName}`] : []),
    ...(entry.sessionName ? [`Session:   ${entry.sessionName}`] : []),
    ...(entry.stableSessionId ? [`StableId:  ${entry.stableSessionId}`] : []),
    ...(entry.recordId ? [`RecordId:  ${entry.recordId}`] : []),
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
 */
export async function findNaxProjectRoot(startDir: string): Promise<string> {
  let dir = resolve(startDir);
  for (let depth = 0; depth < MAX_NAX_WALK_DEPTH; depth++) {
    if (await _promptAuditDeps.exists(join(dir, ".nax", "config.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write a prompt audit entry to disk. Best-effort — errors warn but never throw.
 * Called with `void writePromptAudit(...)` (fire-and-forget) from AgentManager.
 */
export async function writePromptAudit(entry: PromptAuditEntry): Promise<void> {
  try {
    let baseDir: string;
    if (entry.auditDir) {
      baseDir = isAbsolute(entry.auditDir) ? entry.auditDir : join(entry.workdir, entry.auditDir);
    } else if (entry.projectDir) {
      baseDir = join(entry.projectDir, ".nax", "prompt-audit");
    } else {
      const wtMarker = `${sep}.nax-wt${sep}`;
      const wtIdx = entry.workdir.indexOf(wtMarker);
      const strippedWorkdir = wtIdx !== -1 ? entry.workdir.substring(0, wtIdx) : entry.workdir;
      const projectRoot = await findNaxProjectRoot(strippedWorkdir);
      baseDir = join(projectRoot, ".nax", "prompt-audit");
    }

    const resolvedDir = join(baseDir, entry.featureName ?? "_unknown");
    await _promptAuditDeps.mkdir(resolvedDir);

    const epochMs = _promptAuditDeps.now();
    const filename = buildAuditFilename(entry, epochMs);
    const content = buildAuditContent(entry, epochMs);

    await _promptAuditDeps.writeFile(join(resolvedDir, filename), content);
  } catch (err) {
    getSafeLogger()?.warn("agent-manager", "Failed to write prompt audit file", {
      error: String(err),
      sessionName: entry.sessionName ?? entry.agentName,
    });
  }
}
