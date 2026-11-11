/**
 * The whole-branch review (spec §7 step 2) and its scoped re-review (step 4). Never throw except on abort.
 *
 * US-008: the branch review is **sliced** — the package and its required set are built once, then each
 * slice runs as its own fresh session under its own review timeout, and one merged verdict comes back.
 * A branch of 58 changed files is more than one review session takes on.
 */
import { join } from "node:path";
import { buildLedgerSessionName, errorMessage } from "@nathapp/nax-agent/internal";
import { type ConfiguredModel, WORKFLOW_REVIEW_DEFAULTS } from "@/config";
// The audit dir SSOT — the same helper the dispatch writes through (nested barrel, exact alias).
import { toolAuditDir } from "@/config/paths";
import { getLogger } from "@/logger";
import { unreadFiles, workflowBranchReviewOp, workflowReReviewOp } from "@/operations";
import {
  type BranchReviewPromptInput,
  buildProjectContextSection,
  buildWorkflowBranchReReviewPrompt,
  buildWorkflowBranchReviewPrompt,
} from "@/prompts";
import { mergeSliceVerdicts, planReviewSlices, type SliceResult } from "./branch-review-slices";
import type { BranchStepContext } from "./branch-step-context";
import { writeBranchReviewPackage, writeReviewPackage } from "./git";
import { workflowStoryDir } from "./paths";
import { reviewRequiredFiles } from "./review-coverage";
import { readSessionToolCalls, toolReadPaths } from "./review-tool-reads";
import { _workflowDeps } from "./step-context";
import { type ReviewOutcome, reviewPackageFailure, underReviewLimit } from "./story-review";
import type { BranchReviewVerdict, ReReviewVerdict, WorkflowFinding } from "./types";

/** US-006 (nax#2527): `repoGates` is the repo-gate summary the branch reviewer is told about. */
export type BranchReviewFacts = Pick<
  BranchReviewPromptInput,
  "stories" | "minors" | "parked" | "cannotVerify" | "gateFindings" | "repoGates"
>;

/** The type `runBranchReview` inventories: each listed story's report and whether it is on disk. */
type StoryReport = NonNullable<BranchReviewPromptInput["storyReports"]>[number];

/**
 * US-008: the two steps `runBranchReview` owns before any slice runs — writing the package and
 * classifying its changed paths into the required set. A `_deps` seam rather than a second copy of
 * each: the classifier widens the required set on a resolver failure instead of throwing, so a test
 * can only drive its failure path through here.
 */
export const _branchReviewDeps: {
  writeBranchReviewPackage: typeof writeBranchReviewPackage;
  reviewRequiredFiles: typeof reviewRequiredFiles;
} = { writeBranchReviewPackage, reviewRequiredFiles };

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

/** Everything `runBranchReview` takes: the seed the branch range starts at, its documents and facts. */
export interface BranchReviewInput {
  readonly seed: string;
  readonly specPath?: string;
  readonly preflightPath?: string;
  readonly facts: BranchReviewFacts;
}

/**
 * The prompt every slice shares: the run's documents, facts, story-report inventory and memory index.
 * A slice adds its own `requiredFiles` (and, when the review is sliced, its slice line) on top.
 */
async function branchPromptBase(
  fc: BranchStepContext,
  input: BranchReviewInput,
  paths: { readonly packagePath: string; readonly range: string },
): Promise<BranchReviewPromptInput> {
  // US-009: the reviewer cannot look for the reports, so nax takes the inventory before it asks.
  const storyReports = await storyReportInventory(input.facts.stories);
  // US-007: read once, before the prompt is built. The branch reviewer has no memory tools, so the
  // index reaches it as the read-only reference section; a run without memory gets none.
  const memoryIndex = await fc.callCtx.runtime.memory?.index();
  return {
    ...(input.specPath ? { specPath: input.specPath } : {}),
    ...(fc.prdPath !== undefined ? { prdPath: fc.prdPath } : {}),
    ...(input.preflightPath ? { preflightPath: input.preflightPath } : {}),
    ...(memoryIndex !== undefined ? { memoryIndex } : {}),
    packagePath: paths.packagePath,
    range: paths.range,
    ...input.facts,
    ...(storyReports.length > 0 ? { storyReports } : {}),
  };
}

