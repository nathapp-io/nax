/** Repo-scoped post-push forge nodes; a separate review must grade the fixes. */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { resolveWorkflowConfig } from "@/config";
import { NaxError } from "@/errors";
import {
  editComment,
  hasNaxWorkflowMarker,
  listPrComments,
  listReviewThreads,
  MAX_FORGE_COMMENT_CHARS,
  type OwnComment,
  ownComments,
  type PrComment,
  type PrThread,
  parseNaxBotMarker,
  postPrComment,
  readCurrentUser,
  readPrInfo,
  replyToThread,
  resolveThread,
  withNaxBotMarker,
} from "@/forge";
import { getLogger } from "@/logger";
import type { StepResult } from "@/step-graph";
import { configuredChainNoticeGeneration, type FindingTrigger, isBlockingFinding } from "../workflow/blocking-findings";
// Workflow leaves avoid pulling orchestration dependencies into the bot nodes.
import { type CiWaitResult, ciAllowsReady, waitForChecks } from "../workflow/ci-wait";
import { type DecisionEntry, sidecarKindFor } from "../workflow/decisions-sidecar";
import { isOpenItemKind, parseItemOpener } from "../workflow/item-threads";
import { safeCode } from "../workflow/pr-body-safe";
import { evidenceComment, markReadyArgv } from "../workflow/promote";
import {
  type CiWaiverReady,
  FIX_SUMMARY_KEY,
  nameWaiverInSummary,
  readinessLines,
  recordCiWaiver,
} from "./ci-waiver-ready";
import { convergenceLines } from "./convergence-summary";
import { COVERAGE_RECORD_KEY, type CoverageRecord, parseCoverageRecord } from "./coverage-record";
import type { BotFixEnv, BotFixState } from "./fix-steps";
import { renderFixSummary } from "./fix-summary";
import { readHeadGateNames } from "./head-gates";
import type { BotReviewArtifact } from "./post";
import { waitForPrHead } from "./pr-head-wait";
import {
  type BotPushEntry,
  ledgerIssue,
  nextLedgerEntries,
  pushLedgerChars,
  readPushLedger,
  withPushLedger,
} from "./push-ledger";
import { safeText } from "./render";
import { reviewBlockingTriggers } from "./review-blocking";
import { rulingModelReader } from "./ruling-reader";
import { type RecordRulingsOutcome, readConfirmedKeys, readSettledKeys, recordPrRulings } from "./rulings";
import { workflowPrReadiness } from "./workflow-ready";

const SHORT_SHA_LENGTH = 7;
const READY_HOLD_FINDINGS_SHOWN = 5;
/** Room kept under the forge's comment cap for the header, the marker line and the joins between them. */
const SUMMARY_CHARS_RESERVE = 512;
const MAX_ISSUE_LENGTH = 200;
const OUT_OF_ITEM_FILES_SHOWN = 20;
export const _fixReportDeps = {
  replyToThread,
  resolveThread,
  editComment,
  postPrComment,
  waitForChecks,
  waitForPrHead,
  readPrInfo,
  readCurrentUser,
  listReviewThreads,
  listPrComments,
  recordPrRulings,
  readSettledKeys,
  readConfirmedKeys,
  readHeadGateNames,
};

async function replyAgreedThreads(env: BotFixEnv, state: BotFixState): Promise<number> {
  let replied = 0;
  for (const item of env.review.agreed) {
    if (item.kind !== "thread") continue;
    try {
      const body = withNaxBotMarker(
        `nax bot fix pushed ${state.pushedSha?.slice(0, SHORT_SHA_LENGTH)} for this thread. Run nax bot review to check it.`,
        `fix-${item.key}`,
      );
      await _fixReportDeps.replyToThread(env.ref, { replyTo: item.replyTo }, body, env.forge, env.repoRoot);
      replied++;
    } catch (err) {
      getLogger()?.warn("bot-fix", "Could not reply to agreed thread", { key: item.key, error: errorMessage(err) });
    }
  }
  return replied;
}

