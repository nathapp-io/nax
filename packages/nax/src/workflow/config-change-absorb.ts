/**
 * US-005 (gate-config-route, #2897/#2898): the config change an implementer-question advisor picks.
 *
 * A session cannot write nax's config, so an implementer that proved a fix and replied BLOCKED had no
 * route to it. The advisor answers that turn with a `ConfigChangeAnswer` — one value from the rule in
 * `config-change.ts`, never a value of its own — and nax applies it through the story env's US-003
 * transaction. Applying it ends the turn: the answer *was* the change, so no further implementer turn
 * runs, and the round's next gate run reads the reloaded command.
 *
 * This module holds the two halves `absorbTurn` reaches through both `implementStep` and `fixStep` —
 * gathering the facts the menu is built from, and applying/recording the pick. The loop's own
 * `lastTurn` and concern bookkeeping stays in `story-steps.ts`, which imports this module.
 *
 * The seams are optional (a caller that never asks an advisor still compiles), so a missing applier is
 * a change nax could not write: it is recorded as `write-failed` and never as applied.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getLogger } from "@/logger";
import type { ConfigChangeAnswer, ImplementerQuestionFacts, ImplementerQuestionRequest } from "./advisor";
import type { ConfigChangeOutcome, ConfigChangeRefusal } from "./config-change";
import { ledgerText } from "./ledger";
import type { StoryLoopEnv } from "./story-loop";
import type { ConfigChangeRecord, GateName, GateRunResult, GateState, ImplementerReply } from "./types";

/** The refusal a change nax never wrote leaves: an absent applier and a throwing one both land here. */
const NOT_WRITTEN: ConfigChangeRefusal = "write-failed";

/**
 * The red gates of the story's last gate run — `gates.states` only. The full-suite result is
 * deliberately not read: a red `full-suite` gate is nobody's command to change (`testScoped` runs the
 * scoped gate), and offering it would hand the advisor a change that cannot lift the red.
 */
function redGateNamesOf(gates: GateRunResult | undefined): GateName[] {
  const states: Readonly<Partial<Record<GateName, GateState>>> = gates?.states ?? {};
  const red: GateName[] = [];
  for (const [gate, state] of Object.entries(states) as [GateName, GateState | undefined][]) {
    if (state === "red") red.push(gate);
  }
  return red;
}

/**
 * What the question needs an answer to. The facts are gathered only when a gate is red: with none the
 * menu has no config change to offer, so the question is the one it always was, and an env without a
 * `configFacts` step never gains a `facts` key it could not fill.
 */
export async function implementerQuestion(
  env: StoryLoopEnv,
  gates: GateRunResult | undefined,
  reply: ImplementerReply,
): Promise<ImplementerQuestionRequest> {
  const question = {
    storyId: env.storyId,
    status: reply.status as "NEEDS_CONTEXT" | "BLOCKED",
    concerns: reply.concerns ?? "",
  };
  const facts = await configFactsFor(env, redGateNamesOf(gates));
  return facts === undefined ? question : { ...question, facts };
}

/**
 * The facts, or `undefined` when there is nothing to offer or the read failed. A throwing facts step is
 * a warn and a facts-less question, never a failed round: the advisor still has an answer and a hold.
 */
async function configFactsFor(
  env: StoryLoopEnv,
  redGates: readonly GateName[],
): Promise<ImplementerQuestionFacts | undefined> {
  const step = env.steps.configFacts;
  if (step === undefined || redGates.length === 0) return undefined;
  try {
    return await step(redGates);
  } catch (err) {
    getLogger().warn("workflow", "Config facts could not be read; asking the advisor without them", {
      storyId: env.storyId,
      error: errorMessage(err),
    });
    return undefined;
  }
}

/** What became of the answer: no change was picked, nax applied it, or it was refused with a reason. */
export type ConfigAnswerResult =
  | { readonly kind: "none" }
  | { readonly kind: "applied" }
  | { readonly kind: "refused"; readonly note: string };

