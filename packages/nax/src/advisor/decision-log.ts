/**
 * The advisor's voice in the run log (nax#2491 P4): ONE info line per decision, saying who asked
 * (the question kind), about which story, what was ruled and how sure the advisor was. A flagged
 * decision with no way to reach a human says so on the same line, so there is no separate warning
 * that names nothing. The full text stays in the ledger and the audit file.
 */
import { getSafeLogger } from "../logger";
import { describeTarget } from "./format";
import type { AdviceAction, AdviceDecision } from "./types";

const MAX_RULING_CHARS = 200;

function actionText(action: AdviceAction): string {
  switch (action.type) {
    case "fix":
    case "retry":
      return `${action.type}: ${action.instruction}`;
    case "waive":
    case "escalate-tier":
    case "defer":
    case "hold":
      return `${action.type}: ${action.reason}`;
    case "supersede":
      return `supersede ${describeTarget(action.target)}: ${action.newText}`;
    case "retarget":
      return `retarget to ${action.to}: ${action.instruction}`;
    case "re-review":
      return `re-review (${action.phase})`;
    case "answer":
      return `answer: ${action.text}`;
    case "carry":
      return `carry to ${action.toStories.join(", ")}: ${action.instruction}`;
    default:
      return action.type;
  }
}

/** What was ruled, on one line of at most ~200 characters. */
export function describeRuling(decision: AdviceDecision): string {
  const flat = actionText(decision.action).replace(/\s+/g, " ").trim();
  return flat.length > MAX_RULING_CHARS ? `${flat.slice(0, MAX_RULING_CHARS - 3)}...` : flat;
}

export interface HeadsUpOutcome {
  readonly sent: boolean;
  readonly reason?: string;
}

function flagNote(decision: AdviceDecision, headsUp: HeadsUpOutcome | undefined): string {
  if (!decision.needsHumanConfirm) return "";
  return headsUp?.reason === "no-channel" ? "; flagged, no delivery channel" : "; flagged";
}

/** `[kind] story: ruling (confidence c)`: the content shared by the per-decision and the end-of-feature lines. */
export function decisionBody(decision: AdviceDecision): string {
  const where = decision.storyId ?? "feature";
  return `[${decision.kind}] ${where}: ${describeRuling(decision)} (confidence ${decision.confidence})`;
}

export function decisionLine(decision: AdviceDecision, headsUp?: HeadsUpOutcome): string {
  return `Advisor ruling ${decisionBody(decision)}${flagNote(decision, headsUp)}`;
}

export function logAdvisorDecision(decision: AdviceDecision, headsUp?: HeadsUpOutcome): void {
  // Flagged for a human with no way to reach one: the old standalone warning's severity, now on the ruling line.
  const stranded = decision.needsHumanConfirm && headsUp?.reason === "no-channel";
  getSafeLogger()?.[stranded ? "warn" : "info"]("advisor", decisionLine(decision, headsUp), {
    storyId: decision.storyId ?? "_run",
    decisionId: decision.id,
    questionId: decision.questionId,
    kind: decision.kind,
    action: decision.action.type,
    confidence: decision.confidence,
    needsHumanConfirm: decision.needsHumanConfirm,
    ...(headsUp?.reason ? { headsUp: headsUp.reason } : {}),
    ...(decision.reusedFrom ? { reusedFrom: decision.reusedFrom } : {}),
  });
}
