/**
 * The full-screen subagent view as data: the transcript entries a recorded agent run folds
 * into, and the header and footer rows drawn around them.
 *
 * The view reuses the main chat's own reducer and layout, so an agent's text, thinking and tool
 * cards read exactly as they do in the chat. The only entry the reducer does not produce is the
 * first one: the task prompt, drawn as the user message the agent was given.
 */
import type { BackgroundAgentRun, BackgroundTaskState } from "@/chat/background";
import { singleRow } from "./layout-lines";
import type { Span, StyledLine } from "./styled-line";
import type { ChatColorToken } from "./theme";
import { reduceTranscript, type TranscriptEntry } from "./transcript-model";

/** The footer's one hint: the view is read-only, and escape is the only way out. */
export const AGENT_VIEW_HINT = "esc to return";
/** Rows the view spends outside its transcript: title, rule and footer. */
export const AGENT_VIEW_CHROME_ROWS = 3;
/** Rows above the transcript: the title and the rule. */
export const AGENT_VIEW_HEADER_ROWS = 2;

const SEPARATOR = " · ";
const NO_MODEL = "model unknown";

const STATE_LABELS: Record<BackgroundTaskState, string> = {
  running: "running",
  succeeded: "done",
  failed: "failed",
  stopped: "stopped",
};

const STATE_COLORS: Record<BackgroundTaskState, ChatColorToken> = {
  running: "accent",
  succeeded: "success",
  failed: "danger",
  stopped: "warning",
};

/** The state as the header names it: running, done, failed or stopped. */
export function agentStateLabel(state: BackgroundTaskState): string {
  return STATE_LABELS[state];
}

/** What the view says in place of a conversation the registry dropped to stay under its total limit. */
export const LOG_NOT_RETAINED_NOTICE = "the log of this agent is no longer retained";

/**
 * The task prompt first, then everything the agent did, folded the way the chat folds a turn. A
 * finished run whose log was evicted keeps its prompt and says so, rather than showing nothing.
 */
export function agentViewEntries(run: BackgroundAgentRun): readonly TranscriptEntry[] {
  const first: readonly TranscriptEntry[] = [{ kind: "user", text: run.prompt }];
  if (!run.logRetained) return [...first, { kind: "notice", text: LOG_NOT_RETAINED_NOTICE }];
  return run.events.reduce<readonly TranscriptEntry[]>((entries, event) => reduceTranscript(entries, event), first);
}

/** The header's title row: the agent, its model and its state. */
export function agentViewTitle(run: BackgroundAgentRun): StyledLine {
  const facts = `${SEPARATOR}${singleRow(run.model ?? NO_MODEL)}${SEPARATOR}`;
  const state: Span = { text: agentStateLabel(run.state), color: STATE_COLORS[run.state], bold: true };
  return [
    { text: `Agent ${singleRow(run.agent)}`, color: "accent", bold: true },
    { text: facts, color: "muted" },
    state,
  ];
}

/** The title shown when the task has left the registry before the view could read it. */
export function missingAgentTitle(id: string): StyledLine {
  return [
    { text: `Agent ${singleRow(id)}`, color: "accent", bold: true },
    { text: `${SEPARATOR}no longer listed`, color: "muted" },
  ];
}

export function agentViewFooter(): StyledLine {
  return [{ text: AGENT_VIEW_HINT, color: "muted" }];
}

/**
 * A stable identity for an entry the user can open: a tool card by its call, thinking by its
 * turn and start. Not the entry's index, which shifts when the oldest events are dropped.
 */
export function entryKey(entry: TranscriptEntry): string | undefined {
  if (entry.kind === "tool") return `tool:${entry.turnId}:${entry.callId}`;
  if (entry.kind === "thinking") return `thinking:${entry.turnId}:${entry.startedAt}`;
  return undefined;
}

/** The entries with the user's click-opened rows applied; the fold alone never opens one. */
export function withOpened(
  entries: readonly TranscriptEntry[],
  opened: ReadonlyMap<string, boolean>,
): readonly TranscriptEntry[] {
  if (opened.size === 0) return entries;
  return entries.map((entry) => {
    const key = entryKey(entry);
    return key !== undefined && opened.has(key) ? Object.assign({}, entry, { open: opened.get(key) }) : entry;
  });
}

/** The one entry a toggle changed, as its key and new `open`; undefined when nothing keyed changed. */
export function toggledEntry(
  before: readonly TranscriptEntry[],
  after: readonly TranscriptEntry[],
): { key: string; open: boolean } | undefined {
  const entry = after.find((candidate, at) => candidate !== before[at]);
  if (entry === undefined || !("open" in entry)) return undefined;
  const key = entryKey(entry);
  return key === undefined ? undefined : { key, open: entry.open === true };
}