export interface ConfigAnswerInput {
  readonly env: StoryLoopEnv;
  /** The round the change was proposed in — the fix round's number, or 0 for the implement turn. */
  readonly round: number;
  /** The advisor's answer, as `answerQuestion` returned it. */
  readonly answer: string | ConfigChangeAnswer | null;
}

/**
 * Apply the change the advisor picked and record what became of it: the story record's entry, the
 * ledger line, and — for a refusal — the note the loop keeps with the implementer's concern.
 *
 * Nothing here throws. A refused change leaves the loop on its existing path, and a transaction that
 * throws is the same refusal as a failed write, so it can never escape `fixStep`.
 */
export async function absorbConfigChange(input: ConfigAnswerInput): Promise<ConfigAnswerResult> {
  const change = input.answer;
  if (!isConfigChange(change)) return { kind: "none" };
  const outcome = await changeOutcome(input.env, change);
  await input.env.sink.recordConfigChange?.(recordOf(input.round, change, outcome));
  if (outcome.applied) {
    await input.env.sink.ledger(ledgerText.note(appliedNote(change, outcome.from)));
    return { kind: "applied" };
  }
  await input.env.sink.ledger(ledgerText.note(refusedNote(change, outcome.reason)));
  return { kind: "refused", note: refusalConcern(change, outcome.reason) };
}

/** Whether the advisor's answer is a config change rather than a plain answer to the implementer. */
function isConfigChange(answer: string | ConfigChangeAnswer | null): answer is ConfigChangeAnswer {
  return typeof answer === "object" && answer !== null && answer.kind === "config-change";
}

/**
 * The transaction's outcome, or the refusal that says nax wrote nothing. A throw is logged and read as
 * `write-failed`: the applier rolls its own writes back, and a caller that reported success here would
 * claim a config the gates never see.
 */
async function changeOutcome(env: StoryLoopEnv, change: ConfigChangeAnswer): Promise<ConfigChangeOutcome> {
  const step = env.steps.applyConfigChange;
  if (step === undefined) return unwritten(change);
  try {
    return await step(change);
  } catch (err) {
    getLogger().warn("workflow", "Config change could not be applied; the gates keep their command", {
      storyId: env.storyId,
      error: errorMessage(err),
    });
    return unwritten(change);
  }
}

/** The refusal for a change nax did not write, in the shape the transaction's own refusals have. */
function unwritten(change: ConfigChangeAnswer): ConfigChangeOutcome {
  return { applied: false, key: change.key, to: change.to, reason: NOT_WRITTEN };
}

/**
 * One record for the story record: `from` only when nax applied the change (that is the only case where
 * the value it replaced is known) and `reason` only when it refused.
 */
function recordOf(round: number, change: ConfigChangeAnswer, outcome: ConfigChangeOutcome): ConfigChangeRecord {
  return {
    round,
    key: change.key,
    ...(outcome.applied && outcome.from !== undefined ? { from: outcome.from } : {}),
    to: outcome.to,
    applied: outcome.applied,
    ...(outcome.applied ? {} : { reason: outcome.reason }),
    decisionId: change.decisionId,
  };
}

/**
 * The ledger line for a change nax made, naming the key, both values and the decision behind it. A key
 * that had no command before the change names only the value it is now set to, like a refusal line.
 */
function appliedNote(change: ConfigChangeAnswer, from: string | undefined): string {
  const was = from === undefined ? "" : ` "${from}"`;
  return `config change applied: quality.commands.${change.key}${was} -> "${change.to}" (advisor ${change.decisionId})`;
}

/** The ledger line for a change nax refused: the reason and the value that was never written. */
function refusedNote(change: ConfigChangeAnswer, reason: ConfigChangeRefusal): string {
  return `config change refused (${reason}): quality.commands.${change.key} -> "${change.to}" (advisor ${change.decisionId})`;
}

/**
 * The implementer's concern for a refusal: it proposed this command and nax did not make the change, so
 * the value it named — not just the reason — reaches the story reviewer.
 */
function refusalConcern(change: ConfigChangeAnswer, reason: ConfigChangeRefusal): string {
  return `config change not applied (${reason}): quality.commands.${change.key} -> "${change.to}"`;
}
