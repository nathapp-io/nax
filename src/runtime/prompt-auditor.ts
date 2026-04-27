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

import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** Injectable deps — swap `write` in tests to avoid real disk I/O. */
export const _promptAuditorDeps = {
  write: (path: string, data: string): Promise<number> => Bun.write(path, data),
};

export class PromptAuditor implements IPromptAuditor {
  private readonly _entries: (PromptAuditEntry | PromptAuditErrorEntry)[] = [];
  private _draining = false;
  private readonly _inFlightEntries: (PromptAuditEntry | PromptAuditErrorEntry)[] = [];

  constructor(
    private readonly _runId: string,
    private readonly _flushDir: string,
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

      mkdirSync(this._flushDir, { recursive: true });
      const path = join(this._flushDir, `${this._runId}.jsonl`);
      await _promptAuditorDeps.write(path, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);

      // Flush any entries that arrived during the async write.
      // Re-write the complete merged file so the first batch is not lost.
      const lateEntries = this._inFlightEntries.splice(0);
      if (lateEntries.length > 0) {
        const allEntries = [...entries, ...lateEntries];
        await _promptAuditorDeps.write(path, `${allEntries.map((e) => JSON.stringify(e)).join("\n")}\n`);
      }
    } finally {
      this._draining = false;
    }
  }
}
