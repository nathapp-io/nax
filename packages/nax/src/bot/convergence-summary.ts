/**
 * US-008: what the fix summary says about convergence.
 *
 * Two facts, both read from the record the bot keeps and the review it just acted on: how many fix
 * pushes this PR has seen, and which of its blocking findings sit on lines an earlier fix push wrote.
 * The second is the loop the reader is meant to notice — a review that keeps finding things on the
 * lines its own fix added is chasing its own fixes — so it is stated from the notice generation on, and
 * named as a fact only. No line here tells anyone what to do about it.
 *
 * Nothing here posts: the report node passes the result to the summary it already writes. That summary
 * is one public comment under the forge's size limit, and the ledger's own budget bounds only the
 * ledger block — so the chain section is budgeted too. A list that does not fit names as many entries
 * as it can and counts the rest, because a comment the forge refuses records no push at all.
 */
import { MAX_FORGE_COMMENT_CHARS } from "@/forge";
import { type FindingTrigger, isBlockingFinding } from "@/workflow/blocking-findings";
import type { AgreedItem } from "./post";
import { type BotPushEntry, type FindingLineage, parentIssue } from "./push-ledger";
import { safeText } from "./render";

/** A commit is named short, as the fix summary names a push and `Lineage:` names a parent's push. */
const SHORT_SHA_LENGTH = 7;
const CHAIN_HEADING = "### Findings are chasing their own fixes";
/** A parent's issue is ledger text rendered in the public comment: neutralised and capped like any other. */
const PARENT_ISSUE_CHARS = 120;
/** Parents named per finding before the rest are counted; one lineage can hold every item of a push. */
const CHAIN_PARENTS_SHOWN = 5;

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

/**
 * A parent named with what its own push fixed. Untrusted ledger text (a parent can originate in a
 * comment or a review reply) is neutralised here, at the public rendering boundary, exactly as the
 * finding and follow-up renderers treat their author text.
 */
function parentText(parent: string, pushSha: string, entries: readonly BotPushEntry[]): string {
  const issue = parentIssue(pushSha, parent, entries);
  return issue === undefined ? parent : `${parent} (${safeText(issue, PARENT_ISSUE_CHARS)})`;
}

/** The parents one chain line names, with a count for the rest so the line stays readable. */
function parentsText(lineage: FindingLineage, entries: readonly BotPushEntry[]): string {
  const named = lineage.parents
    .slice(0, CHAIN_PARENTS_SHOWN)
    .map((parent) => parentText(parent, lineage.pushSha, entries));
  const hidden = lineage.parents.length - named.length;
  return [...named, ...(hidden > 0 ? [`+${hidden} more`] : [])].join(", ");
}

type FindingItem = Extract<AgreedItem, { kind: "finding" }>;

/** One finding's chain: the generation, the push whose lines it sits on, and the items that push fixed. */
function chainLine(item: FindingItem, lineage: FindingLineage, entries: readonly BotPushEntry[]): string {
  const sha = lineage.pushSha.slice(0, SHORT_SHA_LENGTH);
  const label = `(${severityLabel(item.severity)}, ${item.trigger ?? "normal"})`;
  return `- ${item.key} ${label}, generation ${lineage.generation}: on lines added by nax bot fix ${sha} for ${parentsText(lineage, entries)}`;
}

/** A finding the chain section names: blocking, and on a fix push at or past the notice generation. */
function chained(item: AgreedItem, input: ConvergenceSummaryInput): item is FindingItem & { lineage: FindingLineage } {
  if (item.kind !== "finding" || item.lineage === undefined) return false;
  return item.lineage.generation >= input.noticeGeneration && isBlockingFinding(item, input.blocking);
}

/** The line that stands in for the findings the budget did not let this section name. */
function omittedLine(count: number): string {
  return `- ${count} more finding(s) not listed: the comment is at its size limit.`;
}

function chars(lines: readonly string[]): number {
  return lines.reduce((total, line) => total + line.length + 1, 0);
}

/**
 * The chain section within `maxChars`: findings in `agreed` order until the budget runs out, then a
 * count of the ones left out. The first entry is always named — a section that names nothing says
 * less than the heading it carries — and the ledger and the push count are never trimmed.
 */
function chainLines(input: ConvergenceSummaryInput, maxChars: number): string[] {
  const findings = input.agreed.filter((item) => chained(item, input));
  if (findings.length === 0) return [];
  const lines = [CHAIN_HEADING];
  let used = CHAIN_HEADING.length + 1;
  for (const item of findings) {
    const line = chainLine(item, item.lineage, input.entries);
    // The findings this one would still leave unlisted, whose count line needs the same room.
    const left = findings.length - (lines.length - 1) - 1;
    const tail = left > 0 ? omittedLine(left).length + 1 : 0;
    if (lines.length > 1 && used + line.length + 1 + tail > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  const hidden = findings.length - (lines.length - 1);
  if (hidden > 0) lines.push(omittedLine(hidden));
  return lines;
}

/**
 * The lines the fix summary adds: the push count once the bot has recorded a push, then the chain
 * section once a blocking finding sits on a fix push at or past the notice generation. `maxChars`
 * bounds the chain section, which the caller sizes from what the rest of the comment already uses.
 */
export function convergenceLines(input: ConvergenceSummaryInput, maxChars: number = MAX_FORGE_COMMENT_CHARS): string[] {
  const count = pushCountLine(input);
  return [...count, ...chainLines(input, maxChars - chars(count))];
}
