/** The workflow PR body (spec §7 step 9). Separate from finish's body; reuses its advisor section and escapes. */
import type { AdviceDecision } from "@/advisor";
import { buildAdvisorSection, escapeInline, escapeTableCell } from "@/finish";
import type { PreflightFile } from "./preflight";
import type {
  FeatureCiState,
  FeatureOutcome,
  OpenItem,
  RepoGateSummary,
  StorySummary,
  WorkflowFindingDraft,
  WorkflowRuling,
} from "./types";

export interface WorkflowPrBodyFacts {
  readonly feature: string;
  readonly stories: readonly StorySummary[];
  readonly preflight: PreflightFile | null;
  readonly decisions: readonly AdviceDecision[];
  /** Branch adjudication rulings (the parked branch findings). */
  readonly rulings: readonly WorkflowRuling[];
  /** Deferred minors marked leave, plus minors the branch review raised. */
  readonly minorsLeft: readonly string[];
  readonly finalGates?: RepoGateSummary;
  /** Excerpts of the failing final gates (nax#2484), shown under the gates line when they are red. */
  readonly finalGateFindings?: readonly WorkflowFindingDraft[];
  readonly assumptions: readonly { readonly storyId: string; readonly text: string }[];
  /** What is still open on the feature (#2496); drives the "Before marking ready" section. */
  readonly openItems: readonly OpenItem[];
}

export interface WorkflowPrBodyInput extends WorkflowPrBodyFacts {
  readonly outcome: FeatureOutcome;
  readonly ci: FeatureCiState;
  readonly reasons: readonly string[];
}

const ROW_CAP = 50;
const ITEM_CHARS = 300;
const ASSUMPTION_ITEM_CHARS = 700;
const ASSUMPTIONS_CAP = 600;
const NONE = "None.";
const ASSUMPTIONS_HEADING = /decisions\s*(?:&|and)\s*assumptions/i;
const NEXT_SECTION = /^\s*(?:#{1,6}\s|- \*\*|\*\*[^*]+\*\*)/;

function list(items: readonly string[], chars = ITEM_CHARS): string {
  if (items.length === 0) return NONE;
  const shown = items.slice(0, ROW_CAP).map((i) => `- ${escapeInline(i, chars)}`);
  const hidden = items.length - shown.length;
  return [...shown, ...(hidden > 0 ? [`- …and ${hidden} more`] : [])].join("\n");
}

function summary(input: WorkflowPrBodyInput): string {
  const n = input.stories.length;
  const head = `Workflow mode (A5) implemented ${n} ${n === 1 ? "story" : "stories"} for **${escapeInline(input.feature)}**. Outcome: **${input.outcome}**.`;
  return input.reasons.length > 0 ? `${head}\n\nNot ready because:\n${list(input.reasons)}` : head;
}

function storiesTable(stories: readonly StorySummary[]): string {
  const rows = stories
    .slice(0, ROW_CAP)
    .map(
      (s) =>
        `| ${escapeTableCell(s.id)} | ${escapeTableCell(s.title)} | ${escapeTableCell(s.state)}${s.unreviewed ? " (unreviewed)" : ""} | ${s.rounds} |`,
    );
  return ["| Story | Title | State | Rounds |", "|---|---|---|---|", ...rows].join("\n");
}

function preflightLines(p: PreflightFile | null): string[] {
  return (p?.conflicts ?? []).map(
    (c) => `${c.decisionId ?? "default"} (${c.storyIds.join(", ") || "no story"}): ${c.action} — ${c.summary}`,
  );
}

function gateLines(input: WorkflowPrBodyInput): string[] {
  const g = input.finalGates;
  const gates =
    !g || g.ran.length === 0
      ? "Gates: nothing configured (nothing was verified)"
      : g.failing.length > 0
        ? `Gates: red: ${g.failing.join(", ")} (ran ${g.ran.join(", ")})`
        : `Gates: green (${g.ran.join(", ")})`;
  return [gates, `CI: ${input.ci}`];
}

/** A fence one backtick longer than any run in the text, so the excerpt cannot close it early. */
function fenced(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(3, Math.max(0, ...runs.map((r) => r.length)) + 1));
  return `${fence}\n${text}\n${fence}`;
}

function gateExcerpts(input: WorkflowPrBodyInput): string {
  if ((input.finalGates?.failing.length ?? 0) === 0) return "";
  return (input.finalGateFindings ?? []).map((f) => `\n\n${fenced(f.issue)}`).join("");
}

