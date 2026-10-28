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
  readonly chainId?: string;
  readonly chainStep?: number;
}

/**
 * Third notice line for a job that belongs to a chain: it names the chain (and
 * its step, when the job carries one) and points the agent at the chain state
 * instead of a fresh card. A job with a `chainId` always gets the line — losing
 * the instruction is worse than losing the step number.
 */
function chainNoticeLine(chainId: string, chainStep: number | undefined): string {
  const position = chainStep !== undefined ? `step ${chainStep} of ` : "part of ";
  return `This job is ${position}chain ${chainId}; call nax-jobs__list to see whether the chain continues, and if it does, call the next step's launch tool with exactly the approved arguments (no card is shown for it).`;
}

/** Pure completion notice shared by owned and re-attached background jobs. */
export function buildJobNotice(input: JobNoticeInput): string {
  const cost = input.cost !== undefined ? ` cost $${input.cost.toFixed(2)}` : "";
  const note = input.note !== undefined ? ` (${input.note})` : "";
  const noticeLines = [
    `[nax-jobs] job ${input.id} (${input.kind} ${input.target}) ended: ${input.state}${cost}${note} log ${input.logPath}`,
    "Call `nax-workflow__state`, report the outcome to the user and propose the single next step.",
  ];
  if (input.chainId !== undefined) {
    noticeLines.push(chainNoticeLine(input.chainId, input.chainStep));
  }
  return noticeLines.join("\n");
}

/** Fixed provider guidance; launching, approval and checkout guards live elsewhere. */
export function buildJobsInstructions(): string {
  return [
    "`nax-jobs__plan`, `nax-jobs__run`, `nax-jobs__bot_review` and `nax-jobs__bot_fix`: each is billed and shows the user an approval card.",
    "A denial is final for that call; do not retry with changed arguments to get round it.",
    "Jobs run in the background; a [nax-jobs] notice arrives when one ends.",
    "Write, Edit, Delete and GitCommit are refused in this checkout while a run or plan job runs.",
    "Start one step at a time: after a job ends, report the outcome to the user and propose the single next step.",
    '`nax-jobs__chain` proposes a full run: an ordered list of billed steps on one approval card. Only the user\'s yes on that card approves it; a chat message such as "go ahead" does not.',
    "While a chain is active, call each step's launch tool with exactly the approved arguments, one step at a time, after the previous step succeeded; a different call stops the chain and shows a normal card.",
    "Before a step that names a check, run that check yourself and record its verdict with `nax-jobs__chain_check`; stop the chain with `nax-jobs__chain_stop` when the user asks.",
  ].join("\n");
}