/** Only an own fix after the latest own ruling echo answers this advisor cycle. */
function advisorFixAnswered(thread: PrThread, login: string, key: string): boolean {
  let echo = -1;
  let fix = -1;
  thread.comments.forEach((comment, index) => {
    if (comment.author !== login) return;
    const marker = parseNaxBotMarker(comment.body)?.key;
    if (marker?.startsWith("wr-")) echo = index;
    if (marker === `fix-${key}`) fix = index;
  });
  return echo >= 0 && fix > echo;
}

function skipWorkflowFinding(thread: PrThread, login: string, key: string): boolean {
  if (!key.startsWith("w-")) return false;
  const first = thread.comments[0];
  if (!first || parseItemOpener(first.body)?.kind !== "advisor") return true;
  return advisorFixAnswered(thread, login, key);
}

async function resolveOwnFindings(env: BotFixEnv, state: BotFixState): Promise<{ replied: number; resolved: number }> {
  const agreed = new Map(env.review.agreed.filter((item) => item.kind === "finding").map((item) => [item.key, item]));
  let replied = 0;
  let resolved = 0;
  for (const thread of env.threads) {
    const first = thread.comments[0];
    if (!first || first.author !== env.user.login) continue;
    const marker = parseNaxBotMarker(first.body);
    const item = marker && agreed.get(marker.key);
    if (!item) continue;
    if (skipWorkflowFinding(thread, env.user.login, item.key)) continue;
    try {
      const summary = safeText(item.issue.split(/\r?\n/, 1)[0] ?? "", MAX_ISSUE_LENGTH);
      const body = withNaxBotMarker(
        `Fixed in ${state.pushedSha?.slice(0, SHORT_SHA_LENGTH)}: ${summary}`,
        `fix-${item.key}`,
      );
      await _fixReportDeps.replyToThread(env.ref, { replyTo: thread.replyTo }, body, env.forge, env.repoRoot);
      replied++;
    } catch (err) {
      getLogger()?.warn("bot-fix", "Could not reply to own finding thread; skipping resolution", {
        threadId: thread.id,
        error: errorMessage(err),
      });
      continue;
    }
    // A confirmation can restore agreed work without reopening the forge thread.
    if (thread.resolved) continue;
    try {
      await _fixReportDeps.resolveThread(env.ref, thread, env.forge, env.repoRoot);
      resolved++;
    } catch (err) {
      getLogger()?.warn("bot-fix", "Could not resolve own finding thread", {
        threadId: thread.id,
        error: errorMessage(err),
      });
    }
  }
  return { replied, resolved };
}

export async function replyStep(env: BotFixEnv, state: BotFixState): Promise<StepResult<BotFixState>> {
  const replied = await replyAgreedThreads(env, state);
  const own = await resolveOwnFindings(env, state);
  return { patch: { replied: replied + own.replied, resolved: own.resolved }, exit: "ready" };
}

/**
 * The CI wait for this PR: the head the fix pushed, or the reviewed head when nothing was pushed.
 * The wait is the workflow's own, so bot fix and `nax workflow promote` read the same CI. US-007:
 * `rerunStarved` re-runs a job no runner picked up before the wait reports it starved.
 */
async function waitForCi(env: BotFixEnv, state: Pick<BotFixState, "pushedSha">): Promise<CiWaitResult> {
  const timeouts = resolveWorkflowConfig(env.config).timeouts;
  return _fixReportDeps.waitForChecks(env.ref.forge, env.info.url, {
    cwd: env.repoRoot,
    timeoutMs: timeouts.ciWaitMs,
    pollMs: timeouts.ciPollMs,
    signal: env.ctx.callCtx.runtime.signal,
    expectedSha: state.pushedSha ?? env.info.headSha,
    rerunStarved: true,
  });
}

