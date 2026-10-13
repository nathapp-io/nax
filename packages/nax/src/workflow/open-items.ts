/** #2496: what is still open on a workflow feature, and the verdict a finishing tool reads. Pure. */
import type { OpenItem, WorkflowFeatureRecord, WorkflowFinding, WorkflowRuling, WorkflowVerdict } from "./types";

const BLOCKING_KINDS: ReadonlySet<OpenItem["kind"]> = new Set(["finding", "ruling", "gate"]);

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
  return [...findings, ...cannotVerify, ...gateItems(rec)];
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
