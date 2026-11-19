import { MAX_FORGE_COMMENT_CHARS, withNaxBotMarker } from "@/forge";
import type { PrEarlierVerdict, PrIntent, PrTriageDecision, PrTriageVerdict } from "@/operations/bot-types";
import type { WorkflowFindingDraft } from "@/operations/workflow-types";
import type { EffectiveBlockingTriggers, FindingTrigger } from "@/workflow/blocking-findings";
// Reuse the safe path leaf without loading workflow's orchestration barrel (as in render.ts).
import { safeCode } from "../workflow/pr-body-safe";
import type { BotChecks } from "./checks";
import { checkCommands } from "./checks";
import type { FindingLineage } from "./push-ledger";
import { earlierKey, findingKey, safeText, threadKey } from "./render";
import type { BotReviewScope, ItemStatus } from "./review-rulings";

const TEXT_LIMIT = 2_000;
/** US-001: matches the parser's cap on `triggerEvidence`. */
const EVIDENCE_LIMIT = 300;
const AUTHOR_LIMIT = 100;
const ITEM_RULING_LIMIT = 20;
const ITEM_ID_LIMIT = 100;
const SHORT_SHA_LENGTH = 7;
const SUMMARY_RESERVE = 512;
const DECISION_LABELS: Record<PrTriageDecision, string> = {
  agree: "Agree",
  disagree: "Disagree",
  handled: "Already handled",
};

export interface ReviewSummaryInput {
  readonly itemStatus?: ItemStatus;
  /**
   * US-008: the agreed findings that block under the effective set. They are review threads, not
   * indexed items, so the open-items line names them beside the index's own count. Absent or 0 leaves
   * that line as it always was.
   */
  readonly blockingCount?: number;
  readonly unreadFiles?: readonly string[];
  readonly minor?: readonly WorkflowFindingDraft[];
  /** US-003: critical or important findings outside the blocking set, which get no inline thread. */
  readonly residual?: readonly FindingWithTrigger[];
  /** US-003: the effective blocking set, and where it came from. */
  readonly blockingTriggers?: readonly FindingTrigger[];
  readonly blockingSource?: EffectiveBlockingTriggers["source"];
  /** US-003: the first line of every writer scope comment that stated no usable class. */
  readonly ignoredScopeRulings?: readonly string[];
  readonly earlier?: { readonly open: number; readonly fixed: number; readonly withdrawn: number };
  readonly checks?: BotChecks | null;
  readonly preRunFailed?: string;
  /** The build step that failed after a successful install (US-007). */
  readonly buildFailed?: string;
  readonly ci?: { readonly outcome: string; readonly detail: string };
  readonly headSha: string;
  /** What this review covered (nax#2667); absent keeps the plain head line. */
  readonly scope?: BotReviewScope;
  readonly incrementalSince?: string;
  readonly intent: PrIntent;
  /** `not-reviewed` when the review read no code (US-001). */
  readonly quality: "approved" | "changes" | "not-reviewed";
  readonly inlineFindings: number;
  readonly threadsAnswered: number;
  readonly offLine: readonly WorkflowFindingDraft[];
  readonly commentVerdicts: readonly {
    readonly author: string;
    readonly verdict: PrTriageVerdict;
    readonly notQueued?: boolean;
  }[];
  readonly cannotVerify: readonly string[];
  readonly sensitive: readonly string[];
  readonly staticMode: boolean;
  readonly failed: number;
}

function severityLabel(finding: WorkflowFindingDraft): string {
  return finding.severity.charAt(0).toUpperCase() + finding.severity.slice(1);
}

/** A finding with the trigger facts the review carries (US-001): what it needs in order to occur. */
export interface FindingWithTrigger extends WorkflowFindingDraft {
  readonly trigger?: FindingTrigger;
  readonly triggerEvidence?: string;
  /** US-005: the bot fix whose lines this finding sits on; absent when nothing owns them. */
  readonly lineage?: FindingLineage;
}

