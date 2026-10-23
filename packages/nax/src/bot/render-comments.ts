import { MAX_FORGE_COMMENT_CHARS, withNaxBotMarker } from "@/forge";
import type { PrEarlierVerdict, PrIntent, PrTriageDecision, PrTriageVerdict } from "@/operations/bot-types";
import type { WorkflowFindingDraft } from "@/operations/workflow-types";
// Reuse the safe path leaf without loading workflow's orchestration barrel (as in render.ts).
import { safeCode } from "../workflow/pr-body-safe";
import type { BotChecks } from "./checks";
import { checkCommands } from "./checks";
import { earlierKey, findingKey, safeText, threadKey } from "./render";
import type { BotReviewScope } from "./review-rulings";

const TEXT_LIMIT = 2_000;
const AUTHOR_LIMIT = 100;
const SHORT_SHA_LENGTH = 7;
const SUMMARY_RESERVE = 512;
const DECISION_LABELS: Record<PrTriageDecision, string> = {
  agree: "Agree",
  disagree: "Disagree",
  handled: "Already handled",
};

export interface ReviewSummaryInput {
  readonly unreadFiles?: readonly string[];
  readonly minor?: readonly WorkflowFindingDraft[];
  readonly earlier?: { readonly open: number; readonly fixed: number; readonly withdrawn: number };
  readonly checks?: BotChecks | null;
  readonly preRunFailed?: string;
  readonly ci?: { readonly outcome: string; readonly detail: string };
  readonly headSha: string;
  /** What this review covered (nax#2667); absent keeps the plain head line. */
  readonly scope?: BotReviewScope;
  readonly incrementalSince?: string;
  readonly intent: PrIntent;
  readonly quality: "approved" | "changes";
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

/** A stable marked inline finding, with all author prose neutralised. */
export function renderFindingComment(finding: WorkflowFindingDraft): string {
  let body = `**${severityLabel(finding)}** (${finding.kind}): ${safeText(finding.issue, TEXT_LIMIT)}`;
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

function summarySections(input: ReviewSummaryInput): ListSection[] {
  return [
    { heading: "### Sensitive paths changed", items: input.sensitive.map((path) => `- \`${safeCode(path)}\``) },
    { heading: "### Findings not on a changed line", items: input.offLine.map(offLineItem) },
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
    ...readinessLines(input),
  ];
  if (input.staticMode) prefix.push("Untrusted PR: reviewed without running any code.");
  const suffix = input.failed > 0 ? [`Could not post ${input.failed} comments; re-run nax bot review.`] : [];
  return boundedSummary(prefix, summarySections(input), suffix);
}