function settledEntries(outcome: RecordRulingsOutcome): DecisionEntry[] {
  return outcome.settled.map((item) => {
    const kind = item.kind;
    if (!isOpenItemKind(kind))
      throw new NaxError("[bot-fix] Unknown evidence item kind", "BOT_FIX_EVIDENCE_INVALID", {
        stage: "bot-fix",
        kind: item.kind,
      });
    const { disposition, reason, sha } = item.ruling;
    return {
      id: item.itemId,
      kind: sidecarKindFor({ id: item.itemId, kind, issue: "" }),
      disposition,
      reason,
      ...(disposition === "fixed" && sha ? { sha } : {}),
    };
  });
}

/** The PR as it is now: the readiness checks and the open-finding reconciliation both read it. */
async function readPrState(env: BotFixEnv) {
  const deps = _fixReportDeps;
  const [info, user, threads, comments] = await Promise.all([
    deps.readPrInfo(env.ref, env.forge, env.repoRoot),
    deps.readCurrentUser(env.ref, env.forge, env.repoRoot),
    deps.listReviewThreads(env.ref, env.forge, env.repoRoot),
    deps.listPrComments(env.ref, env.forge, env.repoRoot),
  ]);
  return { info, user, threads, comments };
}

async function readReadyRulings(env: BotFixEnv) {
  const deps = _fixReportDeps;
  const { info, user, threads, comments } = await readPrState(env);
  const outcome = await deps.recordPrRulings({
    ref: env.ref,
    info,
    login: user.login,
    threads,
    comments,
    deps: env.forge,
    cwd: env.repoRoot,
    readModel: rulingModelReader(env.ctx, env.config),
  });
  return { info, user, comments, outcome };
}

/**
 * The bot review's own coverage record (US-013/US-014), read back from the PR's top-level comments.
 * Only an own marked comment is read, and a body the record grammar rejects reads as no record at all,
 * so a comment naming files no review skipped can never hold a draft.
 */
function ownCoverage(comments: readonly PrComment[], login: string): CoverageRecord | undefined {
  const own = ownComments(comments, login).find(({ key }) => key === COVERAGE_RECORD_KEY);
  return own === undefined ? undefined : (parseCoverageRecord(own.comment.body) ?? undefined);
}

/** The workflow readiness reads; `ciWaived` is set only when the pass posted a waiver record. */
async function workflowReadyHold(env: BotFixEnv, state: BotFixState): Promise<CiWaiverReady> {
  try {
    const expectedSha = state.pushedSha ?? env.info.headSha;
    const initial = await readReadyRulings(env);
    if (initial.info.headSha !== expectedSha) return { held: "PR head changed since this execution" };
    // Green here only bypasses the CI check for the initial item-only decision.
    const items = workflowPrReadiness({
      outcome: initial.outcome,
      ci: { outcome: "green", detail: "item preflight" },
      coverage: ownCoverage(initial.comments, initial.user.login),
      headSha: initial.info.headSha,
    });
    if (!items.ready) return { held: items.reason };
    const ci = await waitForCi(env, { pushedSha: expectedSha });
    env.ctx.callCtx.runtime.signal.throwIfAborted();
    // Rulings and index membership can change without a push while CI runs.
    const { info, user, comments, outcome } = await readReadyRulings(env);
    if (info.headSha !== expectedSha) return { held: "PR head changed since this execution" };
    const ready = workflowPrReadiness({
      outcome,
      ci,
      coverage: ownCoverage(comments, user.login),
      headSha: info.headSha,
      // US-007: only an explicit `--waive-starved` widens the strict-green rule, and only for `starved`.
      ...(env.waiveStarved === undefined ? {} : { waiveStarved: true }),
    });
    if (!ready.ready) return { held: ready.reason };
    const evidence = await writeEvidence(env, outcome, ownComments(comments, user.login));
    if (evidence) return { held: evidence };
    // The waiver is durable before the head is re-read and the PR is readied.
    const waiver = await recordCiWaiver({
      env,
      state: { pushedSha: expectedSha },
      ci,
      post: _fixReportDeps.postPrComment,
    });
    if (waiver.held !== undefined) return { held: waiver.held };
    const fresh = await _fixReportDeps.readPrInfo(env.ref, env.forge, env.repoRoot);
    if (fresh.headSha !== expectedSha) return { held: "PR head changed since this execution" };
    return waiver;
  } catch (error) {
    env.ctx.callCtx.runtime.signal.throwIfAborted();
    getLogger()?.warn("bot-fix", "Could not read PR rulings", { pr: env.ref.number, error: errorMessage(error) });
    return { held: "rulings could not be read" };
  }
}

