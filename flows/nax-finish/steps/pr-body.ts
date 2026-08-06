/**
 * nax-finish PR title and body — pure deterministic builder, plus the loader
 * that assembles a `FinishPrContext` from finish-audit artifacts on disk.
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
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { runArgv } from "../exec";
import type { Finding, FinishInput, FinishRound, RunFn } from "../types";
import { readRounds } from "./result";

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

export const _prBodyDeps: {
  run: RunFn;
  readText: (path: string) => Promise<string | null>;
  warn: (message: string, details: { path: string; error: unknown }) => void;
} = {
  run: runArgv,
  // ENOENT is the routine case (status.json/prd.json not yet written) and must
  // stay silent — mirrors `_qualityDeps.readText` in `steps/quality.ts`. Only a
  // genuine I/O failure (permission denied, corrupted mount) should warn.
  readText: async (path) => {
    try {
      return await readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  },
  warn: (message, details) => process.emitWarning(message, { detail: `${details.path}: ${String(details.error)}` }),
};

interface PrdArtifact {
  userStories?: { id: string; title: string; acceptanceCriteria?: unknown[] }[];
  outOfScope?: string[];
}

interface StatusArtifact {
  postRun?: { acceptance?: { status?: string }; regression?: { status?: string } };
  durationMs?: number;
  progress?: { passed?: number; total?: number };
}

async function readJson(path: string): Promise<unknown> {
  let text: string | null;
  try {
    text = await _prBodyDeps.readText(path);
  } catch (error) {
    _prBodyDeps.warn("[finish-pr] Failed to read PR context artifact", { path, error });
    return undefined;
  }
  if (text === null) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function storiesFrom(prd: PrdArtifact | undefined): FinishPrStory[] {
  if (!Array.isArray(prd?.userStories)) return [];
  return prd.userStories.map((story) => ({
    id: story.id,
    title: story.title,
    acCount: Array.isArray(story.acceptanceCriteria) ? story.acceptanceCriteria.length : 0,
  }));
}

/**
 * Run `git diff --stat <base>...HEAD` and return its stdout on success.
 *
 * Fail-open on every non-happy path — a non-zero exit (no commits, divergent
 * branch, base missing), a rejected run promise (forks too slow to start), or
 * any thrown error — returning `undefined`. The PR's Verification block is
 * optional, and a routine empty-branch finish must not lose `open_pr` to a
 * throw that the body can simply skip.
 */
async function runDiffstat(workdir: string, base: string): Promise<string | undefined> {
  try {
    const res = await _prBodyDeps.run(["git", "diff", "--stat", `${base}...HEAD`], { cwd: workdir });
    if (res.exitCode !== 0) return undefined;
    return res.stdout;
  } catch {
    return undefined;
  }
}

export async function loadFinishPrContext(
  input: FinishInput,
  args: { base: string; gatesRan: string[] },
): Promise<FinishPrContext> {
  const inputPrdPath = input.prdPath || "prd.json";
  const prdPath = isAbsolute(inputPrdPath) ? inputPrdPath : join(input.workdir, inputPrdPath);
  // [US-004] The audit trail (`rounds`) and the diffstat are independent of
  // the PRD/status reads — fetching them in parallel keeps the loader's wall
  // clock at max(readRounds, readJson×2, diffstat).
  const [prd, status, rounds, diffstat] = (await Promise.all([
    readJson(prdPath),
    readJson(join(dirname(prdPath), "status.json")),
    readRounds(input),
    runDiffstat(input.workdir, args.base),
  ])) as [PrdArtifact | undefined, StatusArtifact | undefined, FinishRound[], string | undefined];
  return {
    feature: input.feature,
    stories: storiesFrom(prd),
    outOfScope: Array.isArray(prd?.outOfScope) ? prd.outOfScope : [],
    acceptance: status?.postRun?.acceptance?.status,
    regression: status?.postRun?.regression?.status,
    gatesRan: args.gatesRan,
    rounds,
    diffstat,
    run: {
      durationMs: status?.durationMs,
      storiesPassed: status?.progress?.passed,
      storiesTotal: status?.progress?.total,
    },
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
  const stories = ctx.stories ?? [];
  const rounds = ctx.rounds ?? [];
  const outOfScope = ctx.outOfScope ?? [];
  const gatesRan = ctx.gatesRan ?? [];
  const run = ctx.run ?? {};

  if (stories.length > 0) sections.push(buildStoriesSection(stories));

  const verification = buildVerificationSection(ctx.acceptance, ctx.regression, gatesRan, ctx.diffstat);
  if (verification !== null) sections.push(verification);

  const roundsSection = buildRoundsSection(rounds);
  if (roundsSection !== null) sections.push(roundsSection);

  const outOfScopeSection = buildOutOfScopeSection(outOfScope);
  if (outOfScopeSection !== null) sections.push(outOfScopeSection);

  const footer = buildFooter(run);
  if (footer !== null) sections.push(footer);

  return sections.join("\n\n");
}
