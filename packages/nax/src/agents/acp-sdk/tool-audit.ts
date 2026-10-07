/**
 * Tool audit on the ACP SDK transport (S4b spec §7.4, D3-j). The backend emits
 * exactly one tool_result per tool_call, also when the turn throws; this pairs
 * them by ACP call id into one ToolCallRecord. A deny recorded by the ask port
 * between the two marks the call denied, so a refused call is one row. Input is
 * already redacted and capped by the backend; the sink redacts again at write.
 * Without OpenSessionOpts.toolAudit nothing is written.
 */
import {
  createNoOpToolAuditSink,
  createToolAuditSink,
  type ToolAuditHeader,
  type ToolAuditSink,
  type ToolCallRecord,
  type TurnEvent,
} from "@nathapp/nax-agent";

export interface ToolAuditTarget {
  readonly dir: string;
  readonly header: ToolAuditHeader;
}

export interface AuditRecorder {
  onEvent(event: TurnEvent): void;
  /** The ask port's auto-deny (recordAutoDecision). */
  denied(callId: string | undefined, tool: string, reason: string): void;
  /** Writes pending calls as errors, then flushes the sink. */
  flush(): Promise<void>;
}

interface Pending {
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly at: string;
  deniedReason?: string;
}

function inputOf(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : { value: input };
}

export function createAuditRecorder(
  sessionName: string,
  target: ToolAuditTarget | undefined,
  now: () => Date = () => new Date(),
): AuditRecorder {
  const sink: ToolAuditSink =
    target === undefined
      ? createNoOpToolAuditSink()
      : createToolAuditSink({ dir: target.dir, sessionName, header: target.header });
  const storyId = target?.header.storyId;
  const pending = new Map<string, Pending>();

  const write = (
    callId: string | undefined,
    call: Pending,
    outcome: ToolCallRecord["outcome"],
    bytes: number,
  ): void => {
    sink.record({
      tool: call.tool,
      outcome,
      input: call.input,
      resultBytes: bytes,
      ...(storyId === undefined ? {} : { storyId }),
      at: call.at,
      ...(callId === undefined ? {} : { toolCallId: callId }),
      ...(call.deniedReason === undefined ? {} : { reason: call.deniedReason }),
    });
  };

  return {
    onEvent: (event) => {
      if (event.type === "tool_call") {
        pending.set(event.callId, { tool: event.name, input: inputOf(event.input), at: now().toISOString() });
        return;
      }
      if (event.type !== "tool_result") return;
      const call = pending.get(event.callId);
      if (call === undefined) return;
      pending.delete(event.callId);
      const bytes = event.resultBytes ?? Buffer.byteLength(event.preview, "utf8");
      const outcome = call.deniedReason !== undefined ? "denied" : event.isError ? "error" : "ok";
      write(event.callId, call, outcome, bytes);
    },
    denied: (callId, tool, reason) => {
      const call = callId === undefined ? undefined : pending.get(callId);
      if (call !== undefined) {
        call.deniedReason = reason;
        return;
      }
      write(callId, { tool, input: {}, at: now().toISOString(), deniedReason: reason }, "denied", 0);
    },
    flush: async () => {
      for (const [callId, call] of pending)
        write(callId, call, call.deniedReason === undefined ? "error" : "denied", 0);
      pending.clear();
      await sink.flush();
    },
  };
}
