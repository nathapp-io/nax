/**
 * The durable CI-waiver ready step (spec ci-starved-checks US-007).
 *
 * A check no runner ever picked up has no verdict CI can reach on its own, so
 * `nax bot fix <pr> --waive-starved <reason>` is the one way a human accepts it — and only if that
 * acceptance is recorded where the next reader (and `nax workflow status`) can find it. The record
 * is posted before the PR is marked ready: a waiver nobody can read back is worse than a draft, so
 * a failed post becomes the `could not record the CI waiver:` hold and the PR stays a draft.
 *
 * Only a `starved` outcome is ever waived. `failed`, `pending`, `conflicting`, `no-checks` and
 * `unavailable` each have a verdict of their own and keep the draft.
 *
 * The comment writes are injected (`post`, `list`, `edit`) so the caller's own `_fixReportDeps` seam
 * still observes them, and a test that stubs that seam sees the waiver exactly like the evidence
 * comment. This module also owns the readiness lines of the fix summary: the same lines render a
 * fresh summary and rewrite the one an earlier fix published, so the comment cannot claim a draft
 * the waiver has released.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { NAX_BOT_HEADER, ownComments, type PrComment, stripNaxBotMarkers, withNaxBotMarker } from "@/forge";
import { getLogger } from "@/logger";
import type { CiWaitResult } from "../workflow/ci-wait";
import { type CiWaiver, renderCiWaiver } from "../workflow/ci-waiver";
import type { BotFixEnv, BotFixState } from "./fix-steps";
import { safeText } from "./render";

/** The own-comment identity of the fix summary this module may have to keep truthful. */
export const FIX_SUMMARY_KEY = "fix-summary";
/** Longest untrusted readiness text kept; the same cap the summary's other forge text takes. */
const READY_TEXT_MAX = 500;
const DRAFT_PREFIX = "Kept as draft: ";
const READY_LINE = "Marked ready.";
const READY_HEAD = "Marked ready";
/** What a `starved` result with no check names cannot become: a waiver with nothing in it. */
const NO_STARVED_CHECKS = "the CI wait named no starved checks";

/** The waiver a ready pass recorded; absent from the state when the pass waived nothing. */
export type CiWaiverRecord = NonNullable<BotFixState["ciWaived"]>;

/** The comment writer the caller hands in, so its `_fixReportDeps` seam still sees the post. */
export type CiWaiverPost = (
  ref: BotFixEnv["ref"],
  body: string,
  deps: BotFixEnv["forge"],
  cwd: string,
) => Promise<unknown>;

type ListComments = (ref: BotFixEnv["ref"], deps: BotFixEnv["forge"], cwd: string) => Promise<readonly PrComment[]>;
type EditComment = (
  ref: BotFixEnv["ref"],
  comment: Pick<PrComment, "id" | "kind">,
  body: string,
  deps: BotFixEnv["forge"],
  cwd: string,
) => Promise<unknown>;

export interface CiWaiverReadyInput {
  readonly env: BotFixEnv;
  readonly state: Pick<BotFixState, "pushedSha">;
  readonly ci: CiWaitResult;
  readonly post: CiWaiverPost;
}

/** How the waiver step ended: a hold, or the record the ready pass carries into the state. */
export interface CiWaiverReady {
  readonly held?: string;
  readonly ciWaived?: CiWaiverRecord;
}

export interface CiWaiverSummaryInput {
  readonly env: BotFixEnv;
  /** The readiness lines the updated summary must end with, as `readinessLines` renders them. */
  readonly lines: readonly string[];
  readonly list: ListComments;
  readonly edit: EditComment;
}

/**
 * Post the waiver of a starved CI, and report the record it wrote. The head is the exact execution
 * head and the checks are CI's own starved list, so the record names what nobody could judge.
 * Nothing is waived without a reason, and no other outcome is waived at all. A `starved` result that
 * named no check is not a record either: a waiver over an empty list certifies nothing, so the pass
 * holds rather than writing one (US-007).
 */
