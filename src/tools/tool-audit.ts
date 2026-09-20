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
  readonly outcome: "ok" | "error" | "denied" | "denied:ask";
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
  /** Provider id for a provider-supplied tool; absent for built-ins. */
  readonly provider?: string;
  /**
   * Result size BEFORE the maxBytes slice. `resultBytes` is measured after,
   * so elision is otherwise invisible — a 2 MB result and a 40 KB one both
   * ledger as 40000.
   */
  readonly resultBytesPreTruncation?: number;
  /**
   * The `callOp` invocation this tool call happened under.
   *
   * NOT unique: one callId spans every retry, agent-swap hop and turn of the
   * invocation, so it is 1:N over cost rows (10.0% of groups hold more than
   * one). It is a foreign key. Use `turnId` to select a single cost row.
   *
   * This is the OPERATION-layer callId (`DispatchEventBase.callId`), not the
   * stream-layer field of the same name in `agent-stream-events.ts` — joining
   * on that one produced nax#2045's 0-of-1,940 match rate.
   */
  readonly callId?: string;
  /** Caller-defined region spanning many callOp invocations. */
  readonly scopeId?: string;
}

export interface ToolAuditSink {
  record(entry: ToolCallRecord): void;
  flush(): Promise<void>;
}

export function createNoOpToolAuditSink(): ToolAuditSink {
  return { record() {}, async flush() {} };
}

/**
 * tool-audit file schema version.
 *
 * 1 — first versioned generation. Adds a file header (`runId`, `featureName`,
 *     `storyId`, `sessionRole`) and per-call correlation ids (`callId`,
 *     `scopeId`, `turnId`, `roundTrips`, `toolCallId`).
 *
 *     Files written before this field existed carry none of the above and
 *     cannot be backfilled: `runId` in particular was never in scope at the
 *     sink's construction path, so an unversioned file's only identity is its
 *     filename.
 *
 *     `sessionName` is a HUMAN LABEL from this version on, never a join key.
 *     It is constant-prefixed and stable across re-runs by construction, so it
 *     collides: 7.5% of review-audit sessionNames span more than one runId.
 *     Join on `runId` plus `callId`/`turnId` instead.
 *
 *     NOTE ON `resultBytes`: it is measured AFTER the shared model-truncation
 *     policy (applyModelTruncationPolicy, src/tools/spill.ts) and so counts what
 *     the model actually received — the spill marker is composed inside the
 *     measured content, so its bytes count. That boundary moved at the
 *     `native-loop-events` merge (f4b3bbc7a): files written before it measured
 *     each tool's own post-truncation `result.content.length` at `ctx.maxBytes`
 *     instead. The policy additionally applies `MODEL_MAX_LINES` (1_000),
 *     `MODEL_MAX_LINE_CHARS` (2_000) and a `MODEL_MAX_BYTES` (40_000) ceiling,
 *     so the two generations are not comparable call for call. The unit was
 *     never bytes: it is `String#length`, i.e. UTF-16 code units, so a
 *     multi-byte result under-reports against the field name.
 *     `resultBytesPreTruncation` is the pre-policy size and, where a tool sets
 *     it, is UTF-8 bytes (`Buffer.byteLength` / `Bun.file().size`).
 */
export const TOOL_AUDIT_SCHEMA_VERSION = 1;

/** Run-scoped identity stamped once per tool-audit file. */
export interface ToolAuditHeader {
  readonly runId?: string;
  readonly featureName?: string;
  readonly storyId?: string;
  readonly sessionRole?: string;
}

export function createToolAuditSink(opts: {
  dir: string;
  sessionName: string;
  header?: ToolAuditHeader;
}): ToolAuditSink {
  const calls: ToolCallRecord[] = [];
  return {
    record(entry) {
      calls.push(entry);
    },
    async flush() {
      if (calls.length === 0) return;
      await mkdir(opts.dir, { recursive: true });
      const body = JSON.stringify(
        {
          schemaVersion: TOOL_AUDIT_SCHEMA_VERSION,
          ...(opts.header ?? {}),
          sessionName: opts.sessionName,
          calls,
        },
        null,
        2,
      );
      await writeFile(join(opts.dir, `${Date.now()}-${opts.sessionName}.json`), body);
    },
  };
}