/**
 * US-008 step 1: the package, the required set and the two appends, once for the whole review.
 *
 * Returns the skipped-review reason when the package could not be built — `reviewPackageFailure`
 * gives a throw here exactly the semantics `underReviewLimit` gives a package failure — else the
 * required files every slice is planned from.
 */
async function prepareBranchPackage(
  fc: BranchStepContext,
  input: BranchReviewInput,
  packagePath: string,
): Promise<{ readonly requiredFiles: readonly string[] } | { readonly why: string }> {
  let requiredFiles: readonly string[] = [];
  const failed = await reviewPackageFailure(fc, async () => {
    const paths = await _branchReviewDeps.writeBranchReviewPackage(fc.projectDir, input.seed, packagePath);
    requiredFiles = await _branchReviewDeps.reviewRequiredFiles(paths, fc);
    // US-006: the reviewer learns which rule files govern what it must read.
    await appendReviewRules(fc, packagePath, paths);
    // US-007: the run's project context, verbatim, whatever the delivery mode.
    await appendProjectContextOverride(fc, packagePath);
  });
  return failed === null ? { requiredFiles } : { why: failed };
}

/**
 * US-008 step 3: one slice's dispatch. Its own fresh `wf-branch-review` session, its own review
 * timeout, and the prompt the whole review shares plus this slice's files and slice line.
 */
interface SliceRun {
  /** The prompt every slice shares, before this slice's own `requiredFiles` are added. */
  readonly base: BranchReviewPromptInput;
  readonly range: string;
  readonly slice: readonly string[];
  readonly index: number;
  readonly total: number;
  /** How many files the whole review must inspect, so the slice line can count the other ones. */
  readonly requiredCount: number;
  readonly minorIds: readonly string[];
  readonly coverageRetries: number;
}

function runSlice(fc: BranchStepContext, run: SliceRun): Promise<ReviewOutcome<BranchReviewVerdict>> {
  const { base, range, slice, index, total, requiredCount, minorIds, coverageRetries } = run;
  return underReviewLimit(
    fc,
    // The package is on disk already: writing it once is what makes the slices one review.
    async () => {},
    (signal) =>
      _workflowDeps.callOp({ ...fc.callCtx, ...(signal ? { signal } : {}) }, workflowBranchReviewOp, {
        prompt: buildWorkflowBranchReviewPrompt({
          ...base,
          requiredFiles: slice,
          // Absent on a one-slice review, so that prompt is byte-for-byte what it was.
          ...(total > 1 ? { slice: { index: index + 1, count: total, otherFiles: requiredCount - slice.length } } : {}),
        }),
        timeoutMs: fc.workflow.timeouts.reviewMs,
        minorIds,
        requiredFiles: slice,
        repoRoot: fc.projectDir,
        range,
        coverageRetries,
      }),
  );
}

/**
 * US-009: the files this run's branch-review session showed the model in full, from the tool audit
 * its dispatch wrote. Read AFTER the last slice, because the audit file is flushed when the hop
 * ends — so observed reads reduce the final unread list and never feed a slice's own coverage retry.
 *
 * Two guards, both from the branch review's two homes. Outside a run (`nax bot review`) there is no
 * `runId` to match files on and no `outputDir` to look under, so there is nothing to read. A session
 * that wrote no audit file — or a directory that is not there — yields no reads; that is the
 * common case for a first review, not an error.
 */
