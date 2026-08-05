import { join } from "node:path";
import { makeParseRetryStrategy } from "../agents/retry";
import type { TurnResult } from "../agents/types";
import { planConfigSelector } from "../config";
import type { ProjectProfile } from "../config/runtime-types";
import type { PlanConfig } from "../config/selectors";
import { NaxError } from "../errors";
import { getSafeLogger } from "../logger";
import { findMissingOutOfScope, findSpecDriftViolations, getExpectedFiles } from "../prd";
import { validatePlanOutput } from "../prd/schema";
import type { SpecDriftViolation } from "../prd/spec-drift";
import type { ContextFileEntry, PRD } from "../prd/types";
import type { UserStory } from "../prd/types";
import { PlanPromptBuilder } from "../prompts";
import type { PackageSummary } from "../prompts";
import type { SessionRole } from "../session/types";
import { errorMessage } from "../utils/errors";
import { applyPlanFidelity, warnOnSpecDrift } from "./plan-fidelity";
import { type SelfHealStep, makeSelfHealStep, runSelfHealChain } from "./self-heal";
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
 * Collect every file produced (created) by the stories `story` transitively
 * depends on. A file created by an upstream dependency does not exist at plan
 * time but WILL exist at this story's execution time — sequential mode shares one
 * workdir (the producer ran first), and parallel mode merges each batch back to
 * HEAD before the next batch's worktrees branch from it (see
 * docs/architecture/spec-to-prd-pipeline.md, src/execution/parallel-coordinator.ts,
 * src/worktree/manager.ts). So an absent `contextFiles` entry that an upstream
 * story creates is a legitimate read hint, NOT a file this story authors.
 */
function collectUpstreamProducedFiles(story: UserStory, byId: Map<string, UserStory>): Set<string> {
  const produced = new Set<string>();
  const seen = new Set<string>();
  const stack = [...(story.dependencies ?? [])];
  while (stack.length > 0) {
    const depId = stack.pop();
    if (!depId || seen.has(depId)) continue;
    seen.add(depId);
    const dep = byId.get(depId);
    if (!dep) continue;
    for (const filePath of getExpectedFiles(dep)) produced.add(filePath);
    stack.push(...(dep.dependencies ?? []));
  }
  return produced;
}

/**
 * Normalize one story's `contextFiles` against the filesystem and the dependency
 * graph:
 * - An entry that exists on disk, or is already a declared output, is kept.
 * - An entry absent on disk but produced by an UPSTREAM dependency is kept as a
 *   read hint — it exists at this story's runtime; moving it to `expectedFiles`
 *   would wrongly claim this story authors it (see spec-to-prd-pipeline.md).
 * - An uncited entry absent on disk and produced by no upstream story is a file
 *   this story CREATES — move it to `expectedFiles`.
 * - A cited entry (factId) that is absent claims broken manifest grounding, so it
 *   is kept and warned (not silently moved).
 * Returns a new story object when anything moved (immutable update).
 */
