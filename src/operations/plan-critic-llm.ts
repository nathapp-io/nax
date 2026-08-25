import type { TieredInspection } from "@/agents";
import { makeTieredParseRetryStrategy, ParseValidationError } from "@/agents";
import { planConfigSelector } from "@/config";
import type { FactsManifest } from "@/debate/facts-manifest";
import type { VerifierFinding } from "@/plan/spec-deltas";
import type { PRD } from "@/prd";
import { CriticPromptBuilder } from "@/prompts";
import { parseLLMJson } from "@/utils/llm-json";
import type { RunOperation } from "./types";

export interface PlanCriticLlmInput {
  readonly prd: PRD;
  readonly manifest: FactsManifest;
  /** Optional spec content — when present, enables failure-table enumeration audit. */
  readonly specContent?: string;
}

export interface PlanCriticLlmOutput {
  readonly findings: VerifierFinding[];
}

type CriticFailureKind = "not-json" | "schema-invalid";

export interface CriticInspection extends TieredInspection<CriticFailureKind, VerifierFinding[]> {
  readonly ok: boolean;
  readonly kind?: CriticFailureKind;
  readonly message?: string;
  readonly findings?: VerifierFinding[];
}

function isValidVerifierFinding(item: unknown): item is VerifierFinding {
  if (!item || typeof item !== "object") return false;
  const obj = item as Record<string, unknown>;
  return (
    typeof obj.checklistItem === "string" &&
    (obj.severity === "blocker" || obj.severity === "major" || obj.severity === "minor")
  );
}

export function inspectCriticOutput(output: string): CriticInspection {
  let raw: unknown;
  try {
    raw = parseLLMJson(output);
  } catch {
    return {
      ok: false,
      kind: "not-json",
      message: "Response was not valid JSON or could not be extracted.",
    };
  }

  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { findings?: unknown }).findings)) {
    return {
      ok: false,
      kind: "schema-invalid",
      message: "Response was valid JSON but did not have a `findings` array at the root.",
    };
  }

  const findings = (raw as { findings: unknown[] }).findings.filter(isValidVerifierFinding);
  return { ok: true, findings };
}

export function buildCriticRetryPrompt(inspection: CriticInspection, isTruncated: boolean): string {
  switch (inspection.kind) {
    case "not-json":
      return CriticPromptBuilder.jsonRepair(isTruncated, inspection.message ?? "");
    case "schema-invalid":
      return CriticPromptBuilder.schemaRepair(inspection.message ?? "");
    default:
      return CriticPromptBuilder.jsonRepair(false, "Re-emit JSON of shape `{ findings: [...] }`.");
  }
}

type PlanConfig = ReturnType<typeof planConfigSelector.select>;

export const planCriticLlmOp: RunOperation<PlanCriticLlmInput, PlanCriticLlmOutput, PlanConfig> = {
  kind: "run",
  name: "plan-critic-llm",
  stage: "plan",
  session: { role: "plan-critic", lifetime: "fresh" },
  noFallback: true,
  config: planConfigSelector,
  model: (_input, ctx) => ctx.config.plan?.criticModel ?? "fast",
  timeoutMs: (_input, ctx) => (ctx.config.plan?.timeoutSeconds ?? 600) * 1000,
  build(input, _ctx) {
    return new CriticPromptBuilder().build(input.prd, input.manifest, input.specContent ?? "");
  },
  parse(output, _input, _ctx) {
    const inspection = inspectCriticOutput(output);
    if (!inspection.ok) throw new ParseValidationError(inspection.message ?? "critic output invalid");
    return { findings: inspection.findings ?? [] };
  },
  retry: makeTieredParseRetryStrategy({
    reviewerKind: "plan-critic-llm",
    maxAttempts: 2,
    inspect: inspectCriticOutput,
    buildRetryPrompt: buildCriticRetryPrompt,
    exhaustedFallback: () => ({ findings: [] }),
  }),
};