async function writeEvidence(
  env: BotFixEnv,
  outcome: RecordRulingsOutcome,
  own: BotFixEnv["own"],
): Promise<string | undefined> {
  if (!outcome.settled.length) return;
  try {
    const body = withNaxBotMarker(evidenceComment(settledEntries(outcome)), "w-evidence");
    const existing = own.find(({ key }) => key === "w-evidence");
    if (existing) await _fixReportDeps.editComment(env.ref, existing.comment, body, env.forge, env.repoRoot);
    else await _fixReportDeps.postPrComment(env.ref, body, env.forge, env.repoRoot);
  } catch (error) {
    return `evidence comment failed: ${errorMessage(error)}`;
  }
}

async function readyHeadHold(env: BotFixEnv, state: BotFixState): Promise<string | undefined> {
  try {
    const fresh = await _fixReportDeps.readPrInfo(env.ref, env.forge, env.repoRoot);
    if (fresh.headSha !== (state.pushedSha ?? env.info.headSha)) return "PR head changed since this execution";
  } catch (error) {
    env.ctx.callCtx.runtime.signal.throwIfAborted();
    getLogger()?.warn("bot-fix", "Could not re-read PR head", { pr: env.ref.number, error: errorMessage(error) });
    return "PR head could not be re-read";
  }
}

/**
 * nax#2838: the bot runs only the checks resolved from the trusted base, so a gate the PR head added
 * (a quality command the base lacks) never ran. Ready is held until the bot has run every gate the
 * head configures; an unreadable head config holds too (fail closed).
 */
async function headGateHold(env: BotFixEnv): Promise<string | undefined> {
  try {
    const head = await _fixReportDeps.readHeadGateNames(env.checkout.worktree);
    const ran = new Set(env.checks.gates.map((gate) => gate.name));
    const missing = head.filter((name) => !ran.has(name));
    if (missing.length === 0) return undefined;
    return `PR head configures gate(s) ${missing.join(", ")} that nax bot fix did not run; run them before marking ready`;
  } catch (error) {
    getLogger()?.warn("bot-fix", "Could not read the PR head gates", {
      pr: env.ref.number,
      error: errorMessage(error),
    });
    return "PR head gates could not be read, so nax bot fix cannot tell whether it ran them all";
  }
}

/**
 * US-001: this execution pushed, so no bot review has seen the pushed head yet. The cycle reviews it and
 * then runs the ready-only pass; `--no-rereview` leaves the PR a draft until `--ready-only` recovers it.
 */
function pushedHeadHold(env: BotFixEnv, state: BotFixState): string | undefined {
  if (!state.pushedSha || state.readyOnly === true) return undefined;
  const n = env.ref.number;
  const sha = state.pushedSha.slice(0, SHORT_SHA_LENGTH);
  return `pushed ${sha}; a bot review of the pushed head decides readiness (nax bot review ${n}, then nax bot fix ${n} --ready-only)`;
}

/** The review readiness reads: the head's code review when the caller loaded one, else the latest. */
function readinessReview(env: BotFixEnv): BotReviewArtifact {
  return env.codeReview ?? env.review;
}

/** The readiness review's open finding keys that block under `blocking`, in `agreed` order. */
function blockingKeys(review: BotReviewArtifact, blocking: readonly FindingTrigger[]): string[] {
  return review.agreed
    .filter((item) => item.kind === "finding" && isBlockingFinding(item, blocking))
    .map((item) => item.key);
}

/**
 * A newer review of the same head can withdraw a finding without rewriting the code review that raised
 * it: `withdrawalEvents` records that in the newer artifact's own `events`.
 */
