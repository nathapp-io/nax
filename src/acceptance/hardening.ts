/**
 * Hardening Pass — test debater-suggested criteria after acceptance passes.
 *
 * Non-blocking: failures are informational, never block the pipeline.
 * Passing criteria are promoted from suggestedCriteria → acceptanceCriteria.
 */

import path from "node:path";
import type { AgentAdapter } from "../agents/types";
import type { NaxConfig } from "../config";
import { getSafeLogger } from "../logger";
import { callOp as _callOp, acceptanceGenerateOp, acceptanceRefineOp } from "../operations";
import type { CallContext } from "../operations/types";
import { savePRD } from "../prd";
import type { PRD, UserStory } from "../prd/types";
import { detectLanguage as _detectLanguage } from "../project/detector";
import type { DispatchContext } from "../runtime/dispatch-context";
import { parseTestFailures } from "../test-runners/ac-parser";
import { killProcessGroup } from "../utils/process-kill";
import { buildAcceptanceRunCommand, generateSkeletonTests } from "./generator";
import { resolveSuggestedPackageFeatureTestPath } from "./test-path";
import type { AcceptanceCriterion, RefinedCriterion } from "./types";

// ─── Constants ──────────────────────────────────────────────────────────────

/** Fallback when config.acceptance.timeoutMs is absent (schema default is 1_800_000). */
const DEFAULT_HARDENING_TIMEOUT_MS = 1_800_000;
/** Grace period between SIGTERM and SIGKILL on timeout — mirrors quality/runner.ts. */
const HARDENING_SIGKILL_GRACE_PERIOD_MS = 5_000;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface HardeningResult {
  /** Suggested ACs that passed — promoted to acceptanceCriteria */
  promoted: string[];
  /** Suggested ACs that failed — discarded */
  discarded: string[];
}

export interface HardeningContext extends DispatchContext {
  prd: PRD;
  prdPath: string;
  featureDir: string;
  workdir: string;
  config: NaxConfig;
  agentGetFn?: (name: string) => AgentAdapter | undefined;
}

// ─── Injectable deps ────────────────────────────────────────────────────────

export const _hardeningDeps = {
  callOp: _callOp as typeof _callOp,
  savePRD: savePRD,
  spawn: Bun.spawn as typeof Bun.spawn,
  writeFile: async (p: string, c: string) => {
    await Bun.write(p, c);
  },
  detectLanguage: _detectLanguage as (dir: string) => Promise<string | undefined>,
};

// ─── Private helpers ─────────────────────────────────────────────────────────

/**
 * Process one package group: refine criteria, generate test file, run it,
 * then promote passing criteria and discard failing ones.
 * Mutates groupStories' acceptanceCriteria/suggestedCriteria in place and
 * accumulates results into the shared HardeningResult.
 */
