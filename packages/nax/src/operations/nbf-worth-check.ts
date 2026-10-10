/** Read-only worth-check operation for non-blocking-fix findings. */

import { previewOutput, UNPARSED_PREVIEW_BYTES } from "../agents/retry/parse-retry";
import { reviewConfigSelector } from "../config";
import type { ReviewConfig } from "../config/selectors";
import type { Finding } from "../findings";
import type { UserStory } from "../prd";
import { buildNbfWorthCheckPrompt } from "../prompts";
import { tryParseLLMJson } from "../utils/llm-json";
import type { RunOperation } from "./types";

export interface NbfWorthCheckPendingStory {
  readonly id: string;
  readonly title: string;
  readonly acceptanceCriteria: readonly string[];
}

export interface NbfWorthCheckOpInput {
  readonly story: UserStory;
  /** Story diff, already truncated by the runner; "" when unavailable. */
  readonly diff: string;
  readonly findings: readonly Finding[];
  readonly pendingStories: readonly NbfWorthCheckPendingStory[];
}

export interface NbfWorthVerdict {
  readonly index: number;
  readonly verdict: "fix" | "skip";
  readonly reason: string;
}

export type NbfWorthCheckOpOutput =
  | { readonly parsed: true; readonly verdicts: readonly NbfWorthVerdict[] }
  | { readonly parsed: false; readonly unparsedPreview: string };

const INVALID_VERDICT_REASON = "(invalid verdict)";
const EMPTY_SKIP_REASON = "(skip without reason)";
const MISSING_VERDICT_REASON = "(no verdict returned)";
const DEFAULT_MODEL = "balanced";
const DEFAULT_TIMEOUT_MS = 300_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unparsedResult(output: string): NbfWorthCheckOpOutput {
  const preview = previewOutput(output, UNPARSED_PREVIEW_BYTES);
  return { parsed: false, unparsedPreview: preview === "" ? "(empty response)" : preview };
}

function normalizeVerdicts(entries: readonly unknown[], findingCount: number): NbfWorthVerdict[] {
  const firstByIndex = new Map<number, Record<string, unknown>>();
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const index = entry.index;
    if (!Number.isInteger(index) || (index as number) < 1 || (index as number) > findingCount) continue;
    if (!firstByIndex.has(index as number)) firstByIndex.set(index as number, entry);
  }

  return Array.from({ length: findingCount }, (_, offset) => {
    const index = offset + 1;
    const entry = firstByIndex.get(index);
    if (!entry) return { index, verdict: "fix", reason: MISSING_VERDICT_REASON };
    if (entry.verdict !== "fix" && entry.verdict !== "skip") {
      return { index, verdict: "fix", reason: INVALID_VERDICT_REASON };
    }
    if (entry.verdict === "skip") {
      const reason = typeof entry.reason === "string" ? entry.reason : "";
      if (reason.trim() === "") return { index, verdict: "fix", reason: EMPTY_SKIP_REASON };
      return { index, verdict: "skip", reason };
    }
    return { index, verdict: "fix", reason: typeof entry.reason === "string" ? entry.reason : "" };
  });
}

export function parseNbfWorthReply(output: string, findingCount: number): NbfWorthCheckOpOutput {
  const parsed = tryParseLLMJson<unknown>(output);
  if (!isRecord(parsed) || !Array.isArray(parsed.verdicts)) return unparsedResult(output);
  return { parsed: true, verdicts: normalizeVerdicts(parsed.verdicts, findingCount) };
}

export const nbfWorthCheckOp: RunOperation<NbfWorthCheckOpInput, NbfWorthCheckOpOutput, ReviewConfig> = {
  kind: "run",
  name: "nbf-worth-check",
  stage: "review",
  session: { role: "nbf-worth-check", lifetime: "fresh" },
  tools: ["Read", "Glob", "Grep"],
  config: reviewConfigSelector,
  model: (_input, ctx) => ctx.config.review.nonBlockingFix?.worthCheck?.model ?? DEFAULT_MODEL,
  timeoutMs: (_input, ctx) => ctx.config.review.nonBlockingFix?.worthCheck?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  build: (input) => ({
    role: { id: "role", content: "", overridable: false },
    task: { id: "task", content: buildNbfWorthCheckPrompt(input), overridable: false },
  }),
  parse: (output, input) => parseNbfWorthReply(output, input.findings.length),
};
