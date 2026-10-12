/** The workflow PR body (spec §7 step 9). Separate from finish's body; reuses its advisor section and escapes. */
import type { AdviceDecision } from "@/advisor";
import { buildAdvisorSection, escapeInline, escapeTableCell } from "@/finish";
import type { PreflightFile } from "./preflight";
import type { FeatureCiState, FeatureOutcome, RepoGateSummary, StorySummary, WorkflowRuling } from "./types";

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
  readonly assumptions: readonly { readonly storyId: string; readonly text: string }[];
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

export function buildWorkflowPrBody(input: WorkflowPrBodyInput): string {
  return [
    `## Summary\n\n${summary(input)}`,
    `## Stories\n\n${storiesTable(input.stories)}`,
    `## Pre-flight rulings\n\n${list(preflightLines(input.preflight))}`,
    `## Advisor decisions\n\n${buildAdvisorSection([...input.decisions]) ?? NONE}`,
    `## Parked findings\n\n${list(input.rulings.map((r) => `${r.findingId ?? "?"} ${r.action}: ${r.text} — ${r.why}`))}`,
    `## Deferred minors (left)\n\n${list(input.minorsLeft)}`,
    `## Gates and CI\n\n${list(gateLines(input))}`,
    `## Decisions & assumptions\n\n${list(
      input.assumptions.map((a) => `${a.storyId}: ${a.text}`),
      ASSUMPTION_ITEM_CHARS,
    )}`,
    "_Opened by nax workflow mode. nax never merges._",
  ].join("\n\n");
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
