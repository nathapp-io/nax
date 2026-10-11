/** Execution-time worth judgment and filtering for non-blocking-fix advisories. */

import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { NbfWorthCheckConfig } from "../config/selectors";
import type { Finding } from "../findings";
import { getSafeLogger } from "../logger";
import { _nbfWorthCheckAuditDeps, recordNbfWorthCheck } from "../operations/nbf-worth-check-audit";
import { truncateDiff } from "../review/diff-utils";

export { _nbfWorthCheckAuditDeps } from "../operations/nbf-worth-check-audit";

import {
  type NbfWorthCheckOpInput,
  type NbfWorthCheckOpOutput,
  type NbfWorthCheckPendingStory,
  nbfWorthCheckOp,
  _nbfWorthCheckDeps as operationDeps,
} from "../operations/nbf-worth-check";
import type { CallContext } from "../operations/types";

export interface NbfWorthCheckRequest {
  readonly ctx: CallContext;
  readonly findings: readonly Finding[];
  readonly cfg: NbfWorthCheckConfig | undefined;
}

export const _nbfWorthCheckDeps = operationDeps;

async function storyDiff(ctx: CallContext): Promise<string> {
  try {
    const ref = await _nbfWorthCheckDeps.resolveEffectiveRef(ctx.packageDir, ctx.story?.storyGitRef, ctx.storyId ?? "");
    if (!ref) return "";
    const [diff, stat] = await Promise.all([
      _nbfWorthCheckDeps.collectDiff(ctx.packageDir, ref, []),
      _nbfWorthCheckDeps.collectDiffStat(ctx.packageDir, ref),
    ]);
    return diff === null ? "" : truncateDiff(diff, stat);
  } catch (error) {
    getSafeLogger()?.warn("nbf-worth-check", "worth-check diff unavailable — judging from the code", {
      storyId: ctx.storyId,
      packageDir: ctx.packageDir,
      error: errorMessage(error),
    });
    return "";
  }
}

async function pendingFeatureStories(ctx: CallContext): Promise<NbfWorthCheckPendingStory[]> {
  if (!ctx.featureDir) return [];
  try {
    const prd = await _nbfWorthCheckDeps.loadPRD(join(ctx.featureDir, "prd.json"));
    return prd.userStories
      .filter((story) => story.id !== ctx.story?.id && ["pending", "in-progress", "paused"].includes(story.status))
      .map(({ id, title, acceptanceCriteria }) => ({ id, title, acceptanceCriteria }));
  } catch (error) {
    getSafeLogger()?.warn("nbf-worth-check", "worth-check pending stories unavailable — skipping coverage check", {
      storyId: ctx.storyId,
      packageDir: ctx.packageDir,
      error: errorMessage(error),
    });
    return [];
  }
}

export async function runNbfWorthCheck(req: NbfWorthCheckRequest): Promise<Finding[]> {
  const seed = [...req.findings];
  if (!req.cfg || req.cfg.mode === "off" || !req.ctx.story || seed.length === 0) return seed;
  const startedAt = _nbfWorthCheckAuditDeps.now();
  const costBefore = _nbfWorthCheckAuditDeps.costTotal(req.ctx.runtime);
  let result: NbfWorthCheckOpOutput | undefined;
  let failure: string | undefined;
  try {
    const input: NbfWorthCheckOpInput = {
      story: req.ctx.story,
      diff: await storyDiff(req.ctx),
      findings: seed,
      pendingStories: await pendingFeatureStories(req.ctx),
    };
    const output: unknown = await _nbfWorthCheckDeps.callOp(req.ctx, nbfWorthCheckOp, input);
    result = isWorthOutput(output) ? output : { parsed: false, unparsedPreview: "unparseable worth-check reply" };
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }
  await recordNbfWorthCheck({
    runtime: req.ctx.runtime,
    storyId: req.ctx.story.id,
    featureName: req.ctx.featureName,
    packageDir: req.ctx.packageDir,
    mode: req.cfg.mode,
    findings: seed,
    ...(result ? { result } : {}),
    ...(failure !== undefined ? { error: failure } : {}),
    durationMs: _nbfWorthCheckAuditDeps.now() - startedAt,
    costUsd: _nbfWorthCheckAuditDeps.costTotal(req.ctx.runtime) - costBefore,
  });
  if (req.cfg.mode !== "on" || failure !== undefined || !result || !result.parsed) return seed;
  return seed.filter((_, index) =>
    result.verdicts.some((verdict) => verdict.index === index + 1 && verdict.verdict === "fix"),
  );
}

function isWorthOutput(value: unknown): value is NbfWorthCheckOpOutput {
  return (
    isParsedWorthOutput(value) ||
    (typeof value === "object" &&
      value !== null &&
      "parsed" in value &&
      value.parsed === false &&
      "unparsedPreview" in value &&
      typeof value.unparsedPreview === "string")
  );
}

function isParsedWorthOutput(value: unknown): value is Extract<NbfWorthCheckOpOutput, { parsed: true }> {
  return (
    typeof value === "object" &&
    value !== null &&
    "parsed" in value &&
    value.parsed === true &&
    "verdicts" in value &&
    Array.isArray(value.verdicts)
  );
}
