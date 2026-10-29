/**
 * Publish (spec §7 steps 7-9, P4-R3, P4-R11): ask the approval advisor once every deterministic
 * condition but CI holds, commit the ledger its ruling lands in, push the branch, open (or find) the
 * draft PR, wait for CI, then promote only when the ruling and the CI/readiness result both permit it.
 * `workflow.publish` selects the depth: `pr` (default) is the above, `push` stops after the CI wait,
 * `none` touches nothing. nax never merges. A non-feature branch, a dry run, no forge or a failed
 * push ends local-only.
 */
import { isAbsolute, join } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { AdviceDecision, Advisor } from "@/advisor";
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
import { changedFilesSince, listUncommitted, readDefaultBranch, readHead } from "./git";
import { buildOpenItems } from "./open-items";
import { workflowStoryDir } from "./paths";
import { buildWorkflowPrBody, extractAssumptions, type WorkflowPrBodyFacts } from "./pr-body";
import type { PreflightFile } from "./preflight";
import { ledgerCommit, ledgerReasons } from "./publish-ledger";
import { repairEvidence } from "./repair-evidence";
import { _workflowDeps } from "./step-context";
import type { ApprovalOutcome, FeatureCiState, FeatureOutcome, StorySummary, WorkflowFeatureRecord } from "./types";

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
  /**
   * US-001 (nax#2569): the advisor's own outcome, with the decision id, present only when the advisor
   * was asked. A deterministic reason means it never was, so the key is absent rather than null.
   */
  readonly approval?: ApprovalOutcome;
  /**
   * US-001 (nax#2569): the CI wait's `detail` for `conflicting`, `no-checks` and `unavailable` — the
   * three states whose reason is built from it. Absent for every other state.
   */
  readonly ciDetail?: string;
}

/** The CI states whose readiness reason is the wait's own `detail` rather than a fixed sentence. */
const DETAILED_CI_STATES: ReadonlySet<FeatureCiState> = new Set<FeatureCiState>([
  "conflicting",
  "no-checks",
  "unavailable",
]);

/**
 * US-001: the `ciDetail` a result carries, so the verdict keeps the text the draft marker used. An
 * absent key (not an empty one) for `green`, `pending`, `skipped` and `failed` — `pending` keeps
 * none (US-003), so its open item uses the fallback text, not the wait's own detail.
 */
function ciDetailFields(ci: CiWaitResult): Pick<PublishOutcome, "ciDetail"> {
  return DETAILED_CI_STATES.has(ci.outcome) ? { ciDetail: ci.detail } : {};
}

const PROTECTED_BRANCHES = new Set(["", "main", "master"]);

export function isPublishableBranch(branch: string, defaultBranch?: string): boolean {
  return !PROTECTED_BRANCHES.has(branch) && branch !== defaultBranch;
}

export function workflowPrTitle(fc: FeatureContext): string {
  const raw = `feat(${fc.feature}): ${fc.prd.userStories.length} stories (nax workflow)`;
  return sanitizeTitle(raw) ?? raw;
}

