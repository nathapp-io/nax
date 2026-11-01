/**
 * One-line transcript summaries of the background notices written by
 * `buildBackgroundTaskNotice`, `buildJobNotice` and `buildRunAskNotice`.
 *
 * A notice fills the transcript as one collapsed row while the model still receives
 * the whole text. Anything that is not a canonical notice line returns `undefined`,
 * so an ordinary user message keeps its user row.
 *
 * The **first line** decides which notice this is. Every builder writes its identifying line
 * there, and a later line may be a value the builder embedded — a job's note, a task's
 * command — which is not newline-sanitised, so classifying by any line would let that value's
 * own newline flip the kind. Once the kind holds, the text is read whole: one coalesced task
 * notice carries one line per task.
 */

/** `buildBackgroundTaskNotice` line; the command itself may contain `)` and `(`. */
const TASK_LINE = /^\[nax-tasks\] background command \S+ \(.*?\) ended: (\S+?),/;
/** `buildJobNotice` line; `<state>` is the single word after `ended: `, cost/note/log follow. */
const JOB_LINE = /^\[nax-jobs\] job \S+ \((\S+) (.+?)\) ended: (\S+)/;
/** `buildRunAskNotice` first line. */
const RUN_ASK_LINE = /^\[nax-jobs\] run ask (\S+)/;

const SUMMARY_SEPARATOR = " · ";

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
 * Only the notice's first line names its kind — the run-ask check included, so a run ask's
 * run-authored prose, which sits in an untrusted block below that line, can never decide the
 * summary it is drawn as.
 */
export function summarizeBackgroundNotice(text: string): string | undefined {
  const lines = text.split("\n");
  const first = lines[0] ?? "";
  const ask = RUN_ASK_LINE.exec(first);
  if (ask !== null) return `run ask ${ask[1]} sent to the agent`;
  const job = JOB_LINE.exec(first);
  if (job !== null) return [`nax job ${job[1]} ${job[2]} ended`, job[3]].join(SUMMARY_SEPARATOR);
  if (!TASK_LINE.test(first)) return undefined;
  return taskSummary(taskStates(lines));
}
