/**
 * The chat transcript as data: the entry union the redesigned view renders and the pure
 * reducer that folds session events into it.
 *
 * Every step returns a new array in which only the changed entry is a new object, so
 * unchanged entries keep their identity. The view's per-entry layout cache depends on
 * that (US-010), which is why an event that changes nothing returns the input array
 * itself rather than a copy.
 */
import type { SessionEvent } from "@nathapp/nax-agent";
import type { MentionStatus } from "@/chat/mentions";

export interface ToolChild {
  readonly callId: string;
  readonly name: string;
  readonly input: unknown;
  readonly status: "running" | "ok" | "error";
}

export type TranscriptEntry =
  | { kind: "welcome"; skills: number; commands: number; agents: number; mcpServers: number; mcpConnected: number }
  | { kind: "user"; text: string; mentions?: readonly string[] }
  /** One mention nax expanded on send: what travelled, and the body ctrl+o reveals. */
  | { kind: "attachment"; path: string; status: MentionStatus; note: string; body: string; open?: boolean }
  | { kind: "skill"; name: string; args: string; body: string; open?: boolean }
  | { kind: "reply"; turnId: string; text: string }
  | { kind: "thinking"; turnId: string; text: string; startedAt: string; endedAt?: string; open?: boolean }
  | {
      kind: "tool";
      turnId: string;
      callId: string;
      name: string;
      input: unknown;
      startedAt: string;
      status: "running" | "ok" | "error";
      open?: boolean;
      preview?: string;
      endedAt?: string;
      children: readonly ToolChild[];
    }
  | { kind: "notice"; text: string }
  | { kind: "warning"; text: string }
  | { kind: "error"; text: string }
  | { kind: "listing"; title: string; text: string }
  | { kind: "interrupted" };

type ToolEntry = Extract<TranscriptEntry, { kind: "tool" }>;

type ThinkingEntry = Extract<TranscriptEntry, { kind: "thinking" }>;

type EventOf<T extends SessionEvent["type"]> = Extract<SessionEvent, { type: T }>;

/** Where an entry sits, so a shallow copy can stay shallow. */
interface Found<T> {
  readonly index: number;
  readonly entry: T;
}

/** The provider-qualified name of the `nax-agents` provider's `run` tool. */
const AGENT_RUN_TOOL = "nax-agents__run";
const COMPACTION_NOTICE = "conversation compacted";

function replaceIn<T>(items: readonly T[], index: number, item: T): readonly T[] {
  return [...items.slice(0, index), item, ...items.slice(index + 1)];
}

function findOpenThinking(entries: readonly TranscriptEntry[], turnId: string): Found<ThinkingEntry> | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.kind === "thinking" && entry.turnId === turnId && entry.endedAt === undefined) return { index, entry };
  }
  return undefined;
}

/** The most recent tool entry matching `match`. */
function findTool(
  entries: readonly TranscriptEntry[],
  match: (entry: ToolEntry) => boolean,
): Found<ToolEntry> | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.kind === "tool" && match(entry)) return { index, entry };
  }
  return undefined;
}

function stringField(source: unknown, field: string): string | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const value = Reflect.get(source, field);
  return typeof value === "string" ? value : undefined;
}

/** The task a nested subagent call carries (tagged by the host); undefined for a top-level call. */
function subagentTask(event: Pick<SessionEvent, "metadata">): string | undefined {
  return stringField(event.metadata, "subagentTask");
}

/** The running agent entry a nested call belongs under, matched by the task the host tagged. */
function findAgentParent(entries: readonly TranscriptEntry[], task: string): Found<ToolEntry> | undefined {
  return findTool(entries, (entry) => {
    if (entry.name !== AGENT_RUN_TOOL || entry.status !== "running") return false;
    return stringField(entry.input, "task") === task;
  });
}

/** Ends the turn's open thinking entry; returns the input array when there is none. */
function endThinking(entries: readonly TranscriptEntry[], turnId: string, at: string): readonly TranscriptEntry[] {
  const open = findOpenThinking(entries, turnId);
  return open ? replaceIn(entries, open.index, { ...open.entry, endedAt: at }) : entries;
}

