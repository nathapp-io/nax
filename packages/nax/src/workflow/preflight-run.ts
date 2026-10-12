/** Pre-flight placement (spec §5.3, §8, P4-R14): once per run, before the first story. Fail-open. */
import { mkdir } from "node:fs/promises";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { type NaxConfig, resolveWorkflowConfig } from "@/config";
import type { InteractionChain } from "@/interaction";
import { getSafeLogger } from "@/logger";
import type { PRD } from "@/prd";
import type { NaxRuntime } from "@/runtime";
import { specPathFor } from "./brief";
import { buildFeatureContext } from "./feature-context";
import { newestPreflight } from "./feature-record";
import { appendLedger, ensureLedger } from "./ledger";
import { preflightPath, runPreflight } from "./preflight";
import { _workflowDeps } from "./step-context";

export interface WorkflowRunStartInput {
  readonly runtime: NaxRuntime;
  readonly config: NaxConfig;
  readonly prd: PRD;
  readonly feature: string;
  readonly workdir: string;
  readonly runId: string;
  readonly agentName: string;
  readonly abortSignal?: AbortSignal;
  readonly interactionChain?: InteractionChain | null;
}

export const _preflightRunDeps = { buildFeatureContext };

function pendingStoryIds(prd: PRD): string[] {
  return prd.userStories.filter((s) => !s.passes && s.status !== "passed" && s.status !== "skipped").map((s) => s.id);
}

/** Copy the newest reusable preflight.json of an earlier run into this run dir, unless it already has one. */
export async function adoptPriorPreflight(featureDir: string, runDir: string): Promise<boolean> {
  if (await Bun.file(preflightPath(runDir)).exists()) return false;
  const prior = await newestPreflight(featureDir);
  if (!prior) return false;
  await mkdir(runDir, { recursive: true });
  await Bun.write(preflightPath(runDir), `${JSON.stringify(prior.file, null, 2)}\n`);
  return true;
}

export async function runWorkflowPreflight(input: WorkflowRunStartInput): Promise<void> {
  if (!resolveWorkflowConfig(input.config).preflight) return;
  const storyIds = pendingStoryIds(input.prd);
  if (storyIds.length === 0) return;
  let dispose: (() => Promise<void>) | undefined;
  try {
    const built = await _preflightRunDeps.buildFeatureContext({ ...input, branch: "" });
    dispose = built.dispose;
    const { fc } = built;
    await ensureLedger(fc.runDir, fc.runId, fc.feature);
    if (await adoptPriorPreflight(fc.featureDir, fc.runDir)) {
      getSafeLogger()?.info("workflow", "Reusing the pre-flight of an earlier run", { storyId: "_run" });
    }
    const advisor = _workflowDeps.createAdvisor({
      callCtx: fc.callCtx,
      repoRoot: fc.projectDir,
      outputDir: fc.outputDir,
      feature: fc.feature,
      runId: fc.runId,
      specPath: await specPathFor(fc.feature, fc.projectDir),
      workdir: fc.projectDir,
    });
    const file = await runPreflight({
      advisor,
      runDir: fc.runDir,
      storyIds,
      ledger: (storyId, text) => appendLedger(fc.runDir, storyId, text),
    });
    getSafeLogger()?.info("workflow", "Pre-flight done", { storyId: "_run", conflicts: file.conflicts.length });
  } catch (err) {
    if (input.abortSignal?.aborted) throw err;
    getSafeLogger()?.warn("workflow", "Pre-flight failed — stories run under the spec as written", {
      storyId: "_run",
      error: errorMessage(err),
    });
  } finally {
    await dispose?.();
  }
}
