// Bun-native carve-out: appendFileSync + mkdir.
// Bun has no append API on Bun.write / FileSink (writer truncates), so node:fs is
// the pragmatic choice for incremental JSONL persistence.
//
// Why appendFileSync (not appendFile)? Under sustained load we observed
// JSONL entries silently dropping while their sibling `.txt` files (written
// via Bun.write) landed on disk — see the 2026-04-29 dogfood run where the
// run-log heartbeat also silenced for 9 minutes during the same window
// (`docs/findings/...`). The async `appendFile` from `node:fs/promises`
// goes through Bun's libuv-style queue; under event-loop pressure or a
// transient FS stall the promise can resolve without the bytes hitting
// disk. The sync variant goes straight to a `write(2)` syscall, removing
// that buffering hop. The `_queue` Promise chain still serializes calls,
// so the sync hit blocks only the auditor's own microtask — not the rest
// of the run. Audit lines are tiny (a few KB), so the cost is microseconds.
//
// Same pattern is used elsewhere in the repo for reliability-critical
// append paths: `src/execution/crash-heartbeat.ts:45` and
// `src/execution/lifecycle/precheck-runner.ts:67`.
//
// Top-level import avoids per-call dynamic-import cost. See
// `.claude/rules/forbidden-patterns.md` (appendFileSync is not banned;
// documented carve-out from the broader Bun-native rule).
import { appendFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getSafeLogger } from "../logger";
import { errorMessage } from "../utils/errors";

export interface PromptAuditEntry {
  readonly ts: number;
  readonly runId: string;
  readonly agentName: string;
  readonly stage?: string;
  readonly storyId?: string;
  readonly permissionProfile: string;
  readonly prompt: string;
  readonly response: string;
  readonly durationMs: number;
  /** Type of call: "run" | "complete" | "plan". */
  readonly callType?: string;
  readonly workdir?: string;
  readonly projectDir?: string;
  readonly featureName?: string;
  /** ACP-specific session correlation fields. */
  readonly sessionName?: string;
  readonly recordId?: string | null;
  readonly sessionId?: string | null;
  readonly turn?: number;
}

export interface PromptAuditErrorEntry {
  readonly ts: number;
  readonly runId: string;
  readonly agentName: string;
  readonly stage?: string;
  readonly storyId?: string;
  readonly errorCode: string;
  readonly errorMessage?: string;
  readonly durationMs: number;
  /** Type of call that errored: "run" | "complete" | "plan". */
  readonly callType?: string;
  /** Prompt that was being attempted when the error occurred — captured from ctx. */
  readonly prompt?: string;
  readonly workdir?: string;
  readonly projectDir?: string;
  readonly featureName?: string;
  readonly permissionProfile?: string;
}

export interface IPromptAuditor {
  record(entry: PromptAuditEntry): void;
  recordError(entry: PromptAuditErrorEntry): void;
  flush(): Promise<void>;
}

export function createNoOpPromptAuditor(): IPromptAuditor {
  return {
    record() {},
    recordError() {},
    async flush() {},
  };
}

/** Injectable deps — swap in tests to avoid real disk I/O. */
export const _promptAuditorDeps = {
  write: (path: string, data: string): Promise<number> => Bun.write(path, data),
  // Sync append: see file header for rationale (silent-drop bug under load
  // with async appendFile). Returns Promise<void> to keep the call-site
  // signature symmetric with `write` — callers `await` it.
  appendLine: async (path: string, data: string): Promise<void> => {
    appendFileSync(path, data, "utf8");
  },
};

/**
 * Tag a write failure with the phase that produced it ("jsonl" vs "txt") so
 * the catch handler in `_enqueue` can include it in the warning. Preserves
 * the original error as `cause` so OS-level errno fields (code/errno/syscall)
 * remain accessible for diagnostics.
 */
function tagAuditError(err: unknown, phase: "jsonl" | "txt"): Error {
  const wrapped = new Error(`prompt-audit ${phase} write failed: ${errorMessage(err)}`) as Error & {
    _auditPhase: "jsonl" | "txt";
    cause: unknown;
  };
  wrapped._auditPhase = phase;
  wrapped.cause = err;
  return wrapped;
}

// ─────────────────────────────────────────────────────────────────────────────
// Human-readable txt content builder
// ─────────────────────────────────────────────────────────────────────────────

function deriveTxtFilename(entry: PromptAuditEntry): string {
  if (entry.sessionName) {
    const suffix = deriveAuditSuffix(entry);
    return `${entry.ts}-${entry.sessionName}${suffix ? `-${suffix}` : ""}.txt`;
  }
  const parts: string[] = [String(entry.ts), entry.callType ?? "call", entry.stage ?? "unknown"];
  if (entry.storyId) parts.push(entry.storyId);
  return `${parts.join("-")}.txt`;
}