/** US-005: the same fact the fixer receives — the generation, the push, and the items it fixed. */
function lineageLine(lineage: FindingLineage): string {
  const parents = safeText(lineage.parents.join(", "), TEXT_LIMIT);
  return `Lineage: generation ${lineage.generation}, on lines added by nax bot fix ${lineage.pushSha.slice(0, SHORT_SHA_LENGTH)}${parents === "" ? "" : ` for ${parents}`}`;
}

/** Fact lines sit together under the issue, and carry no prose of their own (US-001, US-005). */
function factLines(finding: FindingWithTrigger): string[] {
  const lines: string[] = [];
  if (finding.trigger !== undefined) {
    const evidence =
      finding.triggerEvidence === undefined ? "" : ` - ${safeText(finding.triggerEvidence, EVIDENCE_LIMIT)}`;
    lines.push(`Trigger: ${finding.trigger}${evidence}`);
  }
  if (finding.lineage !== undefined) lines.push(lineageLine(finding.lineage));
  return lines;
}

/** A stable marked inline finding, with all author prose neutralised. */
export function renderFindingComment(finding: FindingWithTrigger): string {
  const facts = factLines(finding);
  let body = `**${severityLabel(finding)}** (${finding.kind}): ${safeText(finding.issue, TEXT_LIMIT)}`;
  if (facts.length > 0) body += `\n\n${facts.join("\n")}`;
  if (finding.suggestion) body += `\n\nSuggestion: ${safeText(finding.suggestion, TEXT_LIMIT)}`;
  return withNaxBotMarker(body, findingKey(finding));
}

/** A stable marked triage reply to a review thread. */
export function renderThreadReply(verdict: PrTriageVerdict, opts?: { notQueued?: boolean }): string {
  let body = `${DECISION_LABELS[verdict.decision]}: ${safeText(verdict.reason, TEXT_LIMIT)}`;
  if (opts?.notQueued)
    body += "\n\nNot queued for `nax bot fix`: this thread was not opened by someone with write access.";
  return withNaxBotMarker(body, threadKey(verdict.id));
}

/** A stable marked reply for a fixed or withdrawn earlier finding. */
export function renderEarlierReply(verdict: PrEarlierVerdict, threadId: string): string {
  const label = verdict.status === "fixed" ? "Fixed" : "Withdrawn";
  return withNaxBotMarker(`${label}: ${safeText(verdict.reason, TEXT_LIMIT)}`, earlierKey(threadId));
}

function offLineItem(finding: WorkflowFindingDraft): string {
  const file = finding.file === undefined ? "" : safeCode(finding.file);
  const line = finding.file === undefined || finding.line === undefined ? "" : `${file ? ":" : ""}${finding.line}`;
  const location = file + line;
  return `- **${severityLabel(finding)}** ${location ? `\`${location}\` ` : ""}${safeText(finding.issue, TEXT_LIMIT)}`;
}

interface ListSection {
  readonly heading: string;
  readonly items: string[];
}

/**
 * US-003: a finding that does not block gets no inline thread, so the summary is the only place it appears —
 * with the class of condition it needs, which is why it did not block.
 */
function residualItem(finding: FindingWithTrigger): string {
  const code = finding.file === undefined ? "" : `\`${safeCode(finding.file)}\``;
  const at = finding.line === undefined ? code : `${code}:${finding.line}`;
  const location = at === "" ? "" : `${at}: `;
  const evidence =
    finding.triggerEvidence === undefined ? "" : ` - ${safeText(finding.triggerEvidence, EVIDENCE_LIMIT)}`;
  const issue = safeText(finding.issue, TEXT_LIMIT);
  return `- **${severityLabel(finding)}** ${location}${issue} (trigger ${finding.trigger ?? "normal"}${evidence})`;
}

/**
 * US-003: a forge login is letters, digits, dot, underscore or hyphen. Nothing else is part of one, so the
 * rendered name can carry no markdown — and, unlike `safeText`, it still reads as the literal `@name`.
 */
