/**
 * Publish (spec §7 steps 7-9, P4-R3, P4-R11): push, open (or find) the draft PR, wait for CI,
 * ask for approval only when every deterministic condition holds, then promote or keep the draft.
 * `workflow.publish` selects the depth: `pr` (default) is the above, `push` stops after the CI wait,
 * `none` touches nothing. nax never merges. A non-feature branch, a dry run, no forge or a failed
 * push ends local-only.
 */
import { isAbsolute, join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { type AdviceDecision, type Advisor, ledgerPath } from "@/advisor";
import type { WorkflowPublishMode } from "@/config";
import { NaxError } from "@/errors";
import { sanitizeTitle } from "@/finish";
import type { ForgeKind } from "@/forge";
import { getSafeLogger } from "@/logger";
import { askApproval, type ReadinessFacts, readinessReasons } from "./approval";
import type { CiWaitResult } from "./ci-wait";
import { parseClosingIssues } from "./closing-issues";
import type { FeatureContext } from "./feature-context";
import { _featureDeps } from "./feature-deps";
import { ledgerCommitMessage, listUncommitted, readHead } from "./git";
import { buildOpenItems } from "./open-items";
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
  // US-005 (nax#2526): name the push, so a slow one is not a silent gap. The ledger commit and the
  // ledger push stay unnamed (they are bookkeeping, not publish steps).
  getSafeLogger()?.info("workflow", `Publish: pushing ${fc.branch}`, { storyId: "_run" });
  try {
    await _featureDeps.commitAndPush(fc.projectDir, fc.branch, `chore(${fc.feature}): workflow`, { skipCommit: true });
    getSafeLogger()?.info("workflow", `Publish: pushed ${fc.branch}`, { storyId: "_run" });
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

/**
 * The closing issues the feature spec declares (US-007), or `undefined` when there is nothing to
 * claim: no spec source, a spec that is not on disk, an unreadable one, or one that declares no
 * `Closes:` line. The path is resolved the way `loadSpec` in `brief.ts` does — the repo-relative
 * path joined to the project dir. Reading is attempted without an `exists` probe so a missing file
 * and an unreadable one (a directory, a permission error) take the same arm: the PR body is built
 * exactly as it was before this feature.
 */
async function specClosingIssues(fc: FeatureContext): Promise<readonly number[] | undefined> {
  try {
    const rel = (await _workflowDeps.resolveFeatureSpec(fc.feature, fc.projectDir)).specSource?.path;
    if (!rel) return undefined;
    const abs = isAbsolute(rel) ? rel : join(fc.projectDir, rel);
    const closes = parseClosingIssues(await Bun.file(abs).text());
    return closes.length > 0 ? closes : undefined;
  } catch {
    return undefined;
  }
}

async function bodyFacts(fc: FeatureContext, input: PublishInput): Promise<WorkflowPrBodyFacts> {
  const r = input.record;
  const closes = await specClosingIssues(fc);
  return {
    feature: fc.feature,
    stories: input.stories,
    preflight: input.preflight,
    decisions: await loadDecisions(fc),
    rulings: r.rulings,
    minorsLeft: [...r.minors.filter((m) => m.triage === "leave").map((m) => `${m.storyId}: ${m.text}`), ...r.newMinors],
    ...(r.finalGates ? { finalGates: r.finalGates } : {}),
    ...(r.finalGateFindings ? { finalGateFindings: r.finalGateFindings } : {}),
    assumptions: await loadAssumptions(input.stories),
    openItems: buildOpenItems(r),
    ...(closes ? { closes } : {}),
  };
}

/** What the approval advisor reads before ruling on readiness. Exported for its own test. */
export function approvalEvidence(
  input: Pick<PublishInput, "record" | "stories">,
  ci: Pick<CiWaitResult, "outcome" | "detail">,
  minorsLeft: number,
): string[] {
  const r = input.record;
  // nax#2548: a repair commits after the re-review, so its diff reaches the PR unreviewed.
  const repaired = r.gateRepairRounds
    ? [
        `Gate repair: ${r.gateRepairRounds} round(s) after the final gates went red; the repair diff was not re-reviewed`,
      ]
    : [];
  return [
    `Stories: ${input.stories.map((s) => `${s.id} ${s.state} (${s.rounds} round(s))`).join(", ") || "none"}`,
    `Final gates: ${r.finalGates?.ran.join(", ") || "none"}, all green`,
    `CI: ${ci.outcome} (${ci.detail})`,
    `Branch review ran; open findings after the fix pass: ${r.reviewOpen.length}; branch rulings: ${r.rulings.length}`,
    `Deferred minors left: ${minorsLeft}`,
    ...repaired,
  ];
}

const DIRTY_REASON = "uncommitted changes after the branch fix";
const ALREADY_READY_REASON = "a human already marked the PR ready; nax left it as is";
const PUBLISH_DISABLED_REASON = "publish disabled (workflow.publish: none)";
/** Absent on a config written before `workflow.publish` existed (and on hand-built test configs). */
const DEFAULT_PUBLISH_MODE: WorkflowPublishMode = "pr";

/** Edits the pushed branch lacks make every recorded gate and approval describe code that is not in the PR. */
async function dirtyTreeReasons(fc: FeatureContext): Promise<string[]> {
  try {
    return (await listUncommitted(fc.projectDir)).length > 0 ? [DIRTY_REASON] : [];
  } catch (err) {
    // nax#2550: a tree whose state cannot be read is not a verified clean one, so it keeps the draft.
    return [`could not verify a clean working tree: ${errorMessage(err)}`];
  }
}

function abortedError(): NaxError {
  return new NaxError("Run aborted during the CI wait", "WORKFLOW_ABORTED", {
    stage: "workflow",
    storyId: "_run",
    step: "publish",
  });
}

interface PrParts {
  readonly pr: { workdir: string; branch: string; title: string; forge: ForgeKind };
  readonly body: WorkflowPrBodyFacts;
  readonly draftUrl?: string;
}

async function finishPr(
  fc: FeatureContext,
  parts: PrParts,
  ci: CiWaitResult,
  reasons: readonly string[],
  approval: { approved: boolean; rationale: string } | null,
): Promise<PublishOutcome> {
  const ready = approval?.approved === true;
  const finalReasons = ready ? [] : approval ? [...reasons, approval.rationale] : [...reasons];
  const finalBody = buildWorkflowPrBody({
    ...parts.body,
    outcome: ready ? "ready" : "draft",
    ci: ci.outcome,
    reasons: finalReasons,
  });
  try {
    const res = await _featureDeps.openOrPromotePr(
      { ...parts.pr, body: finalBody, committedThisRun: true, keepDraft: !ready },
      _featureDeps.forge,
    );
    const url = res.url ?? parts.draftUrl;
    const kept = !ready && res.status === "already-ready" ? [...finalReasons, ALREADY_READY_REASON] : finalReasons;
    logFinishPr(ready, url, kept);
    return { outcome: ready ? "ready" : "draft", ci: ci.outcome, ...(url ? { url } : {}), reasons: kept };
  } catch (err) {
    if (fc.runSignal?.aborted) throw err;
    return {
      outcome: "draft",
      ci: ci.outcome,
      ...(parts.draftUrl ? { url: parts.draftUrl } : {}),
      reasons: [...finalReasons, `PR update failed: ${errorMessage(err)}`],
    };
  }
}

/** US-005 (nax#2526): the last publish sub-step — promoted, or kept a draft and why. */
function logFinishPr(ready: boolean, url: string | undefined, kept: readonly string[]): void {
  const where = url ? ` ${url}` : "";
  const why = kept.length > 0 ? `: ${kept.join("; ")}` : "";
  const line = ready ? `Publish: PR marked ready${where}` : `Publish: PR kept as draft${where}${why}`;
  getSafeLogger()?.info("workflow", line, { storyId: "_run" });
}

/** What one ledger commit attempt did. */
interface LedgerCommitResult {
  /** True when this attempt created a commit. */
  readonly committed: boolean;
  /** Non-empty ledger lines the branch lacks because the attempt failed; 0 when it landed or the ledger is empty. */
  readonly missingRulings: number;
}

const LEDGER_MISSING_PREFIX = "advisor ledger not committed:";

/** Non-empty lines in the feature's ledger on disk; 0 when it is absent or unreadable. */
async function ledgerLineCount(fc: FeatureContext): Promise<number> {
  try {
    const file = Bun.file(ledgerPath(fc.projectDir, fc.feature));
    return (await file.exists()) ? nonEmptyLineCount(await file.text()) : 0;
  } catch {
    return 0;
  }
}

/** A blank line is not a ruling, so only non-empty lines count. */
function nonEmptyLineCount(text: string): number {
  return text.split("\n").filter((line) => line.trim() !== "").length;
}

/**
 * The ledger-only commit, fail-open (US-003). The rulings the PR body cites have to be on the pushed
 * branch, but a git failure or a locked index must never change what publishing does — so a throw is
 * logged and read as "no commit was made".
 *
 * US-007 (nax#2534): the failure is now loud about its consequence. A ledger the branch does not carry
 * means the PR cites rulings nothing backs up, so the caller turns `missingRulings` into a readiness
 * reason and the PR stays a draft. The count is the ledger on disk, since the lines that were never
 * committed are exactly the ones the reader of the PR cannot see.
 */
async function ledgerCommit(fc: FeatureContext): Promise<LedgerCommitResult> {
  if (fc.dryRun) return { committed: false, missingRulings: 0 };
  try {
    return { committed: await _featureDeps.commitLedger(fc.projectDir, fc.feature), missingRulings: 0 };
  } catch (err) {
    const missingRulings = await ledgerLineCount(fc);
    const message =
      missingRulings > 0
        ? `Advisor ledger commit failed — the branch is missing ${missingRulings} advisor rulings`
        : "Advisor ledger commit failed — publishing continues";
    getSafeLogger()?.warn("workflow", message, { storyId: "_run", error: errorMessage(err) });
    return { committed: false, missingRulings };
  }
}

/** The readiness reason a failed ledger commit contributes; empty when the commit landed or had nothing to commit. */
function ledgerReasons(ledger: LedgerCommitResult): string[] {
  return ledger.missingRulings > 0 ? [ledgerMissingReason(ledger.missingRulings)] : [];
}

function ledgerMissingReason(missingRulings: number): string {
  return `${LEDGER_MISSING_PREFIX} the branch is missing ${missingRulings} advisor rulings`;
}

/**
 * After the approval: `askApproval` appended the `finish-approval` ruling, and that line needs its own
 * commit *and* its own push — the first push already happened. A second push that fails is logged, not
 * fatal: the PR is promoted on the CI result observed before the approval (US-003).
 *
 * Its ledger commit is silent about missing rulings on purpose: `prMode` already recorded the reason
 * for the first one, and this call cannot change a draft the advisor has since approved.
 */
async function pushLedger(fc: FeatureContext): Promise<void> {
  if (!(await ledgerCommit(fc)).committed) return;
  try {
    await _featureDeps.commitAndPush(fc.projectDir, fc.branch, ledgerCommitMessage(fc.feature), { skipCommit: true });
  } catch (err) {
    getSafeLogger()?.warn("workflow", "Ledger push failed — the PR is still promoted", {
      storyId: "_run",
      error: errorMessage(err),
    });
  }
}

/** The CI wait both publishing modes share; the timeout and poll interval come from the workflow config. */
async function waitForCi(fc: FeatureContext, forge: ForgeKind): Promise<CiWaitResult> {
  let expectedSha: string | undefined;
  try {
    expectedSha = (await readHead(fc.projectDir)) || undefined;
  } catch (err) {
    getSafeLogger()?.warn("workflow", "Could not read pushed HEAD — CI SHA comparison unavailable", {
      storyId: "_run",
      error: errorMessage(err),
    });
  }
  return _featureDeps.waitForChecks(forge, fc.branch, {
    cwd: fc.projectDir,
    ...(expectedSha ? { expectedSha } : {}),
    timeoutMs: fc.workflow.timeouts.ciWaitMs,
    pollMs: fc.workflow.timeouts.ciPollMs,
    ...(fc.runSignal ? { signal: fc.runSignal } : {}),
  });
}

/** Everything a pushing mode needs: the facts, the dirty tree and the target-less base reasons. */
interface PublishPlan {
  readonly fc: FeatureContext;
  readonly forge: ForgeKind;
  readonly facts: Omit<ReadinessFacts, "ci">;
  readonly dirty: readonly string[];
  readonly base: readonly string[];
}

/**
 * `push` mode: commit the ledger, push, wait for CI, then stop. The caller owns the PR, so nax opens
 * or promotes nothing and asks the advisor nothing; an aborted wait and a failed push behave exactly
 * as in `pr` mode.
 */
async function pushMode(plan: PublishPlan): Promise<PublishOutcome> {
  const ledger = await ledgerCommit(plan.fc);
  const pushFailed = await pushBranch(plan.fc);
  if (pushFailed) {
    return { outcome: "local-only", ci: "skipped", reasons: [...plan.base, ...ledgerReasons(ledger), pushFailed] };
  }
  const ci = await waitForCi(plan.fc, plan.forge);
  if (plan.fc.runSignal?.aborted) throw abortedError();
  const reasons = [
    ...readinessReasons({ ...plan.facts, ci: ci.outcome, ciDetail: ci.detail }),
    ...plan.dirty,
    ...ledgerReasons(ledger),
  ];
  return { outcome: "pushed", ci: ci.outcome, reasons };
}

/**
 * `pr` mode: the ledger commit, the push, the draft PR, the CI wait, the approval (which appends its
 * own ruling and so gets the ledger committed and pushed again), then promote or keep the draft.
 */
async function prMode(plan: PublishPlan, input: PublishInput): Promise<PublishOutcome> {
  const fc = plan.fc;
  const ledger = await ledgerCommit(fc);
  const ledgerReason = ledgerReasons(ledger);
  const pushFailed = await pushBranch(fc);
  if (pushFailed) {
    return { outcome: "local-only", ci: "skipped", reasons: [...plan.base, ...ledgerReason, pushFailed] };
  }

  const body = await bodyFacts(fc, input);
  const pr = { workdir: fc.projectDir, branch: fc.branch, title: workflowPrTitle(fc), forge: plan.forge };
  const draft = await _featureDeps.openDraftFinishPr(
    {
      ...pr,
      body: buildWorkflowPrBody({
        ...body,
        outcome: "draft",
        ci: "pending",
        reasons: [...plan.base, ...ledgerReason],
      }),
    },
    _featureDeps.forge,
  );
  // US-005: a URL the forge did not return is left out rather than invented; the step is still named.
  getSafeLogger()?.info("workflow", `Publish: draft PR${draft?.url ? ` ${draft.url}` : ""}`, { storyId: "_run" });
  const ci = await waitForCi(fc, plan.forge);
  // An aborted wait reports `pending`, which never blocks readiness: stop before approval or promotion.
  if (fc.runSignal?.aborted) throw abortedError();
  // US-007: a ledger the branch lacks is a readiness reason like any other, so the advisor is never
  // asked to approve a PR citing rulings the branch does not carry.
  const reasons = [
    ...readinessReasons({ ...plan.facts, ci: ci.outcome, ciDetail: ci.detail }),
    ...plan.dirty,
    ...ledgerReason,
  ];
  const approval =
    reasons.length === 0
      ? await askApproval(input.advisor, {
          feature: fc.feature,
          evidence: approvalEvidence(input, ci, body.minorsLeft.length),
        })
      : null;
  // A deterministic reason means the advisor was never asked, so there is no second ledger line either.
  if (approval) await pushLedger(fc);
  return finishPr(fc, { pr, body, ...(draft?.url ? { draftUrl: draft.url } : {}) }, ci, reasons, approval);
}

export async function publish(fc: FeatureContext, input: PublishInput): Promise<PublishOutcome> {
  const facts: Omit<ReadinessFacts, "ci"> = {
    ...(input.record.finalGates ? { finalGates: input.record.finalGates } : {}),
    stories: input.stories,
    flagged: input.flagged,
    branchReviewRan: input.record.reviewRan,
    // US-003 (nax#2532): a review that did not read every changed file is an incomplete review, so
    // its reason keeps the PR a draft and the advisor is never asked (reasons non-empty).
    ...(input.record.reviewUnread ? { branchReviewUnread: input.record.reviewUnread } : {}),
    ...(input.record.costLimited ? { costLimited: true } : {}),
    // nax#2550: fix commits no re-review looked at never go ready.
    ...(input.record.reReviewSkipped ? { reReviewSkipped: true } : {}),
  };
  const dirty = await dirtyTreeReasons(fc);
  const base = [...readinessReasons({ ...facts, ci: "skipped" }), ...dirty];
  const mode = fc.workflow.publish ?? DEFAULT_PUBLISH_MODE;
  // `none` outranks the target checks: on any branch, with or without a forge, nothing is pushed. Every
  // path that pushes nothing still commits the ledger — the rulings stay with the branch (US-003), and a
  // commit that cannot land is a readiness reason (US-007), so the reason for the mode stays last.
  if (mode === "none") {
    const ledger = await ledgerCommit(fc);
    return {
      outcome: "local-only",
      ci: "skipped",
      reasons: [...base, ...ledgerReasons(ledger), PUBLISH_DISABLED_REASON],
    };
  }
  const target = await publishTarget(fc);
  if (!("forge" in target)) {
    const ledger = await ledgerCommit(fc);
    return {
      outcome: "local-only",
      ci: "skipped",
      reasons: [...base, ...ledgerReasons(ledger), target.reason],
    };
  }
  const plan: PublishPlan = { fc, forge: target.forge, facts, dirty, base };
  return mode === "push" ? pushMode(plan) : prMode(plan, input);
}
