/**
 * Tool calls on the turn's event stream (S4 spec §6.7 tool rows, S4-5 D5-c to D5-f).
 * tool_call and tool_call_update notifications are merged per call id, cleaned as
 * for approvals (cleanCallId), so tool_call.callId matches approval_requested.callId.
 * A call's tool_call event goes out when the call is used: a permission request
 * names it (announce), or it reports in_progress, completed or failed. Claude
 * streams a call's input after first reporting it, so the event carries the input
 * known at that moment (D5-c). completed/failed answers it with one tool_result;
 * flush() answers an announced call left without one with an error result, so every
 * tool_call has exactly one tool_result (D5-e). A call never used emits nothing. Its
 * name is the agent's tool name, else its first real title, else its kind (D5-d).
 * Input and preview are agent data: capped, scrubbed of the session's secret values
 * and redacted best-effort (D5-f). At most MAX_TRACKED_CALLS calls per turn.
 */
import {
  capStrings,
  redactSecrets,
  TOOL_CALL_INPUT_BYTES,
  TOOL_RESULT_PREVIEW_BYTES,
  type TurnEvent,
} from "@nathapp/nax-agent";
import {
  capBytes,
  cleanLabel,
  isRecord,
  scrubDeep,
  scrubSecrets,
  stripControl,
  stripInvisible,
} from "#src/client/text";
import { cleanCallId } from "#src/client/tool-display";

export const MAX_TRACKED_CALLS = 512;
export const TOOL_NAME_MAX_CHARS = 200;
export const UNANSWERED_PREVIEW = "Not answered: the turn ended.";
/** A diff larger than this (old plus new text, in characters) is shown without line counts. */
export const DIFF_COUNT_MAX_CHARS = 1024 * 1024;
/** Redaction scans at most this much of a string or a preview, as nax-agent's own emitter does. */
const REDACTION_SCAN_BYTES = TOOL_RESULT_PREVIEW_BYTES * 16;
const PLACEHOLDER_TITLES: ReadonlySet<string> = new Set(["tool call", "tool"]);

export interface ToolEvents {
  /** A tool_call or tool_call_update of this turn. */
  onUpdate(update: unknown): void;
  /** A permission request names this call (a ToolCallUpdate): its tool_call goes out now. */
  announce(toolCall: unknown): void;
  /** Answers each announced call that has no result yet. */
  flush(): void;
}

interface CallState {
  readonly id: string;
  readonly name?: string;
  readonly title?: string;
  readonly kind?: string;
  readonly rawInput?: unknown;
  readonly content?: unknown;
  readonly rawOutput?: unknown;
  readonly announced: boolean;
  readonly resolved: boolean;
}

type Update = Readonly<Record<string, unknown>>;

function realTitle(value: unknown, secrets: readonly string[]): string | undefined {
  const title = cleanLabel(value, secrets, TOOL_NAME_MAX_CHARS);
  return title === undefined || PLACEHOLDER_TITLES.has(title.toLowerCase()) ? undefined : title;
}

const present = (value: unknown): boolean => value !== undefined && value !== null;

function merged(state: CallState, update: Update, secrets: readonly string[]): CallState {
  const name = state.name ?? cleanLabel(update.name, secrets, TOOL_NAME_MAX_CHARS);
  const title = state.title ?? realTitle(update.title, secrets);
  const kind = cleanLabel(update.kind, secrets, TOOL_NAME_MAX_CHARS) ?? state.kind;
  return {
    ...state,
    ...(name === undefined ? {} : { name }),
    ...(title === undefined ? {} : { title }),
    ...(kind === undefined ? {} : { kind }),
    ...(present(update.rawInput) ? { rawInput: update.rawInput } : {}),
    ...(Array.isArray(update.content) ? { content: update.content } : {}),
    ...(present(update.rawOutput) ? { rawOutput: update.rawOutput } : {}),
  };
}

function nameOf(state: CallState): string {
  return state.name ?? state.title ?? state.kind ?? "tool";
}

export function inputOf(raw: unknown, secrets: readonly string[]): unknown {
  if (!present(raw)) return {};
  const redacted = redactSecrets(scrubDeep(capStrings(raw, REDACTION_SCAN_BYTES), secrets));
  let json: string;
  try {
    json = JSON.stringify(redacted) ?? "null";
  } catch {
    return { truncated: true, preview: "[input not serializable]" };
  }
  if (Buffer.byteLength(json, "utf8") <= TOOL_CALL_INPUT_BYTES) return redacted;
  return { truncated: true, preview: capBytes(json, TOOL_CALL_INPUT_BYTES) };
}

