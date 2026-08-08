/**
 * nax-finish PR title and body — pure deterministic builder, plus the loader
 * that assembles a `FinishPrContext` from finish-audit artifacts on disk.
 *
 * The finish flow opens a PR via `openOrPromotePr` and used to ship a
 * hardcoded `nax-finish: <feature>` title and a one-sentence body, throwing
 * away every artifact the run produced on the way. This module restores that
 * context as a deterministic markdown body, assembled by string joins over the
 * fields in `FinishPrContext`. Every *section* is reproducible from artifacts
 * that exist before `open_pr` runs, so the body stays greppable in PR history.
 *
 * Two fields are the exception, and both arrive later, from the narrative node
 * that runs after the PR is already open: `narrative` and `title`. Each has a
 * deterministic fallback (`resolveNarrative`, `resolveTitle`) so `open_pr` never
 * waits on a model — see `steps/pr-narrative.ts`.
 *
 * Reimplemented here (rather than imported from `src/`) because `flows/`
 * ships to a different runtime — `acpx flow run` runs it in acpx's own Node
 * process where nax's `src/` and its `@/*` alias are not available.
 */
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { runArgv } from "../exec";
import { readSpecSummary, resolveNarrative } from "../narrative";
import { findPrTemplate } from "../pr-template";
import { type BodySection, type TemplateMode, mergeTemplate } from "../pr-template-merge";
import { resolveTitle } from "../pr-title";
import type { Finding, FinishInput, FinishRound, RunFn } from "../types";
import type { Forge } from "./forge";
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
  /**
   * `--shortstat` for the nax artifacts held out of `diffstat`. Absent when the
   * branch touched none, so a repo that gitignores them renders nothing.
   */
  artifactSummary?: string;
  /** Repository PR/MR template, verbatim. Absent when none resolves. */
  template?: string;
  /** How `template` is honoured. Absent → `merge`. See `pr-template-merge.ts`. */
  templateMode?: TemplateMode;
  /** Repo overrides for the template-heading → section-key table. */
  templateSectionMap?: Record<string, string>;
  /** Resolved "What changed" prose. Absent when neither source produced text. */
  narrative?: string;
  /**
   * Resolved conventional-commit PR title. Always set — `resolveTitle` falls
   * back to `feat: <feature>` when the narrative node produced nothing usable.
   */
  title: string;
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
  } catch (error) {
    _prBodyDeps.warn("[finish-pr] Failed to parse PR context artifact", { path, error });
    return undefined;
  }
}

function storiesFrom(prd: PrdArtifact | undefined): FinishPrStory[] {
  if (!Array.isArray(prd?.userStories)) return [];
  // A hand-edited or older-schema PRD can carry a story with a missing/non-string
  // `id`/`title` — drop only that row rather than letting `escapeTableCell` throw
  // and take down the entire PR body (caught upstream by `open_pr`'s fallback).
  return prd.userStories
    .filter((story) => typeof story.id === "string" && typeof story.title === "string")
    .map((story) => ({
      id: story.id,
      title: story.title,
      acCount: Array.isArray(story.acceptanceCriteria) ? story.acceptanceCriteria.length : 0,
    }));
}

/**
 * Pathspec matching nax's own run artifacts, at any depth.
 *
 * `**` and the `glob` magic word are both load-bearing. nax writes artifacts
 * to a repo-root `.nax/` *and* to a per-package `<pkg>/.nax/` — a root-anchored
 * `:!.nax/**` silently keeps the per-package copy, which is routinely the
 * largest file in the diff (587 of 2039 insertions on the run that motivated
 * this). Without `glob`, git's default wildmatch lets `*` cross `/` and the
 * two forms stop being distinguishable.
 */
const NAX_ARTIFACT_PATHSPEC = "**/.nax/**";

/** The two halves of the branch's diff: what is under review, and what was held out. */
interface DiffstatResult {
  diffstat?: string;
  artifactSummary?: string;
}

/** Run `git diff <...args>` under `workdir`, or `undefined` on any non-happy path. */
async function runGitDiff(workdir: string, args: string[]): Promise<string | undefined> {
  try {
    const res = await _prBodyDeps.run(["git", "diff", ...args], { cwd: workdir });
    if (res.exitCode !== 0) return undefined;
    return res.stdout;
  } catch {
    return undefined;
  }
}