function withdrawnKeys(env: BotFixEnv): ReadonlySet<string> {
  const events = env.review.events ?? [];
  return new Set(events.flatMap((event) => (event.type === "finding-withdrawn" ? [event.key] : [])));
}

/**
 * Drop the keys the PR as it is now has closed: a durable ruling or a resolved thread settles a finding
 * after the artifact was written, and `--ready-only` exists to recover from exactly that. A withdrawal
 * releases a finding only while no authorized writer has reconfirmed it since (B5). An unreadable PR
 * state settles nothing, so the hold stands (fail closed).
 */
async function openKeys(env: BotFixEnv, keys: readonly string[]): Promise<readonly string[]> {
  if (keys.length === 0) return keys;
  const withdrawn = withdrawnKeys(env);
  try {
    const { user, threads, comments } = await readPrState(env);
    const input = { ref: env.ref, login: user.login, threads, comments, deps: env.forge, cwd: env.repoRoot };
    const [settled, confirmed] = await Promise.all([
      _fixReportDeps.readSettledKeys(input),
      withdrawn.size === 0 ? new Set<string>() : _fixReportDeps.readConfirmedKeys(input),
    ]);
    env.ctx.callCtx.runtime.signal.throwIfAborted();
    return keys.filter((key) => (withdrawn.has(key) ? confirmed.has(key) : !settled.has(key)));
  } catch (error) {
    env.ctx.callCtx.runtime.signal.throwIfAborted();
    getLogger()?.warn("bot-fix", "Could not read the PR rulings", { pr: env.ref.number, error: errorMessage(error) });
    return keys;
  }
}

/**
 * US-001/US-003: an open finding that blocks under the effective trigger set holds readiness. `agreed` already
 * excludes the findings settled when that review was written; a settlement or withdrawal recorded since is
 * reconciled against the PR. Minor findings, threads and comments never hold.
 */
async function openFindingHold(env: BotFixEnv): Promise<string | undefined> {
  const review = readinessReview(env);
  const keys = await openKeys(env, blockingKeys(review, reviewBlockingTriggers(env)));
  if (keys.length === 0) return undefined;
  const hidden = keys.length - READY_HOLD_FINDINGS_SHOWN;
  const listed = keys.slice(0, READY_HOLD_FINDINGS_SHOWN).join(", ");
  const head = review.headSha.slice(0, SHORT_SHA_LENGTH);
  return `${keys.length} open critical/important finding(s) in the bot review of ${head}: ${listed}${hidden > 0 ? `, +${hidden} more` : ""}`;
}

/**
 * The plain-PR readiness reads: the CI wait, the head re-read and — on a waived starved CI — the
 * durable waiver comment. The waiver is posted after the first head re-read and before the PR is
 * readied, and the head is read once more after it: the comment can name only one head, so a push
 * while it was being written must not release a head nothing classified (US-007).
 */
async function plainReadyHold(env: BotFixEnv, state: BotFixState): Promise<CiWaiverReady> {
  const ci = await waitForCi(env, state);
  env.ctx.callCtx.runtime.signal.throwIfAborted();
  if (!ciAllowsReady(ci.outcome, env.waiveStarved === undefined ? undefined : { waiveStarved: true }))
    return { held: `CI ${ci.outcome}: ${ci.detail}` };
  const held = await readyHeadHold(env, state);
  if (held !== undefined) return { held };
  const waiver = await recordCiWaiver({ env, state, ci, post: _fixReportDeps.postPrComment });
  if (waiver.held !== undefined || waiver.ciWaived === undefined) return waiver;
  const moved = await readyHeadHold(env, state);
  return moved === undefined ? waiver : { held: moved };
}