function loginText(login: string): string {
  return login.replace(/[^A-Za-z0-9._-]/g, "").slice(0, AUTHOR_LIMIT);
}

function blockingSourceLabel(source: ReviewSummaryInput["blockingSource"]): string {
  if (source === undefined || source === "config") return "config";
  return `PR comment by @${loginText(source.author)}`;
}

/** The policy that decided this review's posting, and every writer ruling it could not use (US-003). */
function policyLines(input: ReviewSummaryInput): string[] {
  const lines: string[] = [];
  if (input.blockingTriggers !== undefined)
    lines.push(
      `Blocking triggers: ${input.blockingTriggers.join(", ")} (${blockingSourceLabel(input.blockingSource)})`,
    );
  for (const ruling of input.ignoredScopeRulings ?? [])
    lines.push(`Ignored scope ruling: ${safeText(ruling, TEXT_LIMIT)}`);
  return lines;
}

function summarySections(input: ReviewSummaryInput): ListSection[] {
  return [
    { heading: "### Sensitive paths changed", items: input.sensitive.map((path) => `- \`${safeCode(path)}\``) },
    { heading: "### Findings not on a changed line", items: input.offLine.map(offLineItem) },
    { heading: "### Residual findings (not blocking)", items: (input.residual ?? []).map(residualItem) },
    { heading: "### Minor findings", items: (input.minor ?? []).map(offLineItem) },
    {
      heading: "### Top-level comments",
      items: input.commentVerdicts.map(
        ({ author, verdict, notQueued }) =>
          `- ${safeText(author, AUTHOR_LIMIT)}: ${DECISION_LABELS[verdict.decision]} — ${safeText(verdict.reason, TEXT_LIMIT)}${notQueued ? " (not queued for fix: author has no write access)" : ""}`,
      ),
    },
    { heading: "### Could not verify", items: input.cannotVerify.map((text) => `- ${safeText(text, TEXT_LIMIT)}`) },
    {
      heading: "### Review coverage",
      items: (input.unreadFiles ?? []).map((path) => `Not read by the review: \`${safeCode(path)}\``),
    },
  ].filter((section) => section.items.length > 0);
}

function omissionLine(count: number, kinds: ReadonlySet<string>): string {
  return `… and ${count} more not shown. Omitted from: ${[...kinds].join(", ")}.`;
}

