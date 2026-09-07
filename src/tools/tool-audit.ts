/**
 * Durable record of every coding-tool call.
 *
 * runtime.ts already logs each outcome, and says why: a refused call that
 * leaves no trace is indistinguishable from a call never made. But it logs
 * through getSafeLogger(), and issue #1359 closed on a measured zero taken off
 * exactly such a counter while the persisted records still held ten in-window
 * findings. The zero meant "no data retained" and was read as "did not happen".
 *
 * So a signal a later decision depends on is written here, not there. The
 * logger keeps its calls for operator visibility; neither replaces the other.
 *
 * File shape mirrors src/review/review-audit.ts: one JSON file per session,
 * named <epochMs>-<sessionName>.json.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ToolCallRecord {
  readonly tool: string;
  readonly outcome: "ok" | "error" | "denied";
  readonly breach?: boolean;
  readonly input: Record<string, unknown>;
  readonly resultBytes: number;
  readonly storyId?: string;
  readonly at: string;
  /**
   * Why a "denied" outcome was refused. runtime.ts's log() computes this for
   * the console logger (under the `error` key) but used to drop it before it
   * reached this sink, so a denied row's `error` field read null and the
   * refusal reason was unrecoverable -- the exact gap this field closes.
   */
  readonly reason?: string;
  /**
   * The argv that actually ran, after normalization (workspace scoping, an
   * appended no-scripts flag). Set only for the argv branch (`Exec`).
   * Deliberately alongside `input.argv` (the model's requested argv) rather
   * than instead of it: either half alone is uninformative -- `input` cannot
   * show what actually ran, and `executed` alone cannot show whether the
   * normalization was faithful to what was requested.
   */
  readonly executed?: readonly string[];
  /** Which workspace root the argv branch executed against. */
  readonly target?: "package" | "repoRoot";
}

export interface ToolAuditSink {
  record(entry: ToolCallRecord): void;
  flush(): Promise<void>;
}

export function createNoOpToolAuditSink(): ToolAuditSink {
  return { record() {}, async flush() {} };
}

export function createToolAuditSink(opts: { dir: string; sessionName: string }): ToolAuditSink {
  const calls: ToolCallRecord[] = [];
  return {
    record(entry) {
      calls.push(entry);
    },
    async flush() {
      if (calls.length === 0) return;
      await mkdir(opts.dir, { recursive: true });
      const body = JSON.stringify({ sessionName: opts.sessionName, calls }, null, 2);
      await writeFile(join(opts.dir, `${Date.now()}-${opts.sessionName}.json`), body);
    },
  };
}
