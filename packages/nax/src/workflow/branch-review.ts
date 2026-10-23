/** The whole-branch review (spec §7 step 2) and its scoped re-review (step 4). Never throw except on abort. */
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { ConfiguredModel } from "@/config";
import { getLogger } from "@/logger";
import { unreadFiles, workflowBranchReviewOp, workflowReReviewOp } from "@/operations";
import {
  type BranchReviewPromptInput,
  buildProjectContextSection,
  buildWorkflowBranchReReviewPrompt,
  buildWorkflowBranchReviewPrompt,
} from "@/prompts";
import type { BranchStepContext } from "./branch-step-context";
import { writeBranchReviewPackage, writeReviewPackage } from "./git";
import { workflowStoryDir } from "./paths";
import { reviewRequiredFiles } from "./review-coverage";
import { _workflowDeps } from "./step-context";
import { type ReviewOutcome, underReviewLimit } from "./story-review";
import type { BranchReviewVerdict, ReReviewVerdict, WorkflowFinding } from "./types";

/** US-006 (nax#2527): `repoGates` is the repo-gate summary the branch reviewer is told about. */
export type BranchReviewFacts = Pick<
  BranchReviewPromptInput,
  "stories" | "minors" | "parked" | "cannotVerify" | "gateFindings" | "repoGates"
>;

/** The type `runBranchReview` inventories: each listed story's report and whether it is on disk. */
type StoryReport = NonNullable<BranchReviewPromptInput["storyReports"]>[number];

/**
 * US-009: every story that kept a run dir, with the `report.md` it should hold. The per-story run
 * dir, not this run's, so a report written by an earlier run still reads as present.
 *
 * A `fileExists` throw reads as present: an unreadable report is not a missing one, and telling
 * the reviewer it is missing is exactly the stale claim this inventory exists to prevent.
 */
async function storyReportInventory(stories: BranchReviewPromptInput["stories"]): Promise<StoryReport[]> {
  const reports: StoryReport[] = [];
  for (const s of stories) {
    if (!s.runDir) continue;
    const path = join(workflowStoryDir(s.runDir, s.id), "report.md");
    const present = await _workflowDeps.fileExists(path).catch(() => true);
    reports.push({ storyId: s.id, path, present });
  }
  return reports;
}

/** Feature artifacts are best effort: a write failure is logged and the step goes on. */
export async function writeFeatureArtifact(fc: BranchStepContext, name: string, value: unknown): Promise<void> {
  try {
    await Bun.write(join(fc.runDir, name), `${JSON.stringify(value, null, 2)}\n`);
  } catch (err) {
    getLogger().warn("workflow", `Could not write ${name}, continuing`, { storyId: "_run", error: errorMessage(err) });
  }
}

/** The branch reviewer's model (spec §4): workflow.models.branchReview, then finish.reviewers.quality. */
export function branchReviewModel(fc: BranchStepContext): ConfiguredModel | undefined {
  return fc.workflow.models.branchReview ?? fc.config.finish?.reviewers?.quality ?? undefined;
}

/**
 * US-006: append the "Rules for the changed files" section to the branch package.
 *
 * `delivery: "index"` only — see `appendReviewRules` in `story-review.ts` for why
 * (the run's config is read defensively, and a throw is a skipped review).
 */
async function appendReviewRules(fc: BranchStepContext, packagePath: string, paths: readonly string[]): Promise<void> {
  const rules = fc.config.context?.rules;
  if ((rules?.delivery ?? "index") !== "index") return;
  await _workflowDeps.appendChangedFileRules(packagePath, paths, {
    repoRoot: fc.projectDir,
    ...(rules?.overrideDir !== undefined && { overrideDir: rules.overrideDir }),
    overrideMode: rules?.overrideMode ?? "merge",
  });
}

/**
 * US-007: append the "## Project context (run override)" section to the branch package.
 *
 * Independent of rules delivery mode and of whether any rule governs a changed
 * file: `delivery` decides what the *brief* carries, while the configured
 * project-context file belongs in every package the run builds. The loader
 * returns `undefined` when no file is configured, so this is a no-op then.
 *
 * A throw from the loader is a skipped review, exactly as a failing rules append
 * is: it happens inside `underReviewLimit`'s package callback, so the reviewer
 * never sees a package that is missing the context it was promised.
 */