/**
 * Diffstat of the branch, excluding nax's own artifacts.
 *
 * The artifacts (`spec.md`, `prd.json`, the generated acceptance test) are
 * committed and real, but they are the run's exhaust rather than the change
 * under review, and they dominate the totals — quoting them in the headline
 * advertises a 2039-line change where 791 lines are reviewable code.
 * `artifactSummary` keeps them accounted for rather than silently dropped, so
 * the body still reconciles against `gh pr diff`.
 *
 * Fail-open on every non-happy path — a non-zero exit (no commits, divergent
 * branch, base missing), a rejected run promise (forks too slow to start), or
 * any thrown error — returning `undefined`. The PR's Verification block is
 * optional, and a routine empty-branch finish must not lose `open_pr` to a
 * throw that the body can simply skip.
 */
async function runDiffstat(workdir: string, base: string): Promise<DiffstatResult> {
  // An empty `base` would interpolate to `...HEAD`, which git resolves as
  // `HEAD...HEAD` — exit 0, empty stdout — masking the missing-base case as
  // "no changes" instead of skipping explicitly.
  if (!base) return {};
  const range = `${base}...HEAD`;
  const [diffstat, artifacts] = await Promise.all([
    runGitDiff(workdir, ["--stat", range, "--", `:(glob,exclude)${NAX_ARTIFACT_PATHSPEC}`]),
    runGitDiff(workdir, ["--shortstat", range, "--", `:(glob)${NAX_ARTIFACT_PATHSPEC}`]),
  ]);
  const summary = artifacts?.trim();
  return { diffstat, artifactSummary: summary ? summary : undefined };
}

/**
 * Resolve the repository's PR/MR template, fail-open.
 *
 * An absent template is the common case and never warns. A genuine read failure
 * is swallowed too: the body is useful without this section, and `open_pr` must
 * not lose a PR to a permissions error on a file most repos do not have.
 */
async function loadTemplate(workdir: string, forge: Forge | undefined): Promise<string | undefined> {
  if (forge === undefined) return undefined;
  try {
    return (await findPrTemplate(workdir, forge, { readText: _prBodyDeps.readText })) ?? undefined;
  } catch {
    return undefined;
  }
}

export async function loadFinishPrContext(
  input: FinishInput,
  args: { base: string; gatesRan: string[]; forge?: Forge; specPath?: string; narrative?: string; title?: string },
): Promise<FinishPrContext> {
  const inputPrdPath = input.prdPath || "prd.json";
  const prdPath = isAbsolute(inputPrdPath) ? inputPrdPath : join(input.workdir, inputPrdPath);
  // [US-004] The audit trail (`rounds`), the diffstat, and the spec summary
  // are independent of the PRD/status reads — fetching them in parallel keeps
  // the loader's wall clock at max(readRounds, readJson×2, diffstat, spec).
  const [prd, status, rounds, stat, template, specSummary] = (await Promise.all([
    readJson(prdPath),
    readJson(join(dirname(prdPath), "status.json")),
    readRounds(input),
    runDiffstat(input.workdir, args.base),
    loadTemplate(input.workdir, args.forge),
    readSpecSummary(args.specPath, _prBodyDeps.readText),
  ])) as [
    PrdArtifact | undefined,
    StatusArtifact | undefined,
    FinishRound[],
    DiffstatResult,
    string | undefined,
    string | null,
  ];
  return {
    feature: input.feature,
    stories: storiesFrom(prd),
    outOfScope: Array.isArray(prd?.outOfScope) ? prd.outOfScope : [],
    acceptance: status?.postRun?.acceptance?.status,
    regression: status?.postRun?.regression?.status,
    gatesRan: args.gatesRan,
    rounds,
    diffstat: stat.diffstat,
    artifactSummary: stat.artifactSummary,
    template,
    ...(input.prBody?.template !== undefined ? { templateMode: input.prBody.template } : {}),
    ...(input.prBody?.sectionMap !== undefined ? { templateSectionMap: input.prBody.sectionMap } : {}),
    narrative: resolveNarrative(args.narrative, specSummary),
    title: resolveTitle(args.title, input.feature),
    run: {
      durationMs: status?.durationMs,
      storiesPassed: status?.progress?.passed,
      storiesTotal: status?.progress?.total,
    },
  };
}

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

function buildRoundBlock(round: FinishRound): string {
  const lines: string[] = [buildRoundHeading(round)];
  if (round.findings.length === 0) {
    lines.push("- _no findings_");
  } else {
    for (const finding of round.findings) lines.push(renderFinding(finding));
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
