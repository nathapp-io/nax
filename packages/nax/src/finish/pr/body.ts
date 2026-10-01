/**
 * The finish PR title and body: a pure deterministic builder over
 * `FinishPrContext`.
 *
 * Pure on purpose. Every fact in a finish body — gate results, story counts,
 * diffstat, review rounds — is a string join over artifacts, which is what
 * keeps a finish PR greppable in history. The only model-authored fields
 * (`narrative`, `title`) arrive already resolved, each with a deterministic
 * fallback, so the body never waits on a reviewer.
 *
 * Ported from `flows/nax-finish/steps/pr-body.ts`; the rendering is settled
 * behaviour (nax#1477, nax#1504, nax#1507) and must not drift.
 */

import type { BodySection } from "@/forge";
import { mergeTemplate } from "@/forge";
import type { Finding, FindingDisposition, FinishRound } from "../types";
import type { FinishPrContext, FinishPrStory } from "./context";

const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;

/** Six hex + one — the abbreviated form used everywhere in PR bodies and logs. */
const SHORT_SHA_LEN = 7;

/**
 * The PR title: the narrative node's conventional-commit subject when it
 * produced one, else `feat: <feature>`.
 *
 * That fallback is what this returned unconditionally, and is still what
 * `buildTitle` in `src/plugins/builtin/auto-pr/pr-body.ts` opens with — so a
 * finish run that reaches `open_pr` before the narrative node has spoken still
 * reads identically to an auto-PR-opened one in a list view. The two diverge
 * only once there is something better to say: `feat: schema-drift-gate` names
 * the run, not the change.
 */
export function buildFinishTitle(ctx: FinishPrContext): string {
  return ctx.title;
}

/**
 * Escape a string for safe inclusion in a single markdown table cell.
 *
 * Mirrors `escapeTableCell` in `src/plugins/builtin/auto-pr/pr-body.ts`,
 * trimmed to the cases the finish body actually needs: pipes (which break
 * the column boundary) and newlines (which create new rows). Backslashes are
 * escaped first so the pipe escape survives a literal backslash in a title.
 */
function escapeTableCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function formatDuration(durationMs: number): string {
  // `Math.max(0, NaN)` returns NaN, and `Math.floor(Infinity / 1000)` returns
  // Infinity — both would render as `"NaNm NaNs"` / `"Infinitym Infinitys"`.
  // A non-finite duration is a corrupted artifact (status.json is hand-editable),
  // so fall back to zero rather than let it leak into the PR body verbatim.
  if (!Number.isFinite(durationMs)) return "0m 00s";
  const clampedMs = Math.max(0, Math.round(durationMs));
  const totalSeconds = Math.floor(clampedMs / MS_PER_SECOND);
  const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  const seconds = totalSeconds % SECONDS_PER_MINUTE;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function buildStoriesSection(stories: FinishPrStory[]): string {
  const lines: string[] = [];
  lines.push("| Story | Title | ACs |");
  lines.push("|-------|-------|-----|");
  for (const story of stories) {
    lines.push(`| ${escapeTableCell(story.id)} | ${escapeTableCell(story.title)} | ${story.acCount} |`);
  }
  return lines.join("\n");
}

/**
 * Takes the whole context rather than the five fields it reads: the section
 * grew past the three-positional-parameter cap in the coding standards, and
 * every field it wants is already on `FinishPrContext`.
 */
function buildVerificationSection(ctx: FinishPrContext): string | null {
  const { acceptance, regression, gatesRan, diffstat, artifactSummary } = ctx;
  const lines: string[] = [];
  if (acceptance !== undefined) lines.push(`- Acceptance: ${acceptance}`);
  if (regression !== undefined) lines.push(`- Regression: ${regression}`);
  if (gatesRan.length > 0) lines.push(`- Gates: ${gatesRan.join(", ")}`);
  if (diffstat !== undefined && diffstat.length > 0) lines.push(`- Diffstat:\n\n\`\`\`\n${diffstat}\n\`\`\``);
  // Stated even though the files are excluded above: a reviewer who diffs the
  // branch themselves sees more than the diffstat quotes, and an unexplained
  // mismatch reads as a stale body.
  if (artifactSummary !== undefined && artifactSummary.length > 0) {
    lines.push(`- Excluded from diffstat — nax run artifacts: ${artifactSummary}`);
  }
  if (lines.length === 0) return null;
  return lines.join("\n");
}

function buildRoundHeading(round: FinishRound): string {
  const base = `### ${round.phase} attempt ${round.attempt}`;
  if (!round.committed || !round.sha) return base;
  const short = round.sha.slice(0, SHORT_SHA_LEN);
  return `${base} (${short})`;
}

/**
 * What an empty finding list means, in the reader's terms.
 *
 * Four different things used to render identically as "_no findings_", which a
 * human reads as "a reviewer looked at this and approved it" (#1507). Only
 * `passed` means that. `no-reviewer` is the one that actively misleads: the
 * gate phase has no reviewer node at all, so its empty list is the absence of a
 * review, not the result of one.
 *
 * `fixed` and the legacy `undefined` both fall through to "_no findings_":
 * rounds written before `outcome` existed carry no field to read, and claiming
 * anything more specific about them would be inventing detail.
 */
const EMPTY_ROUND_NOTE: Record<string, string> = {
  passed: "- _no findings_",
  "no-reviewer": "- _no reviewer for this phase_",
  unparseable: "- _reviewer output could not be parsed_",
  escalated: "- _escalated for human review_",
  "review-skipped": "- _re-review skipped: this fix touched test files only_",
  incomplete: "- _review sent back: required evidence sections missing_",
};

function buildRoundBlock(round: FinishRound): string {
  const lines: string[] = [buildRoundHeading(round)];
  if (round.findings.length === 0) {
    lines.push(EMPTY_ROUND_NOTE[round.outcome ?? ""] ?? "- _no findings_");
  } else {
    if (round.outcome === "incomplete") {
      lines.push("- _not acted on — the review was sent back for missing evidence sections_");
    }
    for (const [i, finding] of round.findings.entries()) {
      const d = round.dispositions?.find((x) => x.index === i + 1);
      lines.push(d?.disposition === "rejected" ? renderRejected(finding, d) : renderFinding(finding));
    }
  }
  return lines.join("\n");
}

function buildRoundsSection(rounds: FinishRound[]): string | null {
  if (rounds.length === 0) return null;
  return rounds.map(buildRoundBlock).join("\n\n");
}

function renderFinding(finding: Finding): string {
  return `- [${finding.severity}] ${finding.title}`;
}

/**
 * A waived finding, shown as waived.
 *
 * The alternative — dropping it — would make a rejection indistinguishable from
 * a fix in the only artifact a human reads, which is the failure this whole
 * mechanism exists to avoid.
 */
function renderRejected(finding: Finding, d: FindingDisposition): string {
  const evidence = d.evidence ? `\`${d.evidence}\`` : "_no evidence cited_";
  const caveat = d.evidenceMissing ? " — **evidence path not found**" : "";
  return `- [${finding.severity}] ${finding.title} — _rejected_: ${evidence}${caveat}`;
}

/**
 * Body only — the heading is attached by `buildFinishBody`, which drops any
 * section whose body is null. "No text" therefore cannot render a bare
 * `## What changed` heading, the empty-heading case #1477 forbids.
 */
function buildNarrativeSection(narrative: string | undefined): string | null {
  return narrative?.trim() || null;
}

function buildOutOfScopeSection(outOfScope: string[]): string | null {
  if (outOfScope.length === 0) return null;
  return outOfScope.map((item) => `- ${item}`).join("\n");
}

function buildFooter(run: FinishPrContext["run"]): string | null {
  const { storiesPassed, storiesTotal, durationMs } = run;
  if (storiesPassed === undefined && storiesTotal === undefined && durationMs === undefined) return null;
  const counts =
    storiesPassed !== undefined && storiesTotal !== undefined ? `${storiesPassed}/${storiesTotal} stories` : null;
  const timing = durationMs !== undefined ? formatDuration(durationMs) : null;
  const parts = [counts, timing].filter((p): p is string => p !== null);
  if (parts.length === 0) return null;
  return parts.join(" · ");
}

/**
 * The nax-authored sections, in canonical order — the order they appear in
 * when the repo has no template, and the order the leftovers are appended in
 * when it has one. `key` is what `mergeTemplate` matches against the repo's
 * headings; the run footer carries an empty heading so it stays unmatchable
 * and last.
 */
function buildBodySections(ctx: FinishPrContext): BodySection[] {
  const candidates: { key: string; heading: string; body: string | null }[] = [
    { key: "narrative", heading: "What changed", body: buildNarrativeSection(ctx.narrative) },
    { key: "stories", heading: "Stories", body: ctx.stories.length > 0 ? buildStoriesSection(ctx.stories) : null },
    { key: "verification", heading: "Verification", body: buildVerificationSection(ctx) },
    { key: "rounds", heading: "Review rounds", body: buildRoundsSection(ctx.rounds) },
    { key: "outOfScope", heading: "Out of scope", body: buildOutOfScopeSection(ctx.outOfScope) },
    { key: "footer", heading: "", body: buildFooter(ctx.run) },
  ];
  return candidates
    .filter((c): c is { key: string; heading: string; body: string } => c.body !== null)
    .map(({ key, heading, body }) => ({ key, heading, body }));
}

/**
 * Assemble the body, merged into the repo's own PR template when it has one.
 *
 * The template supplies the *shape* (which headings, in what order) and these
 * sections supply the *content* — see `pr-template-merge.ts` for why appending
 * it verbatim, which is what this used to do, shipped a blank form under a
 * filled one (nax#1504).
 */
export function buildFinishBody(ctx: FinishPrContext): string {
  return mergeTemplate(ctx.template, buildBodySections(ctx), {
    mode: ctx.templateMode,
    sectionMap: ctx.templateSectionMap,
  });
}
