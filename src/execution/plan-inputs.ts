/**
 * PlanInputs Assembly
 *
 * Introduces PlanInputs as a typed boundary for all orchestrator slots,
 * with explicit validation to prevent hidden null propagation during
 * plan construction.
 */

import { relative, sep } from "node:path";
import type { NaxConfig } from "../config/schema";
import { filterContextByRole } from "../context";
import { NaxError } from "../errors";
import type {
  AdversarialReviewInput,
  FullSuiteGateInput,
  GreenfieldGateInput,
  ImplementerInput,
  LintCheckInput,
  SemanticReviewInput,
  TestWriterInput,
  TypecheckCheckInput,
  VerifierInput,
  VerifyScopedInput,
} from "../operations";
import type { UserStory } from "../prd/types";
import { TddPromptBuilder } from "../prompts";
import { prepareAdversarialReviewInput, prepareSemanticReviewInput } from "../review";
import type { ResolvedTestPatterns } from "../test-runners";
import { resolveTestFilePatterns } from "../test-runners/resolver";
import { isThreeSessionStrategy } from "./build-plan-for-strategy";
import type { RectificationPhaseOptions } from "./story-orchestrator";

/**
 * PlanInputs contains the typed boundary for all orchestrator slots.
 * Assembled by assemblePlanInputs with explicit validation.
 *
 * AC1: Includes testWriter, greenfieldGate, implementer, fullSuiteGate,
 * verifier, semanticReview, adversarialReview, and optionally rectification.
 */
export interface PlanInputs {
  readonly story: UserStory;
  readonly config: NaxConfig;
  /** Resolved test file patterns — present when the caller explicitly provided them. */
  readonly resolvedTestPatterns?: ResolvedTestPatterns;
  readonly testWriter?: TestWriterInput;
  readonly greenfieldGate?: GreenfieldGateInput;
  readonly implementer?: ImplementerInput;
  readonly fullSuiteGate?: FullSuiteGateInput;
  readonly verifier?: VerifierInput;
  readonly verifyScoped?: VerifyScopedInput;
  readonly lintCheck?: LintCheckInput;
  readonly typecheckCheck?: TypecheckCheckInput;
  readonly semanticReview?: SemanticReviewInput;
  readonly adversarialReview?: AdversarialReviewInput;
  readonly rectification?: RectificationPhaseOptions;
}

/**
 * Validate story and config fields required by every plan, regardless of strategy.
 *
 * @throws NaxError with code 'STORY_ID_INVALID' if story.id is missing or blank
 * @throws NaxError with code 'STORY_TITLE_MISSING' if story.title is missing or blank
 * @throws NaxError with code 'CONFIG_INVALID' if config.agent.default is empty
 * @throws NaxError with code 'CONFIG_INVALID' if config.models has no tier mapping for the default agent
 */
export function validatePlanInputs(story: UserStory, config: NaxConfig): void {
  if (!story.id || story.id.trim() === "") {
    throw new NaxError("Story ID is required and must be non-empty", "STORY_ID_INVALID", {
      stage: "execution-inputs",
      storyId: story.id,
    });
  }

  if (!story.title || story.title.trim() === "") {
    throw new NaxError("Story title is required and must be non-empty", "STORY_TITLE_MISSING", {
      stage: "execution-inputs",
      storyId: story.id,
    });
  }

  if (!config.agent?.default) {
    throw new NaxError("Configuration error: agent.default is required", "CONFIG_INVALID", {
      stage: "execution-inputs",
      storyId: story.id,
      field: "agent.default",
    });
  }

  const agentName = config.agent.default;
  if (!config.models?.[agentName] || Object.keys(config.models[agentName]).length === 0) {
    throw new NaxError(
      `Configuration error: no model tier mappings defined for agent "${agentName}" — slot input derivation requires at least one tier mapping`,
      "CONFIG_INVALID",
      {
        stage: "execution-inputs",
        storyId: story.id,
        field: "models",
      },
    );
  }
}

/**
 * Maps the full regressionGate.mode union to the two-value subset accepted by VerifyScopedInput.
 *
 * "disabled" maps to "deferred" because verifyScopedOp doesn't need a separate disabled path:
 * when mode is "disabled", fullSuiteGateOp is never added to the plan (handled in
 * build-plan-for-strategy.ts), so verifyScopedOp's deferred skip — "no mapped tests → SKIPPED" —
 * is already the correct no-op behavior for scope-level verification.
 */