function applyTextDelta(entries: readonly TranscriptEntry[], event: EventOf<"text_delta">): readonly TranscriptEntry[] {
  const ended = endThinking(entries, event.turnId, event.at);
  const last = ended.at(-1);
  if (last?.kind === "reply" && last.turnId === event.turnId) {
    return replaceIn(ended, ended.length - 1, { ...last, text: last.text + event.text });
  }
  return [...ended, { kind: "reply", turnId: event.turnId, text: event.text }];
}

function applyThinkingDelta(
  entries: readonly TranscriptEntry[],
  event: EventOf<"thinking_delta">,
): readonly TranscriptEntry[] {
  const open = findOpenThinking(entries, event.turnId);
  if (!open) {
    return [...entries, { kind: "thinking", turnId: event.turnId, text: event.text, startedAt: event.at }];
  }
  return replaceIn(entries, open.index, { ...open.entry, text: open.entry.text + event.text });
}

function applyToolCall(entries: readonly TranscriptEntry[], event: EventOf<"tool_call">): readonly TranscriptEntry[] {
  const ended = endThinking(entries, event.turnId, event.at);
  const task = subagentTask(event);
  const parent = task === undefined ? undefined : findAgentParent(ended, task);
  if (parent) {
    const child: ToolChild = { callId: event.callId, name: event.name, input: event.input, status: "running" };
    return replaceIn(ended, parent.index, { ...parent.entry, children: [...parent.entry.children, child] });
  }
  return [
    ...ended,
    {
      kind: "tool",
      turnId: event.turnId,
      callId: event.callId,
      name: event.name,
      input: event.input,
      startedAt: event.at,
      status: "running",
      children: [],
    },
  ];
}

/** The agent entry a nested call's result belongs to; only a tagged result is looked up by child call. */
function findChildParent(
  entries: readonly TranscriptEntry[],
  event: EventOf<"tool_result">,
): Found<ToolEntry> | undefined {
  const task = subagentTask(event);
  return findTool(entries, (entry) => {
    if (!entry.children.some((child) => child.callId === event.callId)) return false;
    if (task === undefined) return true;
    return entry.name === AGENT_RUN_TOOL && stringField(entry.input, "task") === task;
  });
}

function applyToolResult(
  entries: readonly TranscriptEntry[],
  event: EventOf<"tool_result">,
): readonly TranscriptEntry[] {
  const status: ToolChild["status"] = event.isError ? "error" : "ok";
  const tool = findTool(entries, (entry) => entry.turnId === event.turnId && entry.callId === event.callId);
  if (tool) {
    return replaceIn(entries, tool.index, { ...tool.entry, status, preview: event.preview, endedAt: event.at });
  }
  const parent = findChildParent(entries, event);
  if (!parent) return entries;
  const childIndex = parent.entry.children.findIndex((child) => child.callId === event.callId);
  if (childIndex < 0) return entries;
  const child = parent.entry.children[childIndex];
  const children = replaceIn(parent.entry.children, childIndex, { ...child, status });
  return replaceIn(entries, parent.index, { ...parent.entry, children });
}

function applyTurnEnd(entries: readonly TranscriptEntry[], event: EventOf<"turn_end">): readonly TranscriptEntry[] {
  const ended = endThinking(entries, event.turnId, event.at);
  if (event.status === "errored" && event.error) {
    return [...ended, { kind: "error", text: `${event.error.code}: ${event.error.message}` }];
  }
  return event.status === "cancelled" ? [...ended, { kind: "interrupted" }] : ended;
}

/**
 * Folds one session event into the transcript. The input array is never mutated: the
 * result shares every entry the event did not touch, and an event that changes nothing
 * returns the input array itself.
 */
export function reduceTranscript(entries: readonly TranscriptEntry[], event: SessionEvent): readonly TranscriptEntry[] {
  switch (event.type) {
    case "text_delta":
      return applyTextDelta(entries, event);
    case "thinking_delta":
      return applyThinkingDelta(entries, event);
    case "tool_call":
      return applyToolCall(entries, event);
    case "tool_result":
      return applyToolResult(entries, event);
    case "turn_end":
      return applyTurnEnd(entries, event);
    case "compaction":
      return [...entries, { kind: "notice", text: COMPACTION_NOTICE }];
    default:
      return entries;
  }
}
