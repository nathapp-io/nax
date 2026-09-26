/**
 * Scoped fix-review runner (US-003, ADR-033 §1).
 *
 * `runFixReview` evaluates in a fixed order and stops at the first stage that
 * decides:
 *
 *   1. `review.fixReview.enabled === false` → pass, not reviewed.
 *   2. Snapshot the working tree after the fix and list the paths changed
 *      between the pre-fix tree and it. No changed path → pass, not reviewed.
 *   3. Scope check over the changed paths → on violation, fail with cause
 *      `scope`. No LLM call.
 *   4. LLM verdict over the fix diff → pass, or fail with cause
 *      `contradiction`.
 *
 * A git failure in stage 2 or 3, a dispatch error, or an unparseable response
 * in stage 4 ends evaluation with kind `error` — there is no parse-retry.
 *
 * The story's own files are `changedPathsBetween(workdir, storyGitRef,
 * preFixTree)` when `storyGitRef` is set, else `undefined` (which makes the
 * scope check skip rather than guess). The embedded diff is
 * `truncateDiff(diffBetween(workdir, preFixTree, postTree))`. After the LLM
 * stage, parsed or not, the op output is emitted once through
 * `emitReviewDecision(ctx, "fix-review", output)`.
 */

import type { TestPatternConfig } from "@/config";
import { type CallContext, callOp, fixReviewOp } from "@/operations";
import { truncateDiff } from "@/review";
import { createTestFileClassifier, resolveTestFilePatterns } from "@/test-runners";
import { storyPackageDir } from "@/utils/path-frame";
import { checkFixScope } from "../scope";
import { changedPathsBetween, diffBetween, snapshotWorkingTree } from "../tree-snapshot";
import type { FixReviewOpOutput, FixReviewRequest, FixReviewVerdict } from "../types";

/**
 * Injectable seam — the same `_deps` pattern as `_nonBlockingFixDeps`. Each
 * member is overridable through `runFixReview`'s `deps` argument, so a unit
 * test can pin every stage without `mock.module()` and without touching git.
 */
export interface FixReviewDeps {
  callOp: typeof callOp;
  snapshotWorkingTree: typeof snapshotWorkingTree;
  changedPathsBetween: typeof changedPathsBetween;
  diffBetween: typeof diffBetween;
  /**
   * The deterministic scope check. Injectable so a unit test can pin the
   * scope-fail branch (spec US-003 AC12/AC19) without arranging real changed
   * paths for every case; production always uses `checkFixScope`.
   */
  checkFixScope: typeof checkFixScope;
  /**
   * The dispatch-events audit seam. The real implementation lives in
   * `src/execution/story-orchestrator/review-decision.ts`, which `src/review`
   * cannot reach: `noRestrictedImports` bans the `../../` form and
   * `check:alias-internals` bans the `@/execution/story-orchestrator/...` leaf.
   * The wiring layer that dispatches this runner (US-004/US-005) injects it —
   * it already imports the emitter. The default below is a no-op ONLY so the
   * module stays importable; a production caller must pass the real one.
   */
  emitReviewDecision: (ctx: CallContext, opName: string, output: unknown) => void;
  resolveTestFilePatterns: typeof resolveTestFilePatterns;
}

const DEFAULT_DEPS: FixReviewDeps = {
  callOp,
  snapshotWorkingTree,
  changedPathsBetween,
  diffBetween,
  checkFixScope,
  emitReviewDecision: () => {},
  resolveTestFilePatterns,
};

/**
 * Compute the package directory relative to the workdir. The story's `workdir`
 * field is the package dir relative to the repo root (ADR-008 / ADR-020); the
 * fix-review runs git from the package dir, but the scope check operates on
 * repo-root-relative paths, so it needs that same package dir joined onto each
 * finding's workdir-relative `file`. `storyPackageDir` collapses the missing-
 * workdir and root-workdir cases into a single `undefined` — the scope check
 * reads `undefined` as "single-package project, no join needed".
 */
function packageDirRelFromCtx(ctx: CallContext): string {
  const story = ctx.story;
  if (!story) return "";
  return storyPackageDir(story) ?? "";
}

/** Read a finding's workdir-relative `file` if present. */
function findingFile(file: unknown): string | undefined {
  if (typeof file !== "string") return undefined;
  return file;
}