async function processPackageGroup(
  ctx: HardeningContext,
  packageDir: string,
  groupStories: UserStory[],
  language: string | undefined,
  result: HardeningResult,
): Promise<void> {
  const logger = getSafeLogger();

  // Refine suggested criteria for this group
  const groupRefined: RefinedCriterion[] = [];
  for (const story of groupStories) {
    const callCtx: CallContext = {
      runtime: ctx.runtime,
      packageView: ctx.runtime.packages.resolve(packageDir),
      packageDir,
      storyId: story.id,
      featureName: ctx.prd.feature,
      agentName: ctx.agentManager.getDefault(),
    };
    let refined: RefinedCriterion[];
    try {
      refined = await _hardeningDeps.callOp(callCtx, acceptanceRefineOp, {
        criteria: story.suggestedCriteria ?? [],
        codebaseContext: "",
        storyId: story.id,
        testStrategy: ctx.config.acceptance?.testStrategy,
        testFramework: ctx.config.acceptance?.testFramework,
        storyTitle: story.title,
        storyDescription: story.description,
      });
    } catch {
      logger?.warn("acceptance", "AC refinement failed after retries — using unrefined criteria", {
        storyId: story.id,
      });
      refined = (story.suggestedCriteria ?? []).map((c) => ({
        original: c,
        refined: c,
        testable: true,
        storyId: story.id,
      }));
    }
    groupRefined.push(...refined);
  }

  // Resolve suggested test path using packageDir (not workdir)
  const suggestedTestPath = resolveSuggestedPackageFeatureTestPath(
    packageDir,
    ctx.prd.feature,
    ctx.config.acceptance?.suggestedTestPath,
    language,
  );

  // Generate test file via acceptanceGenerateOp
  const criteriaList = groupRefined.map((c, i) => `AC-${i + 1}: ${c.refined}`).join("\n");
  const frameworkOverrideLine = ctx.config.acceptance?.testFramework
    ? `\n[FRAMEWORK OVERRIDE: Use ${ctx.config.acceptance.testFramework} as the test framework regardless of what you detect.]`
    : "";

  const genCallCtx: CallContext = {
    runtime: ctx.runtime,
    packageView: ctx.runtime.packages.resolve(packageDir),
    packageDir,
    storyId: groupStories[0]?.id,
    featureName: ctx.prd.feature,
    agentName: ctx.agentManager.getDefault(),
  };
  const genResult = await _hardeningDeps.callOp(genCallCtx, acceptanceGenerateOp, {
    featureName: ctx.prd.feature,
    criteriaList,
    frameworkOverrideLine,
    targetTestFilePath: suggestedTestPath,
  });

  // Write test file; fall back to skeleton when op returns no code (ACP writes directly)
  let testCode = genResult.testCode;
  if (!testCode) {
    const skeletonCriteria: AcceptanceCriterion[] = groupRefined.map((c, i) => ({
      id: `AC-${i + 1}`,
      text: c.refined,
      lineNumber: i + 1,
    }));
    testCode = generateSkeletonTests(ctx.prd.feature, skeletonCriteria, ctx.config.acceptance?.testFramework, language);
    logger?.warn("acceptance", "Hardening generate op returned no test code — using skeleton", {
      storyIds: groupStories.map((s) => s.id),
      storiesProcessed: groupStories.length,
    });
  }
  await _hardeningDeps.writeFile(suggestedTestPath, testCode);

  // Run tests scoped to the package dir
  const testCmd = buildAcceptanceRunCommand(
    suggestedTestPath,
    ctx.config.project?.testFramework,
    ctx.config.acceptance?.command,
    packageDir,
  );
  // detached: true so killProcessGroup(-pid) below reaches the real test-runner
  // process (Bun does not setpgid children into their own group by default —
  // without this the process becomes its own session/group leader via setsid()
  // and killProcessGroup would only be able to signal the immediate child).
  const proc = _hardeningDeps.spawn(testCmd, { cwd: packageDir, stdout: "pipe", stderr: "pipe", detached: true });

  // LLM-generated acceptance tests can hang (open server, watch mode) — enforce
  // a hard wall-clock deadline with SIGTERM -> SIGKILL escalation so the run's
  // completion phase never wedges indefinitely.
  let exitedBeforeSigkill = false;
  let sigkillTimer: ReturnType<typeof setTimeout> | undefined;
  proc.exited
    .then(() => {
      exitedBeforeSigkill = true;
    })
    .catch(() => {});
  const timeoutMs = ctx.config.acceptance?.timeoutMs ?? DEFAULT_HARDENING_TIMEOUT_MS;
  const killTimer = setTimeout(() => {
    killProcessGroup(proc.pid, "SIGTERM");
    sigkillTimer = setTimeout(() => {
      sigkillTimer = undefined;
      if (!exitedBeforeSigkill) {
        killProcessGroup(proc.pid, "SIGKILL");
      }
    }, HARDENING_SIGKILL_GRACE_PERIOD_MS);
  }, timeoutMs);

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text().catch(() => ""),
    new Response(proc.stderr).text().catch(() => ""),
  ]);
  clearTimeout(killTimer);
  if (sigkillTimer) clearTimeout(sigkillTimer);
  const output = `${stdout}\n${stderr}`;

  // Parse results and promote/discard for this group
  const failedACs = parseTestFailures(output);
  const failedSet = new Set(failedACs.map((ac) => ac.toUpperCase()));

  // BUG-14: a command that fails opaquely (timeout kill, missing venv, syntax
  // error) is INCONCLUSIVE, not a verdict — previously it discarded every
  // suggested criterion. Keep them; warn so the operator sees the run was
  // uninformative rather than clean.
  if (exitCode !== 0 && failedACs.length === 0) {
    logger?.warn(
      "acceptance",
      "Test command failed without parseable AC ids — treating as inconclusive, keeping suggested criteria",
      {
        packageDir,
        exitCode,
      },
    );
  }

  // Group refined by storyId to prevent AC index drift (#336 gap 4)
  const refinedByStory = new Map<string, RefinedCriterion[]>();
  for (const r of groupRefined) {
    const list = refinedByStory.get(r.storyId) ?? [];
    list.push(r);
    refinedByStory.set(r.storyId, list);
  }

  let acIndex = 0;
  for (const story of groupStories) {
    const storyRefined = refinedByStory.get(story.id) ?? [];
    const toPromote: string[] = [];
    const toDiscard: string[] = [];

    for (const refined of storyRefined) {
      acIndex++;
      const acId = `AC-${acIndex}`;
      // BUG-14 (D-16): discard only on a definitive verdict — testable:false
      // or an explicitly failed AC. An inconclusive run (exitCode !== 0 with no
      // parseable AC ids) no longer discards anything; it is logged above.
      if (refined.testable === false || failedSet.has(acId)) {
        toDiscard.push(refined.original);
      } else {
        toPromote.push(refined.original);
      }
    }

    if (toPromote.length > 0) {
      const existingACs = new Set(story.acceptanceCriteria);
      const actuallyPromoted = toPromote.filter((ac) => !existingACs.has(ac));
      story.acceptanceCriteria = [...story.acceptanceCriteria, ...actuallyPromoted];
      // Only count promotions that actually mutated the PRD; a criterion
      // already present in acceptanceCriteria is filtered out before mutation
      // and so does not represent a change. result.promoted feeds the
      // persistence condition — counting unchanged items there caused
      // savePRD to fire on a no-op pass (semantic review finding).
      result.promoted.push(...actuallyPromoted);
    }
    result.discarded.push(...toDiscard);
    // Adversarial review: only overwrite story.suggestedCriteria when there
    // are discarded items to record. The previous behaviour set it to
    // undefined for two distinct cases — all-promoted (handled, clear is
    // intentional) and refine-returned-empty (no verdict, clearing was an
    // in-memory mutation that persistence skipped, leaving the PRD on disk
    // out of sync with the in-memory state). Preserve the all-promoted
    // clear to keep existing tests green, and skip the clear entirely when
    // refine returned nothing — that case is a true no-op pass: the
    // suggestions stay in place, the next run refines them again.
    if (toDiscard.length > 0) {
      story.suggestedCriteria = toDiscard;
    } else if (toPromote.length > 0) {
      story.suggestedCriteria = undefined;
    }
    // else: refine returned no criteria; leave story.suggestedCriteria as-is.
  }
}

