/**
 * A1 advisor operation (spec §4.4, §12.1). A verdict-only, read-only run op: it rules on one judgment
 * call and returns a typed reply. Like `fixReviewOp`, it has no parse retry — a missing, invalid or
 * off-menu reply is a typed `{ ok: false }`, which the advisor service turns into a safe fallback.
 */

import type { AdviceActionType, AdviceDecision, AdviceOption, AdviceQuestion, AdvisorReply } from "../advisor/types";
import { previewOutput, UNPARSED_PREVIEW_BYTES } from "../agents/retry/parse-retry";
import type { ConfiguredModel } from "../config";
import { advisorConfigSelector, resolveAdvisorConfig } from "../config";
import type { AdvisorConfigSlice } from "../config/selectors";
import { buildAdvisorPrompt } from "../prompts";
import { tryParseLLMJson } from "../utils/llm-json";
import type { RunOperation } from "./types";

export interface AdviseOpInput {
  readonly question: AdviceQuestion;
  readonly specPath: string;
  readonly prdText: string;
  readonly priorDecisions: readonly AdviceDecision[];
  readonly continuation: boolean;
  /** Warm memory keeps the session open between questions. */
  readonly keepOpen: boolean;
  readonly model?: ConfiguredModel;
  readonly timeoutMs?: number;
}

export type AdviseOpOutput = { ok: true; reply: AdvisorReply } | { ok: false; error: string; preview: string };

/** Mirror of `REQUIRED_TEXT_FIELD` in `src/advisor/menus.ts` (kept here so operations never imports advisor values). */
const REQUIRED: Record<AdviceActionType, "instruction" | "reason" | "newText" | null> = {
  fix: "instruction",
  waive: "reason",
  supersede: "newText",
  retry: "instruction",
  retarget: "instruction",
  "retry-as-lite": null,
  "escalate-tier": "reason",
  defer: "reason",
  approve: null,
  "re-review": null,
  hold: "reason",
};

const CONFIDENCE = new Set(["high", "medium", "low"]);

function optionalText(raw: Record<string, unknown>, key: string): string | undefined {
  return typeof raw[key] === "string" ? (raw[key] as string) : undefined;
}

export function validateAdvisorReply(
  value: unknown,
  options: readonly AdviceOption[],
): { ok: true; reply: AdvisorReply } | { ok: false; error: string } {
  if (typeof value !== "object" || value === null) return { ok: false, error: "reply is not a JSON object" };
  const raw = value as Record<string, unknown>;
  const optionId = typeof raw.optionId === "string" ? raw.optionId : "";
  const option = options.find((o) => o.id === optionId);
  if (!option) return { ok: false, error: `optionId ${optionId || "(missing)"} is not on the menu` };
  if (typeof raw.rationale !== "string" || raw.rationale.trim() === "")
    return { ok: false, error: "rationale is required" };
  if (typeof raw.confidence !== "string" || !CONFIDENCE.has(raw.confidence))
    return { ok: false, error: "confidence must be high|medium|low" };
  if (typeof raw.reversible !== "boolean" || typeof raw.needsHumanConfirm !== "boolean") {
    return { ok: false, error: "reversible and needsHumanConfirm must be booleans" };
  }
  const field = REQUIRED[option.type];
  if (field && (typeof raw[field] !== "string" || (raw[field] as string).trim() === "")) {
    return { ok: false, error: `option ${option.id} (${option.type}) requires a non-empty ${field}` };
  }
  const reply: AdvisorReply = {
    optionId,
    rationale: raw.rationale,
    confidence: raw.confidence as AdvisorReply["confidence"],
    reversible: raw.reversible,
    needsHumanConfirm: raw.needsHumanConfirm,
  };
  const instruction = optionalText(raw, "instruction");
  const reason = optionalText(raw, "reason");
  const newText = optionalText(raw, "newText");
  return {
    ok: true,
    reply: {
      ...reply,
      ...(instruction ? { instruction } : {}),
      ...(reason ? { reason } : {}),
      ...(newText ? { newText } : {}),
    },
  };
}

export const adviseOp: RunOperation<AdviseOpInput, AdviseOpOutput, AdvisorConfigSlice> = {
  kind: "run",
  name: "advise",
  stage: "review",
  session: { role: "advisor", lifetime: "fresh" },
  tools: ["Read", "Glob", "Grep"],
  config: advisorConfigSelector,
  model: (input, ctx) => input.model ?? resolveAdvisorConfig(ctx.config).model,
  timeoutMs: (input, ctx) =>
    input.timeoutMs ?? resolveAdvisorConfig(ctx.config).timeoutMs ?? ctx.config.execution.sessionTimeoutSeconds * 1000,
  keepOpen: (input) => input.keepOpen,
  build: (input) => ({
    role: { id: "role", content: "", overridable: false },
    task: {
      id: "task",
      content: buildAdvisorPrompt({
        question: input.question,
        specPath: input.specPath,
        prdText: input.prdText,
        priorDecisions: input.priorDecisions,
        continuation: input.continuation,
      }),
      overridable: false,
    },
  }),
  parse: (output, input) => {
    const parsed = tryParseLLMJson<unknown>(output);
    if (parsed === null || parsed === undefined) {
      const preview = previewOutput(output, UNPARSED_PREVIEW_BYTES);
      return { ok: false, error: "no-json", preview: preview === "" ? "(empty response)" : preview };
    }
    const checked = validateAdvisorReply(parsed, input.question.options);
    return checked.ok
      ? checked
      : { ok: false, error: checked.error, preview: previewOutput(output, UNPARSED_PREVIEW_BYTES) };
  },
};
