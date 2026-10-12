/**
 * Publish (spec §7 steps 7-9, P4-R3, P4-R11): push, open (or find) the draft PR, wait for CI,
 * ask for approval only when every deterministic condition holds, then promote or keep the draft.
 * nax never merges. A non-feature branch, a dry run, no forge or a failed push ends local-only.
 */
import { join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { AdviceDecision, Advisor } from "@/advisor";
import { sanitizeTitle } from "@/finish";
import type { ForgeKind } from "@/forge";
import { getSafeLogger } from "@/logger";
import { askApproval, type ReadinessFacts, readinessReasons } from "./approval";
import type { CiWaitResult } from "./ci-wait";
import type { FeatureContext } from "./feature-context";
import { _featureDeps } from "./feature-deps";
import { workflowStoryDir } from "./paths";
import { buildWorkflowPrBody, extractAssumptions, type WorkflowPrBodyFacts } from "./pr-body";
import type { PreflightFile } from "./preflight";
import { _workflowDeps } from "./step-context";
import type { FeatureCiState, FeatureOutcome, StorySummary, WorkflowFeatureRecord } from "./types";

export interface PublishInput {
  readonly record: WorkflowFeatureRecord;
  readonly stories: readonly StorySummary[];
  readonly flagged: number;
  readonly advisor: Advisor;
  readonly preflight: PreflightFile | null;
}

export interface PublishOutcome {
  readonly outcome: FeatureOutcome;
  readonly ci: FeatureCiState;
  readonly url?: string;
  readonly reasons: readonly string[];
}

const PROTECTED_BRANCHES = new Set(["", "main", "master"]);

export function isPublishableBranch(branch: string): boolean {
  return !PROTECTED_BRANCHES.has(branch);
}

export function workflowPrTitle(fc: FeatureContext): string {
  const raw = `feat(${fc.feature}): ${fc.prd.userStories.length} stories (nax workflow)`;
  return sanitizeTitle(raw) ?? raw;
}

async function publishTarget(fc: FeatureContext): Promise<{ forge: ForgeKind } | { reason: string }> {
  if (fc.dryRun) return { reason: "dry run" };
  if (!isPublishableBranch(fc.branch)) return { reason: `branch "${fc.branch || "(empty)"}" is not a feature branch` };
  const forge = await _featureDeps.detectForge(fc.projectDir);
  return forge ? { forge } : { reason: "no forge detected (origin is not GitHub or GitLab)" };
}

async function pushBranch(fc: FeatureContext): Promise<string | null> {
  try {
    await _featureDeps.commitAndPush(fc.projectDir, fc.branch, `chore(${fc.feature}): workflow`, { skipCommit: true });
    return null;
  } catch (err) {
    if (fc.runSignal?.aborted) throw err;
    getSafeLogger()?.warn("workflow", "Push failed — the feature ends local-only", {
      storyId: "_run",
      error: errorMessage(err),
    });
    return `push failed: ${errorMessage(err)}`;
  }
}

async function loadDecisions(fc: FeatureContext): Promise<readonly AdviceDecision[]> {
  try {
    return await _workflowDeps.readTrustedDecisions(fc.projectDir, fc.feature, fc.outputDir);
  } catch (err) {
    getSafeLogger()?.warn("workflow", "Advisor decisions unavailable for the PR body", {
      storyId: "_run",
      error: errorMessage(err),
    });
    return [];
  }
}

async function loadAssumptions(stories: readonly StorySummary[]): Promise<{ storyId: string; text: string }[]> {
  const out: { storyId: string; text: string }[] = [];
  for (const s of stories) {
    if (!s.runDir) continue;
    try {
      const file = Bun.file(join(workflowStoryDir(s.runDir, s.id), "report.md"));
      const text = (await file.exists()) ? extractAssumptions(await file.text()) : "";
      if (text) out.push({ storyId: s.id, text });
    } catch {
      // an unreadable report only loses its assumptions line
    }
  }
  return out;
}

async function bodyFacts(fc: FeatureContext, input: PublishInput): Promise<WorkflowPrBodyFacts> {
  const r = input.record;
  return {
    feature: fc.feature,
    stories: input.stories,
    preflight: input.preflight,
    decisions: await loadDecisions(fc),
    rulings: r.rulings,
    minorsLeft: [...r.minors.filter((m) => m.triage === "leave").map((m) => `${m.storyId}: ${m.text}`), ...r.newMinors],
    ...(r.finalGates ? { finalGates: r.finalGates } : {}),
    assumptions: await loadAssumptions(input.stories),
  };
}

function approvalEvidence(input: PublishInput, ci: CiWaitResult, minorsLeft: number): string[] {
  const r = input.record;
  return [
    `Stories: ${input.stories.map((s) => `${s.id} ${s.state} (${s.rounds} round(s))`).join(", ") || "none"}`,
    `Final gates: ${r.finalGates?.ran.join(", ") || "none"}, all green`,
    `CI: ${ci.outcome} (${ci.detail})`,
    `Branch review ran; open findings after the fix pass: ${r.reviewOpen.length}; branch rulings: ${r.rulings.length}`,
    `Deferred minors left: ${minorsLeft}`,
  ];
}

export async function publish(fc: FeatureContext, input: PublishInput): Promise<PublishOutcome> {
  const facts: Omit<ReadinessFacts, "ci"> = {
    ...(input.record.finalGates ? { finalGates: input.record.finalGates } : {}),
    stories: input.stories,
    flagged: input.flagged,
    branchReviewRan: input.record.reviewRan,
  };
  const base = readinessReasons({ ...facts, ci: "skipped" });
  const target = await publishTarget(fc);
  if (!("forge" in target)) return { outcome: "local-only", ci: "skipped", reasons: [...base, target.reason] };
  const pushFailed = await pushBranch(fc);
  if (pushFailed) return { outcome: "local-only", ci: "skipped", reasons: [...base, pushFailed] };

  const body = await bodyFacts(fc, input);
  const pr = { workdir: fc.projectDir, branch: fc.branch, title: workflowPrTitle(fc), forge: target.forge };
  const draft = await _featureDeps.openDraftFinishPr(
    { ...pr, body: buildWorkflowPrBody({ ...body, outcome: "draft", ci: "pending", reasons: base }) },
    _featureDeps.forge,
  );
  const ci = await _featureDeps.waitForChecks(target.forge, fc.branch, {
    cwd: fc.projectDir,
    timeoutMs: fc.workflow.timeouts.ciWaitMs,
    pollMs: fc.workflow.timeouts.ciPollMs,
    ...(fc.runSignal ? { signal: fc.runSignal } : {}),
  });
  const reasons = readinessReasons({ ...facts, ci: ci.outcome });
  const approval =
    reasons.length === 0
      ? await askApproval(input.advisor, {
          feature: fc.feature,
          evidence: approvalEvidence(input, ci, body.minorsLeft.length),
        })
      : null;
  const ready = approval?.approved === true;
  const finalReasons = ready ? [] : approval ? [...reasons, approval.rationale] : reasons;
  const finalBody = buildWorkflowPrBody({
    ...body,
    outcome: ready ? "ready" : "draft",
    ci: ci.outcome,
    reasons: finalReasons,
  });
  try {
    const res = await _featureDeps.openOrPromotePr(
      { ...pr, body: finalBody, committedThisRun: true, keepDraft: !ready },
      _featureDeps.forge,
    );
    const url = res.url ?? draft?.url;
    return { outcome: ready ? "ready" : "draft", ci: ci.outcome, ...(url ? { url } : {}), reasons: finalReasons };
  } catch (err) {
    if (fc.runSignal?.aborted) throw err;
    return {
      outcome: "draft",
      ci: ci.outcome,
      ...(draft?.url ? { url: draft.url } : {}),
      reasons: [...finalReasons, `PR update failed: ${errorMessage(err)}`],
    };
  }
}
