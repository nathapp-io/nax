/**
 * The no-work ladder (spec §6 step 2, US-002). A **no-work turn** is one whose reply carried no
 * status block (US-001's `noStatusBlock`) and after which the story shows no work evidence at all:
 * nothing changed since the story base, nothing uncommitted and no report.md. The observed failure
 * this closes: the implementer read the brief, asked what to do, wrote nothing, and the story then
 * spent a review and two fix rounds (one hung 20 minutes) on an untouched package.
 *
 * Such a turn restarts warm, restarts fresh one tier up, and then closes the story gate-open —
 * with no gates, no review, no fix round and no adjudication.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getLogger } from "@/logger";
import { changedFilesSince, listUncommitted } from "./git";
import type { ImplementOutcome, ImplementTurn } from "./implement";
import { ledgerText } from "./ledger";
import type { StepContext } from "./step-context";
import type { StoryLoopEnv } from "./story-loop";

const NO_WORK_NOTE = "no work: reply carried no status block, no changes since the story base, no report";
const NO_WORK_AFTER_RESTART = "no work after the restart: restarting fresh one tier up";
const NO_WORK_AFTER_FRESH_RESTART = "no work after the fresh restart: closing the story without review";

export interface NoWorkLadderResult {
  /** True: the story closes `complete-gate-open` with reason `no work produced`. */
  readonly closed: boolean;
  /** The last turn's outcome, for the loop to absorb. */
  readonly outcome: ImplementOutcome;
  /** The step-up that turn ran at, so an advisor answer to it runs on the same model. */
  readonly stepUps: number;
}

/**
 * The paths nax owns inside the story tree: the feature tree and the scratch dirs a run creates.
 * A turn that only touched those produced no work — the same filter `listUncommitted` applies.
 */
function isNaxOwned(path: string): boolean {
  return path.startsWith(".nax/") || path.startsWith(".nax-");
}

/**
 * The real work-evidence check; `buildStoryEnv` wires this as `steps.workProduced`. Throws on a git
 * error, from `changedFilesSince` and (nax#2550) `listUncommitted` alike; `producedWork` reads a throw as work.
 */
export async function storyWorkEvidence(sc: StepContext): Promise<boolean> {
  const [changed, uncommitted] = await Promise.all([
    changedFilesSince(sc.projectDir, sc.base),
    listUncommitted(sc.projectDir),
  ]);
  if (changed.some((path) => !isNaxOwned(path))) return true;
  if (uncommitted.length > 0) return true;
  return await Bun.file(sc.reportPath).exists();
}

/**
 * Fail-open, deliberately: an absent check means "work produced", and a throwing one (a git
 * failure, an unreadable report path) does too. A broken check must never close a story that did
 * work, so the ladder's worst failure is doing what nax did before it existed.
 */
async function producedWork(env: StoryLoopEnv): Promise<boolean> {
  const check = env.steps.workProduced;
  if (!check) return true;
  try {
    return await check();
  } catch (err) {
    getLogger().warn("workflow", "Work-evidence check failed; treating the turn as work produced", {
      storyId: env.storyId,
      error: errorMessage(err),
    });
    return true;
  }
}

/** A turn is a dead end only when it said nothing AND left nothing behind. */
async function isNoWorkTurn(env: StoryLoopEnv, outcome: ImplementOutcome): Promise<boolean> {
  if (outcome.failure || outcome.reply?.noStatusBlock !== true) return false;
  return !(await producedWork(env));
}

/**
 * Runs the ladder over the story's first implement turn. `runTurn` is injected because the labelled
 * turn runner lives in `story-loop.ts`, which imports this module (a value import the other way
 * would be a cycle). Each restart is skipped once the cost limit is reached: the loop's own cost
 * check then closes the story `cost-limit`, exactly as it does without the ladder.
 */
export async function runNoWorkLadder(
  env: StoryLoopEnv,
  first: ImplementOutcome,
  runTurn: (turn: ImplementTurn) => Promise<ImplementOutcome>,
): Promise<NoWorkLadderResult> {
  if (!(await isNoWorkTurn(env, first))) return { closed: false, outcome: first, stepUps: 0 };
  await env.sink.ledger(ledgerText.note(NO_WORK_NOTE));
  if (env.steps.costExceeded()) return { closed: false, outcome: first, stepUps: 0 };
  const warm = await runTurn({ kind: "restart", fresh: false, stepUps: 0 });
  if (!(await isNoWorkTurn(env, warm))) return { closed: false, outcome: warm, stepUps: 0 };
  await env.sink.ledger(ledgerText.note(NO_WORK_AFTER_RESTART));
  if (env.steps.costExceeded()) return { closed: false, outcome: warm, stepUps: 0 };
  const fresh = await runTurn({ kind: "restart", fresh: true, stepUps: 1 });
  if (!(await isNoWorkTurn(env, fresh))) return { closed: false, outcome: fresh, stepUps: 1 };
  await env.sink.ledger(ledgerText.note(NO_WORK_AFTER_FRESH_RESTART));
  return { closed: true, outcome: fresh, stepUps: 1 };
}