export async function recordCiWaiver({ env, state, ci, post }: CiWaiverReadyInput): Promise<CiWaiverReady> {
  const reason = env.waiveStarved;
  if (reason === undefined || ci.outcome !== "starved") return {};
  const checks = ci.starvedChecks ?? [];
  if (checks.length === 0) return { held: `could not record the CI waiver: ${NO_STARVED_CHECKS}` };
  const waiver: CiWaiver = { headSha: state.pushedSha ?? env.info.headSha, checks, reason };
  try {
    await post(env.ref, renderCiWaiver(waiver), env.forge, env.repoRoot);
  } catch (error) {
    return { held: `could not record the CI waiver: ${errorMessage(error)}` };
  }
  return { ciWaived: { checks: waiver.checks, reason: waiver.reason } };
}

/**
 * The readiness tail of a fix summary: why the PR is still a draft, or what released it. The draft
 * hold and the check names are forge text, so both are neutralised and capped here — one place for
 * the comment that is rendered and the comment that is rewritten.
 */
export function readinessLines(state: Pick<BotFixState, "markedReady" | "readyHeld" | "ciWaived">): string[] {
  const lines: string[] = [];
  if (state.readyHeld !== undefined) lines.push(`${DRAFT_PREFIX}${safeText(state.readyHeld, READY_TEXT_MAX)}`);
  if (state.markedReady === true) lines.push(READY_LINE);
  const waived = state.ciWaived;
  if (waived !== undefined)
    lines.push(
      `${READY_HEAD} with a CI waiver: ${waived.checks.length} check(s) never got a runner: ${safeText(waived.checks.join("; "), READY_TEXT_MAX)}. Reason: ${safeText(waived.reason, READY_TEXT_MAX)}`,
    );
  return lines;
}

/** A summary line a later readiness answer replaces rather than repeats. */
function isReadinessLine(line: string): boolean {
  return line.startsWith(DRAFT_PREFIX) || line.startsWith(READY_HEAD);
}

/** Drop the blank tail `stripNaxBotMarkers` leaves, so the rewritten body keeps its shape. */
function withoutTrailingBlanks(lines: readonly string[]): string[] {
  const kept = [...lines];
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  return kept;
}

/**
 * The summary body a rewrite keeps. `stripNaxBotMarkers` removes only the identity marker, so the
 * visible header `withNaxBotMarker` writes back is dropped here as well — otherwise every rewrite
 * adds one more `**nax bot**` line to the public comment. Only the leading header goes: the same
 * words inside the summary's own text are the author's.
 */
function bodyWithoutHeader(body: string): string[] {
  const lines = stripNaxBotMarkers(body).split("\n");
  const first = lines.findIndex((line) => line.trim() !== "");
  if (first === -1 || lines[first]?.trim() !== NAX_BOT_HEADER) return lines;
  const rest = lines.slice(first + 1);
  const start = rest.findIndex((line) => line.trim() !== "");
  return start === -1 ? [] : rest.slice(start);
}

/**
 * US-007: a ready-only pass runs no `report` node — that node needs a fix outcome — so the summary
 * the earlier fix published is the only comment that can name the waiver. Its readiness lines are
 * replaced by the ones this pass produced, and a PR with no own summary simply keeps what it had:
 * this is reporting, so a failed edit never decides readiness.
 */
export async function nameWaiverInSummary({ env, lines, list, edit }: CiWaiverSummaryInput): Promise<void> {
  try {
    const comments = await list(env.ref, env.forge, env.repoRoot);
    const own = ownComments(comments, env.user.login).find(({ key }) => key === FIX_SUMMARY_KEY);
    if (own === undefined) return;
    const kept = withoutTrailingBlanks(bodyWithoutHeader(own.comment.body).filter((line) => !isReadinessLine(line)));
    const body = withNaxBotMarker([...kept, ...lines].join("\n"), FIX_SUMMARY_KEY);
    await edit(env.ref, own.comment, body, env.forge, env.repoRoot);
  } catch (error) {
    getLogger()?.warn("bot-fix", "Could not name the CI waiver in the fix summary", {
      pr: env.ref.number,
      error: errorMessage(error),
    });
  }
}
