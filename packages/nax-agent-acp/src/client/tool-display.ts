/**
 * What a person sees of an agent's permission request (S4 spec §6.4 "untrusted
 * fields", D3-a). The agent's kind, title, locations and rawInput are display data
 * only: they never decide. Every string is control-stripped, scrubbed of the
 * session's secret values, masked as nax-agent's own approvals are
 * (maskForPrompt), redacted and capped. Oversized raw text and text whose secret
 * cannot be masked safely make the request unshowable: it is never put in front
 * of a person (D3-b).
 */
import type { ToolKind } from "@agentclientprotocol/sdk";
import { maskForPrompt, redactSecrets, TOOL_CALL_INPUT_BYTES } from "@nathapp/nax-agent";
import { capBytes, isRecord, scrubSecrets, stripControl, stripInvisible } from "#src/client/text";

export const SUMMARY_MAX_BYTES = 1024;
/**
 * Raw agent text above these sizes is withheld without being masked: maskForPrompt
 * is quadratic (8 KiB takes about 4 ms, 256 KiB seconds), and truncating first
 * would show a cut secret prefix.
 */
export const SUMMARY_RAW_MAX_BYTES = 8 * 1024;
export const COMMAND_RAW_MAX_BYTES = 32 * 1024;
const CALL_ID_MAX_CHARS = 512;
const WITHHELD = "(details withheld: they could not be shown safely)";

const KINDS: ReadonlySet<string> = new Set<ToolKind>([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
]);

export interface ToolCallDisplay {
  readonly callId?: string;
  readonly tool: string;
  readonly summary: string;
  readonly command?: string;
  /** False when agent text held a secret that could not be masked safely. */
  readonly showable: boolean;
}

type Call = Readonly<Record<string, unknown>>;
type Shown = { readonly ok: true; readonly text: string } | { readonly ok: false };

interface ShowLimits {
  readonly rawMaxBytes: number;
  readonly capBytes: number;
  /** Newlines and tabs collapse to one space. */
  readonly oneLine: boolean;
}

const SUMMARY: ShowLimits = { rawMaxBytes: SUMMARY_RAW_MAX_BYTES, capBytes: SUMMARY_MAX_BYTES, oneLine: true };
const COMMAND: ShowLimits = { rawMaxBytes: COMMAND_RAW_MAX_BYTES, capBytes: TOOL_CALL_INPUT_BYTES, oneLine: false };

/** Visible, secret-free text: strip, scrub the session's secrets, mask pattern secrets, redact. */
function clean(text: string, secrets: readonly string[]): Shown {
  const masked = maskForPrompt(scrubSecrets(stripInvisible(stripControl(text)), secrets));
  return masked.ok ? { ok: true, text: redactSecrets(masked.masked) } : { ok: false };
}

function show(raw: string, secrets: readonly string[], limits: ShowLimits): Shown {
  if (Buffer.byteLength(raw, "utf8") > limits.rawMaxBytes) return { ok: false };
  const text = limits.oneLine ? raw.replace(/[\n\t\u2028\u2029]+\s*/g, " ") : raw;
  const shown = clean(text, secrets);
  return shown.ok ? { ok: true, text: capBytes(shown.text, limits.capBytes) } : { ok: false };
}

function kindOf(call: Call): string {
  return typeof call.kind === "string" && KINDS.has(call.kind) ? call.kind : "other";
}

/** The agent's id without invisible characters or whitespace; dropped when it held a secret. */
function callIdOf(call: Call, secrets: readonly string[]): string | undefined {
  if (typeof call.toolCallId !== "string" || call.toolCallId.length > CALL_ID_MAX_CHARS) return undefined;
  const id = stripInvisible(stripControl(call.toolCallId)).replace(/\s+/g, "");
  if (id === "") return undefined;
  const shown = clean(id, secrets);
  // An id that held a secret is dropped, not shown masked: it would no longer match the agent's id.
  return shown.ok && shown.text === id ? id : undefined;
}

function firstPath(call: Call): string | undefined {
  if (!Array.isArray(call.locations)) return undefined;
  const first: unknown = call.locations[0];
  return isRecord(first) && typeof first.path === "string" && first.path !== "" ? first.path : undefined;
}

function summarySource(call: Call, kind: string): string {
  const title = typeof call.title === "string" ? call.title.trim() : "";
  if (title !== "") return title;
  const path = firstPath(call);
  return path === undefined ? `${kind} tool call` : `${kind} ${path}`;
}

function commandSource(call: Call, kind: string): string | undefined {
  if (kind !== "execute" || !isRecord(call.rawInput)) return undefined;
  const command = call.rawInput.command;
  return typeof command === "string" && command !== "" ? command : undefined;
}

export function describeToolCall(toolCall: unknown, secrets: readonly string[]): ToolCallDisplay {
  const call: Call = isRecord(toolCall) ? toolCall : {};
  const kind = kindOf(call);
  const callId = callIdOf(call, secrets);
  const summary = show(summarySource(call, kind), secrets, SUMMARY);
  const rawCommand = commandSource(call, kind);
  const command = rawCommand === undefined ? undefined : show(rawCommand, secrets, COMMAND);
  return {
    ...(callId === undefined ? {} : { callId }),
    tool: kind,
    summary: summary.ok ? summary.text : `${kind} tool call ${WITHHELD}`,
    ...(command?.ok ? { command: command.text } : {}),
    showable: summary.ok && (command === undefined || command.ok),
  };
}