/** Only durable workflow rulings and exact-head green CI can release a workflow draft. */
export async function readyStep(env: BotFixEnv, state: BotFixState): Promise<StepResult<BotFixState>> {
  if (
    state.pushedSha &&
    !(await _fixReportDeps.waitForPrHead({ ref: env.ref, repoRoot: env.repoRoot, sha: state.pushedSha }))
  )
    return {
      patch: { markedReady: false, readyHeld: `PR head did not reach ${state.pushedSha.slice(0, SHORT_SHA_LENGTH)}` },
      exit: "report",
    };
  const pushedHeld = pushedHeadHold(env, state);
  if (pushedHeld) return { patch: { markedReady: false, readyHeld: pushedHeld }, exit: "report" };
  const findingsHeld = await openFindingHold(env);
  if (findingsHeld) return { patch: { markedReady: false, readyHeld: findingsHeld }, exit: "report" };
  if (!env.info.draft) return { patch: { markedReady: false }, exit: "report" };
  const headGates = await headGateHold(env);
  if (headGates) return { patch: { markedReady: false, readyHeld: headGates }, exit: "report" };
  const readiness = hasNaxWorkflowMarker(env.info.body)
    ? await workflowReadyHold(env, state)
    : await plainReadyHold(env, state);
  if (readiness.held !== undefined) return { patch: { markedReady: false, readyHeld: readiness.held }, exit: "report" };
  env.ctx.callCtx.runtime.signal.throwIfAborted();
  const result = await env.forge.run(markReadyArgv(env.ref.forge, env.info.url), { cwd: env.repoRoot });
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || `exit code ${result.exitCode}`;
    return { patch: { markedReady: false, readyHeld: `could not mark ready: ${detail}` }, exit: "report" };
  }
  const waived = readiness.ciWaived;
  // US-007: a ready-only pass runs no `report` node, so the waiver is named in the summary the fix
  // published — after readiness succeeded, so the comment never claims a release that did not happen.
  if (waived !== undefined && state.readyOnly === true)
    await nameWaiverInSummary({
      env,
      lines: readinessLines({ markedReady: true, ciWaived: waived }),
      list: _fixReportDeps.listPrComments,
      edit: _fixReportDeps.editComment,
    });
  return { patch: { markedReady: true, ...(waived === undefined ? {} : { ciWaived: waived }) }, exit: "report" };
}

/** The summary text lives in its own module; re-exported here so `fix-report` keeps one public surface. */
export { type FixSummaryOptions, renderFixSummary } from "./fix-summary";

function outOfItemDetail(env: BotFixEnv, state: BotFixState): string | undefined {
  if (state.outcome !== "pushed" || !state.changed) return;
  const named = new Set(
    env.review.agreed.flatMap((item) => (item.kind !== "comment" && item.file !== undefined ? [item.file] : [])),
  );
  if (named.size === 0) return;
  const unnamed = state.changed.filter((file) => !named.has(file));
  if (unnamed.length === 0) return;
  const shown = unnamed
    .slice(0, OUT_OF_ITEM_FILES_SHOWN)
    .map((file) => `\`${safeCode(file)}\``)
    .join(", ");
  const remaining = unnamed.length - OUT_OF_ITEM_FILES_SHOWN;
  return `Also changed, not named by an agreed item: ${shown}${remaining > 0 ? ` and ${remaining} more` : ""}`;
}

/**
 * US-004: the entry this execution records — only a real fix push, never the advisor-ledger-only
 * push (`outcome: "nothing"`), which changes no reviewed line a finding could sit on.
 */
function pushEntry(env: BotFixEnv, state: BotFixState): BotPushEntry | undefined {
  if (state.outcome !== "pushed" || state.pushedSha === undefined) return undefined;
  return {
    base: env.info.headSha,
    sha: state.pushedSha,
    at: new Date().toISOString(),
    items: env.review.agreed.map((item) => ({
      key: item.key,
      generation: item.kind === "finding" ? (item.lineage?.generation ?? 0) : 0,
      issue: ledgerIssue(item.issue),
    })),
  };
}

/**
 * The `fix-summary` comment as the forge holds it now. Every write replaces the whole body, and the
 * ledger inside it is the PR's only record of the bot's own pushes — so the body this run started with
 * is not good enough at write time: another `nax bot fix`, on another host, may have appended its own
 * entry while this one ran. A failed read falls back to the run's own snapshot, whose entries the merge
 * carries over anyway.
 */