/** Account for each joined newline and the marker wrapper without repeatedly joining huge lists. */
function boundedSummary(prefix: string[], sections: ListSection[], suffix: string[]): string {
  let length = withNaxBotMarker([...prefix, ...suffix].join("\n"), "summary").length;
  for (const section of sections) {
    length += section.heading.length + 1;
    for (const item of section.items) length += item.length + 1;
  }
  let omitted = 0;
  const omittedKinds = new Set<string>();
  while (
    length + (omitted ? omissionLine(omitted, omittedKinds).length + 1 : 0) >
    MAX_FORGE_COMMENT_CHARS - SUMMARY_RESERVE
  ) {
    const section = sections.at(-1);
    if (!section) break;
    const item = section.items.pop();
    if (item !== undefined) {
      length -= item.length + 1;
      omitted++;
      omittedKinds.add(section.heading.replace(/^### /, ""));
    }
    if (section.items.length === 0) {
      length -= section.heading.length + 1;
      sections.pop();
    }
  }
  const lists = sections.flatMap(({ heading, items }) => [heading, ...items]);
  const notice = omitted ? [omissionLine(omitted, omittedKinds)] : [];
  return withNaxBotMarker([...prefix, ...lists, ...notice, ...suffix].join("\n"), "summary");
}

function itemStatusLines(status: ItemStatus | undefined, blockingCount: number | undefined): string[] {
  if (status === undefined) return [];
  const lines: string[] = [];
  if (status.recorded.length > 0) {
    const shown = status.recorded
      .slice(0, ITEM_RULING_LIMIT)
      .map(
        ({ id, disposition, by }) =>
          `${safeText(id, ITEM_ID_LIMIT)} ${disposition} by ${by === null ? "nax bot" : `@${by}`}`,
      );
    const hidden = status.recorded.length - shown.length;
    if (hidden > 0) shown.push(`and ${hidden} more`);
    lines.push(`Item rulings recorded: ${status.recorded.length} (${shown.join(", ")}).`);
  }
  // US-008: the index counts its own items; a review's blocking findings are threads, so they are
  // counted beside it (#2981). With none there is nothing to add and the line reads as it always did.
  const blocking =
    blockingCount === undefined || blockingCount === 0 ? "." : ` indexed; ${blockingCount} blocking review findings.`;
  lines.push(`Open items: ${status.open} of ${status.total}${blocking}`);
  return lines;
}

function readinessLines(input: ReviewSummaryInput): string[] {
  const lines: string[] = [];
  if (input.earlier) {
    const { open, fixed, withdrawn } = input.earlier;
    const total = open + fixed + withdrawn;
    if (total > 0)
      lines.push(`${total} earlier findings re-checked: ${open} still open, ${fixed} fixed, ${withdrawn} withdrawn.`);
  }
  if (input.checks?.source === "none") {
    lines.push(
      "No check commands found on the base branch, so nax bot fix will refuse. Add quality.commands to .nax/config.json, or list the commands in AGENTS.md or CLAUDE.md.",
    );
  } else if (input.checks) {
    const labels = {
      config: ".nax/config.json",
      "agents-md": "AGENTS.md",
      "claude-md": "CLAUDE.md",
      detected: "package.json scripts",
    };
    lines.push(
      `Checks (${labels[input.checks.source]}): ${safeText(checkCommands(input.checks).join(", "), TEXT_LIMIT)}.`,
    );
  }
  if (input.ci) {
    lines.push(
      `CI on ${input.headSha.slice(0, SHORT_SHA_LENGTH)}: ${input.ci.outcome} (${safeText(input.ci.detail, TEXT_LIMIT)}).`,
    );
  }
  if (input.preRunFailed !== undefined) {
    lines.push(`Install step failed (${safeText(input.preRunFailed, TEXT_LIMIT)}); checks may not have run.`);
  }
  if (input.buildFailed !== undefined) {
    lines.push(
      `Build step failed (${safeText(input.buildFailed, TEXT_LIMIT)}); checks that import built workspace packages may not have started.`,
    );
  }
  return lines;
}

/** Name the scope the review actually had, so a narrowed review is never read as a full one. */
function scopeSuffix(scope: BotReviewScope | undefined, incrementalSince: string | undefined): string {
  if (scope === "conversation-only") return " (conversation only)";
  if (scope !== "incremental" || incrementalSince === undefined) return "";
  return ` (incremental since ${safeText(incrementalSince, SHORT_SHA_LENGTH)})`;
}

/** Render the ordered review summary, dropping list tails before exceeding the forge budget. */
export function renderReviewSummary(input: ReviewSummaryInput): string {
  const prefix = [
    `Review of ${input.headSha.slice(0, SHORT_SHA_LENGTH)}${scopeSuffix(input.scope, input.incrementalSince)}: intent ${input.intent}, quality ${input.quality}.`,
    `${input.inlineFindings} inline findings, ${input.threadsAnswered} threads answered, ${input.commentVerdicts.length} comments answered.`,
    ...itemStatusLines(input.itemStatus, input.blockingCount),
    ...readinessLines(input),
    ...policyLines(input),
  ];
  if (input.staticMode) prefix.push("Untrusted PR: reviewed without running any code.");
  const suffix = input.failed > 0 ? [`Could not post ${input.failed} comments; re-run nax bot review.`] : [];
  return boundedSummary(prefix, summarySections(input), suffix);
}
