/**
 * The fix summary's outcome line: why this execution ended as it did, in the words the public
 * comment uses (spec bot-convergence-facts US-004).
 *
 * Moved out of `fix-report.ts` unchanged so that module keeps room under the 600-line source limit
 * for the push ledger and the convergence facts the later stories add. Every case here is text a
 * reader sees on the PR, so the wording is not an implementation detail: `test/unit/bot/fix-summary`
 * pins it.
 */
import { basename, isAbsolute, relative, sep } from "node:path";
import { NaxError } from "@/errors";
import { safeCode } from "../workflow/pr-body-safe";
import type { BotFixState } from "./fix-steps";

const SHORT_SHA_LENGTH = 7;

function baselineText(ci: BotFixState["ciOutcome"]): string {
  const head = "They fail on the unmodified PR head in the bot checkout too";
  if (ci === "green")
    return `${head}, while CI is green on it, so the bot checkout differs from CI and these gates cannot judge the fix.`;
  if (ci === "failed") return `${head}, and CI is red on it too: the failure predates the fix.`;
  return `${head}; CI has no result for it (${ci ?? "unknown"}).`;
}

/**
 * The PR comment is public: a local absolute path exposes the username and directory layout
 * (nax#2681). Show the checkout relative to the repo root, or only its directory name.
 */
function displayPath(path: string, repoRoot: string | undefined): string {
  const rel = repoRoot ? relative(repoRoot, path) : "";
  const inside = rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  return inside ? rel : basename(path);
}

function dirtyText(state: BotFixState, repoRoot: string | undefined): string {
  if (state.checkoutMissing === true)
    return "The fix checkout disappeared during the session (removed by another process); nothing pushed.";
  const shown = state.recoveryPath === undefined ? "unknown" : displayPath(state.recoveryPath, repoRoot);
  return `The fix tree is dirty or unreadable; nothing pushed. Recovery checkout retained at \`${safeCode(shown)}\`.`;
}

/** `repoRoot` keeps local absolute paths out of the public comment (nax#2681). */
export function outcomeText(state: BotFixState, repoRoot: string | undefined): string {
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
      return dirtyText(state, repoRoot);
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
