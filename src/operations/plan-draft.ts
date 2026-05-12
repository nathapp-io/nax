import { ParseValidationError } from "../agents/retry";
import { makeTieredParseRetryStrategy } from "../agents/retry/tiered-parse-retry";
import type { TieredInspection } from "../agents/retry/tiered-parse-retry";
import { planConfigSelector } from "../config";
import type { PlanConfig } from "../config/selectors";
import { citationRate, extractClaims } from "../debate/citations";
import type { FactsManifest } from "../debate/facts-manifest";
import type { VerifierFinding } from "../plan/spec-deltas";
import { validatePlanOutput } from "../prd/schema";
import type { PRD } from "../prd/types";
import { PlanPromptBuilder } from "../prompts";
import { errorMessage } from "../utils/errors";
import { parseLLMJson } from "../utils/llm-json";
import type { RunOperation } from "./types";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PlanDraftInput {
  readonly manifestSection: string;
  readonly manifest: FactsManifest;
  readonly specContent: string;
  readonly codebaseContext: string;
  readonly feature: string;
  readonly branchName: string;
  readonly citationThreshold: number;
  readonly revisionFindings?: readonly VerifierFinding[];
}

export interface PlanDraftOutput {
  readonly prd: PRD;
  readonly citationRate: number;
  readonly advisory: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_CITATION_THRESHOLD = 0.5;

const FAIL_OPEN_DRAFT: PlanDraftOutput = {
  prd: { feature: "", project: "", branchName: "", createdAt: "", updatedAt: "", userStories: [] },
  citationRate: 0,
  advisory: true,
};

// ─── Failure kinds ────────────────────────────────────────────────────────────

type DraftFailureKind = "not-json" | "prd-invalid" | "citation-low";

interface DraftInspection extends TieredInspection<DraftFailureKind, PRD> {
  readonly citationRate?: number;
}

// ─── Inspection ───────────────────────────────────────────────────────────────

function inspectDraftOutput(output: string): DraftInspection {
  let raw: unknown;
  try {
    raw = parseLLMJson(output);
  } catch {
    return { ok: false, kind: "not-json", message: "Response was not valid JSON." };
  }

  let prd: PRD;
  try {
    prd = validatePlanOutput(raw, "", "");
  } catch (err) {
    return {
      ok: false,
      kind: "prd-invalid",
      message: `Response was valid JSON but failed PRD schema validation: ${errorMessage(err)}`,
    };
  }

  const claims = extractClaims(output);
  const rate = citationRate(claims);
  if (rate < DEFAULT_CITATION_THRESHOLD) {
    const uncited = claims.filter((c) => !c.cited).length;
    return {
      ok: false,
      kind: "citation-low",
      message: `Citation rate ${rate.toFixed(2)} below default ${DEFAULT_CITATION_THRESHOLD} (${uncited} uncited claims).`,
      partial: prd,
      citationRate: rate,
    };
  }

  return { ok: true, partial: prd, citationRate: rate };
}

// ─── Parse ────────────────────────────────────────────────────────────────────

function parsePlanDraft(output: string, input: PlanDraftInput): PlanDraftOutput {
  const inspection = inspectDraftOutput(output);

  if (!inspection.ok || !inspection.partial) {
    if (inspection.kind === "not-json") {
      throw new ParseValidationError(inspection.message ?? "Output was not valid JSON");
    }
    if (inspection.kind === "prd-invalid") {
      throw new ParseValidationError(inspection.message ?? "PRD schema validation failed");
    }
    throw new ParseValidationError(inspection.message ?? "Draft parse failed");
  }

  const prd = inspection.partial;
  const rate = inspection.citationRate ?? 0;

  if (rate < input.citationThreshold) {
    const claims = extractClaims(output);
    const uncited = claims.filter((c) => !c.cited).length;
    throw new ParseValidationError(
      `citation rate ${rate.toFixed(2)} below configured threshold ${input.citationThreshold} (${uncited} uncited claims)`,
    );
  }

  return { prd, citationRate: rate, advisory: false };
}

// ─── Retry strategy ───────────────────────────────────────────────────────────

function buildDraftRetryPrompt(inspection: DraftInspection, isTruncated: boolean): string {
  const message = inspection.message ?? "Unknown error";
  if (inspection.kind === "not-json") {
    return PlanPromptBuilder.jsonRepair(isTruncated ? 1 : 0, message);
  }
  if (inspection.kind === "prd-invalid") {
    return PlanPromptBuilder.schemaRepair(message);
  }
  return PlanPromptBuilder.citationRepair(message);
}

function createDraftRetryStrategy(): ReturnType<
  typeof makeTieredParseRetryStrategy<PlanDraftOutput, DraftFailureKind, PRD>
> {
  return makeTieredParseRetryStrategy<PlanDraftOutput, DraftFailureKind, PRD>({
    reviewerKind: "plan-draft",
    maxAttempts: 2,
    inspect: inspectDraftOutput,
    buildRetryPrompt: buildDraftRetryPrompt,
    exhaustedFallback(inspection, _lastOutput) {
      if (inspection.partial) {
        return {
          prd: inspection.partial,
          citationRate: (inspection as DraftInspection).citationRate ?? 0,
          advisory: true,
        };
      }
      return FAIL_OPEN_DRAFT;
    },
  });
}

// ─── Operation ────────────────────────────────────────────────────────────────

export const planDraftOp: RunOperation<PlanDraftInput, PlanDraftOutput, PlanConfig> = {
  kind: "run",
  name: "plan-draft",
  stage: "plan",
  session: { role: "plan", lifetime: "fresh" },
  noFallback: true,
  config: planConfigSelector,
  model: (_input, ctx) => ctx.config.plan?.model ?? "fast",
  timeoutMs: (_input, ctx) => (ctx.config.plan?.timeoutSeconds ?? 600) * 1000,
  retry: createDraftRetryStrategy(),
  build(input, _ctx) {
    return new PlanPromptBuilder().buildDraft(input);
  },
  parse(output, input, _ctx) {
    return parsePlanDraft(output, input);
  },
};
