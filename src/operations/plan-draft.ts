import type { TieredInspection } from "../agents/retry";
import { makeTieredParseRetryStrategy, ParseValidationError } from "../agents/retry";
import type { ProjectProfile } from "../config";
import { planConfigSelector } from "../config";
import type { PlanConfig } from "../config/selectors";
import { citationRate, extractClaims } from "../debate/citations";
import type { FactsManifest } from "../debate/facts-manifest";
import { validateDraftCitations } from "../plan/draft-citations";
import type { VerifierFinding } from "../plan/spec-deltas";
import { validatePlanOutput } from "../prd/schema";
import type { PRD } from "../prd/types";
import type { PackageSummary } from "../prompts";
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
  /** Optional monorepo packages — propagated to the draft prompt for parity with single-mode build(). */
  readonly packages?: readonly string[];
  /** Optional per-package tech-stack summaries (only used when packages is non-empty). */
  readonly packageDetails?: readonly PackageSummary[];
  /** Optional project profile for language/type-aware AC examples. */
  readonly projectProfile?: ProjectProfile;
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

export function inspectDraftOutput(
  output: string,
  feature = "",
  branch = "",
  citationThreshold = DEFAULT_CITATION_THRESHOLD,
): DraftInspection {
  let raw: unknown;
  try {
    raw = parseLLMJson(output);
  } catch {
    return { ok: false, kind: "not-json", message: "Response was not valid JSON." };
  }

  let prd: PRD;
  try {
    prd = validatePlanOutput(raw, feature, branch);
  } catch (err) {
    return {
      ok: false,
      kind: "prd-invalid",
      message: `Response was valid JSON but failed PRD schema validation: ${errorMessage(err)}`,
    };
  }

  const claims = extractClaims(output);
  const rate = citationRate(claims);
  if (citationThreshold > 0 && rate < citationThreshold) {
    const uncited = claims.filter((c) => !c.cited).length;
    return {
      ok: false,
      kind: "citation-low",
      message: `Citation rate ${rate.toFixed(2)} below threshold ${citationThreshold} (${uncited} uncited claims).`,
      partial: prd,
      citationRate: rate,
    };
  }

  return { ok: true, partial: prd, citationRate: rate };
}

// ─── Parse ────────────────────────────────────────────────────────────────────

function parsePlanDraft(output: string, input: PlanDraftInput): PlanDraftOutput {
  const inspection = inspectDraftOutput(output, input.feature, input.branchName);

  if (inspection.kind === "not-json") {
    throw new ParseValidationError(inspection.message ?? "Output was not valid JSON");
  }
  if (inspection.kind === "prd-invalid") {
    throw new ParseValidationError(inspection.message ?? "PRD schema validation failed");
  }
  if (!inspection.partial) {
    throw new ParseValidationError(inspection.message ?? "Draft parse failed");
  }
  // citation-low with partial: fall through to validateDraftCitations (configured threshold)

  const prd = inspection.partial;
  const rate = inspection.citationRate ?? 0;

  // Enforce the configured threshold (may differ from DEFAULT_CITATION_THRESHOLD used by inspectDraftOutput).
  // Use validateDraftCitations as the SSOT instead of re-running extractClaims/citationRate inline.
  const citation = validateDraftCitations(output, input.manifest, input.citationThreshold);
  if (!citation.ok) {
    throw new ParseValidationError(
      `citation rate ${citation.rate.toFixed(2)} below configured threshold ${citation.threshold} (${citation.uncitedCount} uncited claims)`,
    );
  }

  return { prd, citationRate: rate, advisory: false };
}

// ─── Retry strategy ───────────────────────────────────────────────────────────

function buildDraftRetryPrompt(inspection: DraftInspection, isTruncated: boolean): string {
  if (inspection.kind === "not-json") {
    return PlanPromptBuilder.jsonRepair(isTruncated ? 1 : 0, inspection.message ?? "Unknown error");
  }
  if (inspection.kind === "prd-invalid") {
    return PlanPromptBuilder.schemaRepair(inspection.message ?? "Unknown error");
  }
  // Handles "citation-low" and the edge case where inspectDraftOutput returned ok: true
  // (rate >= DEFAULT 0.5) but parsePlanDraft still rejected because configured threshold > 0.5.
  const message =
    inspection.message ??
    "The citation rate in your response is below the required threshold. Add [F-NNN] or [S-NNN] citations to all concrete claims.";
  return PlanPromptBuilder.citationRepair(message);
}

function createDraftRetryStrategy(
  citationThreshold = DEFAULT_CITATION_THRESHOLD,
): ReturnType<typeof makeTieredParseRetryStrategy<PlanDraftOutput, DraftFailureKind, PRD>> {
  return makeTieredParseRetryStrategy<PlanDraftOutput, DraftFailureKind, PRD>({
    reviewerKind: "plan-draft",
    maxAttempts: 2,
    inspect: (output) => inspectDraftOutput(output, "", "", citationThreshold),
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
  session: { role: "plan-draft", lifetime: "fresh" },
  noFallback: true,
  config: planConfigSelector,
  model: (_input, ctx) => ctx.config.plan?.model ?? "fast",
  timeoutMs: (_input, ctx) => (ctx.config.plan?.timeoutSeconds ?? 600) * 1000,
  retry: (input: PlanDraftInput) => createDraftRetryStrategy(input.citationThreshold),
  build(input, ctx) {
    const agentRouting = ctx.config.routing?.agents;
    const profiles = agentRouting?.enabled === true ? (agentRouting.profiles ?? []) : [];
    return new PlanPromptBuilder().buildDraft({ ...input, profiles });
  },
  parse(output, input, _ctx) {
    return parsePlanDraft(output, input);
  },
};