async function observedToolReads(fc: BranchStepContext, sinceMs: number): Promise<string[]> {
  if (fc.runId === undefined || fc.outputDir === undefined) return [];
  const calls = await readSessionToolCalls({
    auditDir: toolAuditDir({ root: fc.projectDir, outputDir: fc.outputDir }, fc.feature),
    runId: fc.runId,
    // The role comes off the op itself, so a reader cannot name a session the dispatch never wrote.
    ledgerSessionName: buildLedgerSessionName({
      featureName: fc.feature,
      sessionRole: workflowBranchReviewOp.session.role,
    }),
    sinceMs,
  });
  return toolReadPaths(calls, fc.projectDir);
}

/** Everything `mergeBranchReview` reads: the slices, the required set, and the audit's credit. */
interface BranchReviewMerge {
  readonly results: readonly SliceResult[];
  readonly requiredFiles: readonly string[];
  readonly projectDir: string;
  /** US-009: repo-relative files the session's own tool calls showed in full. */
  readonly toolReads: readonly string[];
}

/**
 * US-008 steps 5-7 + US-009 step 6: one verdict from the slices, the unread set against the whole
 * required list (self-reported inspection plus tool-observed reads), and `slices` only when the
 * review really was sliced (the merge keeps a lone verdict untouched).
 */
function mergeBranchReview(input: BranchReviewMerge): ReviewOutcome<BranchReviewVerdict> {
  const { results, requiredFiles, projectDir, toolReads } = input;
  const merged = mergeSliceVerdicts(results);
  if (merged === null) return { ran: false, why: results.at(0)?.why ?? "unparseable reply" };
  // `?? []` is mandatory: a verdict need not carry `inspectedFiles`, and it must not gain one here —
  // which is also why the observed reads are appended to a NEW list rather than onto the verdict.
  const inspected = [...(merged.inspectedFiles ?? []), ...toolReads];
  const unread = unreadFiles(requiredFiles, inspected, projectDir);
  // A spread, not a mutation: the verdict the op returned is also written as an artifact elsewhere.
  return unread.length > 0
    ? { ran: true, verdict: { ...merged, unreadFiles: unread } }
    : { ran: true, verdict: merged };
}

export async function runBranchReview(
  fc: BranchStepContext,
  input: BranchReviewInput,
): Promise<ReviewOutcome<BranchReviewVerdict>> {
  const packagePath = join(fc.runDir, "package-branch.diff");
  const range = `${input.seed}..HEAD`;
  const review = fc.workflow.review ?? WORKFLOW_REVIEW_DEFAULTS;
  const base = await branchPromptBase(fc, input, { packagePath, range });
  const prepared = await prepareBranchPackage(fc, input, packagePath);
  if ("why" in prepared) return { ran: false, why: prepared.why };
  const slices = planReviewSlices(prepared.requiredFiles, review.sliceFiles);
  const minorIds = input.facts.minors.map((m) => m.id);
  // US-009 step 4: taken BEFORE slice 1, so the read below covers this review and nothing else.
  const startedAt = _workflowDeps.now();
  const results: SliceResult[] = [];
  for (const [index, slice] of slices.entries()) {
    // A slice that does not run is recorded and the next one still runs; an abort is rethrown by
    // `underReviewLimit` and stops the loop.
    const outcome = await runSlice(fc, {
      base,
      range,
      slice,
      index,
      total: slices.length,
      requiredCount: prepared.requiredFiles.length,
      minorIds,
      coverageRetries: review.coverageRetries,
    });
    results.push(
      outcome.ran ? { files: slice, verdict: outcome.verdict } : { files: slice, verdict: null, why: outcome.why },
    );
  }
  // After the last slice: the session's own ledger is flushed by now, so the reads it observed can
  // only ever shorten the final unread list.
  const toolReads = await observedToolReads(fc, startedAt);
  return mergeBranchReview({
    results,
    requiredFiles: prepared.requiredFiles,
    projectDir: fc.projectDir,
    toolReads,
  });
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