async function currentSummary(env: BotFixEnv, snapshot: OwnComment | undefined): Promise<OwnComment | undefined> {
  try {
    const comments = await _fixReportDeps.listPrComments(env.ref, env.forge, env.repoRoot);
    return ownComments(comments, env.user.login).find(
      ({ key, threadId }) => key === FIX_SUMMARY_KEY && threadId === undefined,
    );
  } catch (error) {
    getLogger()?.debug("bot-fix", "Could not re-read the fix summary; merging against this run's snapshot", {
      pr: env.ref.number,
      error: errorMessage(error),
    });
    return snapshot;
  }
}

/**
 * US-007: the advisor-ledger push — only the carried ledger moved — which the brief lists before the
 * follow-up sentence a `nothing` outcome otherwise leads with.
 */
function advisorLine(env: BotFixEnv, state: BotFixState): string | undefined {
  if (state.outcome !== "nothing" || state.pushedSha === undefined) return undefined;
  const sha = state.pushedSha.slice(0, SHORT_SHA_LENGTH);
  return `Pushed ${sha}: advisor ledger. Run nax bot review ${env.ref.number} before the next nax bot fix.`;
}

/** The summary's own lines, before the convergence facts the budget is measured against. */
function summaryDetails(env: BotFixEnv, state: BotFixState): string[] {
  const lines: string[] = [];
  if (state.ledgerCarried)
    lines.push("Run `git pull --rebase` in your main checkout to pick up the carried advisor ledger.");
  const outOfItem = outOfItemDetail(env, state);
  if (outOfItem !== undefined) lines.push(outOfItem);
  return lines;
}

/**
 * The summary body to write: the convergence facts, the outcome, and the ledger the comment holds now.
 *
 * The facts are budgeted against everything else the comment spends — the forge refuses an oversized
 * comment outright, and a refused write records no push at all — so the ledger block, the header, the
 * marker line and the summary's own text are subtracted before the chain section may use the rest.
 */
function summaryBody(env: BotFixEnv, state: BotFixState, own: OwnComment | undefined): string {
  const snapshot = env.own.find(({ key }) => key === FIX_SUMMARY_KEY)?.comment.body;
  const current = own?.comment.body;
  const entry = pushEntry(env, state);
  // An unreadable block is replaced by this execution's entries alone, so the loss is not silent.
  if (entry !== undefined && current !== undefined && readPushLedger(current).unreadable)
    getLogger()?.warn("bot-fix", "Replaced an unreadable push ledger in the fix summary", {
      pr: env.ref.number,
      error: "the ledger block is not base64 JSON this version can read",
    });
  const entries = nextLedgerEntries(current, entry, snapshot);
  const lead = advisorLine(env, state);
  const options = lead === undefined ? {} : { lead: [lead] };
  const details = summaryDetails(env, state);
  const facts = convergenceLines(
    {
      entries,
      unreachable: env.review.unreachablePushes ?? 0,
      agreed: env.review.agreed,
      blocking: reviewBlockingTriggers(env),
      noticeGeneration: configuredChainNoticeGeneration(env.config),
    },
    MAX_FORGE_COMMENT_CHARS -
      renderFixSummary(state, details, env.repoRoot, options).length -
      pushLedgerChars(entries) -
      SUMMARY_CHARS_RESERVE,
  );
  return withPushLedger(renderFixSummary(state, [...facts, ...details], env.repoRoot, options), entries);
}

export async function reportStep(env: BotFixEnv, state: BotFixState): Promise<StepResult<BotFixState>> {
  const own = await currentSummary(
    env,
    env.own.find(({ key }) => key === FIX_SUMMARY_KEY),
  );
  const body = summaryBody(env, state, own);
  if (own) await _fixReportDeps.editComment(env.ref, own.comment, body, env.forge, env.repoRoot);
  else await _fixReportDeps.postPrComment(env.ref, body, env.forge, env.repoRoot);
  return { patch: {}, exit: "done" };
}