export async function runFixReview(
  ctx: CallContext,
  req: FixReviewRequest,
  deps: Partial<FixReviewDeps> = {},
): Promise<FixReviewVerdict> {
  const d: FixReviewDeps = { ...DEFAULT_DEPS, ...deps };
  const logger = ctx.runtime?.logger;

  // ── Stage 1: the fixReview switch ────────────────────────────────────────
  if (req.config.fixReview?.enabled === false) {
    return { kind: "pass", reviewed: false, reason: "fixReview is disabled" };
  }

  // ── Stage 2: snapshot the post-fix tree, list the paths that changed ────
  let postTree: string;
  try {
    postTree = await d.snapshotWorkingTree(req.workdir);
  } catch (err) {
    logger?.error("fix-review", "snapshotWorkingTree failed", {
      storyId: req.story.id,
      stage: "fix-review-tree-snapshot",
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: "error", reason: `snapshot failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  let fixFiles: string[];
  try {
    fixFiles = await d.changedPathsBetween(req.workdir, req.preFixTree, postTree);
  } catch (err) {
    logger?.error("fix-review", "changedPathsBetween (fix) failed", {
      storyId: req.story.id,
      stage: "fix-review-changed-paths",
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: "error", reason: `diff failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (fixFiles.length === 0) {
    return { kind: "pass", reviewed: false, reason: "no paths changed by the fix" };
  }

  // The story's own files for the scope check: compute only when we know the
  // story's start ref (otherwise the comparison has no ground truth, and the
  // scope check will skip rather than guess).
  const storyGitRef = req.story.storyGitRef;
  let storyFiles: readonly string[] | undefined;
  if (storyGitRef !== undefined) {
    try {
      storyFiles = await d.changedPathsBetween(req.workdir, storyGitRef, req.preFixTree);
    } catch (err) {
      logger?.error("fix-review", "changedPathsBetween (story) failed", {
        storyId: req.story.id,
        stage: "fix-review-changed-paths",
        error: err instanceof Error ? err.message : String(err),
      });
      return { kind: "error", reason: `diff failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // ── Stage 3: deterministic scope check ──────────────────────────────────
  const packageDirRel = packageDirRelFromCtx(ctx);
  // Anchor on the repo root when building the classifier — the project's
  // `.nax/config.json` and its `.nax/mono/<pkg>/config.json` overrides live
  // there, and `resolveTestFilePatterns` reads them relative to its `workdir`
  // argument (`ctx.runtime.projectDir`), not the git cwd (`req.workdir`, the
  // story's package dir). Pass `undefined` for packageDir when the story is
  // rooted at the repo root (single-package project). Mirrors
  // `createMeasureSourceDiff` (`src/execution/non-blocking-fix.ts`).
  const fullConfig: TestPatternConfig = ctx.config ?? ctx.packageView.config;
  const resolved = await d.resolveTestFilePatterns(
    fullConfig,
    ctx.runtime.projectDir,
    packageDirRel === "" ? undefined : packageDirRel,
  );
  const isTestFile = createTestFileClassifier(resolved);

  const scope = d.checkFixScope({
    changedFiles: fixFiles,
    storyFiles,
    story: req.story,
    findings: req.findings.map((f) => ({ file: findingFile(f.file) })),
    packageDirRel,
    isTestFile,
  });

  if (!scope.inScope) {
    return {
      kind: "fail",
      cause: "scope",
      files: scope.outOfScopeFiles,
      reason: "fix touches files outside the story's declared scope",
    };
  }

  // ── Stage 4: LLM verdict over the embedded fix diff ─────────────────────
  let rawDiff: string;
  try {
    rawDiff = await d.diffBetween(req.workdir, req.preFixTree, postTree);
  } catch (err) {
    logger?.error("fix-review", "diffBetween failed", {
      storyId: req.story.id,
      stage: "fix-review-diff",
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: "error", reason: `diff failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const diff = truncateDiff(rawDiff);

  let output: FixReviewOpOutput;
  try {
    output = await d.callOp(ctx, fixReviewOp, { story: req.story, diff, findings: req.findings });
  } catch (err) {
    d.emitReviewDecision(ctx, "fix-review", {
      parsed: false,
      unparsedPreview: `callOp threw: ${err instanceof Error ? err.message : String(err)}`,
    });
    logger?.error("fix-review", "callOp dispatch failed", {
      storyId: req.story.id,
      stage: "fix-review-dispatch",
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: "error", reason: `dispatch failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Always emit the decision through the audit seam — parsed or not — so the
  // review-audit subscriber records every fix-review verdict exactly once.
  d.emitReviewDecision(ctx, "fix-review", output);

  if (!output.parsed) {
    return { kind: "error", reason: `unparseable fix-review response: ${output.unparsedPreview}` };
  }

  if (output.passed) {
    return { kind: "pass", reviewed: true, reason: output.reason };
  }

  // Contradiction — carry the optional acIndex and file from the verdict.
  const contradiction: {
    kind: "fail";
    cause: "contradiction";
    reason: string;
    acIndex?: number;
    file?: string;
  } = { kind: "fail", cause: "contradiction", reason: output.reason };
  if (output.acIndex !== undefined) contradiction.acIndex = output.acIndex;
  if (output.file !== undefined) contradiction.file = output.file;
  return contradiction;
}
