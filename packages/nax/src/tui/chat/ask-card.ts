/**
 * Ask cards — the pure model behind the framed card an approval (or a question) puts in
 * place of the chat input.
 *
 * The model carries no colour and no glyph: it names the border's intent, the title, the
 * options in the order they are offered and the lines of an Edit's diff, and `AskCard.tsx`
 * draws them. Title and attribution come from what the session reported, the options from
 * the controller's remembering policy (passed in, never re-derived here), and the diff from
 * the transcript entry the ask's `callId` names — the same `diffLines` the tool card uses,
 * so one replacement text reads identically in both places.
 *
 * Every string that reaches the card came from a tool, an MCP server or the host, so each is
 * sanitised before it becomes span text: a reason carrying `\u001b[?1049l` cannot leave the
 * alternate screen.
 */
import type { AskChoice, ChatApproval, ChatPendingAsk } from "@/chat";
import { sanitizeText } from "./styled-line";
import { type DiffLine, diffLines } from "./tool-card";
import type { TranscriptEntry } from "./transcript-model";

/** What the frame's border says about the ask: a caution, or a refusal waiting to happen. */
export type AskBorder = "warning" | "danger";

/** One option the card offers, numbered as the card numbers it. */
export interface AskOption {
  /** 1-based position in the list, as the card draws it. */
  readonly index: number;
  /** The option's own words, without the number the card prefixes. */
  readonly label: string;
  /** What choosing it resolves. */
  readonly choice: AskChoice;
}

/** The first option's words: yes, this once. */
export const ASK_YES = "Yes";
/** The second option's words: yes, and every later ask carrying the same key. */
export const ASK_YES_SESSION = "Yes, and don't ask again for this in this session";
/** The last option's words: no, with the input freed to say what to do instead. */
export const ASK_NO = "No, tell nax what to do instead (esc)";
/** What a question card titles itself: nax is the one asking. */
export const ASK_QUESTION_TITLE = "nax asks";
/** What the card calls an ask that wants to run outside the OS sandbox. */
const UNSANDBOXED_NOTE = "outside the sandbox";
/** The card's own words for what each tool's approval is about. */
const TITLES: ReadonlyMap<string, string> = new Map([
  ["Bash", "Bash command"],
  ["Edit", "Edit file"],
  ["Write", "Write file"],
  ["Delete", "Delete file"],
]);
/** The provider-qualified prefix of the `nax-agents` provider's tools: an agent run. */
const AGENT_TOOL_PREFIX = "nax-agents__";
/** What separates an MCP server's name from its tool's name. */
const PROVIDER_SEPARATOR = "__";
const AGENT_TITLE = "Agent";
const MCP_TITLE = "MCP tool";
/** The one tool whose approval carries a diff: the replacement it wants to make. */
const DIFF_TOOL = "Edit";
/** The host's tag for an ask a subagent raised: `[agent <name>] ` before its own reason. */
const AGENT_REASON = /^\[agent ([^\]\n]+)\] /;
const TITLE_SEPARATOR = " · ";

export interface AskCardOptions {
  /** Whether the ask may be remembered for the session — `controller.canRemember(ask)`, not re-derived here. */
  readonly canRemember: boolean;
  /** The transcript, where an Edit approval's diff is looked up by `callId`. */
  readonly entries: readonly TranscriptEntry[];
}

export interface AskCardApproval {
  readonly kind: "approval";
  readonly title: string;
  readonly tag?: string;
  readonly command?: string;
  readonly summary: string;
  readonly reason: string;
  readonly border: AskBorder;
  readonly options: readonly AskOption[];
  readonly diff: readonly DiffLine[];
}

export interface AskCardQuestion {
  readonly kind: "question";
  readonly title: string;
  readonly text: string;
  readonly border: AskBorder;
}

export type AskCardModel = AskCardApproval | AskCardQuestion;

/** The card's title: what the tool does, plus the sandbox note when it wants out. */
function askTitle(ask: ChatApproval, tool: string): string {
  const named = TITLES.get(tool);
  const base = named ?? (tool.startsWith(AGENT_TOOL_PREFIX) ? AGENT_TITLE : mcpTitle(tool));
  return ask.unsandboxed === true ? `${base}${TITLE_SEPARATOR}${UNSANDBOXED_NOTE}` : base;
}