/** Open items are shown in full unless the whole body would exceed PR_BODY_MAX_CHARS (#2496). */
const FULL_TEXT = Number.MAX_SAFE_INTEGER;

function openItemLine(item: OpenItem, chars = FULL_TEXT): string {
  if (item.kind === "gate")
    return `- [ ] **${escapeInline(item.id, chars)}** (gate) — final gate ${escapeInline(item.id, chars)} is red; see the excerpt under Gates and CI`;
  const where = item.file
    ? ` \`${escapeInline(item.file, chars)}${item.line !== undefined ? `:${item.line}` : ""}\``
    : "";
  const tags = (item.severity ? [item.severity, item.kind] : [item.kind]).join(", ");
  return [
    `- [ ] **${escapeInline(item.id, chars)}** (${tags})${where} — ${escapeInline(item.issue, chars)}`,
    ...(item.suggestion ? [`  Suggestion: ${escapeInline(item.suggestion, chars)}`] : []),
    ...(item.ruling ? [`  Advisor: ${item.ruling.action} — ${escapeInline(item.ruling.why, chars)}`] : []),
  ].join("\n");
}

function beforeReady(input: WorkflowPrBodyInput, chars = FULL_TEXT): string | null {
  if (input.outcome === "ready" || input.openItems.length === 0) return null;
  const shown = input.openItems.slice(0, ROW_CAP).map((i) => openItemLine(i, chars));
  const hidden = input.openItems.length - shown.length;
  return [
    "## Before marking ready",
    "",
    ...shown,
    ...(hidden > 0 ? [`- …and ${hidden} more, see result.json verdict.openItems`] : []),
    "",
    "Then: rerun the repo gates, push, and run `gh pr ready`.",
  ].join("\n");
}

function assemble(input: WorkflowPrBodyInput, ready: string | null): string {
  return [
    `## Summary\n\n${summary(input)}`,
    `## Stories\n\n${storiesTable(input.stories)}`,
    ...(ready ? [ready] : []),
    `## Pre-flight rulings\n\n${list(preflightLines(input.preflight))}`,
    `## Advisor decisions\n\n${buildAdvisorSection([...input.decisions]) ?? NONE}`,
    `## Parked findings\n\n${list(input.rulings.map((r) => `${r.findingId ?? "?"} ${r.action}: ${r.text} — ${r.why}`))}`,
    `## Deferred minors (left)\n\n${list(input.minorsLeft)}`,
    `## Gates and CI\n\n${list(gateLines(input))}${gateExcerpts(input)}`,
    `## Decisions & assumptions\n\n${list(
      input.assumptions.map((a) => `${a.storyId}: ${a.text}`),
      ASSUMPTION_ITEM_CHARS,
    )}`,
    "_Opened by nax workflow mode. nax never merges._",
  ].join("\n\n");
}

/** GitHub rejects a PR body over ~65,536 chars; stay well under it. */
export const PR_BODY_MAX_CHARS = 60_000;
const TRUNCATED_POINTER = "Open items truncated to fit the PR body; full text in result.json verdict.openItems";

export function buildWorkflowPrBody(input: WorkflowPrBodyInput): string {
  const full = assemble(input, beforeReady(input));
  if (full.length <= PR_BODY_MAX_CHARS) return full;
  const ready = beforeReady(input, ITEM_CHARS);
  const capped = assemble(input, ready ? `${ready}\n\n${TRUNCATED_POINTER}` : null);
  if (capped.length <= PR_BODY_MAX_CHARS) return capped;
  const tail = `\n\n${TRUNCATED_POINTER}`;
  return `${capped.slice(0, PR_BODY_MAX_CHARS - tail.length)}${tail}`;
}

/** The first "Decisions & assumptions" section of a story report, flattened and capped (spec §7.9). */
export function extractAssumptions(report: string): string {
  const lines = report.split("\n");
  const start = lines.findIndex((l) => ASSUMPTIONS_HEADING.test(l));
  if (start < 0) return "";
  const inline = (lines[start] ?? "").split(ASSUMPTIONS_HEADING)[1]?.replace(/^[*:\s]+/, "") ?? "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => NEXT_SECTION.test(l));
  const body = [inline, ...(end < 0 ? rest : rest.slice(0, end))].join(" ").replace(/\s+/g, " ").trim();
  return body.length > ASSUMPTIONS_CAP ? `${body.slice(0, ASSUMPTIONS_CAP)}…` : body;
}
