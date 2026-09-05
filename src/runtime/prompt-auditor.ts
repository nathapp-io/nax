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
import { getSafeLogger, redactSecrets } from "../logger";
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
  /**
   * Session correlation fields, populated by any transport that has a session
   * identity. `recordId` is the stable logical record; `sessionId` is the
   * physical one, which can change on reconnect. They were assumed ACP-only,
   * which is why native records carried neither (#1825).
   */
  readonly sessionName?: string;
  readonly recordId?: string | null;
  readonly sessionId?: string | null;
  readonly roundTrips?: number;
  readonly roundTripUnit?: "model-call" | "agent-run";
  /**
   * Position of this turn within its logical conversation, assigned by
   * PromptAuditor — callers do not set it. Distinct from `roundTrips`, which
   * counts iterations INSIDE one turn.
   */
  readonly turn?: number;
  /**
   * Mid-turn human-in-the-loop Q&A exchanges for this turn (issue #1226).
   * Present only when the agent asked the operator a question that was answered.
   * Appended to the human-readable .txt as an `=== INTERACTIONS ===` section;
   * absent on turns with no interaction, leaving existing .txt output unchanged.
   */
  readonly interactions?: readonly import("../agents/types").InteractionExchange[];
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
  if (entry.callType === "complete") {
    // US-002: a complete entry that knows its stage puts the stage into the
    // suffix so the filename distinguishes which stage's one-shot produced it.
    // Entries without a stage still produce the bare `complete` suffix, so
    // the previous invariant (`-complete.txt`) is preserved when the stage
    // is absent.
    return entry.stage ? `${entry.stage}-complete` : "complete";
  }
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
    ...(entry.roundTrips !== undefined
      ? [entry.roundTripUnit === "agent-run" ? `AgentRuns:  ${entry.roundTrips}` : `ModelCalls: ${entry.roundTrips}`]
      : []),
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
    ...buildInteractionLines(entry.interactions),
  ];
  return lines.join("\n");
}

/**
 * Render mid-turn human Q&A exchanges (issue #1226) as a trailing
 * `=== INTERACTIONS ===` section. Returns an empty array when there are no
 * interactions, so turns without human-in-the-loop Q&A produce byte-identical
 * output to the pre-#1226 format.
 */
function buildInteractionLines(interactions?: readonly import("../agents/types").InteractionExchange[]): string[] {
  if (!interactions?.length) return [];
  const lines = ["", "=== INTERACTIONS ===", ""];
  for (const ix of interactions) {
    lines.push(`[turn ${ix.turnIndex}] Q: ${ix.question}`, `         A: ${ix.reply}`, "");
  }
  // Drop the trailing blank separator for a clean ending.
  lines.pop();
  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// PromptAuditor
// ─────────────────────────────────────────────────────────────────────────────

export class PromptAuditor implements IPromptAuditor {
  private _queue: Promise<void> = Promise.resolve();
  private _dirCreated = false;
  private readonly _jsonlPath: string;
  private readonly _featureDir: string;
  /**
   * recordId (or sessionName when absent) -> turns seen so far.
   *
   * Keyed on the protocol's own identity rather than the display name: one
   * recordId spans separate sendTurn calls and stage changes, so it is what
   * says "still the same conversation". The map is per-auditor, and an auditor
   * is per-run, so the numbering's scope matches the audit directory's.
   */
  private readonly _turnOrdinals = new Map<string, number>();

  constructor(runId: string, flushDir: string, featureName: string) {
    this._featureDir = join(flushDir, featureName);
    this._jsonlPath = join(this._featureDir, `${runId}.jsonl`);
  }

  record(entry: PromptAuditEntry): void {
    this._enqueue(entry.callType === "run" ? { ...entry, turn: this._nextTurn(entry) } : entry);
  }

  private _nextTurn(entry: PromptAuditEntry): number {
    const key = entry.recordId ?? entry.sessionName ?? "";
    const next = (this._turnOrdinals.get(key) ?? 0) + 1;
    this._turnOrdinals.set(key, next);
    return next;
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
    // Redact once — entry.prompt/response can be hundreds of KB, and scanning that
    // text a second time via buildTxtContent(entry) + a second redactSecrets() call
    // would rerun all ~14 secret patterns over it again for no benefit.
    const safeEntry = redactSecrets(entry) as PromptAuditEntry | PromptAuditErrorEntry;
    try {
      await _promptAuditorDeps.appendLine(this._jsonlPath, `${JSON.stringify(safeEntry)}\n`);
    } catch (err) {
      throw tagAuditError(err, "jsonl");
    }

    if (!("prompt" in entry) || !("response" in entry)) return;
    // Filename derives from the original entry, not safeEntry — session names,
    // story IDs, etc. are never secret-shaped, but this keeps filename generation
    // provably independent of redaction either way.
    const filename = deriveTxtFilename(entry as PromptAuditEntry);
    try {
      await _promptAuditorDeps.write(join(this._featureDir, filename), buildTxtContent(safeEntry as PromptAuditEntry));
    } catch (err) {
      throw tagAuditError(err, "txt");
    }
  }

  async flush(): Promise<void> {
    await this._queue;
  }
}
