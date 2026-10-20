/** Repo-scoped branch context for a PR checkout, independent of PRDs and run records. */
import { join } from "node:path";
import { type NaxConfig, resolveWorkflowConfig } from "@/config";
import { NaxError } from "@/errors";
import { buildRunDispatchAskWiring, type InteractionChain } from "@/interaction";
import type { NaxRuntime } from "@/runtime";
import type { PrStepContext, PrStepRef } from "./branch-step-context";
import { workflowRunDir } from "./paths";

export interface PrStepContextInput {
  readonly runtime: NaxRuntime;
  /** The config the PR is reviewed under (B2 decides where it loads from). */
  readonly config: NaxConfig;
  /** Root of the checkout that holds the PR head. */
  readonly repoRoot: string;
  readonly agentName: string;
  readonly pr: PrStepRef;
  readonly abortSignal?: AbortSignal;
  readonly interactionChain?: InteractionChain | null;
}

export const _prStepContextDeps = { buildRunDispatchAskWiring };

function validatePr(pr: PrStepRef): void {
  if (
    !Number.isInteger(pr.number) ||
    pr.number <= 0 ||
    typeof pr.base !== "string" ||
    pr.base.trim() === "" ||
    typeof pr.head !== "string" ||
    pr.head.trim() === ""
  ) {
    throw new NaxError(
      "[workflow] PR context requires a positive integer PR number and non-empty base and head refs",
      "PR_STEP_CONTEXT_INVALID",
      { stage: "workflow" },
    );
  }
}

export async function buildPrStepContext(
  input: PrStepContextInput,
): Promise<{ ctx: PrStepContext; dispose: () => Promise<void> }> {
  validatePr(input.pr);
  const label = `bot-pr-${input.pr.number}`;
  const wiring = await _prStepContextDeps.buildRunDispatchAskWiring({
    config: input.config,
    rootConfig: input.config,
    projectDir: input.repoRoot,
    repoRoot: input.repoRoot,
    packageDirs: [],
    interaction: input.interactionChain,
    outputDir: input.runtime.outputDir,
    runId: input.runtime.runId,
    featureName: label,
    abortSignal: input.abortSignal,
    stage: "merge",
  });
  const runDir = workflowRunDir(input.repoRoot, label, input.runtime.runId);
  const ctx: PrStepContext = {
    callCtx: {
      runtime: input.runtime,
      packageView: input.runtime.packages.resolve(input.repoRoot),
      packageDir: input.repoRoot,
      config: input.config,
      agentName: input.agentName,
      featureName: label,
      ...(input.abortSignal ? { signal: input.abortSignal } : {}),
      askResolver: wiring.askResolver,
      ...(wiring.commandShadow ? { commandShadow: wiring.commandShadow } : {}),
    },
    config: input.config,
    workflow: resolveWorkflowConfig(input.config),
    feature: label,
    projectDir: input.repoRoot,
    runDir,
    reportPath: join(runDir, "feature-report.md"),
    packageDirs: [],
    ...(input.abortSignal ? { runSignal: input.abortSignal } : {}),
    dryRun: input.runtime.dryRun === true,
    pr: input.pr,
  };
  return { ctx, dispose: () => wiring.dispose() };
}