function lines(text: string): readonly string[] {
  return text === "" ? [] : text.split("\n");
}

/** Lines added and removed, as a multiset difference (linear time; moved lines count as unchanged). */
function lineDelta(oldText: string, newText: string): { readonly added: number; readonly removed: number } {
  const pool = new Map<string, number>();
  for (const line of lines(oldText)) pool.set(line, (pool.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of lines(newText)) {
    const left = pool.get(line) ?? 0;
    if (left > 0) pool.set(line, left - 1);
    else added += 1;
  }
  let removed = 0;
  for (const left of pool.values()) removed += left;
  return { added, removed };
}

export function diffSummary(diff: Readonly<Record<string, unknown>>): string {
  const path = typeof diff.path === "string" && diff.path !== "" ? diff.path : "(unknown path)";
  const oldText = typeof diff.oldText === "string" ? diff.oldText : "";
  const newText = typeof diff.newText === "string" ? diff.newText : "";
  if (oldText.length + newText.length > DIFF_COUNT_MAX_CHARS) return `edit ${path}`;
  const { added, removed } = lineDelta(oldText, newText);
  return `edit ${path} (+${added} -${removed})`;
}

function contentPart(item: unknown): string {
  if (!isRecord(item)) return "";
  if (item.type === "diff") return diffSummary(item);
  if (item.type !== "content" || !isRecord(item.content)) return "";
  const block = item.content;
  if (block.type === "text" && typeof block.text === "string") return block.text;
  if (block.type === "resource_link" && typeof block.uri === "string") return block.uri;
  return "";
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map(contentPart)
    .filter((part) => part !== "")
    .join("\n");
}

export function previewOf(
  call: { readonly content?: unknown; readonly rawOutput?: unknown },
  secrets: readonly string[],
): string {
  const fromContent = contentText(call.content);
  let raw = fromContent;
  if (raw === "" && typeof call.rawOutput === "string") raw = call.rawOutput;
  const visible = stripInvisible(stripControl(capBytes(raw, REDACTION_SCAN_BYTES)));
  return capBytes(redactSecrets(scrubSecrets(visible, secrets)), TOOL_RESULT_PREVIEW_BYTES);
}

const UTF8 = new TextEncoder();

/** UTF-8 byte length of the full result text, before any cap (S4b spec §7.4). */
export function resultBytesOf(call: { readonly content?: unknown; readonly rawOutput?: unknown }): number {
  const fromContent = contentText(call.content);
  const raw = fromContent !== "" ? fromContent : typeof call.rawOutput === "string" ? call.rawOutput : "";
  return UTF8.encode(raw).byteLength;
}

function isStarted(status: unknown): boolean {
  return status === "in_progress" || status === "completed" || status === "failed";
}

export function createToolEvents(emit: (event: TurnEvent) => void, secrets: readonly string[]): ToolEvents {
  const calls = new Map<string, CallState>();
  const merge = (update: unknown): CallState | undefined => {
    if (!isRecord(update)) return undefined;
    const id = cleanCallId(update.toolCallId, secrets);
    if (id === undefined) return undefined;
    const known = calls.get(id);
    if (known === undefined && calls.size >= MAX_TRACKED_CALLS) return undefined;
    const next = merged(known ?? { id, announced: false, resolved: false }, update, secrets);
    calls.set(id, next);
    return next;
  };
  const announce = (state: CallState): CallState => {
    if (state.announced) return state;
    const next = { ...state, announced: true };
    calls.set(state.id, next);
    emit({ type: "tool_call", callId: state.id, name: nameOf(state), input: inputOf(state.rawInput, secrets) });
    return next;
  };
  const resolve = (state: CallState, isError: boolean, preview: string, resultBytes: number): void => {
    if (state.resolved) return;
    calls.set(state.id, { ...state, resolved: true });
    emit({ type: "tool_result", callId: state.id, isError, preview, resultBytes });
  };
  return {
    onUpdate(update) {
      const state = merge(update);
      const status = isRecord(update) ? update.status : undefined;
      if (state === undefined || !isStarted(status)) return;
      const shown = announce(state);
      if (status !== "in_progress")
        resolve(shown, status === "failed", previewOf(shown, secrets), resultBytesOf(shown));
    },
    announce(toolCall) {
      const state = merge(toolCall);
      if (state !== undefined) announce(state);
    },
    flush() {
      for (const state of [...calls.values()]) {
        if (state.announced) resolve(state, true, UNANSWERED_PREVIEW, 0);
      }
    },
  };
}
