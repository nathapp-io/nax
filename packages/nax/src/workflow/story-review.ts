/** Story review (spec §6 step 4): fresh session, BASE..HEAD package, review.json. Never throws except on abort. */
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getLogger } from "@/logger";
import { workflowStoryReviewOp } from "@/operations";
import { buildWorkflowStoryReviewPrompt } from "@/prompts";
import { stepSignal } from "@/utils/step-signal";
import { writeReviewPackage } from "./git";
import type { StepContext } from "./step-context";
import { _workflowDeps } from "./step-context";
import type { GateName, GateState, StoryReviewVerdict } from "./types";

export type ReviewOutcome<V> =
  | { readonly ran: true; readonly verdict: V }
  | { readonly ran: false; readonly why: string };

/**
 * Builds the review package, then runs one review op under the review step limit; shared with re-review.ts.
 * A package failure is a skipped review, not a thrown error (abort still propagates).
 */
export async function underReviewLimit<V>(
  sc: Pick<StepContext, "runSignal" | "workflow">,
  writePackage: () => Promise<void>,
  run: (signal: AbortSignal | undefined) => Promise<V | null>,
): Promise<ReviewOutcome<V>> {
  try {
    await writePackage();
  } catch (err) {
    if (sc.runSignal?.aborted) throw err;
    return { ran: false, why: `review package failed: ${errorMessage(err)}` };
  }
  const { signal, limit } = stepSignal(sc.runSignal, sc.workflow.timeouts.reviewMs);
  const stoppedHere = (): boolean => limit?.aborted === true && sc.runSignal?.aborted !== true;
  try {
    const verdict = await run(signal);
    if (stoppedHere()) return { ran: false, why: "timeout" };
    return verdict === null ? { ran: false, why: "unparseable reply" } : { ran: true, verdict };
  } catch (err) {
    if (sc.runSignal?.aborted) throw err;
    return { ran: false, why: stoppedHere() ? "timeout" : errorMessage(err) };
  }
}

/** The verdict file is an artifact; a write failure is logged and the verdict still returns. */
export async function writeVerdictSafe(sc: StepContext, file: string, verdict: unknown): Promise<void> {
  try {
    await Bun.write(join(sc.storyDir, file), `${JSON.stringify(verdict, null, 2)}\n`);
  } catch (err) {
    getLogger().warn("workflow", `Could not write ${file}, continuing`, {
      storyId: sc.story.id,
      error: errorMessage(err),
    });
  }
}

/**
 * US-006: append the "Rules for the changed files" section to a review package.
 *
 * `delivery: "index"` only. `"push"` restores the pre-feature behaviour, where the
 * v2 orchestrator carries every rule body in the brief and the reviewer needs no
 * map; resolving one the package would not print is work with no consumer.
 *
 * Read defensively (`config.context?.rules?.delivery ?? "index"`): the run's
 * config is sparse in several tests, and a missing block means the default, not a
 * crash. A throw here is caught by `underReviewLimit` and is a skipped review.
 */
async function appendReviewRules(sc: StepContext, packagePath: string, paths: readonly string[]): Promise<void> {
  const rules = sc.config.context?.rules;
  if ((rules?.delivery ?? "index") !== "index") return;
  await _workflowDeps.appendChangedFileRules(packagePath, paths, {
    repoRoot: sc.projectDir,
    ...(rules?.overrideDir !== undefined && { overrideDir: rules.overrideDir }),
    overrideMode: rules?.overrideMode ?? "merge",
  });
}

/**
 * US-006 (nax#2527): `gates` are the story's recorded gate states, so the prompt states what nax
 * already checked. Optional — an existing two-argument caller keeps working and renders `not run`.
 */
export async function runStoryReview(
  sc: StepContext,
  concerns: readonly string[],
  gates: Readonly<Partial<Record<GateName, GateState>>> = {},
): Promise<ReviewOutcome<StoryReviewVerdict>> {
  const packagePath = join(sc.storyDir, "package-0.diff");
  const prompt = buildWorkflowStoryReviewPrompt({
    briefPath: sc.briefPath,
    reportPath: sc.reportPath,
    packagePath,
    concerns,
    gates,
    // US-009: the e2e gate runs on the host, so a journey it covers is not something the reviewer
    // could not verify — but only when the project declares that command.
    e2eGate: sc.config.quality?.commands?.e2e !== undefined,
  });
  const outcome = await underReviewLimit(
    sc,
    async () => {
      const paths = await writeReviewPackage(sc.projectDir, sc.base, packagePath);
      await appendReviewRules(sc, packagePath, paths);
    },
    (signal) =>
      _workflowDeps.callOp({ ...sc.callCtx, ...(signal ? { signal } : {}) }, workflowStoryReviewOp, {
        prompt,
        timeoutMs: sc.workflow.timeouts.reviewMs,
      }),
  );
  if (outcome.ran) await writeVerdictSafe(sc, "review.json", outcome.verdict);
  return outcome;
}
