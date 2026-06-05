import { join } from "node:path";
import { makeParseRetryStrategy } from "../agents/retry";
import { planConfigSelector } from "../config";
import type { ProjectProfile } from "../config/runtime-types";
import type { PlanConfig } from "../config/selectors";
import { NaxError } from "../errors";
import { getSafeLogger } from "../logger";
import { findMissingVerbatimAcs, findSpecDriftViolations, getExpectedFiles } from "../prd";
import { validatePlanOutput } from "../prd/schema";
import type { SpecDriftViolation } from "../prd/spec-drift";
import type { PRD } from "../prd/types";
import type { UserStory } from "../prd/types";
import { PlanPromptBuilder } from "../prompts";
import type { PackageSummary } from "../prompts";
import type { SessionRole } from "../session/types";
import type { RunOperation } from "./types";
import { warnOnDroppedVerbatimAcs, warnOnSpecDrift } from "./verbatim-warn";

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
  /** When true, enables the deterministic spec-drift repair turn (Turn 4). */
  specGuard?: boolean;
  /**
   * Absolute repo/package root used by `verify` to audit `contextFiles`
   * existence on disk. When omitted, the existence audit is skipped.
   */
  workdir?: string;
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
    // Draft unparseable here — let the normal parse / recover / verify path own
    // it. Skipping the self-heal turn just means `verify` will emit the residual
    // warning later instead of this turn fixing it.
    getSafeLogger()?.debug("plan", "Skipped [verbatim] self-heal — draft PRD not yet parseable", {
      featureName: input.featureName,
    });
    return [];
  }
}

/**
 * Read the PRD the refine turn wrote to disk and return any spec-drift
 * violations. Returns `[]` when the file is absent or unparseable — those
 * cases are handled by the normal parse / recover / verify path.
 */
async function readSpecDriftViolations(input: PlanRefineInput): Promise<SpecDriftViolation[]> {
  const content = await _planRefineDeps.readFile(input.outputPath);
  if (!content) return [];
  try {
    const prd = validatePlanOutput(content, input.featureName, input.branchName);
    return findSpecDriftViolations(prd);
  } catch {
    getSafeLogger()?.debug("plan", "Skipped spec-drift check — draft PRD not yet parseable", {
      featureName: input.featureName,
    });
    return [];
  }
}

/**
 * Non-fatal safety net: warn when a story's `contextFiles` entry is absent on
 * disk and is NOT already declared as an output in `expectedFiles`. Such an
 * entry is either a file the story creates (it belongs in `expectedFiles`, not
 * `contextFiles`) or a hallucinated reference. Either way it should not sit in
 * `contextFiles`, whose contract is "existing files to read before coding".
 *
 * Warns only — planning stays resilient; the convention fix lives in the spec
 * writer and plan mapping (layers 1–2). Skipped when `workdir` is unset.
 */
export async function auditContextFileExistence(
  prd: PRD,
  workdir: string | undefined,
  fileExists: (path: string) => Promise<boolean>,
): Promise<void> {
  if (!workdir) return;
  const logger = getSafeLogger();
  if (!logger) return;
  for (const story of prd.userStories) {
    const expected = new Set(getExpectedFiles(story));
    for (const entry of story.contextFiles ?? []) {
      const filePath = typeof entry === "string" ? entry : entry.path;
      if (expected.has(filePath)) continue; // already declared as a created file — absence is expected
      if (await fileExists(join(workdir, filePath))) continue;
      logger.warn("plan", "Context file not on disk — if the story creates it, move it to expectedFiles", {
        storyId: story.id,
        filePath,
      });
    }
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
    const specGuard = ctx.input.specGuard ?? false;
    const turn1 = await ctx.sendWithParseRetry(initialPrompt);
    const turn2 = await ctx.send(builder.buildRefineContinuation(ctx.input.outputPath, specGuard));

    let totalCost = (turn1.estimatedCostUsd ?? 0) + (turn2.estimatedCostUsd ?? 0);
    let last = turn2;

    // Deterministic [verbatim] self-heal: if the rewritten PRD dropped any
    // verbatim spec AC, issue exactly one targeted repair turn in the same
    // session. `verify` re-runs the same check and warns if this turn still
    // misses, so the repair prompt and the warning must stay in sync — both
    // route through findMissingVerbatimAcs (src/prd/verbatim-fidelity.ts).
    const missing = await readMissingVerbatimAcs(ctx.input);
    if (missing.length > 0) {
      getSafeLogger()?.info("plan", "Refine dropped [verbatim] spec ACs — issuing one repair turn", {
        featureName: ctx.input.featureName,
        missingCount: missing.length,
      });
      const turn3 = await ctx.send(builder.buildVerbatimRepair(missing, ctx.input.outputPath));
      totalCost += turn3.estimatedCostUsd ?? 0;
      last = turn3;
    }

    // Deterministic spec-drift repair (specGuard only): if the PRD contains
    // deprecated tags or shell-command patterns that signal behavioral
    // regression, issue one targeted repair turn. `verify` re-runs the same
    // check and warns if violations remain after this turn.
    if (specGuard) {
      const drifted = await readSpecDriftViolations(ctx.input);
      if (drifted.length > 0) {
        getSafeLogger()?.info("plan", "specGuard: spec-drift violations found — issuing one repair turn", {
          featureName: ctx.input.featureName,
          violationCount: drifted.length,
        });
        const turn4 = await ctx.send(builder.buildSpecDriftRepair(drifted, ctx.input.outputPath));
        totalCost += turn4.estimatedCostUsd ?? 0;
        last = turn4;
      }
    }

    return { ...last, estimatedCostUsd: totalCost };
  },
  parse(output, input) {
    return validatePlanOutput(output, input.featureName, input.branchName);
  },
  verify: async (parsed, input, ctx) => {
    const validated = validateRefinedPrd(parsed);
    warnOnDroppedVerbatimAcs(validated, input.specContent, input.featureName);
    if (ctx.config.plan.specGuard) {
      warnOnSpecDrift(validated, input.featureName);
    }
    await auditContextFileExistence(validated, input.workdir, ctx.fileExists);
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
