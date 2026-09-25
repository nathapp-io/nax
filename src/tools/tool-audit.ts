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
 * named <runId>-<epochMs>-<sessionName>.json when the runId is known, and
 * <epochMs>-<sessionName>.json otherwise.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { redactRowStrings } from "@/permissions";
import type { SandboxRecord } from "../sandbox";

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
  /**
   * Who approved an ask-matched call and how long the decision took. Recorded
   * on BOTH the allow and deny paths so a human-approved execution is
   * distinguishable in the ledger from a mechanically-allowed one.
   *
   * `remembered` is always false today: `AskVerdict` carries no "remembered"
   * signal, so this is a placeholder for when the cache reports a hit.
   */
  readonly approval?: { readonly decidedBy: string; readonly remembered: boolean; readonly latencyMs: number };
  /**
   * P4: `{ backend, wrapped, reason?, denialHint?, argv? }` on every Bash /
   * Exec row; the exit runs gate on `wrapped`, and `argv` (wrapped calls only)
   * is the argv the sandbox actually executed, beside the logical `executed`.
   * Additive and optional, so `TOOL_AUDIT_SCHEMA_VERSION` stays 1 (as
   * `approval` did).
   */
  readonly sandbox?: SandboxRecord;
  /**
   * Bash rows only: the shell's exit code, present when nax did not kill the
   * process group (absent on timeout and turn abort; see `ToolResult.audit`).
   * `outcome` is unchanged -- every non-zero exit is still `"error"` -- so a
   * reader separates a negative answer (a no-match grep, exit 1) from a real
   * failure by reading `exitCode` together with `executed`. N >= 128 may be a
   * signal nax did not send. Additive and optional, so
   * `TOOL_AUDIT_SCHEMA_VERSION` stays 1 (as `sandbox` did).
   */
  readonly exitCode?: number;
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
  /**
   * The turn this call happened in. One turn is one cost row, so this is the
   * field that prices a tool call. Native sessions only — ACP does not route
   * coding tools through the turn loop.
   */
  readonly turnId?: string;
  /**
   * Model round-trip index WITHIN the turn, 1-based.
   *
   * Not a turn index. `turn-loop.ts` pushes an interaction field named
   * `turnIndex` whose value is this same round-trip counter; the two names
   * have been conflated before. Native sessions only.
   */
  readonly roundTrips?: number;
  /**
   * Provider-assigned `tool_use` id, passed through verbatim — nax never mints
   * or namespaces it. Unique within a session in practice, with no global
   * guarantee, and NOT stable across a retry: a retried turn produces fresh
   * ids. The unique tuple is (runId, sessionName, toolCallId).
   */
  readonly toolCallId?: string;
}

export interface ToolAuditSink {
  record(entry: ToolCallRecord): void;
  flush(): Promise<void>;
}

/**
 * The sink `createToolAuditSink` returns, plus the shutdown-time flush.
 *
 * `flushPartial()` writes whatever is still buffered with `partial: true` so a
 * sink whose hop `finally` never runs before `process.exit` still leaves its
 * audit file behind. After it runs, the sink's own `flush()` is a no-op — the
 * hop `finally` that runs later must not write a second file.
 */
export interface RegisteredSink extends ToolAuditSink {
  flushPartial(): Promise<void>;
}

/** Register a sink so the run's shutdown can flush whatever it still holds. */
export function registerToolAuditSink(_runId: string, _sink: RegisteredSink): void {}

/** Drop a sink from the run's registry (see registerToolAuditSink). */
export function unregisterToolAuditSink(_runId: string, _sink: RegisteredSink): void {}

/**
 * Flush every still-registered sink for `runId` with `partial: true`, then
 * clear them. Never rejects: one sink's failure must not stop the drain.
 */
export async function flushOpenToolAuditSinks(_runId: string): Promise<void> {}

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
}): RegisteredSink {
  const calls: ToolCallRecord[] = [];
  return {
    record(entry) {
      calls.push(entry);
    },
    async flushPartial() {},
    async flush() {
      if (calls.length === 0) return;
      await mkdir(opts.dir, { recursive: true });
      const body = JSON.stringify(
        {
          schemaVersion: TOOL_AUDIT_SCHEMA_VERSION,
          ...(opts.header ?? {}),
          sessionName: opts.sessionName,
          calls: redactRowStrings(calls),
        },
        null,
        2,
      );
      const prefix = opts.header?.runId !== undefined ? `${opts.header.runId}-` : "";
      await writeFile(join(opts.dir, `${prefix}${Date.now()}-${opts.sessionName}.json`), body);
    },
  };
}
