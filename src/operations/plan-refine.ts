import { makeParseRetryStrategy } from "../agents/retry";
import { planConfigSelector } from "../config";
import type { ProjectProfile } from "../config/runtime-types";
import type { PlanConfig } from "../config/selectors";
import { NaxError } from "../errors";
import { findMissingVerbatimAcs } from "../prd";
import { validatePlanOutput } from "../prd/schema";
import type { PRD } from "../prd/types";
import type { UserStory } from "../prd/types";
import { PlanPromptBuilder } from "../prompts";
import type { PackageSummary } from "../prompts";
import type { SessionRole } from "../session/types";
import type { RunOperation } from "./types";

/** Injectable I/O for the hopBody self-heal step (testable without disk). */
export const _planRefineDeps = {
  readFile: async (path: string): Promise<string | null> => {
    try {
      return await Bun.file(path).text();
    } catch {
      return null;
    }
  },
};

export interface PlanRefineInput {
  specContent: string;
  codebaseContext: string;
  featureName: string;
  branchName: string;
  outputPath: string;
  packages?: string[];
  packageDetails?: PackageSummary[];
  projectProfile?: ProjectProfile;
}

const NEGATIVE_PATH_TOKENS = [
  "error",
  "fail",
  "invalid",
  "malformed",
  "missing",
  "non-existent",
  "nonexistent",
  "not found",
  "without",
  "unknown",
  "reject",
  "raises",
  "exception",
  "stderr",
  "exit_code == 2",
  "exit code 2",
  "exit_code == 1",
  "exit code 1",
];

function hasToken(text: string, tokens: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return tokens.some((token) => lower.includes(token));
}

function validateRefinedStory(story: UserStory): void {
  if (!story.acceptanceCriteria.some((ac) => hasToken(ac, NEGATIVE_PATH_TOKENS))) {
    throw new NaxError(
      `[plan-refine verify] ${story.id} is missing a negative-path acceptance criterion`,
      "PLAN_REFINE_VERIFY_MISSING_NEGATIVE_PATH",
      { stage: "plan", storyId: story.id },
    );
  }

  const deps = story.dependencies ?? [];
  if (new Set(deps).size !== deps.length) {
    throw new NaxError(
      `[plan-refine verify] ${story.id} has duplicate dependencies`,
      "PLAN_REFINE_VERIFY_DUPLICATE_DEPENDENCY",
      { stage: "plan", storyId: story.id },
    );
  }
  if (deps.includes(story.id)) {
    throw new NaxError(
      `[plan-refine verify] ${story.id} cannot depend on itself`,
      "PLAN_REFINE_VERIFY_SELF_DEPENDENCY",
      { stage: "plan", storyId: story.id },
    );
  }

  const contextFiles = story.contextFiles ?? [];
  if (contextFiles.length > 5) {
    throw new NaxError(
      `[plan-refine verify] ${story.id} has ${contextFiles.length} contextFiles; maximum is 5`,
      "PLAN_REFINE_VERIFY_CONTEXT_FILES_LIMIT",
      { stage: "plan", storyId: story.id },
    );
  }
  const normalizedContextPaths = contextFiles.map((entry) => (typeof entry === "string" ? entry : entry.path));
  if (new Set(normalizedContextPaths).size !== normalizedContextPaths.length) {
    throw new NaxError(
      `[plan-refine verify] ${story.id} has duplicate contextFiles entries`,
      "PLAN_REFINE_VERIFY_DUPLICATE_CONTEXT_FILE",
      { stage: "plan", storyId: story.id },
    );
  }
}

function validateRefinedPrd(prd: PRD): PRD {
  if (!prd.userStories || prd.userStories.length === 0) {
    throw new NaxError("[plan-refine verify] PRD must contain at least one story", "PLAN_REFINE_VERIFY_EMPTY_PRD", {
      stage: "plan",
    });
  }
  for (const story of prd.userStories) validateRefinedStory(story);
  return prd;
}

/**
 * Hard gate: every `[verbatim]` spec AC must survive into the PRD. Paraphrasing
 * a verbatim grep / file-check / invariant destroys its verification mechanism
 * (docs/findings/nax-plan-prd-fidelity.md). Throws so the failure is loud at
 * plan time rather than a silent drift caught only by spec-review Phase 9.
 */