function deriveAuditSuffix(entry: PromptAuditEntry): string | undefined {
  if (entry.callType === "run" && entry.turn !== undefined) {
    const stage = entry.stage ?? "run";
    return `${stage}-t${String(entry.turn).padStart(2, "0")}`;
  }
  if (entry.callType === "complete") return "complete";
  return entry.stage ?? entry.callType;
}

function buildTxtContent(entry: PromptAuditEntry): string {
  const ts = new Date(entry.ts).toISOString();
  const lines = [
    `Timestamp:  ${ts}`,
    `Session:    ${entry.sessionName ?? "(none)"}`,
    `RunId:      ${entry.runId}`,
    `Agent:      ${entry.agentName}`,
    `Stage:      ${entry.stage ?? entry.callType ?? "(none)"}`,
    `StoryId:    ${entry.storyId ?? "(none)"}`,
    `Feature:    ${entry.featureName ?? "(none)"}`,
    `CallType:   ${entry.callType ?? "(none)"}`,
    ...(entry.turn !== undefined ? [`Turn:       ${entry.turn}`] : []),
    ...(entry.recordId ? [`RecordId:   ${entry.recordId}`] : []),
    ...(entry.sessionId ? [`SessionId:  ${entry.sessionId}`] : []),
    `Permission: ${entry.permissionProfile}`,
    `Duration:   ${entry.durationMs}ms`,
    "---",
    entry.prompt,
    "",
    "=== RESPONSE ===",
    "",
    entry.response,
  ];
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// PromptAuditor
// ─────────────────────────────────────────────────────────────────────────────

export class PromptAuditor implements IPromptAuditor {
  private _queue: Promise<void> = Promise.resolve();
  private _dirCreated = false;
  private readonly _jsonlPath: string;
  private readonly _featureDir: string;

  constructor(runId: string, flushDir: string, featureName: string) {
    this._featureDir = join(flushDir, featureName);
    this._jsonlPath = join(this._featureDir, `${runId}.jsonl`);
  }

  record(entry: PromptAuditEntry): void {
    this._enqueue(entry);
  }

  recordError(entry: PromptAuditErrorEntry): void {
    this._enqueue(entry);
  }

  private _enqueue(entry: PromptAuditEntry | PromptAuditErrorEntry): void {
    this._queue = this._queue
      .then(() => this._writeEntry(entry))
      .catch((err) => {
        // Per-entry failures (disk full, permission denied, transient FS stall)
        // must not break the chain. Log enough context to correlate the dropped
        // entry with the rest of the run's artifacts:
        //   - phase tells us whether the JSONL append or the .txt write failed
        //     (if .txt succeeded we'll find an orphan file with the same `ts`)
        //   - errno/code/syscall surface the OS-level cause (EACCES, ENOSPC, …)
        //   - entry identity (ts/storyId/sessionName/callType/agentName/stage)
        //     lets an operator find the corresponding .txt sidecar by `ts`
        // See file header for the silent-drop incident this guard exists for.
        const phase = (err as { _auditPhase?: "jsonl" | "txt" })._auditPhase;
        const cause = (err as { cause?: unknown }).cause ?? err;
        const sysErr = cause as NodeJS.ErrnoException;
        getSafeLogger()?.warn("audit", "prompt-audit write failed", {
          path: this._jsonlPath,
          phase: phase ?? "unknown",
          error: errorMessage(cause),
          code: sysErr?.code,
          errno: sysErr?.errno,
          syscall: sysErr?.syscall,
          ts: entry.ts,
          storyId: entry.storyId,
          sessionName: "sessionName" in entry ? entry.sessionName : undefined,
          callType: entry.callType,
          agentName: entry.agentName,
          stage: entry.stage,
        });
      });
  }

  private async _writeEntry(entry: PromptAuditEntry | PromptAuditErrorEntry): Promise<void> {
    if (!this._dirCreated) {
      try {
        await mkdir(this._featureDir, { recursive: true });
      } catch (err) {
        throw tagAuditError(err, "jsonl");
      }
      this._dirCreated = true;
    }
    try {
      await _promptAuditorDeps.appendLine(this._jsonlPath, `${JSON.stringify(entry)}\n`);
    } catch (err) {
      throw tagAuditError(err, "jsonl");
    }

    if (!("prompt" in entry) || !("response" in entry)) return;
    const auditEntry = entry as PromptAuditEntry;
    const filename = deriveTxtFilename(auditEntry);
    try {
      await _promptAuditorDeps.write(join(this._featureDir, filename), buildTxtContent(auditEntry));
    } catch (err) {
      throw tagAuditError(err, "txt");
    }
  }

  async flush(): Promise<void> {
    await this._queue;
  }
}
