/** A5 workflow reply parsers. Pure; every LLM JSON read goes through tryParseLLMJson. */
import { tryParseLLMJson } from "../utils/llm-json";
import type {
  BranchReviewVerdict,
  ImplementerReply,
  ImplementerStatus,
  MinorTriageDecision,
  ReReviewResidual,
  ReReviewVerdict,
  StoryReviewVerdict,
  WorkflowFindingDraft,
  WorkflowFindingKind,
  WorkflowSeverity,
} from "./workflow-types";

export const WORKFLOW_INTERRUPT_MARKER = "<<nax-workflow-interrupted>>";

const STATUSES: readonly ImplementerStatus[] = ["DONE", "DONE_WITH_CONCERNS", "NEEDS_CONTEXT", "BLOCKED"];
const SEVERITIES: readonly WorkflowSeverity[] = ["critical", "important", "minor"];
const REVIEW_KINDS: readonly WorkflowFindingKind[] = ["spec", "quality"];
const NO_VERDICT_NOTE = "(no verdict returned)";
const SPEC_FAIL_ISSUE =
  "Story review returned spec: fail without a blocking spec finding. Re-read the brief's acceptance criteria and the TDD-evidence rule, and fix what is missing.";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
}

export function parseImplementerReply(output: string): ImplementerReply {
  if (output.startsWith(WORKFLOW_INTERRUPT_MARKER)) {
    return {
      status: "DONE_WITH_CONCERNS",
      commits: [],
      testSummary: "",
      concerns: "step time limit reached",
      interrupted: true,
    };
  }
  if (output.startsWith('Agent "')) {
    return { status: "DONE_WITH_CONCERNS", commits: [], testSummary: "", interrupted: false, failure: output.trim() };
  }
  const parsed = tryParseLLMJson<unknown>(output);
  const status = isRecord(parsed) ? parsed.status : undefined;
  if (!isRecord(parsed) || !STATUSES.includes(status as ImplementerStatus)) {
    return {
      status: "DONE_WITH_CONCERNS",
      commits: [],
      testSummary: "",
      concerns: "implementer reply carried no status block",
      interrupted: false,
      // US-001: the ladder keys its no-work check on this.
      noStatusBlock: true,
    };
  }
  const concerns = str(parsed.concerns);
  return {
    status: status as ImplementerStatus,
    commits: strings(parsed.commits),
    testSummary: typeof parsed.testSummary === "string" ? parsed.testSummary : "",
    ...(concerns ? { concerns } : {}),
    interrupted: false,
  };
}

export function toFindingDraft(entry: unknown): WorkflowFindingDraft | null {
  if (!isRecord(entry)) return null;
  const issue = str(entry.issue);
  if (!issue) return null;
  const severity = SEVERITIES.includes(entry.severity as WorkflowSeverity)
    ? (entry.severity as WorkflowSeverity)
    : "important";
  const kind = REVIEW_KINDS.includes(entry.kind as WorkflowFindingKind)
    ? (entry.kind as WorkflowFindingKind)
    : "quality";
  const file = str(entry.file);
  const acId = str(entry.acId);
  const suggestion = str(entry.suggestion);
  const observed = str(entry.observed);
  const line = Number.isInteger(entry.line) && (entry.line as number) > 0 ? (entry.line as number) : undefined;
  return {
    severity,
    kind,
    ...(file ? { file } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(acId ? { acId } : {}),
    issue,
    ...(suggestion ? { suggestion } : {}),
    ...(observed ? { observed } : {}),
  };
}

function drafts(v: unknown): WorkflowFindingDraft[] {
  return Array.isArray(v) ? v.map(toFindingDraft).filter((d): d is WorkflowFindingDraft => d !== null) : [];
}

/**
 * US-004 (nax#2524): the residual of a PARTIAL verdict, sanitised exactly as `toFindingDraft` sanitises a
 * finding. Anything else — another verdict, a non-object residual, an empty issue — yields nothing, so
 * the finding fails closed to NOT_ADDRESSED and stays open unchanged.
 */
function residualOf(entry: Record<string, unknown>): ReReviewResidual | undefined {
  if (entry.verdict !== "PARTIAL" || !isRecord(entry.residual)) return undefined;
  const issue = str(entry.residual.issue);
  if (!issue) return undefined;
  const suggestion = str(entry.residual.suggestion);
  const file = str(entry.residual.file);
  const line =
    Number.isInteger(entry.residual.line) && (entry.residual.line as number) > 0
      ? (entry.residual.line as number)
      : undefined;
  return {
    issue,
    ...(suggestion ? { suggestion } : {}),
    ...(file ? { file } : {}),
    ...(line !== undefined ? { line } : {}),
  };
}

export function parseStoryReviewReply(output: string): StoryReviewVerdict | null {
  const parsed = tryParseLLMJson<unknown>(output);
  if (!isRecord(parsed)) return null;
  if (parsed.spec !== "pass" && parsed.spec !== "fail") return null;
  if (parsed.quality !== "approved" && parsed.quality !== "changes") return null;
  const findings = drafts(parsed.findings);
  const hasBlockingSpec = findings.some((f) => f.kind === "spec" && f.severity !== "minor");
  const withSynthetic =
    parsed.spec === "fail" && !hasBlockingSpec
      ? [...findings, { kind: "spec" as const, severity: "important" as const, issue: SPEC_FAIL_ISSUE }]
      : findings;
  return {
    spec: parsed.spec,
    quality: parsed.quality,
    findings: withSynthetic,
    cannotVerify: strings(parsed.cannotVerify),
    inspectedFiles: strings(parsed.inspectedFiles),
  };
}

export function parseReReviewReply(output: string, openIds: readonly string[]): ReReviewVerdict | null {
  const parsed = tryParseLLMJson<unknown>(output);
  if (!isRecord(parsed) || !Array.isArray(parsed.findings)) return null;
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of parsed.findings) {
    if (isRecord(entry) && typeof entry.id === "string" && !byId.has(entry.id)) byId.set(entry.id, entry);
  }
  const verdicts = openIds.map((id) => {
    const entry = byId.get(id);
    if (!entry) return { id, addressed: false, note: NO_VERDICT_NOTE };
    const residual = residualOf(entry);
    return {
      id,
      addressed: entry.verdict === "ADDRESSED",
      note: typeof entry.note === "string" ? entry.note : "",
      ...(residual ? { residual } : {}),
    };
  });
  return { verdicts, newFindings: drafts(parsed.newFindings) };
}

function triageOf(parsed: unknown): Map<string, MinorTriageDecision> {
  const triage = new Map<string, MinorTriageDecision>();
  if (!isRecord(parsed) || !Array.isArray(parsed.minorTriage)) return triage;
  for (const entry of parsed.minorTriage) {
    if (!isRecord(entry) || typeof entry.id !== "string" || triage.has(entry.id)) continue;
    if (entry.decision === "fix-now" || entry.decision === "leave") triage.set(entry.id, entry.decision);
  }
  return triage;
}

/** One triage entry per known minor id, in the given order; untriaged or unknown -> leave (P4-R8). */
export function parseBranchReviewReply(output: string, minorIds: readonly string[]): BranchReviewVerdict | null {
  const verdict = parseStoryReviewReply(output);
  if (!verdict) return null;
  const triage = triageOf(tryParseLLMJson<unknown>(output));
  return { ...verdict, minorTriage: minorIds.map((id) => ({ id, decision: triage.get(id) ?? "leave" })) };
}
