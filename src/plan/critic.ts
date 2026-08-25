/**
 * Plan Critic — US-005
 *
 * Orchestrates the plan review pipeline:
 * 1. Mechanical checks (file existence, citation, contradiction, coverage)
 * 2. LLM judgment via planCriticLlmOp (fail-open)
 * 3. Revision via planDraftOp when blockers are found
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { NaxConfig } from "@/config";
import type { FactsManifest } from "@/debate";
import { checkAcAnchored, checkClaimsCited, checkFilesExist, checkNoContradictions, checkSpecCoverage } from "@/debate";
import { getLogger } from "@/logger";
import type { CallContext, PlanDraftInput } from "@/operations";
import { callOp, planCriticLlmOp, planDraftOp } from "@/operations";
import type { PRD } from "@/prd";
import type { VerifierFinding } from "./spec-deltas";
import { formatSpecDeltas } from "./spec-deltas";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PlanCriticInput {
  readonly prd: PRD;
  readonly manifest: FactsManifest;
  readonly workdir: string;
  readonly runId: string;
  readonly storyId: string;
  readonly config: NaxConfig;
  readonly callCtx: CallContext;
  readonly draftCtx: PlanDraftInput;
}

export interface PlanCriticVerdict {
  readonly outcome: "passed" | "failed";
  readonly prd: PRD;
  readonly findings: VerifierFinding[];
  readonly specDeltasPath?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function writeSpecDeltas(
  findings: VerifierFinding[],
  workdir: string,
  runId: string,
  storyId: string,
  manifest: FactsManifest,
): Promise<string> {
  const path = join(workdir, ".nax", "runs", runId, "plan", storyId, "spec-deltas.md");
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, formatSpecDeltas(findings, manifest));
  return path;
}

function runMechanicalChecks(
  prd: PRD,
  workdir: string,
  manifest: FactsManifest,
  citationThreshold: number,
): VerifierFinding[] {
  return [
    ...checkFilesExist(prd, workdir),
    ...checkAcAnchored(prd),
    ...checkClaimsCited(manifest, citationThreshold),
    ...checkNoContradictions(prd, manifest),
    ...checkSpecCoverage(manifest),
  ];
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function runPlanCritic(input: PlanCriticInput): Promise<PlanCriticVerdict> {
  const logger = getLogger();
  const { prd, manifest, workdir, runId, storyId, callCtx, draftCtx } = input;

  // 1. Mechanical checks
  const mechFindings = runMechanicalChecks(prd, workdir, manifest, draftCtx.citationThreshold);
  const mechBlockers = mechFindings.filter((f) => f.severity === "blocker");

  if (mechBlockers.length > 0) {
    const specDeltasPath = await writeSpecDeltas(mechBlockers, workdir, runId, storyId, manifest);
    return { outcome: "failed", prd, findings: mechFindings, specDeltasPath };
  }

  // 2. LLM judgment via planCriticLlmOp (fail-open: exhaustion returns { findings: [] })
  let llmFindings: VerifierFinding[] = [];
  try {
    const llmResult = await callOp(callCtx, planCriticLlmOp, {
      prd,
      manifest,
      specContent: draftCtx.specContent,
    });
    llmFindings = llmResult.findings as VerifierFinding[];
  } catch {
    logger?.warn("plan-critic", "LLM judgment failed; proceeding with zero LLM findings", { storyId });
  }

  const allFindings = [...mechFindings, ...llmFindings];
  const allBlockers = allFindings.filter((f) => f.severity === "blocker");

  if (allBlockers.length === 0) {
    return { outcome: "passed", prd, findings: allFindings };
  }

  // 3. Revision via planDraftOp (session named "plan-revise" to distinguish from initial draft)
  try {
    const revisedDraft = await callOp({ ...callCtx, sessionOverride: { role: "plan-revise" } }, planDraftOp, {
      ...draftCtx,
      revisionFindings: allBlockers,
    });

    const revisedMechFindings = runMechanicalChecks(revisedDraft.prd, workdir, manifest, draftCtx.citationThreshold);
    const revisedMechBlockers = revisedMechFindings.filter((f) => f.severity === "blocker");

    if (revisedMechBlockers.length === 0) {
      return { outcome: "passed", prd: revisedDraft.prd, findings: allFindings };
    }

    const specDeltasPath = await writeSpecDeltas(revisedMechBlockers, workdir, runId, storyId, manifest);
    return { outcome: "failed", prd: revisedDraft.prd, findings: allFindings, specDeltasPath };
  } catch {
    const specDeltasPath = await writeSpecDeltas(allBlockers, workdir, runId, storyId, manifest);
    return { outcome: "failed", prd, findings: allFindings, specDeltasPath };
  }
}