async function publishTarget(fc: FeatureContext): Promise<{ forge: ForgeKind } | { reason: string }> {
  if (fc.dryRun) return { reason: "dry run" };
  const defaultBranch = await readDefaultBranch(fc.projectDir);
  if (!isPublishableBranch(fc.branch, defaultBranch))
    return { reason: `branch "${fc.branch || "(empty)"}" is not a feature branch` };
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

/**
 * US-001 (nax#2666): the deferred minors the PR body lists and the approval question names, in one
 * place — a `leave`-triaged minor as `<storyId>: <text>`, then the minors this run parked.
 */
function minorsLeftOf(record: WorkflowFeatureRecord): string[] {
  return [
    ...record.minors.filter((m) => m.triage === "leave").map((m) => `${m.storyId}: ${m.text}`),
    ...record.newMinors,
  ];
}

async function bodyFacts(fc: FeatureContext, input: PublishInput): Promise<WorkflowPrBodyFacts> {
  // F1: the advisor has already ruled, so the ledger this body reads back carries the ruling it just
  // wrote. The record's own approval is still dropped: a record resumed into a re-publish may carry an
  // earlier run's hold, and this publish's approval reaches the body through `finishPr` instead.
  const { approval: _priorApproval, ...r } = input.record;
  const closes = await specClosingIssues(fc);
  return {
    feature: fc.feature,
    stories: input.stories,
    preflight: input.preflight,
    decisions: await loadDecisions(fc),
    rulings: r.rulings,
    minorsLeft: minorsLeftOf(r),
    ...(r.finalGates ? { finalGates: r.finalGates } : {}),
    ...(r.finalGateFindings ? { finalGateFindings: r.finalGateFindings } : {}),
    assumptions: await loadAssumptions(input.stories),
    openItems: buildOpenItems(r),
    ...(closes ? { closes } : {}),
  };
}

/**
 * US-001 (nax#2567): the changed-file inventory the approval evidence carries, or the reason there is
 * none. A missing base or a failed diff is reported to the advisor, never thrown — an inventory nax
 * could not build must not become a readiness reason that keeps the PR a draft.
 */
export type ChangedFilesEvidence =
  | { readonly kind: "files"; readonly files: readonly string[] }
  | { readonly kind: "unavailable"; readonly reason: string };

/** How many changed paths the inventory names before it counts the rest instead. */
const MAX_EVIDENCE_FILES = 300;

/** Why there is no inventory when the run resolved no base commit at all. */
const NO_BASE_COMMIT = "no base commit was resolved";

const NO_SEED_LINE =
  "Base commit: unresolved. Establish the diff base from the pull request itself, never from a local branch.";

/** A resolved seed, which is a sha and never a branch name: a stale `main` showed 110 files for a 26-file PR. */
function baseCommitLine(seed: string | null): string {
  return seed === null
    ? NO_SEED_LINE
    : `Base commit: ${seed}. Diff against this sha (git diff ${seed}..HEAD), never against a branch name such as main.`;
}

/** The tail of a bounded inventory: how many named paths the line left out. */
function moreSuffix(total: number): string {
  const rest = total - MAX_EVIDENCE_FILES;
  return rest > 0 ? `, and ${rest} more` : "";
}

function inventoryLine(changed: ChangedFilesEvidence): string {
  if (changed.kind === "unavailable") return `Changed files since the base commit: unavailable (${changed.reason})`;
  const { files } = changed;
  if (files.length === 0) return "Changed files since the base commit (0): none";
  return `Changed files since the base commit (${files.length}): ${files.slice(0, MAX_EVIDENCE_FILES).join(", ")}${moreSuffix(files.length)}`;
}

/**
 * US-001 (nax#2567): the advisor sees every deferred minor's text, not only how many were left — a
 * count tells it nothing about what was deferred.
 */
function minorLines(minorsLeft: readonly string[]): string[] {
  return [`Deferred minors left: ${minorsLeft.length}`, ...minorsLeft.map((m) => `Deferred minor: ${m}`)];
}

/** The one sentence the question carries about CI: the ruling is taken before CI has run. */
const CI_NOT_RUN =
  "CI: not run yet. It runs on the pushed head after this ruling, and the PR is ready only when it is green.";

/** What the approval advisor reads before ruling on readiness. Exported for its own test. */
export function approvalEvidence(
  input: Pick<PublishInput, "record" | "stories">,
  minorsLeft: readonly string[],
  changed: ChangedFilesEvidence,
): string[] {
  const r = input.record;
  const unread = r.reviewUnread?.length ?? 0;
  const coverage =
    unread === 0 ? "it read every changed file it must review (0 unread)" : `it did not read ${unread} changed file(s)`;
  return [
    `Stories: ${input.stories.map((s) => `${s.id} ${s.state} (${s.rounds} round(s))`).join(", ") || "none"}`,
    `Final gates: ${r.finalGates?.ran.join(", ") || "none"}, all green`,
    // US-001 (nax#2666): the ruling is taken before the push, so there is no CI result to report —
    // only when CI runs and what it gates.
    CI_NOT_RUN,
    `Branch review ran; ${coverage}; open findings after the fix pass: ${r.reviewOpen.length}; branch rulings: ${r.rulings.length}`,
    baseCommitLine(r.seed),
    inventoryLine(changed),
    ...minorLines(minorsLeft),
    // nax#2548 / US-008: a repair commits after the re-review, so its diff reaches the PR unreviewed.
    ...repairEvidence(r),
  ];
}

/**
 * The inventory for the approval question (US-001, nax#2567). The diff is taken from the sha
 * `resolveSeed` resolved — the advisor may not guess a base from a local branch. A null seed reads as
 * an unavailable inventory with that reason, and a failed diff as one carrying git's message, because
 * in both cases the advisor is still the one that decides.
 */
async function changedFilesEvidence(projectDir: string, seed: string | null): Promise<ChangedFilesEvidence> {
  if (seed === null) return { kind: "unavailable", reason: NO_BASE_COMMIT };
  try {
    return { kind: "files", files: await changedFilesSince(projectDir, seed) };
  } catch (err) {
    return { kind: "unavailable", reason: errorMessage(err) };
  }
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
  /** US-002: the record and the stories `publish` holds, for the body's open items. */
  readonly record: WorkflowFeatureRecord;
  readonly stories: readonly StorySummary[];
}

/** US-002: the record the final body's open items read: `publish` holds no reasons (`publishStep`
 * writes them) and an older record carries no story states, so this run's approval, CI state and
 * stories fill them in. F1: the record's own `approval` is dropped first, so a resumed record's
 * earlier hold is never cited by a publish that asked no one. */
function openItemRecord(
  parts: PrParts,
  ci: CiWaitResult,
  approval: ApprovalOutcome | null,
  reasons: readonly string[],
): WorkflowFeatureRecord {
  const { approval: _priorApproval, ...record } = parts.record;
  return {
    ...record,
    ...(approval ? { approval } : {}),
    ci: ci.outcome,
    ...ciDetailFields(ci),
    // A summary already carries the id, state and reason a story item reads; this record is transient.
    storyStates: parts.stories,
    reasons,
  };
}

/** US-001 (nax#2666): the reason a hold or an unavailable advisor adds; an approval adds none of its own. */
function holdReasons(approval: ApprovalOutcome | null): string[] {
  return approval?.approved === false ? [approval.rationale] : [];
}

async function finishPr(
  fc: FeatureContext,
  parts: PrParts,
  ci: CiWaitResult,
  reasons: readonly string[],
  approval: ApprovalOutcome | null,
): Promise<PublishOutcome> {
  // US-001 (nax#2666): the ruling is taken before the push, so readiness is both halves — the advisor
  // approved *and* nothing deterministic (CI included) still blocks. A hold or an unavailable advisor
  // contributes its own rationale; an approval a red CI contradicted contributes none.
  const ready = approval?.approved === true && reasons.length === 0;
  const finalReasons = ready ? [] : [...reasons, ...holdReasons(approval)];
  const finalBody = buildWorkflowPrBody({
    ...parts.body,
    decisions: approval?.decisionId ? await loadDecisions(fc) : parts.body.decisions,
    outcome: ready ? "ready" : "draft",
    ci: ci.outcome,
    reasons: finalReasons,
    ...(ready ? { advisorFilesRead: approval?.inspectedFiles?.length ?? 0 } : {}),
    openItems: buildOpenItems(openItemRecord(parts, ci, approval, finalReasons)),
  });
  try {
    const res = await _featureDeps.openOrPromotePr(
      { ...parts.pr, body: finalBody, committedThisRun: true, keepDraft: !ready },
      _featureDeps.forge,
    );
    const url = res.url ?? parts.draftUrl;
    const kept = !ready && res.status === "already-ready" ? [...finalReasons, ALREADY_READY_REASON] : finalReasons;
    logFinishPr(ready, url, kept);
    return {
      outcome: ready ? "ready" : "draft",
      ci: ci.outcome,
      ...(url ? { url } : {}),
      reasons: kept,
      ...(approval ? { approval } : {}),
      ...ciDetailFields(ci),
    };
  } catch (err) {
    if (fc.runSignal?.aborted) throw err;
    return {
      outcome: "draft",
      ci: ci.outcome,
      ...(parts.draftUrl ? { url: parts.draftUrl } : {}),
      reasons: [...finalReasons, `PR update failed: ${errorMessage(err)}`],
      ...(approval ? { approval } : {}),
      ...ciDetailFields(ci),
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

/**
 * The CI wait both publishing modes share; the timeout and poll interval come from the workflow
 * config. The wait is bound to the HEAD that was pushed — read here, because nothing is committed
 * after the push any more (US-002: the approval ruling rides the pre-push ledger commit) — and an
 * unreadable HEAD only warns: `readinessReasons` decides what a missing binding means, not the wait.
 */
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
  return await _featureDeps.waitForChecks(forge, fc.branch, {
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
  return { outcome: "pushed", ci: ci.outcome, reasons, ...ciDetailFields(ci) };
}

/**
 * `pr` mode (US-001, nax#2666): ask the advisor while every deterministic condition but CI holds, then
 * commit the ledger it wrote, push, open the draft PR, wait for CI and promote or keep the draft. The
 * ruling needs no CI result, so it is taken before the push; CI is enforced afterwards by
 * `readinessReasons`, and `finishPr` promotes only when the ruling and that result both allow it.
 */
async function prMode(plan: PublishPlan, input: PublishInput): Promise<PublishOutcome> {
  const fc = plan.fc;
  // `plan.base` holds every pre-push condition — `ciReason("skipped")` is undefined, so no CI reason is
  // in there. A deterministic reason means the advisor is never asked and nothing is diffed for it.
  let approval: ApprovalOutcome | null = null;
  if (plan.base.length === 0) {
    const changed = await changedFilesEvidence(fc.projectDir, input.record.seed);
    approval = await askApproval(input.advisor, {
      feature: fc.feature,
      evidence: approvalEvidence(input, minorsLeftOf(input.record), changed),
    });
  }
  // One ledger commit, after the advisor: it carries the `finish-approval` line the advisor just wrote.
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
  // An aborted wait reports `pending`, which blocks readiness (US-003): stop before promotion.
  if (fc.runSignal?.aborted) throw abortedError();
  // US-007: a ledger the branch lacks is a readiness reason like any other.
  const reasons = [
    ...readinessReasons({ ...plan.facts, ci: ci.outcome, ciDetail: ci.detail }),
    ...plan.dirty,
    ...ledgerReason,
  ];
  const parts: PrParts = {
    pr,
    body,
    record: input.record,
    stories: input.stories,
    ...(draft?.url ? { draftUrl: draft.url } : {}),
  };
  // Nothing is committed after this: the advisory ruling already rode the ledger commit above.
  return finishPr(fc, parts, ci, reasons, approval);
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
    ...(fc.iterationCap ? { iterationCap: fc.iterationCap } : {}),
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
