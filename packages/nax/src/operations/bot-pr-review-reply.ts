import { tryParseLLMJson } from "../utils/llm-json";
import type { PrReviewVerdict, PrTriageVerdict } from "./bot-types";
import { toFindingDraft } from "./workflow-replies";
import type { WorkflowFindingDraft } from "./workflow-types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function findings(value: unknown): WorkflowFindingDraft[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const draft = toFindingDraft(entry);
    if (!draft) return [];
    const { acId: _acId, ...finding } = draft;
    return [finding];
  });
}

function triage(value: unknown, ids: readonly string[]): PrTriageVerdict[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(ids);
  const seen = new Set<string>();
  const result: PrTriageVerdict[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !allowed.has(entry.id) || seen.has(entry.id)) continue;
    if (entry.decision !== "agree" && entry.decision !== "disagree" && entry.decision !== "handled") continue;
    if (typeof entry.reason !== "string" || !entry.reason.trim()) continue;
    seen.add(entry.id);
    result.push({ id: entry.id, decision: entry.decision, reason: entry.reason.trim() });
  }
  return result;
}

/** Lenient shape check: missing triage is usable and handled separately by the retry strategy. */
export function parsePrReviewReply(
  output: string,
  threadIds: readonly string[],
  commentIds: readonly string[],
): PrReviewVerdict | null {
  const parsed = tryParseLLMJson<unknown>(output);
  if (!isRecord(parsed)) return null;
  if (parsed.intent !== "pass" && parsed.intent !== "fail" && parsed.intent !== "n/a") return null;
  if (parsed.quality !== "approved" && parsed.quality !== "changes") return null;
  return {
    intent: parsed.intent,
    quality: parsed.quality,
    findings: findings(parsed.findings),
    threads: triage(parsed.threads, threadIds),
    comments: triage(parsed.comments, commentIds),
    cannotVerify: strings(parsed.cannotVerify),
    inspectedFiles: strings(parsed.inspectedFiles),
  };
}

export function missingTriage(
  verdict: PrReviewVerdict,
  threadIds: readonly string[],
  commentIds: readonly string[],
): string[] {
  const threads = new Set(verdict.threads.map((entry) => entry.id));
  const comments = new Set(verdict.comments.map((entry) => entry.id));
  return [...threadIds.filter((id) => !threads.has(id)), ...commentIds.filter((id) => !comments.has(id))];
}
