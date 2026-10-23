/**
 * US-008: the report check (spec §6 step 6). An implementer that replied DONE can still have left no
 * `report.md` behind, and nothing used to look: the story reviewer discovered the absence itself and
 * spent a spec fail and a fix round on it. This asks the still-warm session for the report once,
 * between the green gates and the review.
 *
 * The report turn's outcome is **not** absorbed — no concern, no advisor answer, no session finding.
 * The story review stays the one place a reviewer's input is gathered, and a report turn that fails
 * says so in the ledger rather than in the findings. It is never continued either: an interrupted
 * report turn gets the "still missing" note and review runs.
 *
 * Pure orchestration over `env`, like the rest of the loop. `runTurn` is injected because the labelled
 * turn runner lives in `story-steps.ts`, which imports this module (the `runNoWorkLadder` pattern).
 *
 * Spec: docs/specs/SPEC-workflow-interrupt-continue.md § US-008.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getLogger } from "@/logger";
import type { ImplementOutcome, ImplementTurn } from "./implement";
import { ledgerText } from "./ledger";
import type { StoryLoopEnv, StoryLoopState } from "./story-loop";
import type { ImplementerStatus } from "./types";

const MISSING_NOTE = "report.md missing after the implementer's reply: asking the session to write it";
const WRITTEN_NOTE = "report turn: report written";
const STILL_MISSING_NOTE = "report turn: report still missing, reviewing without it";

/** The statuses that leave a finished story whose report is worth asking for. */
function finished(status: ImplementerStatus): boolean {
  return status === "DONE" || status === "DONE_WITH_CONCERNS";
}

/**
 * Whether the last absorbed turn leaves a report to repair: it replied, it was not the interrupt
 * fallback (whose concern already says the report may be missing), and it did not fail or stay silent
 * (`lastTurn` is cleared in both of those cases by `absorbTurn`).
 */
function owesReport(lastTurn: StoryLoopState["lastTurn"]): lastTurn is NonNullable<StoryLoopState["lastTurn"]> {
  return lastTurn !== undefined && !lastTurn.fallback && finished(lastTurn.status);
}

/**
 * The report's absence, fail-open: a throwing check reads as present, so a broken check never spends a
 * turn on a story that may already have written its report. Review then runs exactly as it did before
 * this check existed.
 */
async function reportMissing(env: StoryLoopEnv, check: () => Promise<boolean>): Promise<boolean> {
  try {
    return !(await check());
  } catch (err) {
    getLogger().warn("workflow", "The report check failed; treating report.md as present", {
      storyId: env.storyId,
      error: errorMessage(err),
    });
    return false;
  }
}

/** The one line the report turn leaves behind, read off what the turn did and the file now. */
async function outcomeNote(env: StoryLoopEnv, outcome: ImplementOutcome): Promise<string> {
  if (outcome.failure !== undefined) return `report turn failed: ${outcome.failure}`;
  const check = env.steps.reportExists;
  // Fail-open as present here too: a check that fails after the turn is never read as "still missing".
  const missing = check === undefined ? false : await reportMissing(env, check);
  return missing ? STILL_MISSING_NOTE : WRITTEN_NOTE;
}

/**
 * Runs the story's one report turn when it is owed and the report is missing. Returns the new
 * `reportTurnRan`, so the caller writes back a flag it can never spend twice.
 *
 * The turn runs at the step-up of the turn that replied, through the caller's labelled runner, so it
 * keeps both that turn's model and its warm session.
 */
export async function runReportCheck(
  env: StoryLoopEnv,
  state: { reportTurnRan: boolean; lastTurn?: StoryLoopState["lastTurn"] },
  runTurn: (turn: ImplementTurn) => Promise<ImplementOutcome>,
): Promise<boolean> {
  const lastTurn = state.lastTurn;
  if (state.reportTurnRan || !owesReport(lastTurn)) return state.reportTurnRan;
  // An unwired check can never justify a turn, so it is answered before the cost seam: a loop built
  // without report evidence asks `costExceeded` nothing it could act on.
  const check = env.steps.reportExists;
  if (check === undefined) return state.reportTurnRan;
  if (env.steps.costExceeded()) return state.reportTurnRan;
  if (!(await reportMissing(env, check))) return state.reportTurnRan;
  await env.sink.ledger(ledgerText.note(MISSING_NOTE));
  const outcome = await runTurn({ kind: "report", stepUps: lastTurn.stepUps });
  await env.sink.ledger(ledgerText.note(await outcomeNote(env, outcome)));
  return true;
}
