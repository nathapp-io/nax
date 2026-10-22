/** #2496, US-002: what is still open on a workflow feature, and the verdict a finishing tool reads. Pure. */
import { ciReason, gateReasons, storyReasons } from "./approval";
import type {
  OpenItem,
  StoryStateItem,
  WorkflowFeatureRecord,
  WorkflowFinding,
  WorkflowRuling,
  WorkflowVerdict,
} from "./types";

/** Only these three kinds fail `workflowPassed`; US-002's advisor, story, ci and reason items never do. */
const BLOCKING_KINDS: ReadonlySet<OpenItem["kind"]> = new Set(["finding", "ruling", "gate"]);

const APPROVAL_ITEM_ID = "_run:approval";
export const CI_ITEM_ID = "_run:ci";

/** `<n> ruling(s) flagged for a human` — the readiness reason for flagged rulings (`flaggedCount`). */
const FLAGGED_REASON = /^(\d+) ruling\(s\) flagged for a human$/;

const acceptsRisk = (r: WorkflowRuling | undefined): boolean => r?.action === "waive" && r.needsHumanConfirm !== true;

function findingItem(f: WorkflowFinding, r: WorkflowRuling | undefined): OpenItem {
  return {
    id: f.id,
    kind: r ? "ruling" : "finding",
    severity: f.severity,
    ...(f.file ? { file: f.file } : {}),
    ...(f.line !== undefined ? { line: f.line } : {}),
    issue: f.issue,
    ...(f.suggestion ? { suggestion: f.suggestion } : {}),
    ...(r ? { ruling: { action: r.action, why: r.why, ...(r.decisionId ? { decisionId: r.decisionId } : {}) } } : {}),
  };
}

function gateItems(rec: WorkflowFeatureRecord): OpenItem[] {
  return (rec.finalGates?.failing ?? []).map((name) => ({
    id: name,
    kind: "gate" as const,
    issue:
      rec.finalGateFindings?.find((g) => g.issue.startsWith(`repo gate ${name} failed`))?.issue ??
      `final gate ${name} is red`,
  }));
}

/**
 * US-002: a held finish-approval, then every decision id flagged for a human that the approval did
 * not already name — `flaggedDecisions` spans every run of the feature, so it can repeat the hold.
 */
function advisorItems(rec: WorkflowFeatureRecord): OpenItem[] {
  const approval = rec.approval;
  const held: OpenItem | undefined =
    approval && !approval.approved
      ? { id: approval.decisionId ?? APPROVAL_ITEM_ID, kind: "advisor", issue: approval.rationale }
      : undefined;
  const named = new Set(held ? [held.id] : []);
  const flagged = (rec.flaggedDecisions ?? [])
    .filter((id) => !named.has(id))
    .map((id) => ({
      id,
      kind: "advisor" as const,
      issue: `advisor decision ${id} needs a human: see nax advisor list`,
    }));
  return held ? [held, ...flagged] : flagged;
}

function storyIssue(s: StoryStateItem): string {
  if (s.state === "not-run") return `${s.id} did not finish`;
  return s.reason === undefined ? `${s.id} ended ${s.state}` : `${s.id} ended ${s.state}: ${s.reason}`;
}

/** `complete` and `complete-with-rulings` finished the story; the two others left something open. */
const finished = (s: StoryStateItem): boolean => s.state === "complete" || s.state === "complete-with-rulings";

function storyItems(rec: WorkflowFeatureRecord): OpenItem[] {
  return (rec.storyStates ?? [])
    .filter((s) => !finished(s))
    .map((s) => ({ id: s.id, kind: "story" as const, issue: storyIssue(s) }));
}

function ciItems(rec: WorkflowFeatureRecord): OpenItem[] {
  const issue = ciReason(rec.ci, rec.ciDetail);
  return issue === undefined ? [] : [{ id: CI_ITEM_ID, kind: "ci" as const, issue }];
}

/**
 * The gate reason text, but only while a gate item carries it: `gateReasons` answers
 * `NOTHING_VERIFIED` when no gate ran, and nothing ran means no gate item, so that text stays a
 * reason item (AC-15).
 */
function explainedGate(rec: WorkflowFeatureRecord): string | undefined {
  return gateItems(rec).length > 0 ? gateReasons(rec.finalGates)[0] : undefined;
}

/** US-002: a reason a listed fact already carries is not repeated. Matched, never re-spelled. */
function explainedTexts(rec: WorkflowFeatureRecord): ReadonlySet<string> {
  const gate = explainedGate(rec);
  const ci = ciReason(rec.ci, rec.ciDetail);
  const approval = rec.approval;
  return new Set([
    ...(gate === undefined ? [] : [gate]),
    ...(ci === undefined ? [] : [ci]),
    ...storyReasons(rec.storyStates ?? []),
    ...(approval && !approval.approved ? [approval.rationale] : []),
  ]);
}

/**
 * US-002: a flagged count the ledger backs is already named by the flagged decisions' own items. Fewer
 * advisor items than the count claims (story flags and pre-flight holds are counted too, and an
 * unreadable ledger leaves the field absent) stays a reason.
 */
function explainsFlags(text: string, rec: WorkflowFeatureRecord): boolean {
  const claimed = FLAGGED_REASON.exec(text)?.[1];
  return claimed !== undefined && Number(claimed) <= (rec.flaggedDecisions ?? []).length;
}

/** One item per reason nothing else explains, numbered by its position in `reasons` (stable ids). */
function reasonItems(rec: WorkflowFeatureRecord): OpenItem[] {
  const explained = explainedTexts(rec);
  return rec.reasons.flatMap((text, i) =>
    explained.has(text) || explainsFlags(text, rec)
      ? []
      : [{ id: `_run:reason${i + 1}`, kind: "reason" as const, issue: text }],
  );
}

export function buildOpenItems(rec: WorkflowFeatureRecord): OpenItem[] {
  const rulings = new Map(rec.rulings.flatMap((r) => (r.findingId ? [[r.findingId, r] as const] : [])));
  const findings = rec.reviewOpen
    .filter((f) => !acceptsRisk(rulings.get(f.id)))
    .map((f) => findingItem(f, rulings.get(f.id)));
  const cannotVerify = (rec.cannotVerify ?? []).map((issue, i) => ({
    id: `_run:cv${i + 1}`,
    kind: "cannot-verify" as const,
    issue,
  }));
  return [
    ...findings,
    ...cannotVerify,
    ...gateItems(rec),
    ...advisorItems(rec),
    ...storyItems(rec),
    ...ciItems(rec),
    ...reasonItems(rec),
  ];
}

export function buildVerdict(rec: WorkflowFeatureRecord): WorkflowVerdict | undefined {
  if (!rec.outcome) return undefined;
  const openItems = buildOpenItems(rec);
  return {
    workflowPassed: rec.passed === true && !openItems.some((i) => BLOCKING_KINDS.has(i.kind)),
    outcome: rec.outcome,
    reasons: rec.reasons,
    openItems,
  };
}
