/**
 * One-line transcript summaries of the background notices written by
 * `buildBackgroundTaskNotice`, `buildJobNotice` and `buildRunAskNotice`.
 *
 * A notice fills the transcript as one collapsed row while the model still receives
 * the whole text. Anything that is not a canonical notice line returns `undefined`,
 * so an ordinary user message keeps its user row.
 */

/** `buildBackgroundTaskNotice` line; the command itself may contain `)` and `(`. */
const TASK_LINE = /^\[nax-tasks\] background command \S+ \(.*?\) ended: (\S+?),/;
/** `buildJobNotice` line; `<state>` is the single word after `ended: `, cost/note/log follow. */
const JOB_LINE = /^\[nax-jobs\] job \S+ \((\S+) (.+?)\) ended: (\S+)/;
/** `buildRunAskNotice` first line. */
const RUN_ASK_LINE = /^\[nax-jobs\] run ask (\S+)/;

const SUMMARY_SEPARATOR = " · ";

function firstMatch(lines: readonly string[], pattern: RegExp): RegExpExecArray | undefined {
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match !== null) return match;
  }
  return undefined;
}

/** States of every task line, in the order the tasks appear in the notice. */
function taskStates(lines: readonly string[]): string[] {
  const states: string[] = [];
  for (const line of lines) {
    const match = TASK_LINE.exec(line);
    if (match !== null) states.push(match[1]);
  }
  return states;
}

function taskSummary(states: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const state of states) counts.set(state, (counts.get(state) ?? 0) + 1);
  const noun = states.length === 1 ? "background command" : "background commands";
  const parts = [`${states.length} ${noun} ended`];
  for (const [state, count] of counts) parts.push(`${count} ${state}`);
  return parts.join(SUMMARY_SEPARATOR);
}

/**
 * One-line summary of a background notice; `undefined` for any other text.
 *
 * The run-ask line is checked first: a run ask carries run-authored prose inside an
 * untrusted block, and its own first line decides the summary, so that prose cannot
 * masquerade as a task or job line.
 */
export function summarizeBackgroundNotice(text: string): string | undefined {
  const lines = text.split("\n");
  const ask = firstMatch(lines, RUN_ASK_LINE);
  if (ask !== undefined) return `run ask ${ask[1]} sent to the agent`;
  const states = taskStates(lines);
  if (states.length > 0) return taskSummary(states);
  const job = firstMatch(lines, JOB_LINE);
  if (job !== undefined) return [`nax job ${job[1]} ${job[2]} ended`, job[3]].join(SUMMARY_SEPARATOR);
  return undefined;
}
