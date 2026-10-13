/** The feature-level context (spec §7): root config, one feature CallContext, and the run's paths. */
import { join } from "node:path";
import { featureDir, type NaxConfig, resolveWorkflowConfig, type WorkflowConfig } from "@/config";
import type { WorkflowStatusBlock } from "@/execution";
import { buildRunDispatchAskWiring, type InteractionChain } from "@/interaction";
import type { CallContext } from "@/operations";
import type { PRD } from "@/prd";
import type { NaxRuntime } from "@/runtime";
import { storyPackageDir } from "@/utils/path-frame";
import { workflowFeatureDir, workflowRunDir } from "./paths";

export interface WorkflowFeatureInput {
  readonly runtime: NaxRuntime;
  /** The run's root config. */
  readonly config: NaxConfig;
  readonly prd: PRD;
  readonly feature: string;
  /** Repo root. */
  readonly workdir: string;
  readonly branch: string;
  /** The runner run id. Used only for the ask wiring; the run folder keys on `runtime.runId` (nax#2482). */
  readonly runId: string;
  readonly agentName: string;
  readonly abortSignal?: AbortSignal;
  readonly interactionChain?: InteractionChain | null;
  readonly statusWriter?: { setWorkflowStatus?(block: WorkflowStatusBlock): void };
}

export interface FeatureContext {
  readonly callCtx: CallContext;
  readonly config: NaxConfig;
  readonly workflow: WorkflowConfig;
  readonly prd: PRD;
  readonly feature: string;
  readonly projectDir: string;
  readonly branch: string;
  /** `runtime.runId`, the same id the story loop uses, so one run = one folder (nax#2482). */
  readonly runId: string;
  readonly outputDir: string;
  /** This run's workflow dir. */
  readonly runDir: string;
  /** Every run of this feature (`.nax/features/<feature>/workflow`). */
  readonly featureDir: string;
  readonly prdPath: string;
  /** `<runDir>/feature-report.md`. */
  readonly reportPath: string;
  /** Distinct story package dirs (repo-relative), for the repo gates. */
  readonly packageDirs: readonly string[];
  readonly runSignal?: AbortSignal;
  readonly dryRun: boolean;
}

export const _featureContextDeps = { buildRunDispatchAskWiring };

export async function buildFeatureContext(
  input: WorkflowFeatureInput,
): Promise<{ fc: FeatureContext; dispose: () => Promise<void> }> {
  const storyPackageDirs = input.prd.userStories.map(storyPackageDir);
  // ADR-031: a whole-feature op uses root config; the branch fix declares Bash, so the ask wiring is required.
  const dispatchAsk = await _featureContextDeps.buildRunDispatchAskWiring({
    config: input.config,
    rootConfig: input.config,
    projectDir: input.workdir,
    packageDirs: storyPackageDirs,
    interaction: input.interactionChain,
    outputDir: input.runtime.outputDir,
    runId: input.runId,
    repoRoot: input.workdir,
    featureName: input.feature,
    abortSignal: input.abortSignal,
    stage: "merge",
  });
  const callCtx: CallContext = {
    runtime: input.runtime,
    packageView: input.runtime.packages.resolve(input.workdir),
    packageDir: input.workdir,
    config: input.config,
    agentName: input.agentName,
    featureName: input.feature,
    ...(input.abortSignal ? { signal: input.abortSignal } : {}),
    askResolver: dispatchAsk.askResolver,
    ...(dispatchAsk.commandShadow ? { commandShadow: dispatchAsk.commandShadow } : {}),
  };
  const runId = input.runtime.runId;
  const runDir = workflowRunDir(input.workdir, input.feature, runId);
  const fc: FeatureContext = {
    callCtx,
    config: input.config,
    workflow: resolveWorkflowConfig(input.config),
    prd: input.prd,
    feature: input.feature,
    projectDir: input.workdir,
    branch: input.branch,
    runId,
    outputDir: input.runtime.outputDir,
    runDir,
    featureDir: workflowFeatureDir(input.workdir, input.feature),
    prdPath: join(featureDir(input.workdir, input.feature), "prd.json"),
    reportPath: join(runDir, "feature-report.md"),
    packageDirs: [...new Set(storyPackageDirs.filter((d): d is string => typeof d === "string" && d !== ""))],
    ...(input.abortSignal ? { runSignal: input.abortSignal } : {}),
    dryRun: input.runtime.dryRun === true,
  };
  return { fc, dispose: () => dispatchAsk.dispose() };
}
