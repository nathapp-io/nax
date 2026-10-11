/**
 * A4: parse one finish review op's JSON reply (spec §4.1).
 *
 * The reply shape is shared by both lenses; `lens` is stamped onto every
 * finding here so the model can never claim a source. `null` means "not a
 * verdict" — the op's retry strategy reprompts on it, and its exhausted
 * fallback is `MISSING_REVIEW`.
 */
import { tryParseLLMJson } from "@/utils/llm-json";
import type { Finding, FinishReviewOutput, ReviewLens, Severity } from "../types";

const SEVERITIES: ReadonlySet<string> = new Set(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);

export const MISSING_REVIEW: FinishReviewOutput = { findings: [], covered: [], missing: true };

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function toSeverity(value: unknown): Severity {
  const upper = typeof value === "string" ? value.trim().toUpperCase() : "";
  return SEVERITIES.has(upper) ? (upper as Severity) : "LOW";
}

function toFinding(raw: unknown, lens: ReviewLens): Finding | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const title = str(r.title);
  const problem = str(r.problem);
  if (!title || !problem) return null;
  const file = str(r.file);
  const line = typeof r.line === "number" && Number.isInteger(r.line) && r.line > 0 ? r.line : undefined;
  const judgmentReason = str(r.judgmentReason);
  return {
    severity: toSeverity(r.severity),
    title,
    problem,
    fix: str(r.fix) ?? "",
    ...(r.judgment === true ? { judgment: true } : {}),
    ...(judgmentReason ? { judgmentReason } : {}),
    ...(file ? { file } : {}),
    ...(line ? { line } : {}),
    source: lens,
  };
}

export function isFinishReviewShape(value: unknown): boolean {
  return !!value && typeof value === "object" && Array.isArray((value as { findings?: unknown }).findings);
}

export function parseFinishReviewReply(text: string, lens: ReviewLens): FinishReviewOutput | null {
  const parsed = tryParseLLMJson<Record<string, unknown>>(text);
  if (!isFinishReviewShape(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  const findings = (p.findings as unknown[]).map((f) => toFinding(f, lens)).filter((f): f is Finding => f !== null);
  const covered = Array.isArray(p.covered) ? p.covered.filter((c): c is string => typeof c === "string") : [];
  const title = str(p.title);
  const summary = str(p.summary);
  return { findings, covered, ...(title ? { title } : {}), ...(summary ? { summary } : {}) };
}
