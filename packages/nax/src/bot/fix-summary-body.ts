/**
 * The body the report node writes: the outcome, the convergence facts and the push ledger, in one
 * public comment under the forge's size limit.
 *
 * It moved out of `fix-report.ts` for the 600-line source limit, and it is also the one place that has
 * to answer the budget question: the forge refuses an oversized comment outright, and a refused write
 * records no push at all, so every variable line — the detail lines and the chain section alike — is
 * measured against the room the fixed text and the ledger block leave (B2).
 */
import type { OwnComment } from "@/forge";
import { MAX_FORGE_COMMENT_CHARS } from "@/forge";
import { getLogger } from "@/logger";
import { configuredChainNoticeGeneration } from "@/workflow/blocking-findings";
import { safeCode } from "../workflow/pr-body-safe";
import { FIX_SUMMARY_KEY } from "./ci-waiver-ready";
import { convergenceLines } from "./convergence-summary";
import type { BotFixEnv, BotFixState } from "./fix-steps";
import { fitDetails, renderFixSummary } from "./fix-summary";
import {
  type BotPushEntry,
  ledgerIssue,
  nextLedgerEntries,
  pushLedgerChars,
  readPushLedger,
  withPushLedger,
} from "./push-ledger";
import { reviewBlockingTriggers } from "./review-blocking";

const SHORT_SHA_LENGTH = 7;
/** Room kept under the forge's comment cap for the header, the marker line and the joins between them. */
const SUMMARY_CHARS_RESERVE = 512;
const OUT_OF_ITEM_FILES_SHOWN = 20;

/** What a write-time read of the fix summary gives the ledger: the comment, and the pushes beside it. */
export interface CurrentSummary {
  readonly own?: OwnComment | undefined;
  readonly records: readonly BotPushEntry[];
}

/**
 * US-004: the entry this execution records — only a real fix push, never the advisor-ledger-only
 * push (`outcome: "nothing"`), which changes no reviewed line a finding could sit on.
 */
export function pushEntry(env: BotFixEnv, state: BotFixState): BotPushEntry | undefined {
  if (state.outcome !== "pushed" || state.pushedSha === undefined) return undefined;
  return {
    base: env.info.headSha,
    sha: state.pushedSha,
    at: new Date().toISOString(),
    items: env.review.agreed.map((item) => ({
      key: item.key,
      generation: item.kind === "finding" ? (item.lineage?.generation ?? 0) : 0,
      issue: ledgerIssue(item.issue),
      ...(item.kind === "finding" && item.raisedBy !== undefined ? { raisedBy: item.raisedBy } : {}),
    })),
  };
}

/** A pushed fix can change files no agreed item named; a reader needs to know which. */
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
 * US-007: the advisor-ledger push — only the carried ledger moved — which the brief lists before the
 * follow-up sentence a `nothing` outcome otherwise leads with.
 */
function advisorLine(env: BotFixEnv, state: BotFixState): string | undefined {
  if (state.outcome !== "nothing" || state.pushedSha === undefined) return undefined;
  const sha = state.pushedSha.slice(0, SHORT_SHA_LENGTH);
  return `Pushed ${sha}: advisor ledger. Run nax bot review ${env.ref.number} before the next nax bot fix.`;
}

/**
 * The summary body to write: the convergence facts, the outcome, and the ledger the comment holds now.
 *
 * The facts and the summary's own variable text are budgeted against everything else the comment
 * spends — the ledger block, the header, the marker line and the summary's fixed text — so the detail
 * lines and the chain section together can never carry the body past the forge's limit (B2).
 */
export function summaryBody(env: BotFixEnv, state: BotFixState, summary: CurrentSummary, entry?: BotPushEntry): string {
  const snapshot = env.own.find(({ key }) => key === FIX_SUMMARY_KEY)?.comment.body;
  const current = summary.own?.comment.body;
  // An unreadable block is replaced by this execution's entries alone, so the loss is not silent.
  if (entry !== undefined && current !== undefined && readPushLedger(current).unreadable)
    getLogger()?.warn("bot-fix", "Replaced an unreadable push ledger in the fix summary", {
      pr: env.ref.number,
      error: "the ledger block is not base64 JSON this version can read",
    });
  const entries = nextLedgerEntries({ current, snapshot, records: summary.records, entry });
  const lead = advisorLine(env, state);
  const options = lead === undefined ? {} : { lead: [lead] };
  const room = MAX_FORGE_COMMENT_CHARS - SUMMARY_CHARS_RESERVE - pushLedgerChars(entries);
  const fixed = renderFixSummary(state, [], env.repoRoot, options).length;
  const details = fitDetails(summaryDetails(env, state), room - fixed);
  const facts = convergenceLines(
    {
      entries,
      unreachable: env.review.unreachablePushes ?? 0,
      agreed: env.review.agreed,
      blocking: reviewBlockingTriggers(env),
      noticeGeneration: configuredChainNoticeGeneration(env.config),
    },
    room - renderFixSummary(state, details, env.repoRoot, options).length,
  );
  return withPushLedger(renderFixSummary(state, [...facts, ...details], env.repoRoot, options), entries);
}
