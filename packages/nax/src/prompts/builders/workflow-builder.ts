/**
 * The fixed "nax loop" section a chat session carries: the workflow order, when
 * to read feature state, which steps are billed launches, and what nax never does.
 *
 * Pure fixed text — no config, no file reads, no model calls.
 */
export function buildWorkflowInstructions(): string {
  return [
    "Call `nax-workflow__state` before proposing any workflow step, and call it again after any workflow step ends, so what you propose matches the feature's real state.",
    "The nax loop runs in this order: brainstorm → spec-writing → spec-review (at most two fix rounds) → `nax plan` → PRD fidelity check (spec-review `--prd`) → commit the spec and PRD → `nax run` → `nax bot review` / `nax bot fix` → the user merges → the user releases.",
    "`nax plan`, `nax run`, `nax bot review` and `nax bot fix` are billed: never start one without the user's explicit approval of that launch.",
    "nax never merges a PR and never releases; the user merges the PR and the user releases.",
  ].join("\n");
}

export interface JobNoticeInput {
  readonly id: string;
  readonly kind: string;
  readonly target: string;
  readonly state: string;
  readonly cost?: number;
  readonly note?: string;
  readonly logPath: string;
}

/** Pure completion notice shared by owned and re-attached background jobs. */
export function buildJobNotice(input: JobNoticeInput): string {
  const cost = input.cost !== undefined ? ` cost $${input.cost.toFixed(2)}` : "";
  const note = input.note !== undefined ? ` (${input.note})` : "";
  return [
    `[nax-jobs] job ${input.id} (${input.kind} ${input.target}) ended: ${input.state}${cost}${note} log ${input.logPath}`,
    "Call `nax-workflow__state`, report the outcome to the user and propose the single next step.",
  ].join("\n");
}

/** Fixed provider guidance; launching, approval and checkout guards live elsewhere. */
export function buildJobsInstructions(): string {
  return [
    "`nax-jobs__plan`, `nax-jobs__run`, `nax-jobs__bot_review` and `nax-jobs__bot_fix`: each is billed and shows the user an approval card.",
    "A denial is final for that call; do not retry with changed arguments to get round it.",
    "Jobs run in the background; a [nax-jobs] notice arrives when one ends.",
    "Write, Edit, Delete and GitCommit are refused in this checkout while a run or plan job runs.",
    "Start one step at a time: after a job ends, report the outcome to the user and propose the single next step.",
  ].join("\n");
}
