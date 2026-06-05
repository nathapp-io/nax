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
import type { ContextFileEntry, PRD } from "../prd/types";
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

/** Result of normalizing one story's contextFiles against the filesystem. */
interface StoryNormalization {
  story: UserStory;
  changed: boolean;
}

/**
 * Normalize one story: an uncited `contextFiles` entry that is absent on disk is
 * a file the story CREATES — move it to `expectedFiles`. A cited entry (factId)
 * that is absent claims broken manifest grounding, so it is kept and warned
 * (not silently moved). Existing files and already-declared outputs are left
 * untouched. Returns a new story object when anything moved (immutable update).
 */
async function normalizeStoryFiles(
  story: UserStory,
  workdir: string,
  fileExists: (path: string) => Promise<boolean>,
): Promise<StoryNormalization> {
  const contextFiles = story.contextFiles ?? [];
  if (contextFiles.length === 0) return { story, changed: false };

  const logger = getSafeLogger();
  const expected = new Set(getExpectedFiles(story));
  const kept: Array<string | ContextFileEntry> = [];
  const moved: string[] = [];

  for (const entry of contextFiles) {
    const filePath = typeof entry === "string" ? entry : entry.path;
    const factId = typeof entry === "string" ? undefined : entry.factId;
    if (expected.has(filePath) || (await fileExists(join(workdir, filePath)))) {
      kept.push(entry); // already an output, or a legitimate existing read
      continue;
    }
    if (factId) {
      logger?.warn("plan", "Context file cites a manifest fact but is absent on disk", {
        storyId: story.id,
        filePath,
        factId,
      });
      kept.push(entry); // broken grounding — keep so the citation check still flags it
      continue;
    }
    moved.push(filePath); // uncited + absent → the story creates it
  }

  if (moved.length === 0) return { story, changed: false };

  // NOTE: `expectedFiles` currently only drives context create-intent hints
  // (src/context/builder.ts). It is NOT yet wired into the post-run asset gate
  // (verifyAssets in src/verification/runners.ts). This move is a best-effort
  // heuristic — an LLM typo or incidental path could land here. If expectedFiles
  // is ever promoted to a hard gate, promotion must stay opt-in (or this move
  // must require explicit create-intent), so a misclassified path cannot fail a run.
  const newExpected = [...getExpectedFiles(story)];
  for (const filePath of moved) {
    if (!newExpected.includes(filePath)) newExpected.push(filePath);
  }
  logger?.info("plan", "Moved absent contextFiles entries to expectedFiles (story creates them)", {
    storyId: story.id,
    moved,
  });
  return { story: { ...story, contextFiles: kept, expectedFiles: newExpected }, changed: true };
}

/**
 * Deterministic safety net that closes the read/create gap left when a spec or
 * plan routes a created file into `contextFiles`. For every story, an uncited
 * `contextFiles` entry absent on disk is moved to `expectedFiles` (its correct
 * home — a post-run asset gate, not a read list). Returns a new PRD when any
 * entry moved; otherwise the input PRD unchanged. Skipped when `workdir` is unset.
 */
export async function normalizeCreatedContextFiles(
  prd: PRD,
  workdir: string | undefined,
  fileExists: (path: string) => Promise<boolean>,
): Promise<PRD> {
  if (!workdir) return prd;
  const results = await Promise.all(prd.userStories.map((story) => normalizeStoryFiles(story, workdir, fileExists)));
  if (!results.some((r) => r.changed)) return prd;
  return { ...prd, userStories: results.map((r) => r.story) };
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
    return await normalizeCreatedContextFiles(validated, input.workdir, ctx.fileExists);
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
