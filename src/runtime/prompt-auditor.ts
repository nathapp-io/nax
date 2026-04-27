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

/** Injectable deps — swap `write` in tests to avoid real disk I/O. */
export const _promptAuditorDeps = {
  write: (path: string, data: string): Promise<number> => Bun.write(path, data),
};

// ─────────────────────────────────────────────────────────────────────────────
// Human-readable txt content builder
// ─────────────────────────────────────────────────────────────────────────────

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
  private readonly _entries: (PromptAuditEntry | PromptAuditErrorEntry)[] = [];
  private _draining = false;
  private readonly _inFlightEntries: (PromptAuditEntry | PromptAuditErrorEntry)[] = [];

  constructor(
    private readonly _runId: string,
    /** Base audit directory (e.g. <workdir>/.nax/prompt-audit). */
    private readonly _flushDir: string,
    /** Feature name — used as a subdirectory so each feature has its own folder. */
    private readonly _featureName: string,
  ) {}

  record(entry: PromptAuditEntry): void {
    if (this._draining) {
      this._inFlightEntries.push(entry);
      return;
    }
    this._entries.push(entry);
  }

  recordError(entry: PromptAuditErrorEntry): void {
    if (this._draining) {
      this._inFlightEntries.push(entry);
      return;
    }
    this._entries.push(entry);
  }

  async flush(): Promise<void> {
    this._draining = true;
    try {
      const entries = this._entries.splice(0);
      if (entries.length === 0) return;

      const featureDir = join(this._flushDir, this._featureName);
      mkdirSync(featureDir, { recursive: true });

      // ── JSONL (machine-readable) ───────────────────────────────────────────
      const jsonlPath = join(featureDir, `${this._runId}.jsonl`);
      await _promptAuditorDeps.write(jsonlPath, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);

      // ── Per-entry .txt (human-readable) ───────────────────────────────────
      // Only PromptAuditEntry has prompt+response; error entries go to JSONL only.
      for (const entry of entries) {
        if (!("prompt" in entry) || !("response" in entry)) continue;
        const auditEntry = entry as PromptAuditEntry;
        if (!auditEntry.sessionName) continue;
        const filename = `${auditEntry.ts}-${auditEntry.sessionName}.txt`;
        await _promptAuditorDeps.write(join(featureDir, filename), buildTxtContent(auditEntry));
      }

      // Flush any entries that arrived during the async writes.
      const lateEntries = this._inFlightEntries.splice(0);
      if (lateEntries.length > 0) {
        const allEntries = [...entries, ...lateEntries];
        await _promptAuditorDeps.write(jsonlPath, `${allEntries.map((e) => JSON.stringify(e)).join("\n")}\n`);
        for (const entry of lateEntries) {
          if (!("prompt" in entry) || !("response" in entry)) continue;
          const auditEntry = entry as PromptAuditEntry;
          if (!auditEntry.sessionName) continue;
          const filename = `${auditEntry.ts}-${auditEntry.sessionName}.txt`;
          await _promptAuditorDeps.write(join(featureDir, filename), buildTxtContent(auditEntry));
        }
      }
    } finally {
      this._draining = false;
    }
  }
}
