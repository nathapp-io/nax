/**
 * nax-finish PR title and body — pure deterministic builder.
 *
 * The finish flow opens a PR via `openOrPromotePr` and used to ship a
 * hardcoded `nax-finish: <feature>` title and a one-sentence body, throwing
 * away every artifact the run produced on the way. This module restores that
 * context as a deterministic markdown body — the title matches
 * `src/plugins/builtin/auto-pr/pr-body.ts:buildTitle`, and the body is
 * assembled by string joins over the fields in `FinishPrContext`. No model
 * call: every section is reproducible from artifacts that exist before
 * `open_pr` runs, and so the body stays greppable in PR history.
 *
 * Reimplemented here (rather than imported from `src/`) because `flows/`
 * ships to a different runtime — `acpx flow run` runs it in acpx's own Node
 * process where nax's `src/` and its `@/*` alias are not available.
 */
import type { Finding, FinishRound } from "./types";

const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;

/** Six hex + one — the abbreviated form used everywhere in PR bodies and logs. */
const SHORT_SHA_LEN = 7;

/** One row in the Stories table. */
export interface FinishPrStory {
  id: string;
  title: string;
  acCount: number;
}

/** Everything `open_pr` renders, sourced from finish-audit artifacts. */
export interface FinishPrContext {
  feature: string;
  stories: FinishPrStory[];
  outOfScope: string[];
  acceptance?: string;
  regression?: string;
  gatesRan: string[];
  diffstat?: string;
  rounds: FinishRound[];
  run: {
    durationMs?: number;
    storiesPassed?: number;
    storiesTotal?: number;
  };
}

/**
 * Conventional-commit title matching `buildTitle` in
 * `src/plugins/builtin/auto-pr/pr-body.ts:43`, so finish-opened and
 * auto-PR-opened PRs read the same in a list view.
 */
export function buildFinishTitle(ctx: FinishPrContext): string {
  return `feat: ${ctx.feature}`;
}

/**
 * Escape a string for safe inclusion in a single markdown table cell.
 *
 * Mirrors `escapeTableCell` in `src/plugins/builtin/auto-pr/pr-body.ts:77`,
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
  lines.push("## Stories");
  lines.push("| Story | Title | ACs |");
  lines.push("|-------|-------|-----|");
  for (const story of stories) {
    lines.push(`| ${escapeTableCell(story.id)} | ${escapeTableCell(story.title)} | ${story.acCount} |`);
  }
  return lines.join("\n");
}

function buildVerificationSection(
  acceptance: string | undefined,
  regression: string | undefined,
  gatesRan: string[],
  diffstat: string | undefined,
): string | null {
  const lines: string[] = ["## Verification"];
  if (acceptance !== undefined) lines.push(`- Acceptance: ${acceptance}`);
  if (regression !== undefined) lines.push(`- Regression: ${regression}`);
  if (gatesRan.length > 0) lines.push(`- Gates: ${gatesRan.join(", ")}`);
  if (diffstat !== undefined && diffstat.length > 0) lines.push(`- Diffstat:\n\n\`\`\`\n${diffstat}\n\`\`\``);
  if (lines.length === 1) return null;
  return lines.join("\n");
}

function buildRoundHeading(round: FinishRound): string {
  const base = `### ${round.phase} attempt ${round.attempt}`;
  if (!round.committed || !round.sha) return base;
  const short = round.sha.slice(0, SHORT_SHA_LEN);
  return `${base} (${short})`;
}

function buildRoundsSection(rounds: FinishRound[]): string | null {
  if (rounds.length === 0) return null;
  const lines: string[] = ["## Review rounds"];
  for (const round of rounds) {
    lines.push(buildRoundHeading(round));
    for (const finding of round.findings) {
      lines.push(renderFinding(finding));
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderFinding(finding: Finding): string {
  return `- [${finding.severity}] ${finding.title}`;
}

function buildOutOfScopeSection(outOfScope: string[]): string | null {
  if (outOfScope.length === 0) return null;
  const lines: string[] = ["## Out of scope"];
  for (const item of outOfScope) lines.push(`- ${item}`);
  return lines.join("\n");
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

export function buildFinishBody(ctx: FinishPrContext): string {
  const sections: string[] = [];

  if (ctx.stories.length > 0) sections.push(buildStoriesSection(ctx.stories));

  const verification = buildVerificationSection(ctx.acceptance, ctx.regression, ctx.gatesRan, ctx.diffstat);
  if (verification !== null) sections.push(verification);

  const rounds = buildRoundsSection(ctx.rounds);
  if (rounds !== null) sections.push(rounds);

  const outOfScope = buildOutOfScopeSection(ctx.outOfScope);
  if (outOfScope !== null) sections.push(outOfScope);

  const footer = buildFooter(ctx.run);
  if (footer !== null) sections.push(footer);

  return sections.join("\n\n");
}
