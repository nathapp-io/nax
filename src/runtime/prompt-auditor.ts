import { mkdirSync } from "node:fs";
import { join } from "node:path";

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
  appendLine: async (path: string, data: string): Promise<void> => {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(path, data, "utf8");
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Human-readable txt content builder
// ─────────────────────────────────────────────────────────────────────────────

function deriveTxtFilename(entry: PromptAuditEntry): string {
  if (entry.sessionName) {
    return `${entry.ts}-${entry.sessionName}.txt`;
  }
  const parts: string[] = [String(entry.ts), entry.callType ?? "call", entry.stage ?? "unknown"];
  if (entry.storyId) parts.push(entry.storyId);
  return `${parts.join("-")}.txt`;
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
    this._queue = this._queue.then(() => this._writeEntry(entry)).catch(() => this._writeEntry(entry));
  }

  private async _writeEntry(entry: PromptAuditEntry | PromptAuditErrorEntry): Promise<void> {
    if (!this._dirCreated) {
      mkdirSync(this._featureDir, { recursive: true });
      this._dirCreated = true;
    }
    await _promptAuditorDeps.appendLine(this._jsonlPath, `${JSON.stringify(entry)}\n`);

    if (!("prompt" in entry) || !("response" in entry)) return;
    const auditEntry = entry as PromptAuditEntry;
    const filename = deriveTxtFilename(auditEntry);
    await _promptAuditorDeps.write(join(this._featureDir, filename), buildTxtContent(auditEntry));
  }

  async flush(): Promise<void> {
    await this._queue;
  }
}