/** A provider-qualified name reads as the MCP tool it is; any other keeps its own name. */
function mcpTitle(tool: string): string {
  return tool.includes(PROVIDER_SEPARATOR) ? `${MCP_TITLE} ${tool}` : tool;
}

function stringField(source: unknown, field: string): string | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const value = Reflect.get(source, field);
  return typeof value === "string" ? value : undefined;
}

/** The input an ask's call carried, wherever the transcript recorded it. */
interface RecordedCall {
  readonly input: unknown;
}

/**
 * The call the ask names: a top-level entry, or a subagent call the reducer nested under the
 * agent card that ran it. A subagent's approval names its own child call, so searching only
 * the top-level entries would leave every attributed Edit approval without its diff.
 */
function recordedCall(entries: readonly TranscriptEntry[], callId: string | undefined): RecordedCall | undefined {
  if (callId === undefined) return undefined;
  for (const entry of entries) {
    if (entry.kind !== "tool") continue;
    if (entry.callId === callId) return { input: entry.input };
    const child = entry.children.find((item) => item.callId === callId);
    if (child !== undefined) return { input: child.input };
  }
  return undefined;
}

/**
 * The diff of an Edit approval: the replacement the recorded call carried, read the way the
 * tool card reads it. Only an Edit has one — a Write approval would show what it is about to
 * write, not the file it replaces — and an ask with no recorded call, or a call missing
 * either side of the replacement, has none either. The call may be one a subagent made, so
 * it is looked up among the nested calls as well as the top-level ones.
 */
function askDiff(tool: string, ask: ChatApproval, entries: readonly TranscriptEntry[]): readonly DiffLine[] {
  if (tool !== DIFF_TOOL) return [];
  const entry = recordedCall(entries, ask.callId);
  if (entry === undefined) return [];
  const oldText = stringField(entry.input, "old_string");
  const newText = stringField(entry.input, "new_string");
  if (oldText === undefined || newText === undefined) return [];
  return diffLines(oldText, newText).map((line) => ({ sign: line.sign, text: sanitizeText(line.text) }));
}

/** The reason with a subagent's tag taken off it, and the tag itself when there was one. */
interface Attribution {
  readonly reason: string;
  readonly tag?: string;
}

function attribution(reason: string): Attribution {
  const match = AGENT_REASON.exec(reason);
  if (match === null) return { reason };
  return { reason: reason.slice(match[0].length), tag: `[agent ${match[1]}]` };
}

/** The options in the order they are offered; the session option only while it is allowed. */
function askOptions(canRemember: boolean): readonly AskOption[] {
  const yes: AskOption = { index: 1, label: ASK_YES, choice: "allow_once" };
  if (!canRemember) return [yes, { index: 2, label: ASK_NO, choice: "deny" }];
  return [
    yes,
    { index: 2, label: ASK_YES_SESSION, choice: "allow_session" },
    { index: 3, label: ASK_NO, choice: "deny" },
  ];
}

/** The card for one ask: an approval's identity, options and diff, or a question's text. */
export function askCardModel(ask: ChatPendingAsk, options: AskCardOptions): AskCardModel {
  if (ask.type === "question") {
    return { kind: "question", title: ASK_QUESTION_TITLE, text: sanitizeText(ask.text), border: "warning" };
  }
  const tool = sanitizeText(ask.tool);
  const said = attribution(sanitizeText(ask.reason));
  return {
    kind: "approval",
    title: askTitle(ask, tool),
    ...(said.tag === undefined ? {} : { tag: said.tag }),
    ...(ask.command === undefined ? {} : { command: sanitizeText(ask.command) }),
    summary: sanitizeText(ask.summary),
    reason: said.reason,
    border: ask.unsandboxed === true ? "danger" : "warning",
    options: askOptions(options.canRemember),
    diff: askDiff(tool, ask, options.entries),
  };
}
