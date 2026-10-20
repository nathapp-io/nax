/** Repo-scoped post-push forge nodes; a separate review must grade the fixes. */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NaxError } from "@/errors";
import { editComment, parseNaxBotMarker, postPrComment, replyToThread, resolveThread, withNaxBotMarker } from "@/forge";
import { getLogger } from "@/logger";
import type { StepResult } from "@/step-graph";
import { safeCode } from "../workflow/pr-body-safe";
// Workflow leaves avoid pulling orchestration dependencies into the bot nodes.
import { markReadyArgv } from "../workflow/promote";
import type { BotFixEnv, BotFixState } from "./fix-steps";
import { safeText } from "./render";

const SHORT_SHA_LENGTH = 7;
const MAX_FAILURE_LENGTH = 500;
const MAX_ISSUE_LENGTH = 200;

export const _fixReportDeps = { replyToThread, resolveThread, editComment, postPrComment };

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
    if (!first || first.author !== env.user.login || thread.resolved) continue;
    const marker = parseNaxBotMarker(first.body);
    const item = marker && agreed.get(marker.key);
    if (!item) continue;
    try {
      const summary = safeText(item.issue.split(/\r?\n/, 1)[0] ?? "", MAX_ISSUE_LENGTH).slice(0, MAX_ISSUE_LENGTH);
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

export async function readyStep(env: BotFixEnv, _state: BotFixState): Promise<StepResult<BotFixState>> {
  if (!env.info.draft) return { patch: { markedReady: false }, exit: "report" };
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

function outcomeText(state: BotFixState): string {
  switch (state.outcome) {
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
      return `Gates failed: ${(state.failingGates ?? []).join(", ")}; nothing pushed.`;
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

export function renderFixSummary(state: BotFixState): string {
  const lines = [outcomeText(state)];
  if (state.fixFailure !== undefined) lines.push(`Fix session: ${safeText(state.fixFailure, MAX_FAILURE_LENGTH)}`);
  return withNaxBotMarker(lines.join("\n"), "fix-summary");
}

export async function reportStep(env: BotFixEnv, state: BotFixState): Promise<StepResult<BotFixState>> {
  const body = renderFixSummary(state);
  const own = env.own.find(({ key }) => key === "fix-summary");
  if (own) await _fixReportDeps.editComment(env.ref, own.comment, body, env.forge, env.repoRoot);
  else await _fixReportDeps.postPrComment(env.ref, body, env.forge, env.repoRoot);
  return { patch: {}, exit: "done" };
}