async function normalizeStoryFiles(
  story: UserStory,
  workdir: string,
  fileExists: (path: string) => Promise<boolean>,
  upstreamProduced: Set<string>,
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
    if (upstreamProduced.has(filePath)) {
      // Created by an upstream dependency — absent at plan time, present at this
      // story's runtime. Keep it as a read hint; do NOT move to expectedFiles
      // (this story reads/modifies it but does not author it).
      kept.push(entry);
      logger?.debug("plan", "Kept cross-story produced file in contextFiles (upstream dependency creates it)", {
        storyId: story.id,
        filePath,
      });
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
 * `contextFiles` entry absent on disk AND produced by no upstream dependency is
 * moved to `expectedFiles` (its correct home — a post-run asset gate, not a read
 * list). An absent entry an upstream dependency creates is kept (it exists at
 * this story's runtime — see spec-to-prd-pipeline.md). Returns a new PRD when any
 * entry moved; otherwise the input PRD unchanged. Skipped when `workdir` is unset.
 */
export async function normalizeCreatedContextFiles(
  prd: PRD,
  workdir: string | undefined,
  fileExists: (path: string) => Promise<boolean>,
): Promise<PRD> {
  if (!workdir) return prd;
  const byId = new Map(prd.userStories.map((story) => [story.id, story]));
  const results = await Promise.all(
    prd.userStories.map((story) =>
      normalizeStoryFiles(story, workdir, fileExists, collectUpstreamProducedFiles(story, byId)),
    ),
  );
  if (!results.some((r) => r.changed)) return prd;
  return { ...prd, userStories: results.map((r) => r.story) };
}

/**
 * Read the PRD the refine turn wrote to disk and return the spec's out-of-scope
 * statements it dropped. Returns `[]` when the file is absent or unparseable —
 * those cases are handled by the normal parse / recover / verify path.
 */
async function readMissingOutOfScope(input: PlanRefineInput): Promise<string[]> {
  const content = await _planRefineDeps.readFile(input.outputPath);
  if (!content) return [];
  try {
    const prd = validatePlanOutput(content, input.featureName, input.branchName);
    return findMissingOutOfScope(input.specContent, prd);
  } catch (err) {
    getSafeLogger()?.debug("plan", "Skipped out-of-scope self-heal — draft PRD not yet parseable", {
      featureName: input.featureName,
      error: errorMessage(err),
    });
    return [];
  }
}

/**
 * Out-of-scope self-heal — restores feature-level exclusions the refine turn
 * dropped. `verify` backfills anything still missing afterwards, so this turn is
 * about wording quality and per-story Scope echo, not about guaranteeing the
 * field exists.
 */
function outOfScopeSelfHealStep(builder: PlanPromptBuilder): SelfHealStep<PlanRefineInput> {
  return makeSelfHealStep<PlanRefineInput, string>({
    detect: (input) => readMissingOutOfScope(input),
    buildRepair: (missing, input) => builder.buildOutOfScopeRepair(missing, input.outputPath),
    log: {
      kind: "plan",
      message: "Refine dropped spec out-of-scope statements — issuing one repair turn",
      meta: (input, missing) => ({ featureName: input.featureName, missingCount: missing.length }),
    },
  });
}

/** Spec-drift self-heal (specGuard only) — rewrites ACs with deprecated tags / shell patterns. */
function specDriftSelfHealStep(builder: PlanPromptBuilder): SelfHealStep<PlanRefineInput> {
  return makeSelfHealStep<PlanRefineInput, SpecDriftViolation>({
    detect: (input) => readSpecDriftViolations(input),
    buildRepair: (drifted, input) => builder.buildSpecDriftRepair(drifted, input.outputPath),
    log: {
      kind: "plan",
      message: "specGuard: spec-drift violations found — issuing one repair turn",
      meta: (input, drifted) => ({ featureName: input.featureName, violationCount: drifted.length }),
    },
  });
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
  build(input, ctx) {
    const agentRouting = ctx.config.routing?.agents;
    const profiles = agentRouting?.enabled === true ? (agentRouting.profiles ?? []) : [];
    const { taskContext, outputFormat } = new PlanPromptBuilder().build(
      input.specContent,
      input.codebaseContext,
      input.outputPath,
      input.packages,
      input.packageDetails,
      input.projectProfile,
      undefined,
      profiles,
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

    const seed: TurnResult = {
      ...turn2,
      estimatedCostUsd: (turn1.estimatedCostUsd ?? 0) + (turn2.estimatedCostUsd ?? 0),
    };

    // Deterministic same-session self-heal: out-of-scope always; spec-drift only
    // under specGuard. Each step issues at most one corrective turn; `verify`
    // re-runs the same checks and warns if a repair still misses (the plan continues).
    const steps: SelfHealStep<PlanRefineInput>[] = [
      outOfScopeSelfHealStep(builder),
      ...(specGuard ? [specDriftSelfHealStep(builder)] : []),
    ];
    return runSelfHealChain(ctx, seed, steps);
  },
  parse(output, input) {
    return validatePlanOutput(output, input.featureName, input.branchName);
  },
  verify: async (parsed, input, ctx) => {
    const validated = validateRefinedPrd(parsed);
    if (ctx.config.plan.specGuard) {
      warnOnSpecDrift(validated, input.featureName);
    }
    // Last line of defence after the out-of-scope self-heal turn: anything the
    // repair turn still missed is restored verbatim from the spec.
    const scoped = applyPlanFidelity(validated, input.specContent, input.featureName);
    return await normalizeCreatedContextFiles(scoped, input.workdir, ctx.fileExists);
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
