/**
 * PlanInputs Assembly
 *
 * Introduces PlanInputs as a typed boundary for all orchestrator slots,
 * with explicit validation to prevent hidden null propagation during
 * plan construction.
 */

import type { NaxConfig } from "../config/schema";
import { NaxError } from "../errors";
import type {
  AdversarialReviewInput,
  FullSuiteGateInput,
  GreenfieldGateInput,
  ImplementerInput,
  SemanticReviewInput,
  TestWriterInput,
  VerifierInput,
} from "../operations";
import type { UserStory } from "../prd/types";
import { TddPromptBuilder } from "../prompts";
import type { SemanticStory } from "../review/types";
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

  // Resolve once for the plan — reused by greenfieldGate and threaded into fullSuiteGate
  // so the gate doesn't re-resolve. Per ADR-009 the resolver is the SSOT.
  const resolvedTestPatterns = _isTdd ? await resolveTestFilePatterns(config, ctx.workdir) : undefined;
  const [testWriterPrompt, implementerPrompt, verifierPrompt] = _isTdd
    ? await Promise.all([
        _isFreshRun ? buildThreeSessionPrompt("test-writer", ctx, isLite) : Promise.resolve(""),
        buildThreeSessionPrompt("implementer", ctx, isLite),
        buildThreeSessionPrompt("verifier", ctx, isLite),
      ])
    : ["", ctx.prompt ?? "", ""];

  const testWriterInput =
    _isTdd && _isFreshRun
      ? {
          story,
          promptMarkdown: testWriterPrompt,
          featureContextMarkdown: ctx.featureContextMarkdown,
          constitution: ctx.constitution?.content,
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

  // Build review + rectification inputs only when inlineReview is enabled.
  // Default (false) preserves legacy behavior where review/rectify run as standalone stages.
  const inlineReviewEnabled = ctx.config.execution?.inlineReview === true;

  const semanticStory: SemanticStory = {
    id: story.id,
    title: story.title,
    description: story.description ?? "",
    acceptanceCriteria: Array.isArray(story.acceptanceCriteria) ? story.acceptanceCriteria : [],
  };

  const semanticConfig = ctx.config.review?.semantic;
  const semanticReviewInput: SemanticReviewInput | undefined =
    inlineReviewEnabled &&
    ctx.config.review?.enabled === true &&
    ctx.config.review.checks?.includes("semantic") &&
    semanticConfig !== undefined
      ? {
          workdir: ctx.workdir,
          story: semanticStory,
          semanticConfig,
          mode: semanticConfig.diffMode ?? "ref",
          storyGitRef: ctx.storyGitRef,
          blockingThreshold: ctx.config.review.blockingThreshold,
        }
      : undefined;

  const adversarialConfig = ctx.config.review?.adversarial;
  const adversarialReviewInput: AdversarialReviewInput | undefined =
    inlineReviewEnabled &&
    ctx.config.review?.enabled === true &&
    ctx.config.review.checks?.includes("adversarial") &&
    adversarialConfig !== undefined
      ? {
          story: semanticStory,
          adversarialConfig,
          mode: adversarialConfig.diffMode ?? "ref",
          storyGitRef: ctx.storyGitRef,
          blockingThreshold: ctx.config.review.blockingThreshold,
        }
      : undefined;

  const rectificationInput: RectificationPhaseOptions | undefined =
    inlineReviewEnabled && ctx.config.execution?.rectification?.enabled === true
      ? {
          maxAttempts: ctx.config.execution.rectification.maxRetries ?? 2,
          strategies: [], // base — buildPlanForStrategy prepends makeFullSuiteRectifyStrategy(story) for TDD+gate plans
          abortOnIncreasingFailures: ctx.config.execution.rectification.abortOnIncreasingFailures ?? true,
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
    semanticReview: semanticReviewInput,
    adversarialReview: adversarialReviewInput,
    rectification: rectificationInput,
  };
}
