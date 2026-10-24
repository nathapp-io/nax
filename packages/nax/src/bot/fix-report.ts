/** Repo-scoped post-push forge nodes; a separate review must grade the fixes. */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { resolveWorkflowConfig } from "@/config";
import { NaxError } from "@/errors";
import {
  editComment,
  hasNaxWorkflowMarker,
  listPrComments,
  listReviewThreads,
  ownComments,
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
// Workflow leaves avoid pulling orchestration dependencies into the bot nodes.
import { type CiWaitResult, ciAllowsReady, waitForChecks } from "../workflow/ci-wait";
import { type DecisionEntry, sidecarKindFor } from "../workflow/decisions-sidecar";
import { isOpenItemKind } from "../workflow/item-threads";
import { safeCode } from "../workflow/pr-body-safe";
import { evidenceComment, markReadyArgv } from "../workflow/promote";
import type { BotFixEnv, BotFixState } from "./fix-steps";
import { waitForPrHead } from "./pr-head-wait";
import { safeText } from "./render";
import { rulingModelReader } from "./ruling-reader";
import { type RecordRulingsOutcome, recordPrRulings } from "./rulings";
import { workflowPrReadiness } from "./workflow-ready";

const SHORT_SHA_LENGTH = 7;
const MAX_FAILURE_LENGTH = 500;
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

async function resolveOwnFindings(env: BotFixEnv, state: BotFixState): Promise<{ replied: number; resolved: number }> {
  const agreed = new Map(env.review.agreed.filter((item) => item.kind === "finding").map((item) => [item.key, item]));
  let replied = 0;
  let resolved = 0;
  for (const thread of env.threads) {
    const first = thread.comments[0];
    if (!first || first.author !== env.user.login) continue;
    const marker = parseNaxBotMarker(first.body);
    const item = marker && agreed.get(marker.key);
    if (!item || item.key.startsWith("w-")) continue;
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
 * The wait is the workflow's own, so bot fix and `nax workflow promote` read the same CI.
 */
async function waitForCi(env: BotFixEnv, state: Pick<BotFixState, "pushedSha">): Promise<CiWaitResult> {
  const timeouts = resolveWorkflowConfig(env.config).timeouts;
  return _fixReportDeps.waitForChecks(env.ref.forge, env.info.url, {
    cwd: env.repoRoot,
    timeoutMs: timeouts.ciWaitMs,
    pollMs: timeouts.ciPollMs,
    signal: env.ctx.callCtx.runtime.signal,
    expectedSha: state.pushedSha ?? env.info.headSha,
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

async function readReadyRulings(env: BotFixEnv) {
  const deps = _fixReportDeps;
  const [info, user, threads, comments] = await Promise.all([
    deps.readPrInfo(env.ref, env.forge, env.repoRoot),
    deps.readCurrentUser(env.ref, env.forge, env.repoRoot),
    deps.listReviewThreads(env.ref, env.forge, env.repoRoot),
    deps.listPrComments(env.ref, env.forge, env.repoRoot),
  ]);
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

async function workflowReadyHold(env: BotFixEnv, state: BotFixState): Promise<string | undefined> {
  try {
    const expectedSha = state.pushedSha ?? env.info.headSha;
    const initial = await readReadyRulings(env);
    if (initial.info.headSha !== expectedSha) return "PR head changed since this execution";
    // Green here only bypasses the CI check for the initial item-only decision.
    const items = workflowPrReadiness({ outcome: initial.outcome, ci: { outcome: "green", detail: "item preflight" } });
    if (!items.ready) return items.reason;
    const ci = await waitForCi(env, { pushedSha: expectedSha });
    env.ctx.callCtx.runtime.signal.throwIfAborted();
    // Rulings and index membership can change without a push while CI runs.
    const { info, user, comments, outcome } = await readReadyRulings(env);
    if (info.headSha !== expectedSha) return "PR head changed since this execution";
    const ready = workflowPrReadiness({ outcome, ci });
    if (!ready.ready) return ready.reason;
    const evidence = await writeEvidence(env, outcome, ownComments(comments, user.login));
    if (evidence) return evidence;
    const fresh = await _fixReportDeps.readPrInfo(env.ref, env.forge, env.repoRoot);
    if (fresh.headSha !== expectedSha) return "PR head changed since this execution";
  } catch (error) {
    env.ctx.callCtx.runtime.signal.throwIfAborted();
    getLogger()?.warn("bot-fix", "Could not read PR rulings", { pr: env.ref.number, error: errorMessage(error) });
    return "rulings could not be read";
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
  if (!env.info.draft) return { patch: { markedReady: false }, exit: "report" };
  if (hasNaxWorkflowMarker(env.info.body)) {
    const readyHeld = await workflowReadyHold(env, state);
    if (readyHeld) return { patch: { markedReady: false, readyHeld }, exit: "report" };
  } else {
    const ci = await waitForCi(env, state);
    env.ctx.callCtx.runtime.signal.throwIfAborted();
    if (!ciAllowsReady(ci.outcome)) {
      return { patch: { markedReady: false, readyHeld: `CI ${ci.outcome}: ${ci.detail}` }, exit: "report" };
    }
  }
  env.ctx.callCtx.runtime.signal.throwIfAborted();
  const result = await env.forge.run(markReadyArgv(env.ref.forge, String(env.ref.number)), { cwd: env.repoRoot });
  if (result.exitCode !== 0) {
    throw new NaxError(`[bot-fix] Could not mark ${env.ref.repo}#${env.ref.number} ready`, "BOT_FIX_READY_FAILED", {
      stage: "bot-fix",
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
  }
  return { patch: { markedReady: true }, exit: "report" };
}

/** Why every red gate is not the fix's: CI's verdict on the same head decides (nax#2631). */
function baselineText(ci: BotFixState["ciOutcome"]): string {
  const head = "They fail on the unmodified PR head in the bot checkout too";
  if (ci === "green")
    return `${head}, while CI is green on it, so the bot checkout differs from CI and these gates cannot judge the fix.`;
  if (ci === "failed") return `${head}, and CI is red on it too: the failure predates the fix.`;
  return `${head}; CI has no result for it (${ci ?? "unknown"}).`;
}

function outcomeText(state: BotFixState): string {
  switch (state.outcome) {
    case "cost-limit":
      if (state.costSpentUsd === undefined || state.costLimitUsd === undefined)
        throw new NaxError("[bot-fix] Cannot report cost limit without spend and limit", "BOT_FIX_OUTCOME_MISSING", {
          stage: "bot-fix",
        });
      return `Cost limit reached: ${state.costSpentUsd.toFixed(2)} of ${state.costLimitUsd.toFixed(2)} USD; nothing pushed.`;
    case "setup-failed":
      return `Setup failed at \`${safeCode(state.setupFailed ?? "unknown")}\`; nothing ran.`;
    case "pushed":
      return `Pushed ${state.pushedSha?.slice(0, SHORT_SHA_LENGTH)}: ${state.agreedCount ?? 0} agreed items fixed in one round; gates passed.`;
    case "nothing":
      return "Nothing to fix: the latest review agreed with no item.";
    case "no-change":
      return "The fix session changed nothing; nothing pushed.";
    case "protected":
      return [
        "The fix changed protected files; nothing pushed.",
        ...(state.protectedFiles ?? []).map((path) => `- \`${safeCode(path)}\``),
      ].join("\n");
    case "no-gates":
      return "No gates are configured on the base branch; nothing pushed.";
    case "gates-failed":
      return [
        `Gates failed: ${(state.failingGates ?? []).join(", ")}; nothing pushed.`,
        ...(state.baselineFailing?.length
          ? [`Already red on the unmodified PR head: ${state.baselineFailing.join(", ")}.`]
          : []),
      ].join(" ");
    case "prepare-touched-tracked":
      return state.prepareTreeUnreadable
        ? "The prepare tree could not be read; nothing pushed."
        : "The prepare turn changed tracked files; nothing pushed.";
    case "baseline-red":
      return `Gates failed: ${(state.failingGates ?? []).join(", ")}. ${baselineText(state.ciOutcome)} Nothing pushed.`;
    case "dirty":
      return `The fix tree is dirty or unreadable; nothing pushed. Recovery checkout retained at \`${safeCode(state.recoveryPath ?? "unknown")}\`.`;
    case "push-unknown":
      return "The push timed out; remote outcome is unknown. Check the remote before retrying.";
    case "push-rejected":
      return "The push was rejected (the PR changed or access was denied); nothing pushed.";
    default:
      throw new NaxError("[bot-fix] Cannot report without a fix outcome", "BOT_FIX_OUTCOME_MISSING", {
        stage: "bot-fix",
      });
  }
}

export function renderFixSummary(state: BotFixState, details: readonly string[] = []): string {
  const lines = [outcomeText(state), ...details];
  if (state.reusedFix)
    lines.push(
      `Reused the saved fix ${safeText(state.reusedFix.slice(0, SHORT_SHA_LENGTH), SHORT_SHA_LENGTH)}; no new fix session.`,
    );
  if (state.repairMode !== undefined)
    lines.push(`Repair turn: ${state.repairMode}, round ${state.gateRepairRounds ?? 0}.`);
  if (state.repairSkippedForCost) lines.push("Repair turn skipped: cost limit reached.");
  if (state.fixFailure !== undefined) lines.push(`Fix session: ${safeText(state.fixFailure, MAX_FAILURE_LENGTH)}`);
  // Why the PR is still a draft — a workflow PR, or a CI that is not green — or that it is ready.
  // The reason carries the CI wait's own detail, which is forge output: it is neutralised and
  // capped like the fix failure above, so a hostile or noisy detail cannot inject into the comment.
  if (state.readyHeld !== undefined) lines.push(`Kept as draft: ${safeText(state.readyHeld, MAX_FAILURE_LENGTH)}`);
  if (state.markedReady === true) lines.push("Marked ready.");
  return withNaxBotMarker(lines.join("\n"), "fix-summary");
}

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

export async function reportStep(env: BotFixEnv, state: BotFixState): Promise<StepResult<BotFixState>> {
  const lines: string[] = [];
  if (state.outcome === "nothing" && state.pushedSha)
    lines.push(
      `Pushed ${state.pushedSha.slice(0, SHORT_SHA_LENGTH)}: advisor ledger. Run nax bot review ${env.ref.number} before the next nax bot fix.`,
    );
  if (state.ledgerCarried)
    lines.push("Run `git pull --rebase` in your main checkout to pick up the carried advisor ledger.");
  const outOfItem = outOfItemDetail(env, state);
  if (outOfItem !== undefined) lines.push(outOfItem);
  const body = renderFixSummary(state, lines);
  const own = env.own.find(({ key }) => key === "fix-summary");
  if (own) await _fixReportDeps.editComment(env.ref, own.comment, body, env.forge, env.repoRoot);
  else await _fixReportDeps.postPrComment(env.ref, body, env.forge, env.repoRoot);
  return { patch: {}, exit: "done" };
}
