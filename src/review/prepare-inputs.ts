/**
 * Prepare review op inputs.
 *
 * Shared collection logic that gathers stat / diff / testInventory for the
 * semantic and adversarial review ops. Called from plan-inputs.ts so the
 * orchestrator path produces the same SemanticReviewInput / AdversarialReviewInput
 * shape that the legacy runSemanticCheck / runAdversarialReview paths produce.
 *
 * Without this, the orchestrator was constructing inputs with stat/diff/testInventory
 * left undefined, causing the prompt's "## Changed Files" block to render as an
 * empty code fence and misleading the reviewer LLM into emitting a spurious
 * "diff is empty — cannot verify ACs" finding.
 */

import { relative, sep } from "node:path";
import { DEFAULT_CONFIG, reviewConfigSelector } from "../config";
import type { NaxConfig } from "../config/schema";
import type { AdversarialReviewConfig, SemanticReviewConfig } from "../review/types";
import { resolveReviewExcludePatterns, resolveTestFilePatterns } from "../test-runners";
import type { NaxIgnoreIndex } from "../utils/path-filters";
import {
  DIFF_CAP_BYTES,
  collectDiff,
  collectDiffStat,
  computeTestInventory,
  resolveEffectiveRef,
  truncateDiff,
} from "./diff-utils";
import type { TestInventory } from "./diff-utils";

export interface PrepareReviewInputArgs {
  workdir: string;
  projectDir?: string;
  storyId: string;
  storyGitRef: string | undefined;
  config: NaxConfig;
  naxIgnoreIndex?: NaxIgnoreIndex;
}

export interface PreparedSemanticReviewInput {
  /** Resolved git baseline ref to diff against. Undefined => skip review. */
  effectiveRef: string | undefined;
  /** `git diff --stat` output (file inventory + change counts). */
  stat: string;
  /** Full diff text (embedded mode only; truncated if oversize). */
  diff: string | undefined;
  /** Pathspec exclude patterns (test files etc.) used to build diff. */
  excludePatterns: string[];
  /** When set, callers should skip the review and report this reason. */
  skipReason?: string;
}

export interface PreparedAdversarialReviewInput {
  effectiveRef: string | undefined;
  stat: string;
  diff: string | undefined;
  testInventory: TestInventory | undefined;
  excludePatterns: string[];
  /** Test-file globs surfaced for the adversarial test-gap audit prompt. */
  testGlobs: readonly string[];
  /** Pathspec excludes for production-only diff command in the prompt. */
  refExcludePatterns: readonly string[];
  skipReason?: string;
}

function derivePackageDirs(
  workdir: string,
  projectDir: string | undefined,
): {
  repoRoot: string;
  packageDir: string | undefined;
  packageDirRelative: string | undefined;
} {
  const repoRoot = projectDir ?? workdir;
  const packageDir = workdir !== repoRoot ? workdir : undefined;
  let packageDirRelative: string | undefined;
  if (projectDir && workdir !== projectDir) {
    const rel = relative(projectDir, workdir);
    if (rel !== ".." && !rel.startsWith(`..${sep}`)) {
      packageDirRelative = rel && rel !== "." ? rel : undefined;
    }
  }
  return { repoRoot, packageDir, packageDirRelative };
}

/**
 * Collect stat/diff for semantic review.
 *
 * - Always collects `stat` (file inventory rendered in both modes).
 * - Collects `diff` only when `semanticConfig.diffMode === "embedded"`.
 * - Returns `skipReason` when stat is empty (no changes) so the caller can
 *   short-circuit and avoid spawning the reviewer for a no-op.
 */
