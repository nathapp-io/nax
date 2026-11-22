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

/** The task prompt first, then everything the agent did, folded the way the chat folds a turn. */
export function agentViewEntries(run: BackgroundAgentRun): readonly TranscriptEntry[] {
  const first: readonly TranscriptEntry[] = [{ kind: "user", text: run.prompt }];
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
