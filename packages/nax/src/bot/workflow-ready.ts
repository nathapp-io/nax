import { type CiWaitResult, ciAllowsReady } from "../workflow/ci-wait";
import type { CoverageRecord } from "./coverage-record";
import type { RecordRulingsOutcome } from "./rulings";

export type WorkflowPrReadiness = { ready: true } | { ready: false; reason: string };

type ConfirmedWork = NonNullable<RecordRulingsOutcome["confirmedWork"]>;

const CONFIRMED_WORK_HINT = "run nax bot review, then nax bot fix";
const SHORT_SHA_LENGTH = 7;
const COVERAGE_FILES_SHOWN = 5;
const COVERAGE_HINT = "run nax bot review";

/** Confirmed advisor changes no `nax bot fix` push has answered yet: the PR cannot be readied. */
function confirmedWorkHold(confirmedWork: ConfirmedWork): WorkflowPrReadiness {
  const ids = confirmedWork.map((item) => item.itemId).join(", ");
  return {
    ready: false,
    reason: `${confirmedWork.length} confirmed advisor item(s) awaiting a fix: ${ids}; ${CONFIRMED_WORK_HINT}`,
  };
}

/** The bot review's own record for this head names files it never read: a fix must re-run the review. */
function coverageHold(coverage: CoverageRecord, headSha?: string): WorkflowPrReadiness | undefined {
  if (headSha === undefined || coverage.headSha !== headSha) return undefined;
  const { uncovered } = coverage;
  if (!uncovered.length) return undefined;
  const shown = uncovered.slice(0, COVERAGE_FILES_SHOWN).join(", ");
  const remaining = uncovered.length - COVERAGE_FILES_SHOWN;
  const tail = remaining > 0 ? `, +${remaining} more` : "";
  const reason = `bot review did not read ${uncovered.length} required file(s) at ${headSha.slice(0, SHORT_SHA_LENGTH)}: ${shown}${tail}; ${COVERAGE_HINT}`;
  return { ready: false, reason };
}

/** The durable index and rulings, not body ticks, decide whether CI may promote a draft. */
export function workflowPrReadiness(input: {
  outcome?: RecordRulingsOutcome;
  ci: CiWaitResult;
  coverage?: CoverageRecord;
  headSha?: string;
  /** US-004: accept a CI whose checks never got a runner; never a CI that failed or is still running. */
  readonly waiveStarved?: boolean;
}): WorkflowPrReadiness {
  const { outcome, ci } = input;
  if (!outcome) return { ready: false, reason: "rulings could not be read" };
  if (!outcome.index) return { ready: false, reason: "no nax item index on this PR" };
  if (outcome.unindexed?.length)
    return { ready: false, reason: `incomplete item publication: ${outcome.unindexed.length} unindexed item(s)` };
  const confirmedWork = outcome.confirmedWork ?? [];
  // Confirmed work still owns its thread: an index key it covers is published, not missing.
  const present = new Set([...outcome.settled, ...outcome.open, ...confirmedWork].map((item) => item.key));
  const missing = outcome.index.keys
    .filter((key) => !present.has(key))
    .map((key) => key.slice(2, key.lastIndexOf(".")));
  if (missing.length)
    return { ready: false, reason: `${missing.length} item(s) without a thread: ${missing.join(", ")}` };
  if (outcome.open.length)
    return {
      ready: false,
      reason: `${outcome.open.length} open item(s): ${outcome.open.map((item) => item.itemId).join(", ")}`,
    };
  if (confirmedWork.length) return confirmedWorkHold(confirmedWork);
  const hold = input.coverage ? coverageHold(input.coverage, input.headSha) : undefined;
  if (hold) return hold;
  if (!ciAllowsReady(ci.outcome, { waiveStarved: input.waiveStarved }))
    return { ready: false, reason: `CI ${ci.outcome}: ${ci.detail}` };
  return { ready: true };
}