function assertVerbatimAcsPreserved(prd: PRD, specContent: string): void {
  const missing = findMissingVerbatimAcs(specContent, prd);
  if (missing.length > 0) {
    throw new NaxError(
      `[plan-refine verify] PRD dropped or altered ${missing.length} [verbatim] spec acceptance criterion(s): ${missing.join(" | ")}`,
      "PLAN_REFINE_VERIFY_VERBATIM_AC_DROPPED",
      { stage: "plan", missingCount: missing.length },
    );
  }
}

/**
 * Read the PRD the refine turn wrote to disk and return the `[verbatim]` spec
 * ACs it dropped. Returns `[]` when the file is absent or unparseable — those
 * cases are handled by the normal parse / recover / verify path, not the
 * self-heal turn.
 */
async function readMissingVerbatimAcs(input: PlanRefineInput): Promise<string[]> {
  const content = await _planRefineDeps.readFile(input.outputPath);
  if (!content) return [];
  try {
    const prd = validatePlanOutput(content, input.featureName, input.branchName);
    return findMissingVerbatimAcs(input.specContent, prd);
  } catch {
    return [];
  }
}

export const planRefineOp: RunOperation<PlanRefineInput, PRD, PlanConfig> = {
  kind: "run",
  name: "plan-refine",
  stage: "plan",
  session: { role: "plan-refine" as SessionRole, lifetime: "fresh" },
  config: planConfigSelector,
  model: (_input, ctx) => ctx.config.plan.model,
  timeoutMs: (_input, ctx) => (ctx.config.plan.timeoutSeconds ?? 600) * 1000,
  retry: () =>
    makeParseRetryStrategy({
      validate: (parsed) => {
        if (parsed === null || typeof parsed !== "object") return false;
        const obj = parsed as Record<string, unknown>;
        if (!("userStories" in obj)) return false;
        if (!Array.isArray(obj.userStories)) return false;
        return obj.userStories.length > 0;
      },
      reviewerKind: "plan",
      maxAttempts: 3,
      prompts: {
        invalid: () => PlanPromptBuilder.jsonRepair(0, "Invalid JSON — response was not parseable"),
        truncated: () => PlanPromptBuilder.jsonRepair(0, "JSON appears truncated — please rewrite completely"),
      },
    }),
  fileOutput: (input) => input.outputPath,
  build(input, _ctx) {
    const { taskContext, outputFormat } = new PlanPromptBuilder().build(
      input.specContent,
      input.codebaseContext,
      input.outputPath,
      input.packages,
      input.packageDetails,
      input.projectProfile,
    );
    return {
      role: { id: "role", content: "", overridable: false },
      task: {
        id: "task",
        content: `You are drafting a PRD for the feature: **${input.featureName}**.\n\n${taskContext}\n\n${outputFormat}`,
        overridable: false,
      },
    };
  },
  async hopBody(initialPrompt, ctx) {
    const builder = new PlanPromptBuilder();
    const turn1 = await ctx.sendWithParseRetry(initialPrompt);
    const turn2 = await ctx.send(builder.buildRefineContinuation(ctx.input.outputPath));

    let totalCost = (turn1.estimatedCostUsd ?? 0) + (turn2.estimatedCostUsd ?? 0);
    let last = turn2;

    // Deterministic [verbatim] self-heal: if the rewritten PRD dropped any
    // verbatim spec AC, issue exactly one targeted repair turn in the same
    // session. `verify` is the hard floor if this turn still misses.
    const missing = await readMissingVerbatimAcs(ctx.input);
    if (missing.length > 0) {
      const turn3 = await ctx.send(builder.buildVerbatimRepair(missing, ctx.input.outputPath));
      totalCost += turn3.estimatedCostUsd ?? 0;
      last = turn3;
    }

    return { ...last, estimatedCostUsd: totalCost };
  },
  parse(output, input) {
    return validatePlanOutput(output, input.featureName, input.branchName);
  },
  verify: async (parsed, input, _ctx) => {
    const validated = validateRefinedPrd(parsed);
    assertVerbatimAcsPreserved(validated, input.specContent);
    return validated;
  },
  recover: async (input, ctx) => {
    const content = await ctx.readFile(input.outputPath);
    if (!content) return null;
    try {
      return validatePlanOutput(content, input.featureName, input.branchName);
    } catch {
      return null;
    }
  },
};