export async function prepareSemanticReviewInput(
  args: PrepareReviewInputArgs & { semanticConfig: SemanticReviewConfig },
): Promise<PreparedSemanticReviewInput> {
  const { workdir, projectDir, storyId, storyGitRef, config, naxIgnoreIndex, semanticConfig } = args;

  const effectiveRef = await resolveEffectiveRef(workdir, storyGitRef, storyId);
  if (!effectiveRef) {
    return {
      effectiveRef: undefined,
      stat: "",
      diff: undefined,
      excludePatterns: [],
      skipReason: "no git ref",
    };
  }

  const { packageDir, packageDirRelative } = derivePackageDirs(workdir, projectDir);
  const stat = await collectDiffStat(workdir, effectiveRef, { naxIgnoreIndex, packageDir });

  const resolved = await resolveTestFilePatterns(
    config ?? reviewConfigSelector.select(DEFAULT_CONFIG),
    projectDir ?? workdir,
    packageDirRelative,
  );
  const excludePatterns = [...resolveReviewExcludePatterns(semanticConfig.excludePatterns, resolved)];

  const diffMode = semanticConfig.diffMode ?? "ref";

  if (diffMode === "ref") {
    if (!stat) {
      return { effectiveRef, stat: "", diff: undefined, excludePatterns, skipReason: "no changes detected" };
    }
    return { effectiveRef, stat, diff: undefined, excludePatterns };
  }

  const rawDiff = await collectDiff(workdir, effectiveRef, excludePatterns, { naxIgnoreIndex, packageDir });
  const diff = truncateDiff(rawDiff, rawDiff.length > DIFF_CAP_BYTES ? stat : undefined);
  if (!diff) {
    return { effectiveRef, stat, diff: undefined, excludePatterns, skipReason: "no production code changes" };
  }
  return { effectiveRef, stat, diff, excludePatterns };
}

/**
 * Collect stat/diff/testInventory for adversarial review.
 *
 * - Always collects `stat`.
 * - In `embedded` mode: collects full diff (test files included — adversarial
 *   sees everything) + precomputed TestInventory for the test-gap audit.
 * - In `ref` mode: testInventory is left undefined; the reviewer self-serves
 *   the file list via the diff command in the prompt.
 */
export async function prepareAdversarialReviewInput(
  args: PrepareReviewInputArgs & { adversarialConfig: AdversarialReviewConfig },
): Promise<PreparedAdversarialReviewInput> {
  const { workdir, projectDir, storyId, storyGitRef, config, naxIgnoreIndex, adversarialConfig } = args;

  const effectiveRef = await resolveEffectiveRef(workdir, storyGitRef, storyId);
  if (!effectiveRef) {
    return {
      effectiveRef: undefined,
      stat: "",
      diff: undefined,
      testInventory: undefined,
      excludePatterns: [],
      testGlobs: [],
      refExcludePatterns: [],
      skipReason: "no git ref",
    };
  }

  const { packageDir, packageDirRelative } = derivePackageDirs(workdir, projectDir);
  const stat = await collectDiffStat(workdir, effectiveRef, { naxIgnoreIndex, packageDir });

  const diffMode = adversarialConfig.diffMode ?? "ref";

  // Parity with legacy adversarial.ts:169 — return on !stat (ref mode) BEFORE
  // resolving test patterns. Avoids a wasted filesystem scan when there are no changes.
  if (diffMode === "ref" && !stat) {
    return {
      effectiveRef,
      stat: "",
      diff: undefined,
      testInventory: undefined,
      excludePatterns: [],
      testGlobs: [],
      refExcludePatterns: [],
      skipReason: "no changes detected",
    };
  }

  const effectiveConfig = config ?? reviewConfigSelector.select(DEFAULT_CONFIG);
  const resolved = await resolveTestFilePatterns(effectiveConfig, projectDir ?? workdir, packageDirRelative);
  const refExcludePatterns = [...resolveReviewExcludePatterns(adversarialConfig.excludePatterns, resolved)];
  const testGlobs = resolved.globs ?? [];
  const excludePatterns: string[] = [...(adversarialConfig.excludePatterns ?? [])];

  const testFilePatterns =
    (typeof config?.execution?.smartTestRunner === "object"
      ? config.execution.smartTestRunner?.testFilePatterns
      : undefined) ?? undefined;

  if (diffMode === "ref") {
    // !stat case handled above; surviving branch always has stat
    return {
      effectiveRef,
      stat,
      diff: undefined,
      testInventory: undefined,
      excludePatterns,
      testGlobs,
      refExcludePatterns,
    };
  }

  // embedded mode
  const diff = await collectDiff(workdir, effectiveRef, excludePatterns, { naxIgnoreIndex, packageDir });
  if (!diff) {
    return {
      effectiveRef,
      stat,
      diff: undefined,
      testInventory: undefined,
      excludePatterns,
      testGlobs,
      refExcludePatterns,
      skipReason: "no code changes",
    };
  }
  const testInventory = await computeTestInventory(workdir, effectiveRef, testFilePatterns, {
    naxIgnoreIndex,
    packageDir,
  });
  return { effectiveRef, stat, diff, testInventory, excludePatterns, testGlobs, refExcludePatterns };
}
