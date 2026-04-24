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
}

export interface PromptAuditErrorEntry {
  readonly ts: number;
  readonly runId: string;
  readonly agentName: string;
  readonly stage?: string;
  readonly storyId?: string;
  readonly errorCode: string;
  readonly durationMs: number;
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

  constructor(
    private readonly _runId: string,
    private readonly _flushDir: string,
  ) {}

  record(entry: PromptAuditEntry): void {
    this._entries.push(entry);
  }

  recordError(entry: PromptAuditErrorEntry): void {
    this._entries.push(entry);
  }

  async flush(): Promise<void> {
    if (this._entries.length === 0) return;
    mkdirSync(this._flushDir, { recursive: true });
    const path = join(this._flushDir, `${this._runId}.jsonl`);
    const content = `${this._entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
    await _promptAuditorDeps.write(path, content);
  }
}