function toVerifyScopedMode(
  mode: "deferred" | "per-story" | "disabled" | undefined,
): "deferred" | "per-story" {
  if (mode === "per-story") return "per-story";
  return "deferred"; // "deferred", "disabled", and undefined all produce deferred behavior
}

export function assemblePlanInputs(
  story: UserStory,
  config: NaxConfig,
  resolvedTestPatterns?: ResolvedTestPatterns | null,
): PlanInputs {
  validatePlanInputs(story, config);

  // AC3: explicit null signals that patterns were required but could not be resolved.
  // Failing here with a structured error prevents null propagation into test-slot inputs.
  if (resolvedTestPatterns === null) {
    throw new NaxError(
      "Resolved test patterns are required but missing — test slot inputs cannot be derived without them",
      "TEST_PATTERNS_MISSING",
      {
        stage: "execution-inputs",
        storyId: story.id,
        field: "resolvedTestPatterns",
      },
    );
  }

  return {
    story,
    config,
    ...(resolvedTestPatterns !== undefined ? { resolvedTestPatterns } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline-context overload
// ─────────────────────────────────────────────────────────────────────────────

function hasReviewEscalation(story: UserStory): boolean {
  return (story.priorFailures ?? []).some((f: { stage?: string }) => f.stage === "review");
}

async function buildThreeSessionPrompt(
  role: "test-writer" | "implementer" | "verifier",
  ctx: import("../pipeline/types").PipelineContext,
  lite: boolean,
): Promise<string> {
  return TddPromptBuilder.buildForRole(role, ctx.workdir, ctx.config, ctx.story, {
    lite,
    contextMarkdown: ctx.contextMarkdown,
    featureContextMarkdown: ctx.featureContextMarkdown,
    contextBundle: ctx.contextBundle,
    constitution: ctx.constitution?.content,
  });
}

function buildFeatureCtxBlock(
  ctx: import("../pipeline/types").PipelineContext,
  role: "reviewer-semantic" | "reviewer-adversarial",
): string | undefined {
  const bundleMarkdown = ctx.contextBundle?.pushMarkdown.trim();
  if (bundleMarkdown) {
    return `${bundleMarkdown}\n\n---\n\n`;
  }

  const featureMarkdown = ctx.featureContextMarkdown?.trim();
  if (!featureMarkdown) {
    return undefined;
  }

  const filtered = filterContextByRole(featureMarkdown, role).trim();
  return filtered ? `${filtered}\n\n---\n\n` : undefined;
}

/**
 * Assemble typed PlanInputs from the current pipeline context.
 * Populates all slots eligible for the given strategy + run phase.
 *
 * Use this from pipeline stages; use assemblePlanInputs() for
 * simple story+config assembly without context.
 */
export async function assemblePlanInputsFromCtx(ctx: import("../pipeline/types").PipelineContext): Promise<PlanInputs> {
  const { story, config } = ctx;
  validatePlanInputs(story, config);
  const _isTdd = isThreeSessionStrategy(ctx.routing.testStrategy);
  const _isFreshRun = (story.attempts ?? 0) === 0 && !hasReviewEscalation(story);
  const isLite = ctx.routing.testStrategy === "three-session-tdd-lite";

  // Non-TDD strategies feed ctx.prompt (built by promptStage) into implementerInput.
  // TDD strategies build per-role prompts internally below, so promptStage is skipped
  // for them. Validate here — this is the single site that knows which strategies
  // depend on ctx.prompt — so executionStage doesn't need a leaky "prompt-missing"
  // guard that duplicates the predicate.
  if (!_isTdd && !ctx.prompt?.trim()) {
    throw new NaxError(
      `Prompt missing for strategy "${ctx.routing.testStrategy}" — non-TDD strategies require ctx.prompt`,
      "PROMPT_NOT_BUILT",
      { stage: "plan-inputs", storyId: story.id, testStrategy: ctx.routing.testStrategy },
    );
  }

  // AC#4 (#1120) + ADR-009: resolve once per plan — shared by TDD gates AND review helpers.
  // Always resolves (not gated on _isTdd) so review helpers get patterns even on non-TDD plans.
  // Using projectDir as root (with packageDirRelative for monorepos) is the SSOT per ADR-009.
  const packageDirRelative = (() => {
    if (ctx.workdir === ctx.projectDir) return undefined;
    const rel = relative(ctx.projectDir, ctx.workdir);
    if (rel === ".." || rel.startsWith(`..${sep}`)) return undefined;
    return rel && rel !== "." ? rel : undefined;
  })();
  const resolvedTestPatterns = await resolveTestFilePatterns(config, ctx.projectDir, packageDirRelative);
  const [testWriterPrompt, implementerPrompt, verifierPrompt] = _isTdd
    ? await Promise.all([
        _isFreshRun ? buildThreeSessionPrompt("test-writer", ctx, isLite) : Promise.resolve(""),
        buildThreeSessionPrompt("implementer", ctx, isLite),
        buildThreeSessionPrompt("verifier", ctx, isLite),
      ])
    : ["", ctx.prompt as string, ""];

  const testWriterInput =
    _isTdd && _isFreshRun
      ? {
          story,
          promptMarkdown: testWriterPrompt,
          featureContextMarkdown: ctx.featureContextMarkdown,
          constitution: ctx.constitution?.content,
          lite: isLite,
        }
      : undefined;

  const greenfieldGateInput: PlanInputs["greenfieldGate"] =
    _isTdd && _isFreshRun && resolvedTestPatterns ? { story, workdir: ctx.workdir, resolvedTestPatterns } : undefined;

  const implementerInput = {
    story,
    promptMarkdown: implementerPrompt,
    featureContextMarkdown: ctx.featureContextMarkdown,
    constitution: ctx.constitution?.content,
  };

  const fullSuiteGateInput = _isTdd
    ? {
        story,
        workdir: ctx.workdir,
        featureName: ctx.prd.feature,
        projectDir: ctx.projectDir,
        resolvedTestPatterns,
      }
    : undefined;

  const verifierInput = _isTdd ? { story, promptMarkdown: verifierPrompt } : undefined;

  // verifyScoped: present for non-TDD strategies (TDD uses fullSuiteGate + verifier instead)
  const verifyScopedInput: VerifyScopedInput | undefined = !_isTdd
    ? {
        workdir: ctx.workdir,
        storyId: story.id,
        storyGitRef: ctx.storyGitRef,
        naxIgnoreIndex: ctx.naxIgnoreIndex,
        // "disabled" mode means the regression gate is fully off; treat as "deferred" for
        // verifyScopedOp (scope-level behavior unchanged — fullSuiteGateOp handles enabled=false).
        regressionMode: toVerifyScopedMode(ctx.config.execution?.regressionGate?.mode),
      }
    : undefined;

  // lintCheck: gated by review.checks includes "lint" and a lint command is configured
  const lintCheckInput: LintCheckInput | undefined =
    ctx.config.review?.enabled === true &&
    ctx.config.review.checks?.includes("lint") &&
    ctx.config.quality.commands.lint
      ? { workdir: ctx.workdir, storyId: story.id }
      : undefined;

  // typecheckCheck: gated by review.checks includes "typecheck" and a typecheck command is configured
  const typecheckCheckInput: TypecheckCheckInput | undefined =
    ctx.config.review?.enabled === true &&
    ctx.config.review.checks?.includes("typecheck") &&
    ctx.config.quality.commands.typecheck
      ? { workdir: ctx.workdir, storyId: story.id }
      : undefined;

  // Semantic and adversarial review inputs must carry stat/diff (and for adversarial,
  // testInventory) so the prompt's "## Changed Files" block is populated. The legacy
  // runSemanticCheck / runAdversarialReview paths collected these before calling callOp;
  // the orchestrator path must do the same or the reviewer LLM falsely concludes
  // "diff is empty" and skips every AC. prepareSemanticReviewInput / prepareAdversarialReviewInput
  // are the shared SSOT for that collection.

  const semanticEnabled =
    ctx.config.review?.enabled === true &&
    ctx.config.review.checks?.includes("semantic") &&
    !!ctx.config.review.semantic;
  const semanticReviewInput: SemanticReviewInput | undefined = semanticEnabled
    ? await (async (): Promise<SemanticReviewInput | undefined> => {
        const prepared = await prepareSemanticReviewInput({
          workdir: ctx.workdir,
          projectDir: ctx.projectDir,
          storyId: story.id,
          storyGitRef: ctx.storyGitRef,
          config: ctx.config,
          naxIgnoreIndex: ctx.naxIgnoreIndex,
          resolvedTestPatterns,
          // biome-ignore lint/style/noNonNullAssertion: semanticEnabled guards presence
          semanticConfig: ctx.config.review!.semantic!,
        });
        // Skip slot entirely when stat is empty / no ref — orchestrator will see no
        // semantic-review phase and mark the check as not-applicable.
        if (prepared.skipReason) return undefined;
        return {
          workdir: ctx.workdir,
          story,
          // biome-ignore lint/style/noNonNullAssertion: semanticEnabled guards presence
          semanticConfig: ctx.config.review!.semantic!,
          // biome-ignore lint/style/noNonNullAssertion: semanticEnabled guards presence
          mode: ctx.config.review!.semantic!.diffMode,
          storyGitRef: prepared.effectiveRef,
          stat: prepared.stat,
          diff: prepared.diff,
          excludePatterns: prepared.excludePatterns,
          featureCtxBlock: buildFeatureCtxBlock(ctx, "reviewer-semantic"),
          priorSemanticIterations: ctx.priorSemanticIterations,
          // biome-ignore lint/style/noNonNullAssertion: semanticEnabled guards presence
          blockingThreshold: ctx.config.review!.blockingThreshold,
        };
      })()
    : undefined;

  const adversarialEnabled =
    ctx.config.review?.enabled === true &&
    ctx.config.review.checks?.includes("adversarial") &&
    !!ctx.config.review.adversarial;
  const adversarialReviewInput: AdversarialReviewInput | undefined = adversarialEnabled
    ? await (async (): Promise<AdversarialReviewInput | undefined> => {
        const prepared = await prepareAdversarialReviewInput({
          workdir: ctx.workdir,
          projectDir: ctx.projectDir,
          storyId: story.id,
          storyGitRef: ctx.storyGitRef,
          config: ctx.config,
          naxIgnoreIndex: ctx.naxIgnoreIndex,
          resolvedTestPatterns,
          // biome-ignore lint/style/noNonNullAssertion: adversarialEnabled guards presence
          adversarialConfig: ctx.config.review!.adversarial!,
        });
        if (prepared.skipReason) return undefined;
        return {
          workdir: ctx.workdir,
          story,
          // biome-ignore lint/style/noNonNullAssertion: adversarialEnabled guards presence
          adversarialConfig: ctx.config.review!.adversarial!,
          // biome-ignore lint/style/noNonNullAssertion: adversarialEnabled guards presence
          mode: ctx.config.review!.adversarial!.diffMode,
          storyGitRef: prepared.effectiveRef,
          stat: prepared.stat,
          diff: prepared.diff,
          testInventory: prepared.testInventory,
          excludePatterns: prepared.excludePatterns,
          testGlobs: prepared.testGlobs,
          refExcludePatterns: prepared.refExcludePatterns,
          featureCtxBlock: buildFeatureCtxBlock(ctx, "reviewer-adversarial"),
          priorAdversarialIterations: ctx.priorAdversarialIterations,
          // biome-ignore lint/style/noNonNullAssertion: adversarialEnabled guards presence
          blockingThreshold: ctx.config.review!.blockingThreshold,
        };
      })()
    : undefined;

  const rectificationInput: RectificationPhaseOptions | undefined =
    ctx.config.execution?.rectification?.enabled === true
      ? {
          maxAttempts: ctx.config.execution.rectification.maxAttemptsTotal,
          strategies: [], // base — buildPlanForStrategy prepends makeFullSuiteRectifyStrategy(story) for TDD+gate plans
          abortOnIncreasingFailures: ctx.config.execution.rectification.abortOnIncreasingFailures,
        }
      : undefined;

  return {
    story,
    config,
    testWriter: testWriterInput,
    greenfieldGate: greenfieldGateInput,
    implementer: implementerInput,
    fullSuiteGate: fullSuiteGateInput,
    verifier: verifierInput,
    verifyScoped: verifyScopedInput,
    lintCheck: lintCheckInput,
    typecheckCheck: typecheckCheckInput,
    semanticReview: semanticReviewInput,
    adversarialReview: adversarialReviewInput,
    rectification: rectificationInput,
  };
}
