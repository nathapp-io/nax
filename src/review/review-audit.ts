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
  /** Runtime run ID for correlation with prompt/cost audit. */
  runId?: string;
  /** Reviewer type. */
  reviewer: "semantic" | "adversarial";
  /** ACP session name — used as part of the filename for correlation with prompt-audit. */
  sessionName: string;
  /** ACP volatile session ID. */
  sessionId?: string | null;
  /** ACP stable record ID. */
  recordId?: string | null;
  /** Working directory — used to resolve the audit dir when projectDir is absent. */
  workdir: string;
  /** Project root, when known. */
  projectDir?: string;
  /** Output directory — when present, used as the first choice for resolvedDir. */
  outputDir?: string;
  /** Agent that produced the reviewed response. */
  agentName?: string;
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
  /** Whether the final review result failed open. */
  failOpen?: boolean;
  /** Final review pass/fail after review-domain threshold handling. */
  passed?: boolean;
  /** Blocking threshold used to classify findings. */
  blockingThreshold?: "error" | "warning" | "info";
  /** The structured reviewer result. null when parsed is false. */
  result: { passed: boolean; findings: unknown[] } | null;
  /** Findings retained as advisory after threshold handling. */
  advisoryFindings?: unknown[];
}

export interface ReviewAuditDispatch {
  runId: string;
  reviewer: "semantic" | "adversarial";
  sessionName: string;
  sessionId?: string | null;
  recordId?: string | null;
  workdir?: string;
  projectDir?: string;
  /** Output directory — when present, used as the first choice for resolvedDir. */
  outputDir?: string;
  agentName?: string;
  storyId?: string;
  featureName?: string;
}

export type ReviewAuditDecision = Omit<ReviewAuditEntry, "sessionName" | "workdir"> & {
  sessionName?: string;
  workdir?: string;
};

export interface IReviewAuditor {
  recordDispatch(entry: ReviewAuditDispatch): void;
  recordDecision(entry: ReviewAuditDecision): void;
  flush(): Promise<void>;
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

function auditKey(reviewer: "semantic" | "adversarial", storyId: string | undefined): string {
  return `${reviewer}:${storyId ?? "_feature"}`;
}

function fallbackSessionName(entry: ReviewAuditDecision): string {
  return `review-${entry.reviewer}-${entry.storyId ?? "unknown"}`;
}

function toPersistedEntry(entry: ReviewAuditEntry, epochMs: number): string {
  return JSON.stringify(
    {
      timestamp: new Date(epochMs).toISOString(),
      runId: entry.runId ?? null,
      storyId: entry.storyId ?? null,
      featureName: entry.featureName ?? null,
      reviewer: entry.reviewer,
      sessionName: entry.sessionName,
      sessionId: entry.sessionId ?? null,
      recordId: entry.recordId ?? null,
      agentName: entry.agentName ?? null,
      parsed: entry.parsed,
      ...(entry.parsed ? {} : { looksLikeFail: entry.looksLikeFail ?? false }),
      failOpen: entry.failOpen ?? false,
      passed: entry.passed ?? entry.result?.passed ?? null,
      blockingThreshold: entry.blockingThreshold ?? null,
      result: entry.result,
      advisoryFindings: entry.advisoryFindings ?? null,
    },
    null,
    2,
  );
}

async function persistReviewAudit(entry: ReviewAuditEntry): Promise<void> {
  let resolvedDir: string;
  if (entry.outputDir) {
    resolvedDir = join(entry.outputDir, "review-audit", entry.featureName ?? "_unknown");
  } else {
    const projectRoot = entry.projectDir ?? (await _reviewAuditDeps.findNaxProjectRoot(entry.workdir));
    resolvedDir = join(projectRoot, ".nax", "review-audit", entry.featureName ?? "_unknown");
  }

  await _reviewAuditDeps.mkdir(resolvedDir);

  const epochMs = _reviewAuditDeps.now();
  const filename = `${epochMs}-${entry.sessionName}.json`;
  await _reviewAuditDeps.writeFile(join(resolvedDir, filename), toPersistedEntry(entry, epochMs));
}

export function createNoOpReviewAuditor(): IReviewAuditor {
  return {
    recordDispatch() {},
    recordDecision() {},
    async flush() {},
  };
}

export class ReviewAuditor implements IReviewAuditor {
  private _queue: Promise<void> = Promise.resolve();
  private readonly _dispatches = new Map<string, ReviewAuditDispatch>();

  constructor(
    private readonly _runId: string,
    private readonly _outputDir: string,
  ) {}

  recordDispatch(entry: ReviewAuditDispatch): void {
    this._dispatches.set(auditKey(entry.reviewer, entry.storyId), entry);
  }

  recordDecision(entry: ReviewAuditDecision): void {
    const key = auditKey(entry.reviewer, entry.storyId);
    const dispatch = this._dispatches.get(key);
    this._dispatches.delete(key);
    const merged: ReviewAuditEntry = {
      ...entry,
      runId: entry.runId ?? dispatch?.runId ?? this._runId,
      sessionName: entry.sessionName ?? dispatch?.sessionName ?? fallbackSessionName(entry),
      sessionId: entry.sessionId ?? dispatch?.sessionId ?? null,
      recordId: entry.recordId ?? dispatch?.recordId ?? null,
      workdir: entry.workdir ?? dispatch?.workdir ?? "",
      outputDir: entry.outputDir ?? dispatch?.outputDir ?? this._outputDir,
      projectDir: entry.projectDir ?? dispatch?.projectDir,
      agentName: entry.agentName ?? dispatch?.agentName,
      storyId: entry.storyId ?? dispatch?.storyId,
      featureName: entry.featureName ?? dispatch?.featureName,
    };

    this._queue = this._queue
      .then(() => persistReviewAudit(merged))
      .catch((err) => {
        getSafeLogger()?.warn("review-audit", "Failed to write review audit file", {
          error: String(err),
          sessionName: merged.sessionName,
          storyId: merged.storyId,
          reviewer: merged.reviewer,
        });
      });
  }

  async flush(): Promise<void> {
    await this._queue;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write a review audit entry to disk. Best-effort — errors warn but never throw.
 * Call with `void writeReviewAudit(...)` (fire-and-forget) from reviewer functions.
 */
export async function writeReviewAudit(entry: ReviewAuditEntry): Promise<void> {
  try {
    await persistReviewAudit(entry);
  } catch (err) {
    getSafeLogger()?.warn("review-audit", "Failed to write review audit file", {
      error: String(err),
      sessionName: entry.sessionName,
    });
  }
}
