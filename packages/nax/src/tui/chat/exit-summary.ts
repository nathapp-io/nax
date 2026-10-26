/**
 * What the terminal is left with once the chat screen has closed: which session was
 * just lived through, what it cost, and the command that resumes it. The chat prints it
 * after leaving the alternate screen, so it survives in the user's scrollback (US-019).
 */
import type { ChatHostState } from "@/chat";

/** Two decimals, matching the footer's spend display. */
const COST_DECIMALS = 2;
const COST_PREFIX = "$";
const BULLET = "✻";
const SEPARATOR = " · ";
const INDENT = "  ";

/**
 * The two-line summary for a finished chat session. Derived from the host state alone, so
 * it is the same line whether the session ended from a quit, a turn failure or a signal.
 */
export function formatChatExitSummary(state: ChatHostState): string {
  const cost = (state.meta.costUsd ?? 0).toFixed(COST_DECIMALS);
  const resume = `nax chat --resume ${state.sessionId}`;
  return `${BULLET} nax chat session ${state.sessionId}${SEPARATOR}${COST_PREFIX}${cost}\n${INDENT}resume with: ${resume}`;
}