// ─── Main runner ─────────────────────────────────────────────────────────────

export async function runHardeningPass(ctx: HardeningContext): Promise<HardeningResult> {
  const logger = getSafeLogger();
  const result: HardeningResult = { promoted: [], discarded: [] };

  const storiesWithSuggested = ctx.prd.userStories.filter((s) => s.suggestedCriteria && s.suggestedCriteria.length > 0);
  if (storiesWithSuggested.length === 0) return result;

  logger?.info("acceptance", "Starting hardening pass", {
    storyIds: storiesWithSuggested.map((s) => s.id),
    storiesProcessed: storiesWithSuggested.length,
    totalSuggestedACs: storiesWithSuggested.reduce((n, s) => n + (s.suggestedCriteria?.length ?? 0), 0),
  });

  try {
    // Group stories by package so each package gets its own suggested test file
    // placed under <packageDir>/.nax/features/… rather than at the repo root.
    const packageGroups = new Map<string, typeof storiesWithSuggested>();
    for (const story of storiesWithSuggested) {
      const wd = story.workdir ?? "";
      if (!packageGroups.has(wd)) packageGroups.set(wd, []);
      packageGroups.get(wd)?.push(story);
    }

    for (const [wd, groupStories] of packageGroups.entries()) {
      const packageDir = wd ? path.join(ctx.workdir, wd) : ctx.workdir;
      const detectedLang = await _hardeningDeps.detectLanguage(packageDir);
      await processPackageGroup(ctx, packageDir, groupStories, detectedLang ?? ctx.config.project?.language, result);
    }

    if (result.promoted.length > 0 || result.discarded.length > 0) {
      await _hardeningDeps.savePRD(ctx.prd, ctx.prdPath);
    }

    logger?.info("acceptance", "Hardening pass complete", {
      storyIds: storiesWithSuggested.map((s) => s.id),
      storiesProcessed: storiesWithSuggested.length,
      promoted: result.promoted.length,
      discarded: result.discarded.length,
    });
  } catch (err) {
    logger?.warn("acceptance", "Hardening pass failed (non-blocking)", {
      storyIds: storiesWithSuggested.map((s) => s.id),
      storiesProcessed: storiesWithSuggested.length,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return result;
}