async function appendProjectContextOverride(fc: BranchStepContext, packagePath: string): Promise<void> {
  const override = await _workflowDeps.loadProjectContextOverride(fc.config);
  const section = buildProjectContextSection(override);
  if (section === "") return;
  const file = Bun.file(packagePath);
  const prior = (await file.exists()) ? await file.text() : "";
  // A blank line before the appended `##` heading, or Markdown renders it as part
  // of the package's last block — the rule `appendChangedFileRules` applies too.
  const separator = prior === "" || prior.endsWith("\n\n") ? "" : prior.endsWith("\n") ? "\n" : "\n\n";
  await Bun.write(packagePath, `${prior}${separator}${section}`);
}

export async function runBranchReview(
  fc: BranchStepContext,
  input: { seed: string; specPath?: string; preflightPath?: string; facts: BranchReviewFacts },
): Promise<ReviewOutcome<BranchReviewVerdict>> {
  const packagePath = join(fc.runDir, "package-branch.diff");
  const range = `${input.seed}..HEAD`;
  // US-009: the reviewer cannot look for the reports, so nax takes the inventory before it asks.
  const storyReports = await storyReportInventory(input.facts.stories);
  const prompt = buildWorkflowBranchReviewPrompt({
    ...(input.specPath ? { specPath: input.specPath } : {}),
    ...(fc.prdPath !== undefined ? { prdPath: fc.prdPath } : {}),
    ...(input.preflightPath ? { preflightPath: input.preflightPath } : {}),
    packagePath,
    range,
    ...input.facts,
    ...(storyReports.length > 0 ? { storyReports } : {}),
  });
  // The package writer's callback assigns this before the op runs; a throw from either step is a
  // skipped review, so the op never sees a half-built set.
  let requiredFiles: readonly string[] = [];
  const outcome = await underReviewLimit(
    fc,
    async () => {
      const paths = await writeBranchReviewPackage(fc.projectDir, input.seed, packagePath);
      requiredFiles = await reviewRequiredFiles(paths, fc);
      // US-006: the reviewer learns which rule files govern what it must read.
      await appendReviewRules(fc, packagePath, paths);
      // US-007: the run's project context, verbatim, whatever the delivery mode.
      await appendProjectContextOverride(fc, packagePath);
    },
    (signal) =>
      _workflowDeps.callOp({ ...fc.callCtx, ...(signal ? { signal } : {}) }, workflowBranchReviewOp, {
        prompt,
        timeoutMs: fc.workflow.timeouts.reviewMs,
        minorIds: input.facts.minors.map((m) => m.id),
        requiredFiles,
        repoRoot: fc.projectDir,
        range,
      }),
  );
  if (!outcome.ran) return outcome;
  const unread = unreadFiles(requiredFiles, outcome.verdict.inspectedFiles ?? [], fc.projectDir);
  // A spread, not a mutation: the verdict the op returned is also written as an artifact elsewhere.
  return unread.length > 0 ? { ran: true, verdict: { ...outcome.verdict, unreadFiles: unread } } : outcome;
}

export async function runBranchReReview(
  fc: BranchStepContext,
  input: { specPath?: string; findings: readonly WorkflowFinding[]; fixBase: string },
): Promise<ReviewOutcome<ReReviewVerdict>> {
  const packagePath = join(fc.runDir, "package-branch-fix.diff");
  const prompt = buildWorkflowBranchReReviewPrompt({
    ...(input.specPath ? { specPath: input.specPath } : {}),
    reportPath: fc.reportPath,
    packagePath,
    findings: input.findings,
  });
  const model = branchReviewModel(fc);
  const outcome = await underReviewLimit(
    fc,
    async () => {
      // US-006: the writer now returns the surviving changed paths; a re-review package
      // carries no changed-file rules section, so the result is discarded here.
      await writeReviewPackage(fc.projectDir, input.fixBase, packagePath);
    },
    (signal) =>
      _workflowDeps.callOp({ ...fc.callCtx, ...(signal ? { signal } : {}) }, workflowReReviewOp, {
        prompt,
        openIds: input.findings.map((f) => f.id),
        timeoutMs: fc.workflow.timeouts.reviewMs,
        ...(model !== undefined ? { model } : {}),
      }),
  );
  return outcome;
}
