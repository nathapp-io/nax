/**
 * US-008: what the fix summary says about convergence.
 *
 * Two facts, both read from the record the bot keeps and the review it just acted on: how many fix
 * pushes this PR has seen, and which of its blocking findings sit on lines an earlier fix push wrote.
 * The second is the loop the reader is meant to notice — a review that keeps finding things on the
 * lines its own fix added is chasing its own fixes — so it is stated from the notice generation on, and
 * named as a fact only. No line here tells anyone what to do about it.
 *
 * Nothing here posts: the report node passes the result to the summary it already writes.
 */
import { type FindingTrigger, isBlockingFinding } from "@/workflow/blocking-findings";
import type { AgreedItem } from "./post";
import type { BotPushEntry, BotPushItem, FindingLineage } from "./push-ledger";

/** A commit is named short, as the fix summary names a push and `Lineage:` names a parent's push. */
const SHORT_SHA_LENGTH = 7;
const CHAIN_HEADING = "### Findings are chasing their own fixes";

export interface ConvergenceSummaryInput {
  /** The ledger as the summary being written will carry it, this execution's push included. */
  readonly entries: readonly BotPushEntry[];
  /** Recorded pushes this PR's history no longer reaches, so their lineage is lost. */
  readonly unreachable: number;
  readonly agreed: readonly AgreedItem[];
  readonly blocking: readonly FindingTrigger[];
  /** The generation at which a blocking finding is reported as sitting on a fix (`bot.chainNoticeGeneration`). */
  readonly noticeGeneration: number;
}

function severityLabel(severity: string): string {
  return severity.charAt(0).toUpperCase() + severity.slice(1);
}

/** How many pushes the bot has recorded; the unreachable ones are named so the count is not read as the whole history. */
function pushCountLine(input: ConvergenceSummaryInput): string[] {
  if (input.entries.length === 0) return [];
  const gone = input.unreachable > 0 ? ` (${input.unreachable} no longer in history)` : "";
  return [`nax bot fix pushes on this PR: ${input.entries.length}${gone}`];
}

/** The newest record of what a parent key fixed: entries are appended, so the last match is the latest. */
function parentIssue(parent: string, entries: readonly BotPushEntry[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const found: BotPushItem | undefined = entries[index]?.items.find((item) => item.key === parent);
    if (found !== undefined) return found.issue;
  }
  return undefined;
}

/** Each parent named with what it fixed; a parent the ledger no longer holds is named without an issue. */
function parentText(parent: string, entries: readonly BotPushEntry[]): string {
  const issue = parentIssue(parent, entries);
  return issue === undefined ? parent : `${parent} (${issue})`;
}

type FindingItem = Extract<AgreedItem, { kind: "finding" }>;

/** One finding's chain: the generation, the push whose lines it sits on, and the items that push fixed. */
function chainLine(item: FindingItem, lineage: FindingLineage, entries: readonly BotPushEntry[]): string {
  const parents = lineage.parents.map((parent) => parentText(parent, entries)).join(", ");
  const sha = lineage.pushSha.slice(0, SHORT_SHA_LENGTH);
  return `- ${item.key} (${severityLabel(item.severity)}, ${item.trigger ?? "normal"}), generation ${lineage.generation}: on lines added by nax bot fix ${sha} for ${parents}`;
}

/** A finding the chain section names: blocking, and on a fix push at or past the notice generation. */
function chained(item: AgreedItem, input: ConvergenceSummaryInput): item is FindingItem & { lineage: FindingLineage } {
  if (item.kind !== "finding" || item.lineage === undefined) return false;
  return item.lineage.generation >= input.noticeGeneration && isBlockingFinding(item, input.blocking);
}

function chainLines(input: ConvergenceSummaryInput): string[] {
  const lines = input.agreed
    .filter((item) => chained(item, input))
    .map((item) => chainLine(item, item.lineage, input.entries));
  return lines.length === 0 ? [] : [CHAIN_HEADING, ...lines];
}

/**
 * The lines the fix summary adds: the push count once the bot has recorded a push, then the chain
 * section once a blocking finding sits on a fix push at or past the notice generation.
 */
export function convergenceLines(input: ConvergenceSummaryInput): string[] {
  return [...pushCountLine(input), ...chainLines(input)];
}
