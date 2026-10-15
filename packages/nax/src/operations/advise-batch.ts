/**
 * A5 PR3: one advisor call that rules on N items (spec §8 "Batched questions"). Each residual
 * answer is validated against its own item's menu; pre-flight conflicts are validated later,
 * against the menu the advisor service builds from each conflict's references (P3-R2).
 */
import type { AdvisorReply } from "../advisor/types";
import { previewOutput, UNPARSED_PREVIEW_BYTES } from "../agents/retry/parse-retry";
import type { ConfiguredModel } from "../config";
import { advisorConfigSelector, resolveAdvisorConfig } from "../config";
import type { AdvisorConfigSlice } from "../config/selectors";
import { buildAdvisorBatchPrompt } from "../prompts";
import type { AdvisorBatchPromptInput } from "../prompts/builders/advisor-batch-builder";
import { tryParseLLMJson } from "../utils/llm-json";
import { validateAdvisorReply } from "./advise";
import type { RunOperation } from "./types";

export interface AdviseBatchOpInput extends AdvisorBatchPromptInput {
  readonly model?: ConfiguredModel;
  readonly timeoutMs?: number;
}

export interface BatchItemAnswer {
  readonly itemId: string;
  readonly reply?: AdvisorReply;
  readonly error?: string;
  readonly raw: unknown;
}

export interface RawPreflightConflict {
  readonly storyIds: readonly string[];
  readonly acRef?: { readonly storyId: string; readonly acId: string };
  readonly specSection?: string;
  readonly description: string;
  /** The reply fields, validated later against the built menu. */
  readonly raw: Record<string, unknown>;
}

export type AdviseBatchOpOutput =
  | {
      ok: true;
      answers: readonly BatchItemAnswer[];
      diagnoses: Readonly<Record<string, string>>;
      conflicts: readonly RawPreflightConflict[];
      overlap: readonly { readonly storyId: string; readonly specSections: readonly string[] }[];
    }
  | { ok: false; error: string; preview: string };

const NO_ANSWER = "no answer for this item";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function unparsedPreview(output: string): string {
  const preview = previewOutput(output, UNPARSED_PREVIEW_BYTES);
  return preview === "" ? "(empty response)" : preview;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim() !== "") : [];
}

function residualAnswers(parsed: Record<string, unknown>, input: AdviseBatchOpInput): BatchItemAnswer[] {
  const byId = new Map<string, Record<string, unknown>>();
  for (const a of Array.isArray(parsed.answers) ? parsed.answers : []) {
    if (isRecord(a) && typeof a.itemId === "string" && !byId.has(a.itemId)) byId.set(a.itemId, a);
  }
  return input.items.map((item): BatchItemAnswer => {
    const raw = byId.get(item.id);
    if (!raw) return { itemId: item.id, error: NO_ANSWER, raw: null };
    const checked = validateAdvisorReply(raw, item.options);
    return checked.ok ? { itemId: item.id, reply: checked.reply, raw } : { itemId: item.id, error: checked.error, raw };
  });
}

function diagnoses(parsed: Record<string, unknown>, gates: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(parsed.diagnoses)) return out;
  for (const gate of gates) {
    const text = parsed.diagnoses[gate];
    if (typeof text === "string" && text.trim() !== "") out[gate] = text;
  }
  return out;
}

function acRefOf(v: unknown): { storyId: string; acId: string } | undefined {
  return isRecord(v) && typeof v.storyId === "string" && typeof v.acId === "string"
    ? { storyId: v.storyId, acId: v.acId }
    : undefined;
}

function conflicts(parsed: Record<string, unknown>): RawPreflightConflict[] {
  const out: RawPreflightConflict[] = [];
  for (const c of Array.isArray(parsed.conflicts) ? parsed.conflicts : []) {
    if (!isRecord(c) || typeof c.description !== "string" || c.description.trim() === "") continue;
    const acRef = acRefOf(c.acRef);
    const specSection = typeof c.specSection === "string" && c.specSection.trim() !== "" ? c.specSection : undefined;
    if (!acRef && !specSection) continue;
    out.push({
      storyIds: strings(c.storyIds),
      ...(acRef ? { acRef } : {}),
      ...(specSection ? { specSection } : {}),
      description: c.description,
      raw: c,
    });
  }
  return out;
}

function overlap(parsed: Record<string, unknown>): { storyId: string; specSections: string[] }[] {
  const out: { storyId: string; specSections: string[] }[] = [];
  for (const o of Array.isArray(parsed.overlap) ? parsed.overlap : []) {
    if (isRecord(o) && typeof o.storyId === "string")
      out.push({ storyId: o.storyId, specSections: strings(o.specSections) });
  }
  return out;
}

export const adviseBatchOp: RunOperation<AdviseBatchOpInput, AdviseBatchOpOutput, AdvisorConfigSlice> = {
  kind: "run",
  name: "advise-batch",
  stage: "review",
  session: { role: "advisor", lifetime: "fresh" },
  tools: ["Read", "Glob", "Grep"],
  config: advisorConfigSelector,
  model: (input, ctx) => input.model ?? resolveAdvisorConfig(ctx.config).model,
  timeoutMs: (input, ctx) =>
    input.timeoutMs ?? resolveAdvisorConfig(ctx.config).timeoutMs ?? ctx.config.execution.sessionTimeoutSeconds * 1000,
  build: (input) => ({
    role: { id: "role", content: "", overridable: false },
    task: { id: "task", content: buildAdvisorBatchPrompt(input), overridable: false },
  }),
  parse: (output, input) => {
    const parsed = tryParseLLMJson<unknown>(output);
    if (!isRecord(parsed)) return { ok: false, error: "no-json", preview: unparsedPreview(output) };
    // Fail closed: a reply that is JSON but carries no usable ruling must escalate the ladder
    // (runBatchLadder only moves on when !ok), not pass as "the advisor had nothing to say".
    const answers = input.kind === "residual" ? residualAnswers(parsed, input) : [];
    if (input.kind === "residual" && input.items.length > 0 && !answers.some((a) => a.reply)) {
      return { ok: false, error: "no-valid-answers", preview: unparsedPreview(output) };
    }
    if (input.kind === "preflight" && !Array.isArray(parsed.conflicts)) {
      return { ok: false, error: "no-conflicts-array", preview: unparsedPreview(output) };
    }
    return {
      ok: true,
      answers,
      diagnoses: input.kind === "residual" ? diagnoses(parsed, input.redGates) : {},
      conflicts: input.kind === "preflight" ? conflicts(parsed) : [],
      overlap: input.kind === "preflight" ? overlap(parsed) : [],
    };
  },
};
